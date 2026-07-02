# Plan 008: Block nested built-in Task delegation from subagent sessions

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bfd12e1..HEAD -- src/plugin/hooks.ts src/router/sessions.ts src/verify/dispatch.ts test/unit/verify-dispatch.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `bfd12e1`, 2026-06-30

## Why this matters

The router plugin already documents a critical runtime constraint: creating child sessions under subagent sessions can hang the opencode runtime permanently. Prior fixes prevented verifier/grader sessions from using a subagent session as their parent, but the general built-in `Task()` path is still open: a child subagent can call `Task()` and attempt to create a grandchild session.

The current plugin has exactly enough information to prevent this safely and early. The `tool.execute.before` hook already knows the current `sessionID`, the requested `tool`, and whether that session is a tracked subagent. Blocking nested built-in `task` calls at that point is the minimal, highest-confidence fix: it prevents the unsafe runtime path before any grandchild session is created, without introducing new parent/depth tracking or changing teardown behavior.

This plan intentionally fixes only the plugin-owned bug: unsafe nested delegation from subagent sessions. It does **not** attempt to fix the separate opencode-core issue where killing a child session returns the UI to a blank session instead of restoring the parent; that requires changes outside this repository.

## Current state

The facts below are the minimum context the executor needs. Do not assume anything beyond what is in this section.

### Relevant files

- `src/plugin/hooks.ts` — plugin hook entry points for `tool.execute.before`, `tool.execute.after`, chat tracking, and system prompt behavior.
- `src/plugin/runtime.ts` — registers the hook handlers with the opencode plugin runtime.
- `src/router/sessions.ts` — tracks whether a session is a subagent and stores per-subagent cap/triviality state.
- `src/verify/dispatch.ts` — parses built-in `task` output and performs verification/cleanup for direct child sessions after a task finishes.
- `test/unit/verify-dispatch.test.ts` — established test harness pattern for plugin contexts and task-verification behavior.

### Evidence that nested child-of-subagent sessions are unsafe

`src/plugin/hooks.ts:171-184`

```ts
// Option (i): verify-dispatch around the built-in `task` tool ...
//
// Parent for grader sessions is read metadata-first from
// `output.metadata.parentSessionId` (or `parentSessionID`) inside
// `verifyTaskAfterHook`. We intentionally do NOT forward `sid` (the subagent
// session id) here. Passing it as `parentSessionID` caused grader session
// creation to hang because the SDK cannot create child sessions of subagent
// sessions ...
await verifyTaskAfterHook(ctx, input, output);
```

`src/verify/dispatch.ts:320-327`

```ts
* The subagent `input.sessionID` MUST NEVER be forwarded as
* `parentSessionID`: passing the subagent SID caused the SDK to attempt to
* create child sessions of subagent sessions, which hangs the opencode
* runtime permanently ...
```

These comments are not speculative. They record prior debugging and fixes already merged into the codebase. This plan must preserve that invariant.

### Existing `tool.execute.before` guard already has the right data

`src/plugin/hooks.ts:87-123`

```ts
export const handleToolExecuteBefore = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;
  if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof tool !== "string") {
    return;
  }
  let res: BeforeResult;
  try {
    const cfg = await ctx.getConfig();
    res = guardBeforeCall({
      cfg,
      tier: ctx.sessionStore.getTier(sid),
      trivial: ctx.sessionStore.isTrivial(sid),
      sessionID: sid,
      tool,
      toolArgs: output?.args as Record<string, unknown> | undefined,
      store: ctx.guardStore,
      env: process.env,
    });
  } catch {
    return; // never break a real session on a guard-internal error
  }
  if (res.block) {
    ctx.trajectoryStore.recordToolEvent(sid, {
      tool,
      readOnly: READ_ONLY_TOOLS.has(tool),
      blocked: true,
      selfScript: res.guard === "anti_self_script",
    });
    throw new Error(res.message);
  }
};
```

Key implications:

- `sid` is the current session ID.
- `tool` is the tool being invoked.
- `ctx.sessionStore.isSubagent(sid)` already tells the hook whether the current session is a subagent.
- Throwing from this hook is the established mechanism for blocking a tool call before execution.

