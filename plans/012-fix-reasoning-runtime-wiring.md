# Plan 012: Make manual reasoning overrides actually patch task dispatch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 0400624..HEAD -- src/plugin/hooks.ts src/router/commands.ts src/reasoning/policy.ts test/unit/plugin-hooks.test.ts test/integration/layer2-wiring.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/011-restore-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `0400624`, 2026-07-01

## Why this matters

The adaptive-reasoning feature (plan 010, 26 tasks, 3 chained PRs, fully
archived) shipped a complete stack: capability model, translation layer,
session override store, `/reasoning` command, policy resolver, and a paired
patch/restore in the before/after hooks. Every layer works in isolation and
has unit tests.

But the single hook that connects the override to the live `task` dispatch is
**unreachable dead code**. An operator who sets `reasoningPolicy.mode:
"manual"` and runs `/reasoning elevated` gets a success message and zero
runtime effect — the next task dispatch runs with the original tier baseline.

This is the highest-impact product defect in the current audit because the
feature appears fully shipped but is silently inert at runtime.

## Current state

### The dead-code proof

`src/plugin/hooks.ts:88-177` — `handleToolExecuteBefore` has this structure:

```
Line 93:  if (ctx.state.bypassed) return;

Line 96:  if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof tool !== "string") {
Line 97:    return;              ← non-subagent sessions exit here
          }

Line 106: if (tool === "task") {
Line 107:   throw new Error("Nested subagent delegation is not allowed...");
          }

Line 130: if (tool === "task" && ctx.opencodeConfig?.agent) {
Line 144:   applyReasoningPatch(agentDef, resolved);     ← NEVER REACHED
          }
```

To reach line 130, execution must:
1. Pass line 96 → requires `isSubagent(sid) === true`
2. Not throw at line 106 → requires `tool !== "task"`
3. Match line 130 → requires `tool === "task"`

Conditions 2 and 3 are **logically contradictory**. There is no execution path
to the reasoning patch.

### Why it is placed wrong

The orchestrator (which calls `task` to dispatch subagents) is NOT a subagent
session — `isSubagent(orchestratorSid)` is false, so the function early-returns
at line 96. The reasoning patch was meant to execute for orchestrator sessions
calling `task`, but it was placed inside the subagent-only path, below a throw
guard that blocks the exact tool it needs.

### Git evidence

