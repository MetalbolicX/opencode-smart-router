# Plan 044: Add a plugin-owned `fanout` tool for child-initiated lower-tier parallel delegation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 047215f..HEAD -- src/plugin/ src/router/ config/tiers/ test/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: direction
- **Planned at**: commit `047215f`, 2026-09-13

## Why this matters

Today only the root orchestrator can dispatch tier subagents. Medium/focused/heavy
subagents must do cheap exploration (greps, reads, lookups) with their own
expensive tokens. We want those children to offload lower-value work to cheaper
tiers **in parallel** — without ever creating a *physical grandchild* session.

Physical nesting is off the table: creating a session whose parent is a
subagent session historically hangs the OpenCode runtime permanently
(`src/plugin/hooks/tool-guards.ts:289-295`), and upstream OpenCode 1.18.30
foreground Task has no independent timeout — one hung nested Task blocks the
whole parent turn (upstream: `task.ts` `background.wait` without timeout;
issues anomalyco/opencode#13841, #23404 still open; timeout PRs #20103,
#43685 unmerged). The safe shape: the child is the **logical** caller of one
batch tool; the plugin creates workers as **siblings parented to the ROOT
session** and owns deadlines, cancellation, aggregation, and cleanup.

## Current state

Files and the exact patterns the executor must follow:

- `src/plugin/runtime.ts` — hook assembly. Custom tools are registered here
  via the SDK `tool()` helper. Existing exemplar (the `delegate` tool), lines
  87-111:

  ```ts
  tool: {
    ...(enableDelegateTool
      ? {
          delegate: tool({
            description: DELEGATE_DESCRIPTION,
            args: { task: tool.schema.string().describe("..."), /* ... */ },
            async execute(args: DelegateArgs, context: ToolContext): Promise<string> {
              return executeDelegate(ctx, args, context.sessionID, context.abort);
            },
          }),
        }
      : {}),
  },
  ```

  Note: `ToolContext` already provides `sessionID` and `abort` (an
  `AbortSignal`). Gating precedent: `enableDelegateTool` ships the tool only
  when an experimental flag/env gate is set — `fanout` follows the same
  pattern (config flag, default OFF).

- `src/plugin/delegate.ts` — worker-session lifecycle exemplar. Reuse these
  proven pieces verbatim in spirit:
  - create with root parenting + 30s timeout (`:281-295`):

    ```ts
    created = await withTimeout(
      ctx.plugin.client.session.create({
        ...(parentSessionID ? { body: { parentID: parentSessionID } } : {}),
        ...(signal ? { signal } : {}),
      }),
      30_000,
      "session.create",
      signal,
    );
    ```

    The comment at `:281-286` documents that `parentID` hides the session from
    the TUI list (`WHERE parent_session_id IS NULL` filter) — fanout workers
    MUST be created with `parentID = <root session id>`, never the caller's id.
  - registration of plugin-created sessions (`:334`):
    `ctx.sessionStore.registerProducerSession(producerSid, tier, activeCfg)` wrapped in try/catch (fail-soft, logs `delegate.register_failed`).
  - prompt with model + agent + 600s timeout (`:435-448`): `session.prompt({ path: { id }, body: { model, agent: tier, parts: [{ type: "text", text }] } })` via `withTimeout`, result text via `extractPromptText(res)`.
  - tier model resolution fail-fast (`:359-389`): `resolveTierModelGuard(activeCfg, tier)`; `!guard.ok` → structured failure, no prompt attempted.
  - cleanup (`:62-118` `cleanupProducerSession`): clears `changedFileStore`, `sessionStore.unregister`, `guardStore.clear`, then **conditional** `session.abort` with its own 10s `withTimeout` on non-success paths; `session.delete` is NEVER called; success sessions persist (see `:580-585` `attemptSucceeded = true` and `:652` `cleanupProducerSession(ctx, producerSid, !attemptSucceeded)`).
  - abort contract (`:128-146`): when the caller's `AbortSignal` fires, return `""` silently; check the signal at loop top, after create, and inside the prompt catch (`classifyPromptError` distinguishes `abort` / `non_retryable` / `retryable`).

- `src/router/sessions.ts` — session store. Depth/parent machinery already
  exists and is what makes the policy enforceable:
  - `registerFromSessionCreated({ sessionID, parentID })` (`:221-229`) records parentage from the `session.created` event.
  - `depth(sessionID)` (`:235-241`), `parentOf(sessionID)` (`:244-246`), `isDescendant()` (`:249-251`).
  - `registerProducerSession(sessionID, tier, cfg)` (`:203-213`) marks plugin-created worker sessions (`trivial: false` — always fully enforced).
  - `registerFromChatMessage(...)` (`:267-291`) marks Task-dispatched tier children and is the ONLY registration path a legitimate `fanout` caller can have.

- `src/plugin/hooks/tool-guards.ts` — the nested-delegation guards. They block
  ONLY `task` and `delegate` for descendants (`assertNestedDelegationAllowed`,
  `:70-82`) and `task` for subagents (`runSubagentGuard`, `:296-300`). A new
  `fanout` tool name passes both guards by design — **do not add `fanout` to
  these guards**; depth-1 tier children are descendants and must be allowed.
  `runSubagentGuard` also runs `guardBeforeCall` (`:302-326`) for every
  subagent tool call — Step 5 verifies `fanout` is not blocked there.

- `src/router/config.types.ts` — `RouterConfig` (`:275-294`). The config-block
  convention to mirror is `experimental?: { verifiedDelegateTool?: boolean }`
  (`:290`) plus a typed optional block like `reasoningPolicy?: ReasoningPolicyConfigV2` (`:293`).

- `src/router/config-validate.ts` (28.6K) — section validators; follow the
  existing per-section pattern. Test exemplar:
  `test/unit/config-validate-sections.test.ts`.

- `src/plugin/context.ts` — `PluginContext` (`:72-139`). Per-plugin stores are
  created in `createPluginContext` (`:155-229`) via factory functions
  (`createSessionStore()`, `createGuardStore()`, …). The new fanout state
  store follows the same factory pattern and is added as a `ctx` field.

- Test exemplars:
  - `test/unit/plugin-delegate.test.ts` (137K) — how to mock
    `ctx.plugin.client.session.{create,prompt,abort}` and the store surface;
    reuse its mock-building helpers/shape.
  - `test/integration/nested-delegation-guard.test.ts:77-180` — the depth-1 /
    depth-2 guard matrix; the fanout policy tests extend this file's approach.
  - `test/unit/sessions.test.ts` — session-store unit test style.

- **Verifier note (from plans/README.md, cycle 6)**: at recent baselines,
  `pnpm run typecheck` has a pre-existing TS2322 in
  `test/unit/ladder.test.ts:268` and 3 integration tests
  (`packaging.test.ts`, `ladder-wiring.test.ts`, `modeA-e2e.test.ts`) need
  `dist/` artifacts or a live runtime. Phrase done criteria as
  "**no NEW failures versus baseline**", not "exits 0". Capture the baseline
  first (`git stash` is NOT needed — just run the commands on the clean tree
  before editing and record failures).

## Commands you will need

| Purpose        | Command                                   | Expected on success        |
|----------------|-------------------------------------------|----------------------------|
| Install        | `pnpm install`                            | exit 0                     |
| Typecheck      | `pnpm run typecheck`                      | no NEW errors vs baseline  |
| Tests (TS)     | `pnpm test` / `pnpm test -- <filter>`     | no NEW failures vs baseline|
| Tests (RS)     | `pnpm run test:res`                       | no NEW failures vs baseline|
| Lint           | `pnpm run lint`                           | exit 0                     |
| Build          | `pnpm run build`                          | exit 0 (regenerates tiers.json via `build:tiers`) |
| Coverage gate  | `pnpm run test:gate`                      | thresholds hold (95%)      |

## Scope

**In scope** (the only files you should modify):

- `src/router/config.types.ts` — add `FanoutConfig` + `RouterConfig.fanout?`.
- `src/router/config-validate.ts` — validate the new block.
- `src/router/sessions.ts` — add caller-kind markers (`producers` set, fanout-worker set) and predicates.
- `src/plugin/fanout.ts` — NEW: `executeFanout` + `createFanoutStore` (or a separate `fanout-store.ts` if the file exceeds ~400 lines).
- `src/plugin/context.ts` — add `fanoutStore` to `PluginContext` + factory wiring.
- `src/plugin/runtime.ts` — register the `fanout` tool behind the config gate.
- `src/plugin/types.ts` — add `FanoutArgs` / worker outcome types (follow `DelegateArgs` precedent).
- `config/tiers/presets.json` — add fanout usage guidance to medium/focused/heavy tier prompts and an explicit "you cannot fan out" line to fast/light prompts; regenerate `tiers.json` with `pnpm run build:tiers`.
- `test/unit/plugin-fanout.test.ts` — NEW.
- `test/unit/sessions.test.ts` — extend for the new markers.
- `test/unit/config-validate-sections.test.ts` — extend for the fanout block.
- `test/integration/nested-delegation-guard.test.ts` — extend with fanout policy cases.
- `README.md`, `docs/CONFIG_REFERENCE.md` — document the tool + config block.

**Out of scope** (do NOT touch, even though they look related):

- `src/plugin/hooks/tool-guards.ts` — the `task`/`delegate` descendant blocks
  MUST stay exactly as they are. Native nesting remains forbidden.
- `src/plugin/delegate.ts` — reuse its patterns, do not refactor it.
- `src/verify/*` — fanout workers get NO independent DoD/grader verification
  in this phase; the calling tier synthesizes and is responsible for the
  results. (Recorded as accepted limitation.)
- Reasoning-patch machinery (`src/reasoning/*`, `applyReasoningPatch`) —
  fanout workers run with the tier's static agent def; no per-attempt
  reasoning patching in this phase.
- Any process-isolation / worker-process backend — that is a separate future
  plan (the escalation path if in-process containment proves insufficient).
- OpenCode runtime config (`subagent_depth`, env flags) — never set them.

## Git workflow

- Branch: `advisor/044-tier-fanout-tool`.
- Conventional commits, one per step, e.g.
  `feat(config): add fanout policy block with validation`.
- Do NOT push or open a PR unless the operator instructed it.

## Design summary (the contract to implement)

**Policy matrix** (hard-coded in `fanout.ts`, keyed by CALLER tier):

| Caller tier | Allowed worker tiers |
|-------------|----------------------|
| `medium`    | `fast`               |
| `focused`   | `fast`, `light`, `medium` |
| `heavy`     | `fast`, `light`, `medium` |
| `fast`, `light` | (none — rejected) |

**Caller eligibility** (ALL must hold, else typed rejection before any session
is created):

1. `ctx.sessionStore.depth(callerSid) === 1` (a direct child of root).
2. `getTier(callerSid)` ∈ {medium, focused, heavy}.
3. Caller is NOT a delegate producer, NOT a grader session
   (`ctx.graderSessions`), NOT itself a fanout worker.
4. `cfg.fanout.enabled === true`.
5. Circuit breaker is closed.

**Worker execution**: for each requested `{tier, prompt}`: validate tier edge →
check caps → `session.create({ body: { parentID: rootSid } })` where
`rootSid = ctx.sessionStore.parentOf(callerSid)` →
`registerProducerSession(workerSid, workerTier, cfg)` + mark as fanout worker →
`session.prompt` with the tier's model/agent, raced against the per-worker
deadline → collect text → cleanup with the delegate semantics (abort with 10s
timeout on non-success; never delete; success persists).

**Aggregation**: `Promise.allSettled` across workers, plus a batch-level
deadline. Every worker yields a typed outcome:
`completed | failed | timed_out | cancelled | rejected`. Return ONE markdown
aggregate: one `## [n] tier=<t> status=<s>` section per worker with its text
or typed error. A batch-level deadline expiry aborts outstanding workers and
returns partial results.

**Cancellation**: if `context.abort` fires, abort all outstanding workers
(each with the 10s abort timeout), return `""` silently (delegate precedent).

**Config block** (all optional; shown with defaults):

```jsonc
{
  "fanout": {
    "enabled": false,                 // kill switch; default OFF
    "maxWorkersPerBatch": 4,
    "maxConcurrentGlobal": 6,
    "maxConcurrentPerTier": { "fast": 4, "light": 2, "medium": 1 },
    "workerTimeoutMs": 120000,
    "batchTimeoutMs": 180000,         // must be >= workerTimeoutMs
    "breaker": { "failureThreshold": 3, "cooldownMs": 60000 }
  }
}
```

**Circuit breaker**: after `failureThreshold` consecutive batch outcomes
containing a `timed_out` worker or a failed abort, open for `cooldownMs`;
while open, reject with typed `circuit_open`. Half-open after cooldown (one
probe batch allowed).

## Steps

### Step 0: Capture the verification baseline

Run `pnpm install && pnpm run typecheck && pnpm test 2>&1 | tail -30 && pnpm run lint`.
Record the pre-existing failures. Every later gate compares against this list.

**Verify**: baseline failure list written to `/tmp/opencode/044-baseline.txt`.

### Step 1: Config types + validation

Add `FanoutConfig` to `src/router/config.types.ts` and `fanout?: FanoutConfig`
on `RouterConfig` (mirror the `reasoningPolicy?` optional-block convention).
Add a `validateFanout` section validator to `src/router/config-validate.ts`
following the existing per-section pattern: reject non-positive numbers,
`batchTimeoutMs < workerTimeoutMs`, unknown tier keys in
`maxConcurrentPerTier`. Defaults live in ONE exported constant
(`DEFAULT_FANOUT_CONFIG`) in `config.types.ts` or the validator module —
match where sibling defaults live.

**Verify**: `pnpm test -- config-validate-sections` → new cases pass; no NEW failures vs baseline.

### Step 2: Session-store caller-kind markers

In `src/router/sessions.ts`: add two sets to the store closure — `producers`
(populated by `registerProducerSession`) and `fanoutWorkers` (populated by a
new `markFanoutWorker(sessionID)`), plus predicates `isProducerSession(id)`
and `isFanoutWorker(id)`. `unregister` must delete from both new sets.
Do not change any existing method's signature or behavior.

**Verify**: `pnpm test -- sessions` → existing tests pass + new marker tests pass.

### Step 3: Fanout store (concurrency + breaker)

New factory `createFanoutStore()` (in `src/plugin/fanout.ts` or
`fanout-store.ts`): tracks `activeByTier: Map<string, number>`,
`activeGlobal: number`, and breaker state (`consecutiveFailures`,
`openedAt`). Methods: `tryAcquire(tier, cfg): boolean`,
`release(tier)`, `recordOutcome(kind)`, `breakerState(): "closed" | "open" | "half_open"`.
Wire into `PluginContext` as `fanoutStore` in `src/plugin/context.ts`
(factory call in `createPluginContext`).

**Verify**: `pnpm run typecheck` → no NEW errors; `pnpm test -- plugin-context` passes.

### Step 4: `executeFanout` + tool registration

New `src/plugin/fanout.ts` exporting
`executeFanout(ctx, args: FanoutArgs, callerSid: string, signal?: AbortSignal): Promise<string>`
implementing the Design summary contract exactly. `FanoutArgs` in
`src/plugin/types.ts`:

```ts
interface FanoutArgs { items: Array<{ tier: string; prompt: string }>; }
```

Register in `src/plugin/runtime.ts` next to `delegate`, gated on
`cfg.fanout?.enabled === true` read from `ctx.initialConfig` (load-time gate
like `enableDelegateTool`; the runtime `enabled` check inside
`executeFanout` re-reads fresh config so the kill switch works without
restart). Tool description must state: allowed caller tiers, the policy
matrix, that workers run in parallel, and that fast/light cannot call it.

Aggregate result format:

```markdown
## [1] tier=fast status=completed
<worker text>

## [2] tier=fast status=timed_out
(worker exceeded 120000ms; abort attempted)
```

**Verify**: `pnpm test -- plugin-fanout` → unit tests pass (mocked client, following `test/unit/plugin-delegate.test.ts` mock style).

### Step 5: Guard-interaction verification

Confirm `runSubagentGuard`'s `guardBeforeCall` does NOT block a tool named
`fanout` for subagent sessions. Read `src/guard/enforce.ts` and its policy
presets first. If `fanout` is blocked, add the minimal whitelist entry for
the `fanout` tool name in the guard policy for medium/focused/heavy tiers —
and STOP if that requires changing enforcement semantics (report instead).

Extend `test/integration/nested-delegation-guard.test.ts` with the fanout
policy matrix: depth-1 medium caller → allowed; fast/light caller → rejected;
fanout worker caller → rejected; delegate producer caller → rejected;
grader session → rejected; depth-0 (orchestrator) → rejected (fanout is
child-only; the orchestrator already has `task`/`delegate`). Assert the
existing `task`/`delegate` descendant blocks are unchanged (existing tests
stay green).

**Verify**: `pnpm test -- nested-delegation-guard` → all pass.

### Step 6: Tier prompts

Edit `config/tiers/presets.json` (source of truth — NOT `tiers.json`, which
is generated): add to medium/focused/heavy prompts a short fanout usage
block (when to use, the matrix, batch-call example); add to fast/light
prompts "You cannot fan out; do not call the fanout tool." Regenerate:
`pnpm run build:tiers` and confirm `tiers.json` changed.

**Verify**: `pnpm run build` → exit 0; `git status` shows `tiers.json` regenerated.

### Step 7: Docs

README.md: new short section "Child-initiated fan-out (`fanout` tool)" —
what it is, the policy matrix, config block, and the explicit limitation
"bounded response, not guaranteed worker termination; native nesting stays
blocked". `docs/CONFIG_REFERENCE.md`: the `fanout` block reference.

**Verify**: `pnpm run lint` → exit 0.

## Test plan

New file `test/unit/plugin-fanout.test.ts` (model after
`test/unit/plugin-delegate.test.ts` mock patterns), covering:

- Policy matrix: every allowed edge passes validation; every denied edge
  (fast→anything, light→anything, medium→light, medium→medium, focused→heavy,
  heavy→heavy) is rejected BEFORE `session.create` is called (assert mock
  call count 0).
- Caller eligibility: each of the 5 eligibility rules rejects independently.
- **No-grandchild invariant**: for any accepted batch, every
  `session.create` mock call has `body.parentID === <root sid>` and NEVER
  the caller's sid.
- Parallelism: two workers with controllable deferred prompts overlap in
  time (assert both prompts were issued before either resolved).
- Timeout: one worker's prompt never resolves → aggregate returns by
  `batchTimeoutMs` (use fake timers), outcome `timed_out`, `session.abort`
  called for that worker, the completed sibling's text preserved.
- Cancellation: signal fires mid-batch → all outstanding workers aborted,
  return value is `""`.
- Caps: `maxWorkersPerBatch`, per-tier cap, and global cap each reject with
  typed `rejected` outcome.
- Breaker: `failureThreshold` consecutive timeout outcomes →
  `circuit_open` rejection; after `cooldownMs` (fake timers) a probe batch
  is allowed.
- Cleanup: on success no abort is called and the session persists; on
  failure abort is called with a 10s bounded wait; `session.delete` is
  NEVER called (assert mock).
- Kill switch: `enabled: false` in fresh config → typed rejection without
  touching the SDK.

Extend: `test/unit/sessions.test.ts` (markers), `test/unit/config-validate-sections.test.ts` (fanout block), `test/integration/nested-delegation-guard.test.ts` (Step 5 matrix).

**Verification**: `pnpm test` → no NEW failures vs Step-0 baseline; all new
tests pass. `pnpm run test:gate` → coverage thresholds hold.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` — no NEW errors vs baseline
- [ ] `pnpm test` — no NEW failures vs baseline; `test/unit/plugin-fanout.test.ts` exists with all cases above passing
- [ ] `pnpm run test:res` — no NEW failures vs baseline
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run build` exits 0 and `tiers.json` regenerated from `config/tiers/presets.json`
- [ ] `rtk grep -n '"fanout"' src/plugin/hooks/tool-guards.ts` returns NO matches (fanout was NOT added to the native guards)
- [ ] `rtk grep -n 'session.delete' src/plugin/fanout.ts` returns NO matches
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (drift).
- A smoke/manual probe shows a plugin custom tool is NOT invocable from a
  depth-1 subagent session at runtime (the entire delivery mechanism is then
  invalid — report before writing more code; the `delegate` descendant-guard
  at `tool-guards.ts:75` strongly implies it IS invocable, but this was never
  runtime-proven for a custom tool from a tier child).
- `session.create` with `parentID = <root sid>` executed while a tier child
  is mid-flight fails or hangs at runtime (the core safety assumption).
- `ToolContext` in the pinned `@opencode-ai/plugin@1.18.30` lacks `sessionID`
  or `abort` (contradicts `runtime.ts:105-106` — would mean drift).
- Whitelisting `fanout` in the guard policy (Step 5) requires changing
  enforcement semantics rather than adding a tool-name entry.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Accepted limitation (documented in README)**: in-process workers can only
  guarantee a *bounded response*; a stuck SDK call may linger after the
  router returns its timeout result. The process-isolation backend
  (killable worker processes) is the deferred follow-up plan if production
  telemetry shows unreconciled-worker growth.
- Future interaction: if per-worker reasoning patches are ever wanted, they
  must reuse `acquireTierOwner`/baseline-restore from `delegate.ts` — never
  patch the shared agent def without ownership.
- Reviewers should scrutinize: (1) the no-grandchild invariant in
  `executeFanout` (every create uses the ROOT id), (2) that
  `assertNestedDelegationAllowed` / `runSubagentGuard` were not weakened,
  (3) cleanup paths never call `session.delete`, (4) breaker state is
  per-plugin-instance, not module-global.
- The tier-prompt guidance (Step 6) is load-bearing: without it, tier models
  will not discover the tool. If prompts change shape, regenerate
  `tiers.json` and re-run the ladder-wiring integration test.
