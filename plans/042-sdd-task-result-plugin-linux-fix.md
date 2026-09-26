# Plan 042: Rewrite the SDD task-result plugin — tolerant envelope, reformed latch, recovery evidence

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (repo: `opencode-smart-router`) — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: this plan edits files OUTSIDE any git repo
> (the machine-global OpenCode config dir). Verify the starting state by
> hash instead of a git SHA:
>
> `sha256sum /home/metalbolicx/.config/opencode/plugins/sdd-task-result-artifacts.ts`
> → must print `bfd291ff60c7d186d3e727327a9cc038a8ac4275128bcb8b406cb322858eb6f6`
>
> and `wc -c` → must print `5890`. If either differs, the file drifted since
> this plan was written — treat as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (this plugin is the transport gate for EVERY SDD subagent dispatch; a bug here blocks all SDD work — hence the extensive test gate below)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `0ea3822` (repo `opencode-smart-router`), 2026-08-31. The edited files live in `~/.config/opencode/`, outside that repo.
- **Issue**: (not published)

## Why this matters

Every SDD subagent dispatch on this machine can be destroyed by a
post-processing false positive: the installed OpenCode plugin
`sdd-task-result-artifacts.ts` validates the `<task>…</task>` transport
envelope with an end-anchored regex, so a perfectly valid completed result
that carries ANY text after the closing `</task>` (observed in the wild:
OpenCode's router appending `[router ⚠ NOT ACCEPTED] acceptance metadata`)
is classified `sdd_task_result_malformed`, the session permanently
latches, and hours of real, committed work get reported as "no valid task
result". This exact failure wedged Plan 041's WU-2 and re-occurred on
WU-3..8. After this plan: envelopes are found tolerantly wherever they sit
in the output, benign shapes (router suffixes, surrounding prose, code
fenced examples, non-completed states) are classified without permanent
damage, genuinely-bad envelopes get exactly one retry before latching, and
every failure persists a private raw-output artifact for diagnosis.

## Current state

Files (all under `/home/metalbolicx/.config/opencode/`):

- `plugins/sdd-task-result-artifacts.ts` (113 lines, 5890 bytes) — the
  plugin under replacement. SHA-256 `bfd291ff…` (see drift check).
- `tests/sdd-task-result-artifacts.test.ts` (124 lines) — the behavioral
  contract. **5 tests, currently 0/5 passing** against the installed
  plugin (verified 2026-08-31: `bun test` → "0 pass, 5 fail").

### Current plugin — the four defects

Defect 1 — anchored regex (line 3):

```ts
const TASK_RESULT = /^<task id="[^"\r\n]+" state="completed">\n<task_result>\n([\s\S]*?)\n<\/task_result>\n<\/task>$/
```

The trailing `$` requires `</task>` to be the final byte of the trimmed
output. Anything after it → no match.

Defect 2 — rejection without fence stripping (lines 21-24):

```ts
const envelope = TASK_RESULT.exec(trimmed)
if (!envelope) {
  if (TASK_TAG.test(trimmed)) throw Object.assign(new Error("SDD phase output contains a malformed task result envelope"), { sddClass: "malformed_result" })
  return
}
```

`TASK_TAG` scans raw output, so a code-fenced *example* of the envelope in
otherwise-valid prose is rejected; and output with NO envelope at all
silently passes (the `return` on line 24) — harsh on noise, lenient on
real damage.

Defect 3 — unconditional permanent latch (lines 105-107):

```ts
} catch (cause) {
  const failure = sddTaskFailure(subagent, cwd, cause, output.metadata)
  failedSDDSessions.set(input.sessionID, failure.sddFailure)
  throw failure
}
```

One `empty_result` OR `malformed_result` → session latched forever (until
restart). No retry, no user-message recovery.

Defect 4 — cwd ignorance + no evidence (lines 83-85, 45-67): `cwd` is
`worktree || directory` only (in real runs the repo path happens to be
there; in failure recovery the continuation can point at `/`), and no raw
output is ever persisted.

### Existing helpers to KEEP (unchanged semantics)

- `SDD_PHASES` list + `isSDDPhase()` (lines 5, 12-14)
- `shellQuote()` (lines 30-32)
- `taskRouteModel()` with `SDD_TASK_ROUTE_TOKEN` validation (lines 34-43)
- The `GENTLE_AI_SDD_FAILURE` envelope shape (lines 56-64): fields
  `schemaName: "gentle-ai.sdd-task-result-failure/v1"`, `status:
  "blocked"`, `code`, `phase`, optional `taskModel`, `summary`,
  `continuation: gentle-ai sdd-status --cwd '<cwd>' --json`.
- `sddDispatchLatched()` envelope (lines 69-81): code
  `sdd_task_dispatch_latched`, `latchedPhase`, `latchedCode`, `exit`.

### The behavioral contract (the 5 failing tests)

Read `/home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts`
in full before coding. Its non-obvious requirements:

1. **Test 1** — output `'<task id="child" state="completed">\n<task_result>\nready\n</task_result>\n</task>\n\n[router ⚠ NOT ACCEPTED] acceptance metadata'`
   must RESOLVE (no throw). → envelope extraction must be non-anchored.
2. **Test 2** — `tool.execute.before` must reject with a message
   containing `sdd_background_not_supported` when `args.background === true`
   OR `args.background === "true"` (string!), and resolve when absent.
3. **Test 3** — the test constructs the plugin with
   `client.session.get` returning `{ data: { directory: "/home/user/project" } }`
   and `directory: "/", worktree: ""`. A malformed result's continuation
   must contain `--cwd '/home/user/project'`. → **the failure-path cwd
   MUST be resolved via `await client.session.get(sessionID)` →
   `data.directory`**, falling back to `worktree || directory` on any
   error/non-string.
4. **Test 4** — a truncated envelope (`'<task id="child" state="completed">\n<task_result>\npartial'`)
   must throw a message containing `"rawResultArtifact":"<path>"`; the file
   at `<path>` must contain the raw output byte-for-byte and have mode
   `0o600`. Directory comes from `process.env.OPENCODE_SDD_FAILURE_DIR`.
5. **Test 5** — two burst failures must produce two DISTINCT artifact
   paths (no overwrite), contents preserved.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Run the contract tests | `bun test /home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts` | all pass (5 pre-existing + ~10 new) |
| Isolated acceptance repro | see Step 5 below | prints `ACCEPTED` |
| Hash the plugin | `sha256sum …/plugins/sdd-task-result-artifacts.ts` | records the new known-good digest |
| Plugin API check | `ls /home/metalbolicx/.config/opencode/node_modules/@opencode-ai/plugin` | package exists (types source of truth) |

`bun` is at `/home/metalbolicx/.bun/bin/bun` (v1.3.14) and runs TypeScript
natively. `node` v24.19.0 also available. No repo install/build involved.

## Scope

**In scope** (the only files you should modify):

- `/home/metalbolicx/.config/opencode/plugins/sdd-task-result-artifacts.ts` (full rewrite)
- `/home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts` (extend with new tests)
- `/home/metalbolicx/.config/opencode/plugin-tests/` (create dir; Step 0 backup lands here — nothing executable may live in `plugins/`)
- `/home/metalbolicx/.config/opencode/skills/_shared/sdd-phase-common.md` (append a 2-3 line transport-tag warning, Step 6)
- `/home/metalbolicx/.local/state/opencode/sdd-task-failures/` (runtime artifacts created by the new persistence)

**Out of scope** (do NOT touch):

- Any other plugin in `~/.config/opencode/plugins/` (engram.ts, rtk.ts, model-variants.ts, opencode-review-transport.ts, skill-registry.ts).
- `~/.config/opencode/opencode.json` and the `opencode.json.bak.*` files.
- The gentle-ai CLI / Homebrew installation.
- The wedged `sdd-attempt` ledger under
  `<repo>/.git/gentle-ai/sdd-runtime/` — a separate, known issue; this
  plan must not call `gentle-ai sdd-attempt` at all.
- Any file in the `opencode-smart-router` repository itself.

## Git workflow

None. These files live outside any git repository. Do NOT `git init` here —
that is Plan 043's job, and it must baseline the FINISHED state. Do not
commit anything anywhere for this plan.

## Steps

### Step 0: Back up the original plugin

```bash
mkdir -p /home/metalbolicx/.config/opencode/plugin-tests
cp /home/metalbolicx/.config/opencode/plugins/sdd-task-result-artifacts.ts \
   /home/metalbolicx/.config/opencode/plugin-tests/original-sdd-task-result-artifacts.bak.ts
```

This is the escape-hatch restore copy (the `plugin-tests/` dir is NOT
auto-discovered by OpenCode — only `plugins/` is — so a `.ts` file there is
inert; this exact hazard is documented in the Windows decision record).

**Verify**: `ls -la /home/metalbolicx/.config/opencode/plugin-tests/` → the
`.bak.ts` file exists.

### Step 1: Rewrite the plugin

Replace `plugins/sdd-task-result-artifacts.ts` with a new implementation
that keeps the existing helpers (see "Existing helpers to KEEP") and
changes the following behaviors. Target shape (~250-300 lines) — the
pattern to produce:

**Constants:**

```ts
const TASK_RESULT = /<task id="[^"\r\n]+" state="completed">\r?\n<task_result>\r?\n([\s\S]*?)\r?\n<\/task_result>\r?\n<\/task>/g
const TASK_TAG = /<\/?task(?:\s|>)|<\/?task_result>/
const NON_COMPLETED_TASK = /<task[^>]*\bstate="(?!completed")[^"]*"/
const CODE_FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
```

Note: `TASK_RESULT` loses its `^…$` anchors, gains `\r?\n` CRLF tolerance,
and gains the `g` flag (used with `matchAll` for counting). Reset `lastIndex`
(or construct a fresh regex) before each `matchAll` — a `g`-flagged regex
shared across calls is a classic statefulness bug.

**Classification function** `classify(output: unknown)` returning a
discriminated result, in this exact order:

1. `typeof output !== "string" || output.trim() === ""` → `{ kind: "empty" }`.
2. `const stripped = stripCodeFences(output)` (remove every ``` / ~~~ fenced
   block, including the fences themselves).
3. `const envelopes = [...stripped.matchAll(TASK_RESULT)]`.
4. Exactly 1 envelope → check its payload (fence-stripped):
   - payload trim empty → `{ kind: "empty" }` (keep current line-26 rule);
   - `TASK_TAG.test(payloadStripped)` → `{ kind: "malformed", reason: "nested" }`
     (keep current line-27 rule — fenced examples inside the payload are OK,
     real nested transport tags are not);
   - else → `{ kind: "ok" }`.
5. More than 1 envelope → `{ kind: "malformed", reason: "multiple" }` —
   an ambiguous transport, never silently pick one.
6. Zero envelopes:
   - `NON_COMPLETED_TASK.test(stripped)` → `{ kind: "interrupted" }` —
     a wrapper for a task that did not complete is a cancellation signal,
     not a protocol violation;
   - `TASK_TAG.test(stripped)` → `{ kind: "malformed", reason: "truncated" }`;
   - otherwise → `{ kind: "malformed", reason: "missing" }` — closes the
     current silent-pass hole (line 24): an SDD phase result with no
     envelope at all is a transport violation.

**Raw artifact persistence** `persistRawArtifact(output: string)`:

- Directory: `process.env.OPENCODE_SDD_FAILURE_DIR` if set, else
  `join(homedir(), ".local/state/opencode/sdd-task-failures")` (XDG state,
  Linux-appropriate).
- `mkdirSync(dir, { recursive: true })`; filename
  `${Date.now()}-${randomBytes(4).toString("hex")}.txt` (from `node:crypto`)
  — unique per failure, burst-safe by construction;
- `writeFileSync(file, output)` then `chmodSync(file, 0o600)`;
- wrap the whole thing in try/catch and return `undefined` on failure —
  an artifact write failure must NEVER mask or replace the classification
  error.
- Persist for `malformed` and `interrupted` classifications (non-empty
  outputs only). Skip for `empty` (nothing to persist).

**Sanitization** `sanitizeSnippet(text: string): string` — applied to any
output fragment embedded into an error message:

- Replace `/(bearer|token|api[_-]?key|password)\s*[:=]\s*\S+/gi` with
  `[REDACTED]`;
- Replace runs of 32+ chars from `[A-Za-z0-9+/=_-]` with `[REDACTED]`;
- Bound to the first 200 chars, append `…(truncated)` if cut.

**Session cwd resolution** — the plugin init already receives `{ client }`
(see the test's `pluginFor`); use it:

```ts
async function resolveSessionCwd(client: unknown, sessionID: string, fallback: string): Promise<string> {
  try {
    const info = await (client as any).session.get(sessionID)
    const dir = info?.data?.directory
    return typeof dir === "string" && dir !== "" ? dir : fallback
  } catch { return fallback }
}
```

(`fallback` = `worktree || directory`, the current rule.)

**Retry/latch state machine** — replace `failedSDDSessions: Map<string, SDDTaskFailure>`
with `Map<string, { latched?: SDDTaskFailure; malformedOnce?: boolean }>`:

- `empty` → latch immediately (existing semantic, preserved).
- `interrupted` → **never** mutate state (no latch, no retry-mark). Throw a
  `GENTLE_AI_SDD_FAILURE` envelope with code `sdd_task_interrupted` and a
  summary that says the task did not complete and may be re-dispatched.
- `malformed`, no `malformedOnce` yet → set `malformedOnce`, throw an
  envelope with code `sdd_task_result_malformed` whose `summary` explicitly
  permits exactly ONE re-dispatch of this phase (this is the "contract-pure
  retry").
- `malformed`, `malformedOnce` already set → upgrade to `latched`, throw
  the terminal malformed envelope (summary: retry exhausted, start a new
  session).
- `ok` → delete the session's state entry entirely (a success clears even
  a pending retry-mark).

**Hooks:**

- `tool.execute.before` (SDD phases only): FIRST reject background —
  `if (args.background === true || args.background === "true")` throw
  `new Error("sdd_background_not_supported: SDD phases must run in the foreground")`
  (test matches the substring) — BEFORE the latch check. Then: if
  `latched` → throw `sddDispatchLatched(...)` as today. A session with
  only `malformedOnce` must pass through (that dispatch IS the retry).
- `tool.execute.after` (SDD phases only): classify; on `ok` clear state and
  return; otherwise resolve cwd via `resolveSessionCwd(client,
  input.sessionID, fallback)`, persist raw artifact (when applicable),
  apply the state machine, and throw the envelope with an optional
  `rawResultArtifact: "<abs path>"` field added to the JSON.
- `chat.message`: `async (input) => { state.delete(input.sessionID) }` —
  any user message clears retry/latch state for that session (manual
  recovery without restart). This hook exists in the installed API —
  `~/.config/opencode/plugins/engram.ts:334` already uses
  `"chat.message": async (input, output) => {…}`; mirror that signature.
- Keep `dispose` and the `session.deleted` event cleanup (extend to the
  new state shape).

**Failure envelopes** — reuse `sddTaskFailure()` extended with: the
`interrupted` code path, an optional retry-permitting summary variant, and
the optional `rawResultArtifact` field. Do NOT change `schemaName`,
`status`, `continuation` format, or `sddDispatchLatched`'s field set —
orchestrator tooling parses them.

### Step 2: Verify the 5-test contract

**Verify**: `bun test /home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts`
→ 5 pass, 0 fail. If any of the five fails, fix the plugin (not the tests)
before proceeding.

### Step 3: Extend the test suite

Add to the SAME test file, following its existing style (`pluginFor`,
`afterEach` cleanup, `tmpdir` failure dirs). New cases:

1. Accepts envelope surrounded by prose BEFORE and AFTER the wrapper.
2. Accepts a CRLF envelope (`\r\n` line endings throughout).
3. Accepts when the payload contains a code-fenced example of `<task>` tags
   (fences stripped before the nested-tag scan → not "nested").
4. Rejects REAL nested transport tags in the payload (unfenced) with
   `sdd_task_result_malformed`.
5. Rejects TWO complete envelopes with `sdd_task_result_malformed`.
6. `state="running"` output → message contains `sdd_task_interrupted`, AND
   a subsequent `tool.execute.before` for the same session RESOLVES (no
   latch).
7. Empty output → `sdd_task_result_empty`, AND a subsequent `before`
   REJECTS with `sdd_task_dispatch_latched`.
8. Retry semantics: first malformed throws (envelope mentions the retry
   allowance), `before` still resolves; second malformed throws terminal;
   `before` now rejects latched.
9. A success after a first malformed clears state: `before` resolves.
10. `chat.message` clears a latched session: after latch, invoke
    `hooks["chat.message"]({ sessionID })`, then `before` resolves.
11. Sanitization: malformed output containing `Bearer abc123…` → the
    thrown message does NOT contain the token, contains `[REDACTED]`.
12. Malformed with NO real envelope and NO task tags (plain prose only) →
    `sdd_task_result_malformed` (the closed silent-pass hole).

**Verify**: `bun test …/tests/sdd-task-result-artifacts.test.ts` → all
pass (5 original + ≥12 new; expect ≥17 total, 0 fail).

### Step 4: Record the new known-good digest

```bash
sha256sum /home/metalbolicx/.config/opencode/plugins/sdd-task-result-artifacts.ts
```

Write the digest down — Plan 043 embeds it in the runbook and git tag.

**Verify**: command prints a sha256 (obviously different from `bfd291ff…`).

### Step 5: Restart OpenCode + isolated live smoke

Plugins load at OpenCode startup — the new code is inert until restart.
Ask the user to restart OpenCode (or do it if you run inside a
non-interactive context and the user pre-approved). Then run the
acceptance repro against the LIVE plugin file:

```bash
cd /home/metalbolicx/.config/opencode && bun -e '
import Plugin from "./plugins/sdd-task-result-artifacts.ts";
const hooks = await Plugin({ client: {}, directory: "/tmp", worktree: "" });
try {
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "parser-repro-2", args: { subagent_type: "sdd-apply" } },
    { output: `<task id="child" state="completed">\n<task_result>\nready\n</task_result>\n</task>\n\n[router ⚠ NOT ACCEPTED] acceptance metadata`, metadata: {} },
  );
  console.log("ACCEPTED");
} catch (error) { console.log("REJECTED:", error.message.slice(0, 120)); }'
```

**Verify**: prints `ACCEPTED`.

### Step 6: Documentation hardening

Append to `/home/metalbolicx/.config/opencode/skills/_shared/sdd-phase-common.md`
(Section D area) 2-3 lines:

> Transport tags are transport, never content: `<task …>`,
> `<task_result>`, `</task_result>`, `</task>` MUST NOT appear in an
> agent's final response payload. Fenced examples are tolerated by the
> validator but confuse older consumers — emit placeholder names instead.

**Verify**: `tail -5` of the file shows the warning.

## Test plan

Covered by Steps 2-3: the exact production false-positive (router suffix),
all classification branches (ok/empty/interrupted/malformed×3 reasons),
the latch state machine (latch-on-empty, retry-then-latch-on-malformed,
interrupted-never-latches), recovery paths (chat.message reset,
rawResultArtifact persistence + 0600 + burst uniqueness), background
rejection (bool + string), session-cwd continuation, CRLF, and secret
redaction. Structural pattern: the existing test file itself.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test /home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts` → 0 fail (≥17 pass)
- [ ] Step 5 repro prints `ACCEPTED` after restart
- [ ] `sha256sum` of the new plugin recorded in the final report
- [ ] `ls /home/metalbolicx/.config/opencode/plugin-tests/original-sdd-task-result-artifacts.bak.ts` exists
- [ ] `diff <(sha256sum < /home/metalbolicx/.config/opencode/plugin-tests/original-sdd-task-result-artifacts.bak.ts) <(echo "bfd291ff60c7d186d3e727327a9cc038a8ac4275128bcb8b406cb322858eb6f6  -")` → empty (backup is the pristine original)
- [ ] No file outside the In-scope list modified
- [ ] `plans/README.md` status row for 042 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Step-0 drift check hash is NOT `bfd291ff…` (file already changed).
- The `@opencode-ai/plugin` type definitions (in
  `~/.config/opencode/node_modules/@opencode-ai/plugin`) do not contain
  `tool.execute.before` / `tool.execute.after` / `chat.message` hooks —
  the API changed; report the actual hook names instead of guessing.