- Lines 99-110 (the throw guard): added in commit `1819fd5` ("fix(plugin):
  block nested built-in task delegation from subagents").
- Lines 111-177 (the reasoning patch): added AFTER in commit `22f00e2`
  ("feat(reasoning): wire store + /reasoning command + runtime patch/restore
  around task"). The reasoning wiring landed below the guard it can never
  bypass.

### The paired restore in the after-hook (NOT broken)

`src/plugin/hooks.ts:230-252` — `handleToolExecuteAfter` restores the baseline:
```ts
if (tool === "task" && ctx.opencodeConfig?.agent) {
  const subagentType = (input?.args ...)?.subagent_type ...;
  const agentDef = subagentType ? ctx.opencodeConfig.agent[subagentType] : undefined;
  if (subagentType && agentDef) {
    const baseline = ctx.reasoningStore.getBaseline(subagentType);
    if (baseline) {
      restoreAgentBaseline(agentDef, baseline);
    }
  }
}
```

This restore block IS reachable — the after-hook has no `isSubagent` early
return before this block. But since the before-hook patch never fires, the
restore currently calls `getBaseline` and either gets the pre-captured
baseline (harmless — restores to the same state) or gets `null` (no-op).
Once this plan fixes the before-hook, the restore will actually have a
patched state to revert.

### The policy resolver (NOT broken, confirms manual mode works)

`src/reasoning/policy.ts:48-64`:
```ts
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride?: ReasoningLevel,
): ResolvedReasoning => {
  const mode = policy?.mode ?? "static";
  if (mode !== "manual") return null;   // static + adaptive → null

  const level = sessionOverride ?? policy?.defaultLevel;
  if (!level) return null;

  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
};
```

When `mode === "manual"` and a session override exists, this returns a real
`ResolvedReasoning` patch. The bug is that `handleToolExecuteBefore` never
calls it for orchestrator `task` calls.

### The `/reasoning` command (NOT broken, stores the override)

`src/router/commands.ts:293-302`:
```ts
if (policyMode === "static") {
  return [ ... "the override will NOT be applied at task dispatch." ... ].join("\n");
}
if (sessionID) ctx.reasoningStore.setOverride(sessionID, arg as ReasoningLevel);
```

The override is stored correctly. In `static` mode it warns the user. In
`manual` mode it stores the override and reports per-tier behavior. The
command works; the runtime wiring does not.

### Existing test coverage for the nested-task guard

`test/unit/plugin-hooks.test.ts:474-548` — five tests that lock the
nested-task invariant:
- "allows the built-in task tool for non-subagent (root/orchestrator) sessions"
- "allows non-task tools for subagent sessions"
- "blocks the built-in task tool for subagent sessions with the deterministic error"
- "throws the exact error message specified in plan 008"
- "guard depends only on isSubagent(sid) && tool === 'task'"

These tests MUST still pass after this plan's changes.

### Repo conventions to match

- Hook logic is best-effort around errors: `try { ... } catch { log.warn(...) }`
  rather than crashing real sessions. See the existing catch at lines 169-176.
- Tests use Vitest `describe/it` with a `makeHarness()` helper that builds a
  fake `PluginContext`. Mirror the existing harness in
  `test/unit/plugin-hooks.test.ts`.
- Conventional commits: `fix(reasoning): ...`, `test(reasoning): ...`.

### Documented design constraints to honor

- ADR 0001 (`docs/adr/0001-hard-block-guard.md:15-18`) — the nested-task guard
  exists because "creating child sessions under a subagent session hangs the
  opencode runtime permanently." The guard depends ONLY on
  `isSubagent(sid) && tool === "task"` — no parent/depth metadata.
- The exact error string is load-bearing:
  `"Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool"`
  — five tests assert it verbatim. Do NOT change this string.
- Plan 010 design: `static` mode is the primary regression guard. It must
  remain a hard no-op regardless of any session override. See
  `src/reasoning/policy.ts:53-57`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0 |
| Lint | `pnpm run lint` | exit 0 |
| Hook unit tests | `pnpm test -- test/unit/plugin-hooks.test.ts` | all pass |
| Reasoning tests | `pnpm test -- test/unit/reasoning-policy.test.ts test/unit/reasoning-translate.test.ts test/unit/reasoning-capability.test.ts test/unit/router-agents.test.ts` | all pass |
| Integration test | `pnpm test -- test/integration/reasoning-runtime.test.ts` | all pass |
| Full tests | `pnpm test` | exit 0 |
| Build | `pnpm run build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/plugin/hooks.ts`
- `test/unit/plugin-hooks.test.ts`
- `test/integration/reasoning-runtime.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/reasoning/policy.ts` — policy semantics are correct.
- `src/reasoning/translate.ts` — translation layer is correct.
- `src/reasoning/capability.ts` — capability inference is correct.
- `src/reasoning/store.ts` — store implementation is correct.
- `src/router/commands.ts` — `/reasoning` command is correct.
- `src/router/agents.ts` — `applyReasoningPatch` and `restoreAgentBaseline`
  helpers are correct.
- The nested-task error message string.
- CI/workflow files.

## Git workflow

- Branch: `advisor/012-fix-reasoning-runtime-wiring`
- Commit per logical unit; use conventional commits.
- Suggested commits:
  - `fix(reasoning): restructure before-hook so orchestrator task calls reach the patch`
  - `test(reasoning): cover patch application and restore for manual overrides`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Restructure `handleToolExecuteBefore` to make the reasoning patch reachable

The current function flow is:

```
bypassed → return
extract sid, tool
if (!isSubagent(sid)) return          ← orchestrator exits here
if (tool === "task") throw            ← subagent+task throws
... reasoning patch (DEAD) ...
guardBeforeCall                       ← subagent non-task
```

The target flow after this step:

```
bypassed → return
extract sid, tool

// --- Reasoning patch: orchestrator task calls only ---
if (sid && tool === "task" && !ctx.sessionStore.isSubagent(sid)) {
  try {
    // existing reasoning patch logic (lines 130-177)
    // reads subagent_type from output.args
    // resolves override via resolveReasoningOverride
    // applies patch via applyReasoningPatch
  } catch { log.warn(...) }
  return;  // orchestrator task calls do not need guard evaluation
}

// --- Guard path: subagent sessions only ---
if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof tool !== "string") {
  return;
}
if (tool === "task") {
  throw new Error("Nested subagent delegation is not allowed: ...");
}
// ... existing guardBeforeCall logic (lines 179+) ...
```

Key invariants the restructure must preserve:

1. **Nested-task guard unchanged**: subagent + `task` still throws the exact
   same error. The guard's position moves but its condition and message do not.
2. **Orchestrator non-task calls still early-return**: the guard path was
   never meant for orchestrator sessions; it still isn't.
3. **Orchestrator task calls now reach the patch**: this is the fix.
4. **Patch failures are best-effort**: a reasoning patch failure must never
   block the task. Keep the existing `try/catch` with `log.warn`.
5. **Static mode is still a no-op**: `resolveReasoningOverride` returns `null`
   for static mode; the patch block's `if (resolved)` guard handles that.

Move the reasoning patch block (currently lines 130-177) to BEFORE the
`isSubagent` early-return at line 96, gated by
`!ctx.sessionStore.isSubagent(sid)` instead of being trapped inside the
subagent path. Then keep the nested-task throw and `guardBeforeCall` in their
existing positions for subagent sessions.

After the move, add a `return;` at the end of the orchestrator-task-patch
block so orchestrator task calls do not fall through into the guard path.

**Verify**: `pnpm test -- test/unit/plugin-hooks.test.ts` → all existing
tests pass, including the five nested-task guard tests at lines 474-548

### Step 2: Add unit tests for the reachable patch path

Extend `test/unit/plugin-hooks.test.ts` with a new `describe` block that
covers the previously-dead reasoning patch path. Use the existing
`makeHarness()` helper and mirror its style.

Cases to cover:

1. **Manual mode + override + orchestrator task → patch applied**: set
   `reasoningPolicy.mode` to `"manual"`, set a session override via
   `ctx.reasoningStore.setOverride(sid, "elevated")`, call
   `handleToolExecuteBefore` with a non-subagent session and `tool: "task"`,
   assert the target agent def was patched (check `variant` or `options`
   changed from baseline).

2. **Static mode + override + orchestrator task → no-op**: same setup but
   `mode: "static"`. Assert the agent def is unchanged after the hook call.

3. **Manual mode + no override + no default → no-op**: `mode: "manual"` but
   no override set and no `defaultLevel`. Assert no patch applied.

4. **After-hook restore**: call `handleToolExecuteAfter` for a task call
   after a patch was applied. Assert the agent def returned to its baseline
   via `restoreAgentBaseline`.

5. **Patch failure is best-effort**: mock `resolveReasoningOverride` or
   `applyReasoningPatch` to throw. Assert the hook does not throw and logs
   a warning instead.

The harness in `plugin-hooks.test.ts` already provides `ctx.opencodeConfig`
and `ctx.reasoningStore`. Check how `makeHarness()` initializes these and
extend if needed to support a `reasoningPolicy` config and tier capabilities.

**Verify**: `pnpm test -- test/unit/plugin-hooks.test.ts test/unit/reasoning-policy.test.ts test/unit/router-agents.test.ts` → all pass

### Step 3: Add one integration test for the operator-visible flow

Create `test/integration/reasoning-runtime.test.ts` that exercises the real
plugin assembly path:

1. Create a temp directory with a config where
   `reasoningPolicy: { mode: "manual" }` and at least one tier has a
   `capability` declaration.
2. Assemble the plugin hooks via `ModelRouterPlugin(ctx)`.
3. Simulate the `/reasoning` command to set an override for the orchestrator
   session.
4. Call the `tool.execute.before` hook with the orchestrator session ID and
   `tool: "task"` + `args: { subagent_type: "<tier>" }`.
5. Assert the agent definition in `ctx.opencodeConfig.agent["<tier>"]` was
   mutated (variant/options changed from the registered baseline).
6. Call the `tool.execute.after` hook.
7. Assert the agent definition was restored to its baseline.

Model the integration assembly after `test/integration/layer2-wiring.test.ts`
(its `makeCtx` helper and `ModelRouterPlugin` invocation pattern). Remember
to pass a `ToolContext` as the second argument to any `.execute()` call
(this was fixed in Plan 011).

**Verify**: `pnpm test -- test/integration/reasoning-runtime.test.ts` → all pass

### Step 4: Re-run the full baseline

This plan depends on Plan 011. The full suite must be green.

**Verify**:
- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm test` → exit 0
- `pnpm run build` → exit 0

## Test plan

- **Extend** `test/unit/plugin-hooks.test.ts`: add a `describe` block for the
  reasoning patch path covering cases 1-5 listed in Step 2.
- **Create** `test/integration/reasoning-runtime.test.ts`: one end-to-end test
  covering the operator-visible flow (set override → dispatch task → verify
  patch → verify restore).
- **Structural patterns**:
  - `test/unit/plugin-hooks.test.ts:474-548` — the nested-task guard tests,
    which show how to set up `makeHarness()`, configure `isSubagent`, and
    call `handleToolExecuteBefore`.
  - `test/integration/layer2-wiring.test.ts:172-183` — assembling real hooks
    via `ModelRouterPlugin` and calling them.
- **Do not test**: provider-specific translation outputs (already covered in
  `reasoning-translate.test.ts`), policy resolution logic (already covered in
  `reasoning-policy.test.ts`), or the `/reasoning` command text (already
  covered in `router-commands.test.ts`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm run build` exits 0
- [ ] A non-subagent `task` call with `mode: "manual"` + session override
      patches the target agent def (new unit test proves this)
- [ ] `static` mode remains a hard no-op for orchestrator task calls
- [ ] Subagent `task` calls still throw the exact nested-delegation error
      (existing tests at `plugin-hooks.test.ts:474-548` still pass)
- [ ] `handleToolExecuteAfter` restores the baseline after a patched dispatch
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The before-hook payload (`output` argument) for `tool === "task"` does not
  expose `args.subagent_type` in the position the current code expects
  (`output?.args?.subagent_type`). The adapter at `runtime.ts:119-120` may
  pass the payload differently than the tests simulate.
- Moving the reasoning patch block requires changing the function signature,
  not just the internal control flow.
- The after-hook restore path (`handleToolExecuteAfter` lines 230-252) has
  a separate reachability issue that this plan's scope cannot cover.
- Existing plan-008 nested-task tests fail in a way that suggests the guard
  contract or error message changed, not just moved.
- The `makeHarness()` helper in `plugin-hooks.test.ts` does not support
  configuring `reasoningPolicy` or tier capabilities, and extending it
  requires changes to more than the test file.

## Maintenance notes

- **Reviewer focus**: the control-flow ordering is the highest-risk part of
  this change. Verify that:
  1. Orchestrator task calls reach the patch (the fix).
  2. Subagent task calls still throw (the invariant).
  3. Subagent non-task calls still reach `guardBeforeCall` (unchanged).
  4. Orchestrator non-task calls still early-return (unchanged).
- Keep patch application best-effort. A reasoning patch failure should
  degrade to baseline behavior (the task still runs), not block dispatch.
- Adaptive mode remains out of scope. This plan only makes `manual` runtime
  overrides actually work. Adaptive engine implementation is a future plan.
- If a future change adds a new tool that should also receive reasoning
  patches, the patch block's `tool === "task"` guard is the single place to
  extend.