This means the fix belongs here. The after-hook is too late because by then the nested `task` has already run.

### Hook wiring confirms the before-hook is authoritative

`src/plugin/runtime.ts:119-123`

```ts
"tool.execute.before": (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) =>
  handleToolExecuteBefore(ctx, toHookPayload(input), toHookPayload(output)),

"tool.execute.after": (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) =>
  handleToolExecuteAfter(ctx, toHookPayload(input), toHookPayload(output)),
```

The runtime calls `handleToolExecuteBefore()` before the tool starts. That is the correct insertion point for a fail-fast nested-delegation guard.

### Session tracking is boolean, not hierarchical

`src/router/sessions.ts:12-19`

```ts
export interface SubagentState {
  tierName: string;
  cap: Cap;
  calls: number;
  seen: Map<string, number>;
  trivial: boolean;
}
```

`src/router/sessions.ts:159-197`

```ts
const subagentSessionIDs = new Set<string>();
const subagentCapState = new Map<string, SubagentState>();

return {
  isSubagent(sessionID: string): boolean {
    return subagentSessionIDs.has(sessionID);
  },
  getTier(sessionID: string): string | null {
    return subagentCapState.get(sessionID)?.tierName ?? null;
  },
  isTrivial(sessionID: string): boolean {
    return subagentCapState.get(sessionID)?.trivial === true;
  },
  registerProducerSession(sessionID: string, tier: string, cfg: RouterConfig): void {
    subagentSessionIDs.add(sessionID);
    const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
    subagentCapState.set(sessionID, {
      tierName: tier, cap: baseline, calls: 0, seen: new Map(), trivial: false,
    });
  },
  unregister(sessionID: string): void {
    subagentSessionIDs.delete(sessionID);
    subagentCapState.delete(sessionID);
  },
```

Important constraint: the store does **not** track `parentID`, `parentSessionID`, or nesting depth. Do **not** expand scope by adding hierarchy metadata for this fix. The boolean `isSubagent` check is sufficient for blocking the unsafe case.

### Current verification/cleanup is direct-child only

`src/verify/dispatch.ts:119-138`

```ts
export const parseTaskResult = (output: unknown): ParsedTaskResult => {
  const o = (output ?? {}) as Record<string, unknown>;
  const raw = typeof o.output === "string" ? o.output : "";
  const m = raw.match(TASK_RESULT_RE);
  const finalReturnText = (m ? m[1] : raw).trim();
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const childSessionID =
    typeof meta.sessionId === "string"
      ? meta.sessionId
      : typeof meta.sessionID === "string"
        ? meta.sessionID
        : null;
  const parentSessionID =
    typeof meta.parentSessionId === "string"
      ? meta.parentSessionId
      : typeof meta.parentSessionID === "string"
        ? meta.parentSessionID
        : null;
  return { finalReturnText, childSessionID, parentSessionID };
};
```

`src/verify/dispatch.ts:454-490`

```ts
if (childSessionID) {
  ctx.changedFileStore.clear(childSessionID);
  try {
    ctx.sessionStore.unregister(childSessionID);
  } catch {}
  try {
    ctx.guardStore.clear(childSessionID);
  } catch {}
  try {
    await withTimeout(
      ctx.plugin.client.session.abort({ path: { id: childSessionID } }),
      10_000,
      "task child session.abort",
    );
  } catch {}
  try {
    await withTimeout(
      ctx.plugin.client.session.delete({ path: { id: childSessionID } }),
      10_000,
      "task child session.delete",
    );
  } catch {}
}
```

This confirms the existing after-hook logic is designed around one parsed child session. The correct fix is prevention, not more cleanup logic.

### Existing test harness pattern

`test/unit/verify-dispatch.test.ts:38-141`

`makeCtx(...)` builds a fake `PluginContext` with mocked `plugin.client.session.{create,prompt,abort,delete}`, `getConfig`, `sessionStore`, `guardStore`, `trajectoryStore`, and `changedFileStore`.

