# Plan 028: Eliminate all 162 ReScript compiler warnings via mechanical migration to @rescript/core

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 0c3447f..HEAD -- src/escalate/Ladder.res src/escalate/Ladder.resi src/escalate/Ladder_test.res src/router/TierLadder_test.res`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `0c3447f`, 2026-08-03

## Why this matters

The repo currently emits **160 deprecation warnings + 2 unused-code warnings
= 162 total** on every `pnpm run res:build`. These are noise that obscures
real issues in CI output and code review. A prior attempt to clear them
(commits `2a4a4b2` + `9c744be`) introduced 6 behavioral regressions because
it also changed `%raw` regex literals, `Obj.magic` casts, and `Js.typeof`
semantic checks — none of which ARE deprecation warnings. Those commits were
reverted (`f86da65` + `eac39cf`).

This plan takes the narrow path: migrate ONLY the deprecated APIs to their
`@rescript/core` equivalents, which are type aliases or function renames
with identical runtime behavior. It does NOT touch `%raw`, `Obj.magic`, or
`Js.typeof` — those are separate concerns that require semantic analysis,
not mechanical migration.

## Current state

### The 160 deprecation warnings — categorised

Grep-verified at `0c3447f` via `pnpm run res:build 2>&1 | grep -oE
"deprecated: [A-Za-z._]+" | sort | uniq -c | sort -rn`:

| Deprecated API | @rescript/core replacement | Count | Runtime change |
|---|---|---|---|
| `Js.Nullable.return` | `Nullable.make` | 57 | None — both create `Value(x)` |
| `Js.Nullable.null` | `Nullable.null` | 38 | None — both create JS `null` |
| `Js.Nullable.toOption` | `Nullable.toOption` | 31 | None — both convert to `option<'a>` |
| `Js.Nullable.t` | `Nullable.t` | 20 | None — type alias identity |
| `Js.Json.stringifyAny` | `JSON.stringifyAny` | 8 | None — same function |
| `Js.Array2.joinWith` | `Array.joinWith` (ReScript 12 built-in) | 2 | None — verify signature matches |
| `Js.Nullable.isNullable` | `Nullable.isNullable` | 1 | None |
| `Js.Json.parseExn` | `JSON.parseExn` | 1 | None — same function |
| `Js.Exn.raiseError` | `failwith` (ReScript built-in) | 1 | Test-only; exception type changes from JS `Error` to `Failure` — acceptable in test helper |
| `Js.Dict.empty` | `Dict.make` | 1 | None — both return `{}` |

### The 2 unused-code warnings (non-deprecation)

| Warning | File:Line | Fix |
|---|---|---|
| Warning 32: unused value `defaultTierNames` | `src/escalate/Ladder.res:13` | Delete the value (or add `[@warning "-32"]` if it's a public API placeholder) |
| Warning 33: unused open `TierLadder` | `src/escalate/Ladder_test.res:2` | Delete the `open TierLadder` line |

### Files affected — all 4 are in the escalate/router area

| File | Deprecation count | Unused-code |
|---|---|---|
| `src/escalate/Ladder.res` | 50 | 1 (unused `defaultTierNames`) |
| `src/escalate/Ladder.resi` | 8 | 0 |
| `src/escalate/Ladder_test.res` | 100 | 1 (unused open) |
| `src/router/TierLadder_test.res` | 4 | 0 |
| **Total** | **162** | **2** |

### @rescript/core API surface (confirmed at v1.6.1)

All replacements are exported by `@rescript/core@1.6.1` (installed):

- `Nullable.t<'a>` — type alias of `Js.Nullable.t<'a>` (runtime-identical)
- `Nullable.make` — `external make: 'a => t<'a> = "#identity"` (zero-cost)
- `Nullable.null` — `external null: t<'a> = "#null"`
- `Nullable.toOption` — `external toOption: t<'a> => option<'a>`
- `Nullable.isNullable` — `external isNullable: t<'a> => bool`
- `JSON.stringifyAny` — `let stringifyAny: 'a => string`
- `JSON.parseExn` — `external parseExn: string => t`

For `Js.Array2.joinWith`: ReScript 12's built-in `Array` module provides
`joinWith`. Verify the exact signature by running `grep -rn "joinWith"
node_modules/rescript/lib/es6/array.js` or checking the ReScript docs.

For `Js.Exn.raiseError`: `@rescript/core` does NOT export a replacement.
Use `failwith(msg)` — the ReScript built-in that raises `Failure(msg)`.
This is in test code only (`TierLadder_test.res:70`), where the exact
exception type is irrelevant (the test just needs to throw on malformed
fixtures).

### Repo conventions to match

- `open Nullable` at the top of each `.res` file that uses `Nullable.*`
  extensively (check if `Ladder.res` already opens it; if not, add it).
- `open JSON` for `JSON.*` APIs — but ONLY if the file doesn't already
  use `JSON.t` (the `@rescript/core` module alias). If it uses `JSON.t`,
  the module is already visible.
- Match the existing `@setRuntimeSideEffects` annotation pattern if any
  function's side-effects need to be preserved (none expected for pure
  renames).