- Any test fails twice after a reasonable fix attempt.
- Passing the tests appears to require WEAKENING a classification (e.g.
  making "missing envelope" pass silently) — that contradicts the design;
  report instead.
- OpenCode fails to start after the plugin swap — restore the Step-0
  backup (`cp plugin-tests/original-sdd-task-result-artifacts.bak.ts
  plugins/sdd-task-result-artifacts.ts`), confirm startup, and report.
- The `sdd-envelope-debug.log` lesson applies: if a case you expect to be
  accepted is rejected, do NOT loosen the regex further — dump the actual
  bytes (write them to the failure artifact dir) and report. The Windows
  porting record documents this exact trap: the wrapper format was fine,
  the content was truncated.

## Maintenance notes

- `gentle-ai sync|upgrade|restore` can silently overwrite this file with
  the broken upstream generation — Plan 043 (git baseline + verifier +
  convergence runbook) exists solely to manage that; run the verifier
  after ANY gentle-ai operation.
- A reviewer should scrutinize: (1) the tolerance/strictness balance —
  tolerant of noise AROUND the envelope, strict about the envelope
  EXISTING and being singular; (2) that no raw output or secret material
  leaks into error strings (sanitizer coverage); (3) that the
  `g`-flagged regex never leaks `lastIndex` state across calls.
- Explicitly deferred: porting the Windows 40-test Node harness (the ~17
  local tests supersede it on this machine); the wedged `sdd-attempt`
  ledger (separate concern, handled by the established option-C bypass).
- The Windows decision record
  (`opencode-smart-router/sdd-artifacts-plugin-fix.md`) is the design
  provenance — consult it if intent is unclear.