`test/unit/verify-dispatch.test.ts:549-572`

```ts
it("appends a forcing note when a built-in task call fails deterministic verification", async () => {
  process.env.MODEL_ROUTER_ENFORCE = "1";
  const ctx = makeCtx({ directory: workDir });
  const input = {
    tool: "task",
    sessionID: "orch",
    args: {
      subagent_type: "fast",
      prompt: "Create the report.\n[acceptance]\ncheck: fileExists path=missing.txt\n[/acceptance]",
    },
  };
  const output = {
    output: "<task_result>\nDONE: report created.\n</task_result>",
    metadata: { sessionId: "child1" },
  };
  await verifyTaskAfterHook(ctx, input, output);
  expect(output.output).toContain("NOT ACCEPTED");
  expect(output.output).toContain("[router");
});
```

Mirror this testing style: construct a fake context, build minimal `input`/`output`, call the hook directly, and assert on behavior and mocks.

### Repo conventions to match

- Conventional commits: recent examples include `fix(verify): ...`, `fix(delegate): ...`, `refactor(plugin): ...`
- Verification commands:
  - `pnpm run typecheck`
  - `pnpm run test`
  - `pnpm run lint`
- Tooling:
  - TypeScript, ESM
  - Vitest for unit tests
  - Biome for lint/format