### Documented design constraints to honor

- `sdd/rescript-migration-phase4-5` byte-parity invariant: the compiled
  `.res.mjs` output must be functionally identical. For type-alias
  renames (`Js.Nullable.t` → `Nullable.t`), the compiled JS is literally
  identical (both compile to the same runtime representation).
- DO NOT change any runtime behavior. This is a rename, not a refactor.
- DO NOT touch `%raw`, `Obj.magic`, or `Js.typeof` sites — they are NOT
  deprecation warnings and require separate semantic analysis.

## Commands you will need

| Purpose              | Command                                                | Expected on success                                  |
|----------------------|--------------------------------------------------------|------------------------------------------------------|
| Install              | `pnpm install`                                         | exit 0                                               |
| ReScript build       | `pnpm run res:build`                                   | exit 0; **0 warnings** (down from 162)               |
| Typecheck            | `pnpm run typecheck`                                   | exit 0, no errors                                    |
| ReScript parity      | `pnpm run test:res`                                     | 416/416 passing (unchanged from baseline)            |
| Full vitest           | `pnpm test`                                             | 14 failed / 1571 passed (unchanged from baseline)    |
| Build                | `pnpm run build`                                        | exit 0                                               |
| Warning count audit   | `pnpm run res:build 2>&1 \| grep -c "deprecated:"`      | **0**                                                |

## Scope

**In scope** (the only files you should modify):
- `src/escalate/Ladder.res` — 50 deprecation + 1 unused-value warning
- `src/escalate/Ladder.resi` — 8 deprecation warnings (type aliases only)
- `src/escalate/Ladder_test.res` — 100 deprecation + 1 unused-open warning
- `src/router/TierLadder_test.res` — 4 deprecation warnings
- Regenerated `.res.mjs` files for each of the above (via `pnpm run res:build`)

**Out of scope** (do NOT touch, even though they look related):
- `src/config/ConfigMerge.res` — contains `Js.typeof` (NOT a deprecation
  warning; semantic site). Leave as-is.
- `src/guard/Guard.res` — contains `Obj.magic` casts and `%raw` regex
  literals (NOT deprecation warnings; semantic sites). Leave as-is.
- `src/guard/Guard_test.res` — contains `Obj.magic` casts (NOT deprecation
  warnings). Leave as-is.
- `src/reasoning/ReasoningMatch.res` — contains `%raw` regex (NOT a
  deprecation warning). Leave as-is.
- Any `.ts` file, `rescript-modules.d.ts`, or `rescript.json`.
- Any test file under `test/` (vitest layer).

## Git workflow

- Branch: `advisor/028-eliminate-rescript-warnings`
- **One commit per file** (4 commits) — if any file's migration introduces
  a regression, it can be individually reverted without affecting the
  others.
- Conventional commit style:
  - `refactor(escalate): migrate Ladder.res deprecation warnings to @rescript/core`
  - `refactor(escalate): migrate Ladder.resi type aliases to @rescript/core`
  - `refactor(escalate): migrate Ladder_test.res deprecation warnings to @rescript/core`
  - `refactor(router): migrate TierLadder_test.res deprecation warnings to @rescript/core`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Pre-flight — capture the baseline

Before any edit, confirm the current state is the 14-failure baseline and
162 warnings:

```sh
pnpm run res:build 2>&1 | grep -c "deprecated:"    # expect: 160
pnpm run res:build 2>&1 | grep -cE "Warning number (32|33)"  # expect: 2
pnpm run test:res 2>&1 | tail -3                    # expect: 416 passed, 0 failed
pnpm test 2>&1 | tail -5                            # expect: 14 failed | 1571 passed
```

Record the exact output for comparison after migration.

**Verify**: all four counts match expectations.

### Step 2: Migrate `src/escalate/Ladder.res` (50 deprecation + 1 unused)

Apply these renames mechanically (use search-and-replace, NOT manual
per-line editing):

