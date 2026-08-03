# Plan 023: Restore Guard self-script hard-block (regression from %raw / compiler-warning cleanup)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9c744be..HEAD -- src/guard/Guard.res src/guard/Guard.resi src/guard/Guard.res.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9c744be`, 2026-08-03

## Why this matters

The Guard module's self-script threat matrix is the security boundary that
hard-blocks bash heredocs, `node -e`, `bash -c`, redirect-to-script, and
`.sh/.py/.mjs` write targets. Two recent cleanup commits (`2a4a4b2` "eliminate
all compiler warnings" and `9c744be` "eliminate %raw and Obj.magic from core")
replaced `%raw(/.../i)` regex literals with `RegExp.fromString(...)` and
replaced an `Obj.magic(v)` command-extraction cast with a stricter
`JSON.Decode.string(v)->Option.getOr("")`. Together these two changes broke
self-script detection:

- 4 of the 6 detection regexes silently **dropped the case-insensitive `i`
  flag** during the migration, so `Node -E` / `BASH -C` etc. slip past.
- The command extraction now returns `""` for command strings that arrive from
  the integration-test args dict, so `isSelfScript` short-circuits with `false`
  before any regex even runs.

Four integration tests went from green → red between `2dedbde` and `9c744be`:

- `test/integration/guard-before-wiring.test.ts` — `(a) ENFORCED: self-script bash command is hard-blocked`
- `test/integration/guard-before-wiring.test.ts` — `(d) ENFORCED: second identical read is blocked as redundant`
- `test/integration/proportional-downgrade.test.ts` — `non-trivial dispatch: self-script is hard-blocked`
- `test/integration/concurrency.test.ts` — `per-session read budget is isolated` and `each session is independently blockable on its own budget` (the read-budget isolation depends on the same self-script classification path)

The ReScript parity suite `Guard_test.res` still passes (413/416 — the 3
unrelated failures are not in the threat matrix), because it constructs args
dicts in ReScript where `JSON.Decode.string` happens to accept them. The
failure is specifically at the **TS/JS ABI boundary** the integration tests
exercise — exactly the surface the `%raw`/`Obj.magic` cleanup was supposed to
keep sound. This is a security regression, not a cosmetic one.

## Current state

### Problem 1 — lost `i` flag on 4 of 6 detection regexes

`src/guard/Guard.res:316-339` (current, broken):

```rescript
let _hasScriptExt = (_target: string): bool => {
  RegExp.test(RegExp.fromString("\\.(mjs|sh|py|js|ts|cjs|bash)\\b"), _target)
}
let _hasHeredoc = (_cmd: string): bool => {
  RegExp.test(RegExp.fromString("<<-?\\s*['\"]?[A-Za-z_]"), _cmd)
}
let _hasRedirectScript = (_cmd: string): bool => {
  RegExp.test(RegExp.fromString(">\\s*\\S+\\.(mjs|sh|py|js|ts|cjs|bash)\\b"), _cmd)
}
let _hasInlineScript = (_cmd: string): bool => {
  RegExp.test(RegExp.fromString("\\b(node|python3?|deno|bun)\\s+-(e|c)\\b"), _cmd)
}
let _hasCatWrite = (_cmd: string): bool => {
  RegExp.test(RegExp.fromString("\\bcat\\s+>\\s*\\S"), _cmd)
}
let _hasBashC = (_cmd: string): bool => {
  RegExp.test(RegExp.fromString("\\bbash\\s+-c\\b"), _cmd)
}
```

Old form (before the cleanup) — these had the trailing `/i` flag:

```rescript
let _SCRIPT_EXT_RE    = %raw(`/\\.(mjs|sh|py|js|ts|cjs|bash)\\b/i`)
let _HEREDOC_RE       = %raw(`/<<-?\\s*['"]?[A-Za-z_]/`)
let _REDIRECT_SCRIPT_RE = %raw(`/\\>\\s*\\S+\\.(mjs|sh|py|js|ts|cjs|bash)\\b/i`)
let _INLINE_SCRIPT_RE = %raw(`/\\b(node|python3?|deno|bun)\\s+-(e|c)\\b/i`)
let _CAT_WRITE_RE     = %raw(`/\\bcat\\s+>\\s*\\S/`)
let _BASH_C_RE        = %raw(`/\\bbash\\s+-c\\b/i`)
```

The case-insensitive flag was load-bearing: `Node -E`, `BASH -C`, `Python3 -C`
elude the lowercase-only patterns otherwise. Restore the `i` flag on
`_hasScriptExt`, `_hasRedirectScript`, `_hasInlineScript`, and `_hasBashC`
exactly. `_hasHeredoc` and `_hasCatWrite` did NOT carry `i` and must stay
case-sensitive.

### Problem 2 — `JSON.Decode.string` is too strict for runtime JS strings

`src/guard/Guard.res:456-463` (current, broken — the `isSelfScript` command
extraction):

```rescript
let cmd = switch args->Dict.get("command") {
| Some(v) => JSON.Decode.string(v)->Option.getOr("")
| None =>
  switch args->Dict.get("cmd") {
  | Some(v) => JSON.Decode.string(v)->Option.getOr("")
  | None => ""
  }
}
```

The previous form used a force-cast that worked for any runtime JS string:

```rescript
| Some(v) => {
    let s: string = Obj.magic(v)
    s
  }
```

`Obj.magic` was unsound and worth removing, but `JSON.Decode.string(v)->Option.getOr("")`
is too strict: for command strings passed from JS through the
`Nullable.t<dict<JSON.t>>` ABI bridge (as the integration tests do), it returns
`None`, so `cmd` becomes `""`. `isSelfScript` then short-circuits to `false`
and the bash heredoc / `node -e` / `bash -c` block is never reached. The
integration tests' assertion `await expect(...).rejects.toThrow()` resolves with
`undefined` instead — confirming the guard does not even try to block.

### Repo conventions to match

- ReScript 12 in-source ESM (`.res.mjs`); `rescript.json` includes all of `src/`.
- The codebase has already migrated to `@rescript/core` (`JSON`, `Dict`, `Option`,
  `RegExp`). Use those, not `Js_*` modules, EXCEPT where a routine genuinely
  needs runtime JS inspection (see Suggested executor toolkit below).
- The migration's defining rule (from `sdd/rescript-migration-phase4-5` design):
  byte/output parity at every ABI boundary; `Js.Nullable.t<T>` (now `Nullable.t<T>`)
  at TS-facing boundaries.
- Match the existing `_has*` helper naming. No new exports in `Guard.resi`.

### Documented design constraints to honor

- The Guard threat matrix is documented in `Guard_test.res` (the rescript-test
  parity suite). It covers `requirements.txt`, `CMakeLists.txt`, `README.md` as
  benign normal writes; `README.sh` as opt-in; `node -e "..."`
  heredoc/redirect as blocked; `.ts` as allowed. The plan MUST keep all 413
  currently-passing `Guard_test.res` cases green.
- The `i` flag's importance is structural: a producer passing `BASH -c '...'`
  must be hard-blocked exactly as `bash -c '...'` is. Case-folding at the
  regex level is the contract.

## Commands you will need

| Purpose            | Command                                                            | Expected on success                                  |
|--------------------|-------------------------------------------------------------------|------------------------------------------------------|
| Install            | `pnpm install`                                                    | exit 0                                               |
| ReScript build     | `pnpm run res:build`                                              | exit 0, regenerates `src/guard/Guard.res.mjs`        |
| Typecheck          | `pnpm run typecheck`                                              | exit 0, no errors                                    |
| ReScript parity    | `pnpm run test:res -- src/guard/Guard_test.res.mjs`              | 413/413 passing (threat matrix unchanged)            |
| Full rescript-test | `pnpm run test:res`                                               | 416/416 passing                                      |
| Targeted vitest    | `pnpm test -- test/integration/guard-before-wiring.test.ts test/integration/proportional-downgrade.test.ts test/integration/concurrency.test.ts` | all listed files pass                  |
| Full vitest         | `pnpm test`                                                       | at most the 14-failure accepted baseline (this plan's 4 + the 2 concurrency ones are fixed) |
| Build              | `pnpm run build`                                                  | exit 0                                               |

## Suggested executor toolkit

- `@rescript/core` `RegExp` module — for restoring the `i` flag, use the
  flags-aware constructor. Inspect the installed API in
  `node_modules/@rescript/core/` for the exact name (e.g.
  `RegExp.fromStringWithFlags(~flags="i", pattern)` or `RegExp.make(~flags="i", ~pattern=...)`).
  If no flag-aware constructor exists, the cleanest fallback is
  `Js.Re.fromStringWithFlags` from the `@rescript/.Platform` / runtime, or a
  single-line `%raw(\`new RegExp("...", "i")\`)` typed back to the `RegExp.t`
  type. The user's prior directive was "eliminate %raw and Obj.magic from
  core" — but a *flag-bearing regex literal in the regex module* is an
  acceptable, idiomatic ReScript escape hatch when the high-level RegExp API
  lacks flag support. Prefer the API; fall back to `%raw` only for the regex
  literal, never for data flow.
- `JSON.classify(v)` (from `@rescript/core`) — the structural inspector for a
  `JSON.t`. Returns the variant `JSON.Null | JSON.Undefined | JSON.Bool(_) |
  JSON.Number(_) | JSON.String(_) | JSON.Array(_) | JSON.Object(_)`. This is
  the idiomatic, sound replacement for `Obj.magic(v)` — `JSON.String(s)`
  matches any runtime JS string and gives you `s` without unsound casts.

## Scope

**In scope** (the only files you should modify):
- `src/guard/Guard.res` — restore `i` flag on 4 regexes; replace command
  extraction `JSON.Decode.string(v)->Option.getOr("")` with a
  `JSON.classify`-based helper (or equivalent sound runtime string check).
- `src/guard/Guard.res.mjs` — regenerated by `pnpm run res:build`. Do NOT
  hand-edit; treat the regenerated file as a verification artifact.

**Out of scope** (do NOT touch, even though they look related):
- `src/guard/Guard.resi` — the public API is unchanged.
- `src/guard/Guard_test.res` — the parity suite still passes; do not weaken or
  rewrite its assertions to mask the integration failure. If a `Guard_test.res`
  case would need to change to expose the integration bug, STOP — that means
  the parity suite itself had a coverage gap and needs a separate plan.
- `src/types/rescript-modules.d.ts` — the ABI bridge is additive and
  unchanged by this fix.
- Any other ReScript module. The root cause is entirely inside `Guard.res`.
- The `%raw` / `Obj.magic` cleanup pattern as a whole. Do NOT reintroduce
  `Obj.magic` anywhere. The regex flag restoration is the only acceptable
  `%raw` reappearance and only if the @rescript/core API lacks a flag-aware
  constructor.

## Git workflow

- Branch: `advisor/023-fix-guard-self-script-regression`
- Commit per logical unit; conventional commits. Suggested split:
  - `fix(guard): restore case-insensitive flag on self-script regexes`
  - `fix(guard): use JSON.classify for command extraction (replaces Obj.magic soundly)`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Restore the `i` flag on the 4 case-insensitive detection regexes

In `src/guard/Guard.res`, change the four helpers so their compiled regex
includes the `i` flag. Use whichever `@rescript/core` `RegExp` constructor the
installed version supports for flags (verify by inspecting
`node_modules/@rescript/core/src/RegExp.*` or its `.resi`). Targeted helpers
only:

- `_hasScriptExt` — pattern `"\\.(mjs|sh|py|js|ts|cjs|bash)\\b"`, flag `i`
- `_hasRedirectScript` — pattern `">\\s*\\S+\\.(mjs|sh|py|js|ts|cjs|bash)\\b"`, flag `i`
- `_hasInlineScript` — pattern `"\\b(node|python3?|deno|bun)\\s+-(e|c)\\b"`, flag `i`
- `_hasBashC` — pattern `"\\bbash\\s+-c\\b"`, flag `i`

Leave `_hasHeredoc` and `_hasCatWrite` case-sensitive (they had no `i` flag
before the cleanup either).

**Verify (build parity)**: `pnpm run res:build` → exit 0. Then confirm by
inspecting the regenerated `src/guard/Guard.res.mjs`: each of the 4 affected
arrows should compile to `new RegExp("...", "i")` (flag string present).
`grep -n '"i"' src/guard/Guard.res.mjs` should show 4 hits in the right places.

### Step 2: Replace command extraction with a sound runtime classifier

Define one helper near the other `_has*` helpers in `src/guard/Guard.res`:

```rescript
let _stringOrEmpty = (v: JSON.t): string => {
  switch JSON.classify(v) {
  | JSON.String(s) => s
  | _ => ""
  }
}
```

Then update the `cmd` extraction in `isSelfScript` to use it for both the
`"command"` and `"cmd"` keys:

```rescript
let cmd = switch args->Dict.get("command") {
| Some(v) => _stringOrEmpty(v)
| None =>
  switch args->Dict.get("cmd") {
  | Some(v) => _stringOrEmpty(v)
  | None => ""
  }
}
```

If, in the executor's environment, `JSON.classify` does not return
`JSON.String(s)` for the runtime JS strings the integration tests pass (i.e.
the targeted vitest from Step 4 still fails with `promise resolved "undefined"
instead of rejecting`), STOP and consult the STOP conditions below — do not
reintroduce `Obj.magic`.

**Verify (compile)**: `pnpm run res:build && pnpm run typecheck` → both exit 0.

### Step 3: Confirm the parity suite is unchanged

The rescript-test parity suite must not regress. The threat-matrix tests are
the source of truth for Guard behavior; if compiling in Step 2 broke any, the
helper is wrong.

**Verify**: `pnpm run test:res -- src/guard/Guard_test.res.mjs` → 413/413
passing (same as before this plan started).

### Step 4: Confirm the 4 integration-test regressions are fixed

**Verify**:
`pnpm test -- test/integration/guard-before-wiring.test.ts test/integration/proportional-downgrade.test.ts test/integration/concurrency.test.ts` → all listed files pass.
Expected: the `(a)`, `(d)` cases and the two concurrency isolation cases now
THROW with the NEXT:-prefixed rejection as designed, instead of resolving
`undefined`.

### Step 5: Re-run the full baseline to confirm no new regressions

**Verify**:
- `pnpm run typecheck` → exit 0
- `pnpm run test:res` → 416/416 passing
- `pnpm test` → total failures reduced from 20 → 14 (the 6 self-script /
  read-budget isolations fixed; the 14-failure accepted baseline preserved).
- `pnpm run build` → exit 0

## Test plan

- No new tests required; the 4 red integration tests are the regressionCase
  fixtures the plan restores to green.
- If the fix is correct, the parity suite `Guard_test.res` continues at 413/413
  and the 4 vitest integration cases go green. If `Guard_test.res` gains new
  failing cases (the count drops below 413) AFTER this fix, the helper has
  broken something — revert the Step 2 helper and investigate.
- A useful probe if Step 4 fails: write a one-liner
  `node -e "import('./dist/src/guard/Guard.res.mjs').then(m => console.log(m.isSelfScript({command: 'node -e \"console.log(1)\"'})))"`
  AFTER `pnpm run build`. If it prints `false`, the command extraction still
  isn't seeing the `"command"` value — go back to Step 2 and choose the STOP
  branch.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run res:build` exits 0 and regenerates `Guard.res.mjs`
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test:res -- src/guard/Guard_test.res.mjs` → 413/413 passing
      (threat matrix parity preserved)
- [ ] `pnpm run test:res` → 416/416
- [ ] `pnpm test -- test/integration/guard-before-wiring.test.ts test/integration/proportional-downgrade.test.ts test/integration/concurrency.test.ts` → all pass
- [ ] `pnpm test` → failures reduced from 20 → 14 (only the 14 accepted baseline remains)
- [ ] `pnpm run build` exits 0
- [ ] `grep -nE 'Obj\.magic' src/guard/Guard.res` returns NO matches (the cleanup
      goal is preserved)
- [ ] `grep -nE 'new RegExp\("[^"]+", "i"\)' src/guard/Guard.res.mjs` returns 4
      matches (the `i` flag is present in the compiled output for the 4
      case-insensitive regexes)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `@rescript/core` `RegExp` module has no flag-aware constructor AND you
  cannot find a documented way to set the `i` flag — STOP and report; do not
  hand-roll a regex string that drops the flag and ship a false positive.
- `JSON.classify(v)` returns something other than `JSON.String(s)` for the
  runtime `"command": "node -e ..."` strings the integration tests pass — STOP
  and attach the diff of `JSON.classify` output vs. raw runtime JS type. The
  fix may need a runtime `typeof v === "string"` guard via a small typed
  `%raw` helper, but that decision must be made with the executor's evidence
  in hand, not improvised.
- The `Guard_test.res` parity suite falls below 413 passing after the fix —
  STOP. The fix has broken parity and must not be merged.
- A different integration test goes red after Step 2 in a way that wasn't red
  at HEAD `9c744be` — STOP and report which test.

## Maintenance notes

- Future Guard work that adds a new dimension to the threat matrix (e.g.
  pwsh-based self-script) MUST go through `Guard_test.res` first (RED) and then
  the regex helper — never the other way around. The integration suite is the
  second line of defense; the parity suite is the contract.
- Reviewers should verify the 4 `i`-flag restorations precisely match the
  previous `%raw` semantics — case-insensitive on `_hasScriptExt`,
  `_hasRedirectScript`, `_hasInlineScript`, `_hasBashC`, and case-sensitive on
  the other two. A `grep '"i"' src/guard/Guard.res.mjs` showing 4 hits is a
  quick check.
- The `Obj.magic` → `JSON.classify` swap is the *sound* replacement the
  compiler-warning cleanup was aiming for. It should be the pattern used
  elsewhere in the codebase whenever a JSON value must be inspected at the
  runtime boundary; do NOT reintroduce `Obj.magic` to "match" a TS caller.
- A separate follow-up (Plan 024) addresses the ConfigMerge scalar-override
  regression introduced by the same two cleanup commits. The two plans are
  independent and may be executed in parallel on separate branches; they
  touch disjoint files (`Guard.res` vs `ConfigMerge.res`).