- Existing behavior in hook code favors:
  - minimal runtime guards
  - best-effort non-crashing cleanup
  - explicit comments explaining safety constraints

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat bfd12e1..HEAD -- src/plugin/hooks.ts src/router/sessions.ts src/verify/dispatch.ts test/unit/verify-dispatch.test.ts` | no unexpected drift, or drift reconciled before editing |
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Unit tests | `pnpm run test` | all tests pass |
| Targeted tests | `npx vitest run --reporter=verbose test/unit/hooks.test.ts` or repo-equivalent test filter | new/updated hook tests pass |
| Lint | `pnpm run lint` | exit 0 |

Use the repo's actual test filtering convention if `npx vitest run` does not match existing usage. If a narrower Vitest filter is already used elsewhere in the repo, follow that pattern.

## Scope

**In scope** (the only files you should modify):
- `src/plugin/hooks.ts`
- `test/unit/hooks.test.ts` (create if it does not exist, or add to the closest existing hook test file)

**Out of scope** (do NOT touch, even though they look related):
- `src/router/sessions.ts` — behavior changes beyond reading existing `isSubagent()` state
- `src/verify/dispatch.ts` — algorithm changes
- Any new parent/depth/nesting metadata in the session store
- opencode core or TUI session restoration behavior
- Changing task-verification semantics for root/orchestrator sessions

## Git workflow

- Branch: `advisor/008-block-nested-task-delegation`
- Commit as one logical unit
- Commit message style: `fix(plugin): block nested built-in task delegation from subagents`
- Do NOT push or open a PR unless explicitly instructed

## Steps

### Step 1: Add a fail-fast nested-task guard in `handleToolExecuteBefore`

Edit `src/plugin/hooks.ts`.

Inside `handleToolExecuteBefore()`, keep the existing early return for non-subagent sessions. For sessions that are already recognized as subagents, add a minimal check before `guardBeforeCall(...)`:

- If `tool !== "task"`, preserve current behavior (proceed to `guardBeforeCall`).
- If `tool === "task"`, throw a deterministic error immediately.
- The error text must clearly state that a subagent cannot delegate using the built-in `task` tool because nested subagent creation is not supported.

Requirements:

- Do **not** broaden the guard to all tools.
- Do **not** try to inspect `args` or infer depth.
- Do **not** call `verifyTaskAfterHook()` or any cleanup path from here.
- Keep the implementation small and local to `handleToolExecuteBefore()`.

Error message to use (exact):

```
Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool
```

**Verify**: `pnpm run typecheck` → exit 0

### Step 2: Add focused unit tests for the before-hook behavior

Create `test/unit/hooks.test.ts` with unit tests for the new guard. Follow the `makeCtx(...)` pattern from `test/unit/verify-dispatch.test.ts`.

Cover exactly these cases:

1. Root/orchestrator session calling `task` is still allowed (the before-hook early-returns for non-subagents).
2. Subagent session calling a non-`task` tool is still allowed and continues through the existing guard flow.
3. Subagent session calling `task` throws the new deterministic error before tool execution.
4. The new guard does not depend on parent/depth metadata; it only depends on `isSubagent(sessionID)` and `tool === "task"`.

Implementation guidance:

- Create a minimal `makeCtx` or a direct mock-based helper. If an existing helper from `verify-dispatch` is importable (check its export), reuse it.
- Stub `sessionStore.isSubagent` explicitly for each case:
  - Return `false` for non-subagent (root orchestrator)
  - Return `true` for subagent
- `sessionStore.getTier` and `sessionStore.isTrivial` are not needed for this test (the guard exits before `guardBeforeCall`).
- Assert on thrown error text, not just "throws".
- Keep the tests unit-level; do not try to create real sessions.

**Verify**: `npx vitest run --reporter=verbose test/unit/hooks.test.ts` → all 4+ new tests pass

### Step 3: Run repo-wide verification

Run the repo's standard checks after the code and tests are created.

**Verify**:
- `pnpm run typecheck` → exit 0
- `pnpm run test` → all pass
- `pnpm run lint` → exit 0

## Test plan

New or updated test file: `test/unit/hooks.test.ts`

Tests to add:

| Test case | Description | Assertion |
|---|---|---|
| non-subagent + task allowed | root orchestrator calls built-in task | before-hook returns without throwing |
| subagent + non-task allowed | subagent calls a permitted tool (e.g., `read`, `bash`) | before-hook does not throw and reaches guard flow |
| subagent + task blocked | subagent calls built-in task | before-hook throws with exact error text |
| message stability | the blocked error message is the exact string specified | `expect(err.message).toBe("Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool")` |

Use the same mocking/testing style already established in `test/unit/verify-dispatch.test.ts`:
- fake `PluginContext`
- explicit mocked store behavior
- direct invocation of the hook function
- narrow, behavior-first assertions

Do **not** add smoke/integration tests for this plan.

## Done criteria

All of the following must hold:

- [ ] `src/plugin/hooks.ts` rejects built-in `task` calls when `ctx.sessionStore.isSubagent(sessionID)` is `true`
- [ ] Non-subagent `task` behavior remains allowed
- [ ] Non-`task` behavior for subagent sessions remains unchanged
- [ ] New unit tests exist for the blocked and allowed paths
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if any of these occur:

- The code in `src/plugin/hooks.ts` no longer matches the excerpts in "Current state", especially if `handleToolExecuteBefore()` no longer receives `sessionID`, `tool`, or `isSubagent()` access.
- There is already an existing product decision that nested subagents must be supported, not blocked. That would require a larger design with explicit hierarchy/lifecycle management, not this fix.
- The only way to implement the guard cleanly appears to require changing `src/router/sessions.ts` to add parent/depth tracking. That is scope growth for this plan.
- Existing tests prove that nested `task` from subagents is intentionally allowed in some cases.
- The repo has no practical existing test harness pattern for hook-level unit tests and `makeCtx` from `verify-dispatch.test.ts` is not exportable. If the test setup effort is large, stop and report before building a custom harness.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- This plan intentionally chooses the smallest safe fix: block nested built-in `task` from already-subagent sessions.
- If the product later requires nested subagents, the future implementation must treat that as an architecture feature with:
  - explicit parent/depth tracking
  - coordinated session ownership/cleanup
  - integration tests against the runtime's actual session semantics
- Reviewer focus in the PR:
  - confirm the guard is inserted before any work starts (before `guardBeforeCall`)
  - confirm only subagent `task` is blocked (non-subagent sessions and other tools are untouched)
  - confirm the error message is deterministic and matches what tests assert
  - confirm no unrelated guard logic changed
- Follow-up explicitly deferred:
  - opencode core fix for restoring the parent session after a child is killed/deleted
  - any redesign of `sessionStore` to represent nested session trees