| Find | Replace | Count |
|---|---|---|
| `Js.Nullable.return` | `Nullable.make` | ~13 |
| `Js.Nullable.null` | `Nullable.null` | ~16 |
| `Js.Nullable.toOption` | `Nullable.toOption` | ~7 |
| `Js.Nullable.isNullable` | `Nullable.isNullable` | 1 |
| `Js.Nullable.t` | `Nullable.t` | ~3 |

If `Ladder.res` doesn't already have `open Nullable` at the top, add it
after the existing `open` statements (or use the qualified `Nullable.*`
form if the file prefers qualified imports — match the existing style).

**Unused-value warning**: at `Ladder.res:13`, find `defaultTierNames`.
If it's truly unused (grep confirms no references), delete the `let`
binding. If it's referenced from `.resi`, keep it and add `[@warning
"-32"]` above the declaration.

**Verify**:
```sh
pnpm run res:build 2>&1 | grep "Ladder.res" | grep "deprecated:" | wc -l   # expect: 0
pnpm run res:build 2>&1 | grep "Ladder.res" | grep "Warning number 32" | wc -l  # expect: 0
pnpm run test:res 2>&1 | tail -3    # expect: 416 passed (no regressions)
```

Commit: `refactor(escalate): migrate Ladder.res deprecation warnings to @rescript/core`

### Step 3: Migrate `src/escalate/Ladder.resi` (8 deprecation)

The `.resi` file has only type-alias warnings:

| Find | Replace | Count |
|---|---|---|
| `Js.Nullable.t` | `Nullable.t` | ~8 |

These are pure type renames — no runtime impact, no behavioral change.

**Verify**:
```sh
pnpm run res:build 2>&1 | grep "Ladder.resi" | grep "deprecated:" | wc -l  # expect: 0
pnpm run test:res 2>&1 | tail -3    # expect: 416 passed
```

Commit: `refactor(escalate): migrate Ladder.resi type aliases to @rescript/core`

### Step 4: Migrate `src/escalate/Ladder_test.res` (100 deprecation + 1 unused)

Apply the same `Js.Nullable.*` → `Nullable.*` renames. This file has the
bulk of the warnings:

| Find | Replace | Count |
|---|---|---|
| `Js.Nullable.return` | `Nullable.make` | ~44 |
| `Js.Nullable.null` | `Nullable.null` | ~22 |
| `Js.Nullable.toOption` | `Nullable.toOption` | ~24 |
| `Js.Nullable.t` | `Nullable.t` | ~9 |
| `Js.Json.stringifyAny` | `JSON.stringifyAny` | ~8 |

**Unused-open warning**: at `Ladder_test.res:2`, find `open TierLadder`.
If no symbol from `TierLadder` is used unqualified, delete the line.
Verify by checking if any bare reference (e.g. `TierLadder.something`)
exists; if references exist, they're qualified and the open is truly
unused.

If `open Nullable` or `open JSON` isn't already present, add them.

**Verify**:
```sh
pnpm run res:build 2>&1 | grep "Ladder_test.res" | grep "deprecated:" | wc -l  # expect: 0
pnpm run res:build 2>&1 | grep "Ladder_test.res" | grep "Warning number 33" | wc -l  # expect: 0
pnpm run test:res 2>&1 | tail -3    # expect: 416 passed
pnpm run test:res -- src/escalate/Ladder_test.res.mjs 2>&1 | tail -3  # Ladder-specific parity
```

Commit: `refactor(escalate): migrate Ladder_test.res deprecation warnings to @rescript/core`

### Step 5: Migrate `src/router/TierLadder_test.res` (4 deprecation)

| Find | Replace | Count |
|---|---|---|
| `Js.Json.parseExn` | `JSON.parseExn` | 1 |
| `Js.Array2.joinWith` | `Array.joinWith` (verify ReScript 12 built-in) | 2 |
| `Js.Exn.raiseError(msg)` | `failwith(msg)` | 1 |

For `Js.Array2.joinWith`: verify the replacement by checking
`grep -rn "let joinWith" node_modules/rescript/lib/` or by writing a
one-liner test compile. If `Array.joinWith` doesn't exist in the ReScript
12 built-in, use `Belt.Array.joinWith` or `Js.Array2.joinWith` with a
`[@warning "-3"]` suppression annotation as a fallback.

For `Js.Exn.raiseError`: replace with `failwith(msg)` at line 70. The
test helper `makeCfg` raises this when JSON parsing fails — `failwith`
is idiomatic for test assertions and is not deprecated.

**Verify**:
```sh
pnpm run res:build 2>&1 | grep "TierLadder_test.res" | grep "deprecated:" | wc -l  # expect: 0
pnpm run test:res -- src/router/TierLadder_test.res.mjs 2>&1 | tail -3  # parity preserved
```

Commit: `refactor(router): migrate TierLadder_test.res deprecation warnings to @rescript/core`

### Step 6: Final warning audit and full baseline verification

After all 4 files are migrated and committed:

```sh
# Warning count — must be ZERO
pnpm run res:build 2>&1 | grep -c "deprecated:"           # expect: 0
pnpm run res:build 2>&1 | grep -cE "Warning number"        # expect: 0

# Parity — must be unchanged from baseline
pnpm run test:res 2>&1 | tail -3                           # expect: 416 passed, 0 failed
pnpm test 2>&1 | tail -5                                    # expect: 14 failed | 1571 passed

# Build / typecheck
pnpm run typecheck                                          # expect: exit 0
pnpm run build                                              # expect: exit 0
```

**Verify**: ALL of the above match expectations. Zero deprecation warnings.
Zero unused-code warnings. 416/416 rescript-test. 14/1571 vitest (the
accepted baseline).

## Test plan

- No new tests required; this is a mechanical rename.
- The existing `Ladder_test.res` (100 tests) and `TierLadder_test.res`
  (4 tests) are the parity authority — if the rename is correct, they
  continue to pass unchanged.
- The vitest baseline (14 failures) must not change — these are all in
  TS test files that don't import from the migrated ReScript modules
  directly (they import from the compiled `.res.mjs` which is runtime-
  identical for type-alias renames).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run res:build 2>&1 | grep -c "deprecated:"` → **0**
- [ ] `pnpm run res:build 2>&1 | grep -cE "Warning number"` → **0**
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test:res` → 416/416 passing (no regression from 416)
- [ ] `pnpm test` → 14 failed / 1571 passed (the accepted baseline, unchanged)
- [ ] `pnpm run build` exits 0
- [ ] `git diff --name-only` shows ONLY the 4 in-scope `.res`/`.resi` files
      (+ their regenerated `.res.mjs` outputs)
- [ ] No `%raw`, `Obj.magic`, or `Js.typeof` site is touched (verify:
      `git diff | grep -E '%raw|Obj\.magic|Js\.typeof'` returns empty)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The deprecated-API count in the baseline (Step 1) does not match the
  table in "Current state" — the codebase has drifted since this plan
  was written. Re-run the categorisation before proceeding.
- A `Nullable.*` or `JSON.*` replacement function does not exist in
  `@rescript/core@1.6.1` — STOP and report which function is missing.
  Do NOT invent a replacement or fall back to `Js.*` with a suppression
  annotation without reporting.
- `Array.joinWith` is not a ReScript 12 built-in — STOP and report.
  The fallback is `[@warning "-3"]` suppression on the specific line,
  but that decision should be made with evidence.
- `pnpm run test:res` drops below 416/416 after any file's migration —
  STOP. The rename has broken something (likely a `Nullable` API that
  compiles differently than expected). Revert that file's commit and
  report which test regressed.
- `pnpm test` increases beyond 14 failures — STOP. The rename has
  changed runtime behavior in a way that breaks the vitest layer.
  This should NOT happen for type-alias renames; if it does, it means
  `Nullable.make` / `Nullable.null` / `Nullable.toOption` have
  different runtime semantics than their `Js.Nullable.*` counterparts,
  which would be a @rescript/core bug worth reporting upstream.
- You discover a deprecation warning in a file NOT listed in "Files
  affected" — STOP and report. The plan's scope was verified at
  `0c3447f`; a warning in an unlisted file means either drift or a
  survey error.

## Maintenance notes

- After this plan lands, any new `Js.*` API usage should trigger a
  deprecation warning immediately (since the codebase will be clean).
  Do NOT suppress deprecation warnings with `[@warning "-3"]` for new
  code — migrate to `@rescript/core` instead.
- The 24 HIGH-risk sites (`Js.typeof` in ConfigMerge, `Obj.magic` in
  Guard, `%raw` regex literals in Guard + ReasoningMatch) are NOT
  addressed by this plan. They require semantic analysis and should
  be planned separately if the user wants to eliminate them.
- `@rescript/core@1.6.1` is the current version. If it upgrades, check
  the changelog for any API renames that affect `Nullable.*` or
  `JSON.*` — the migration may need a follow-up.
- This plan is INDEPENDENT of Plans 025 / 026 / 027 (Verify parity
  fixtures, Protocol ABI alias, README test docs). Any order is safe.