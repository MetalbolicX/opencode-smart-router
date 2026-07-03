# Plan 017: Fix Task child session cleanup bypassing when verification is off

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7698dc9..HEAD -- src/verify/dispatch.ts test/unit/verify-dispatch.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `7698dc9`, 2026-07-02

## Why this matters

Every `Task` tool dispatch leaves a zombie session in the TUI when verification
mode is `"off"` (the default for non-enforced runs). The `verifyTaskAfterHook`
function in `src/verify/dispatch.ts` has a structural flaw: it early-returns at
line 345 (`if (!shouldVerifyTask(...)) return;`) **before** reaching the
`try/finally` block (lines 353–492) that contains session cleanup — including
the `session.abort()` + `session.delete()` SDK teardown added in Plan 007.

The result: the child session is created by the SDK, visible in the TUI session
list (`Ctrl+X L`) with a running chronometer, but never torn down. Sessions
accumulate over the course of a working session. This is the exact issue the
user observed: a hung session titled "Analyze the adaptive engine robustness"
with its timer still counting after the subagent had already returned.

Three prior SDD changes (`fix-subagent-session-hang`, `fix-orphan-subagent-
sessions`, Plan 007) hardened the cleanup inside the `try/finally`, but none
moved the cleanup above the `shouldVerifyTask` gate. The early return is the
sole remaining leak path.

## Current state

### File: `src/verify/dispatch.ts` (493 lines)

The function `verifyTaskAfterHook` (lines 328–493) has this structure:

```
328  export const verifyTaskAfterHook = async (ctx, input, output) => {
333    const toolName = input?.tool;
335    if (typeof toolName !== "string") return;          ← non-task early return (fine)
337    const activeCfg = await ctx.getConfig();
338    let mode = "off";
340    mode = resolveEnforcementMode(...).mode;
344    const requireMode = activeCfg.enforcement?.verify?.require;
345    if (!shouldVerifyTask(toolName, mode, requireMode)) return;  ← BUG: bypasses cleanup
346
352    let childSessionID: string | null = null;
353    try {
354      const parsed = parseTaskResult(output);
355      childSessionID = parsed.childSessionID;
         ... verification logic ...
         } catch (err) { ... }
441    } finally {
442      if (childSessionID) {
445        ctx.changedFileStore.clear(childSessionID);
457        ctx.sessionStore.unregister(childSessionID);
462        ctx.guardStore.clear(childSessionID);
473        await withTimeout(session.abort({ path: { id: childSessionID } }), ...);
483        await withTimeout(session.delete({ path: { id: childSessionID } }), ...);
490      }
492    }
493  };
```

**The problem**: Line 345 returns before `childSessionID` is ever parsed (line
354) and before the `finally` block (line 441) can run. When `mode === "off"`,
cleanup never executes.

### `shouldVerifyTask` (lines 173–182)

```typescript
export const shouldVerifyTask = (tool, mode, require) => {
  if (tool !== "task") return false;
  if (mode === "off") return false;       // ← the trigger condition
  if ((require ?? "whenDoDPresent") === "never") return false;
  return true;
};
```

### File: `test/unit/verify-dispatch.test.ts` (1851 lines)

The existing test at line 608 proves the gap:

```typescript
it("is a no-op when enforcement mode is OFF", async () => {
  process.env.MODEL_ROUTER_ENFORCE = "0";
  // ... sets metadata: { sessionId: "child3" } ...
  await verifyTaskAfterHook(ctx, input, output);
  expect(output.output).toBe(original);   // ← only checks output, NOT cleanup
});
```

This test asserts output is unchanged but never checks that `session.abort()` /
`session.delete()` were called. The cleanup tests (lines 767–877) all use
`MODEL_ROUTER_ENFORCE = "1"` (verification ON), so the early return never
fires and the bug is invisible.

### Conventions

- Error handling: fail-closed — a verification error must NEVER throw out of
  the after-hook. Cleanup in `finally` blocks must be best-effort (swallow
  errors individually so one failure doesn't block the next).
- `withTimeout` is used for all SDK teardown calls (defense-in-depth).
- Test runner: vitest (`describe`/`it`/`expect`). Tests use `makeCtx()` helper
  with `abortImpl` / `deleteImpl` mocks for SDK session methods.
- Commit style: conventional commits (`fix(verify): ...`).

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Typecheck | `pnpm typecheck`                         | exit 0, no errors   |
| Tests     | `pnpm test -- verify-dispatch`           | all pass            |
| Full      | `pnpm test`                              | all pass            |

## Scope

**In scope** (the only files you should modify):
- `src/verify/dispatch.ts` — restructure `verifyTaskAfterHook` so cleanup runs unconditionally
- `test/unit/verify-dispatch.test.ts` — add regression tests for mode-off cleanup

**Out of scope** (do NOT touch):
- `src/plugin/delegate.ts` — the plugin-owned delegate tool has its own cleanup in `cleanupProducerSession`; that path is not affected by this bug.
- `src/plugin/hooks.ts` — the hook registration and `handleToolExecuteAfter` dispatcher are correct; they call `verifyTaskAfterHook` unconditionally.
- `shouldVerifyTask` itself — the function is correct: it gates *verification*, not *cleanup*. The fix is in where cleanup runs relative to the gate, not in the gate logic.

## Git workflow

- Branch: `fix/task-child-cleanup-bypass` (or the repo's branch-naming convention if one is evident)
- Commit per step or per logical unit; message style: conventional commits
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract childSessionID above the verification gate

In `src/verify/dispatch.ts`, restructure `verifyTaskAfterHook` so the
`childSessionID` is parsed from `output` **before** the `shouldVerifyTask`
check, and the cleanup `finally` wraps the **entire** function body (including
the gate).

**Target structure** (not every line — just the shape):

```typescript
export const verifyTaskAfterHook = async (
  ctx: PluginContext,
  input: unknown,
  output: Record<string, unknown>,
): Promise<void> => {
  const inputRec = (input ?? {}) as Record<string, unknown>;
  const toolName = inputRec["tool"];
  if (typeof toolName !== "string") return;

  // Parse the childSessionID UNCONDITIONALLY so cleanup can always reach it,
  // even when verification is disabled (mode === "off"). This is the fix for
  // the TUI session leak: previously the early return at shouldVerifyTask
  // bypassed the entire try/finally, leaving the child session in the TUI.
  const parsed = parseTaskResult(output);
  const childSessionID = parsed.childSessionID;

  try {
    const taskArgs = asTaskToolArgs(inputRec["args"]);
    const activeCfg = await ctx.getConfig();
    let mode = "off";
    try {
      mode = resolveEnforcementMode({ config: activeCfg, env: process.env }).mode;
    } catch {
      // fall through with mode "off"
    }
    const requireMode = activeCfg.enforcement?.verify?.require;
    if (!shouldVerifyTask(toolName, mode, requireMode)) return;

    const { finalReturnText, parentSessionID } = parsed;
    // ... existing verification logic unchanged ...
  } catch (err) {
    // ... existing catch block unchanged ...
  } finally {
    if (childSessionID) {
      ctx.changedFileStore.clear(childSessionID);
      try { ctx.sessionStore.unregister(childSessionID); } catch { }
      try { ctx.guardStore.clear(childSessionID); } catch { }
      try {
        await withTimeout(
          ctx.plugin.client.session.abort({ path: { id: childSessionID } }),
          10_000,
          "task child session.abort",
        );
      } catch { }
      try {
        await withTimeout(
          ctx.plugin.client.session.delete({ path: { id: childSessionID } }),
          10_000,
          "task child session.delete",
        );
      } catch { }
    }
  }
};
```

**Key changes**:
1. `parseTaskResult(output)` moves ABOVE the verification gate — runs unconditionally.
2. `childSessionID` is declared outside the `try` so the `finally` can always reach it.
3. The `try/catch/finally` now wraps the `shouldVerifyTask` check — the early return still skips verification logic, but the `finally` always runs cleanup.
4. The inner `let childSessionID = null` declaration (old line 352) is removed — replaced by the hoisted parse.

**Important**: The `const parsed = parseTaskResult(output)` call at the top will run even for non-task tools. That's fine — `parseTaskResult` is a pure parser that reads from `output.metadata` and returns `{ childSessionID: null, ... }` when metadata is absent. No side effects, no SDK calls. The `childSessionID` will be `null` for non-task tools, so the `finally` block's `if (childSessionID)` guard skips cleanup.

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Add regression test — cleanup runs when mode is OFF

This is the **critical regression test**. It proves the bug is fixed: the
child session is aborted and deleted even when verification is disabled.

Add to `test/unit/verify-dispatch.test.ts`, in the existing
`describe("verifyTaskAfterHook", ...)` block, near the other cleanup tests
(after line ~877):

```typescript
it("still aborts and deletes the Task child session when enforcement mode is OFF", async () => {
  process.env.MODEL_ROUTER_ENFORCE = "0";

  const abortCalls: string[] = [];
  const deleteCalls: string[] = [];

  const ctx = makeCtx({
    directory: workDir,
    abortImpl: async (req: any) => {
      abortCalls.push(req?.path?.id);
      return { data: true };
    },
    deleteImpl: async (req: any) => {
      deleteCalls.push(req?.path?.id);
      return { data: true };
    },
  });

  const input = {
    tool: "task",
    sessionID: "orch",
    args: {
      subagent_type: "fast",
      prompt: "Do some work.",
    },
  };
  const output = {
    output: "<task_result>\nDONE: work done.\n</task_result>",
    metadata: { sessionId: "child-mode-off" },
  };

  await verifyTaskAfterHook(ctx, input, output);

  // Verification is OFF so output is not modified — but cleanup MUST still run.
  expect(abortCalls).toEqual(["child-mode-off"]);
  expect(deleteCalls).toEqual(["child-mode-off"]);
});
```

**Verify**: `pnpm test -- verify-dispatch` → this test passes (it should FAIL before the Step 1 fix and PASS after — that's the TDD contract).

### Step 3: Add regression test — cleanup runs when require is "never"

The `shouldVerifyTask` function has a second `return false` path: when
`require === "never"`. This must also not bypass cleanup.

Add after the Step 2 test:

```typescript
it("still aborts and deletes the Task child session when verify.require is 'never'", async () => {
  process.env.MODEL_ROUTER_ENFORCE = "1";

  const abortCalls: string[] = [];
  const deleteCalls: string[] = [];

  const ctx = makeCtx({
    directory: workDir,
    abortImpl: async (req: any) => {
      abortCalls.push(req?.path?.id);
      return { data: true };
    },
    deleteImpl: async (req: any) => {
      deleteCalls.push(req?.path?.id);
      return { data: true };
    },
  });

  // Override config to set verify.require = "never"
  ctx.getConfig = async () => ({
    ...DEFAULT_TEST_CONFIG,
    enforcement: {
      ...DEFAULT_TEST_CONFIG.enforcement,
      verify: { require: "never" },
    },
  }) as any;

  const input = {
    tool: "task",
    sessionID: "orch",
    args: {
      subagent_type: "fast",
      prompt: "Do some work.",
    },
  };
  const output = {
    output: "<task_result>\nDONE.\n</task_result>",
    metadata: { sessionId: "child-req-never" },
  };

  await verifyTaskAfterHook(ctx, input, output);

  expect(abortCalls).toEqual(["child-req-never"]);
  expect(deleteCalls).toEqual(["child-req-never"]);
});
```

> **Note**: Check how the existing `makeCtx` builds its config. The test at
> line 608 works by setting `process.env.MODEL_ROUTER_ENFORCE = "0"` which
> makes `resolveEnforcementMode` return `mode: "off"`. For `require: "never"`,
> you need `mode` to be non-off AND `require` to be `"never"`. Adjust the
> config override approach to match whatever pattern the existing tests use
> for custom enforcement configs. If `makeCtx` doesn't support inline config
> overrides, mock `ctx.getConfig` as shown above.

**Verify**: `pnpm test -- verify-dispatch` → this test passes.

### Step 4: Add regression test — cleanup runs when task output has no sessionId

Edge case: when `output.metadata.sessionId` is absent, `childSessionID` is
`null`, and the `finally` block must skip cleanup without throwing.

Add after Step 3:

```typescript
it("does not crash when enforcement is OFF and output has no sessionId", async () => {
  process.env.MODEL_ROUTER_ENFORCE = "0";

  const abortCalls: string[] = [];
  const deleteCalls: string[] = [];

  const ctx = makeCtx({
    directory: workDir,
    abortImpl: async (req: any) => {
      abortCalls.push(req?.path?.id);
      return { data: true };
    },
    deleteImpl: async (req: any) => {
      deleteCalls.push(req?.path?.id);
      return { data: true };
    },
  });

  const input = {
    tool: "task",
    sessionID: "orch",
    args: { subagent_type: "fast", prompt: "Do some work." },
  };
  const output = {
    output: "<task_result>\nDONE.\n</task_result>",
    // No metadata.sessionId — childSessionID will be null
  };

  // Must not throw — null childSessionID means no cleanup needed.
  await expect(verifyTaskAfterHook(ctx, input, output)).resolves.toBeUndefined();
  expect(abortCalls).toEqual([]);
  expect(deleteCalls).toEqual([]);
});
```

**Verify**: `pnpm test -- verify-dispatch` → all pass

## Test plan

**New tests** (4 total):

| Test | Purpose |
|------|---------|
| cleanup when mode is OFF | The primary regression — proves the bug is fixed |
| cleanup when require is "never" | Second gate path — proves the fix is complete |
| no crash when sessionId is absent | Edge case — null childSessionID must not throw |
| existing "no-op when mode is OFF" test (line 608) | Update to also assert abort/delete called |

**Existing test to update** (line 608): The test "is a no-op when enforcement
mode is OFF" currently only asserts `output.output` is unchanged. After the
fix, it should ALSO assert that `session.abort()` and `session.delete()` were
called. However, the existing test doesn't pass `abortImpl` / `deleteImpl`
mocks — so either add them to the existing test, or rely on the new Step 2
test to cover that assertion and leave the existing test as-is (it still
validates that output is not modified). The Step 2 test is the authoritative
regression guard; the existing test can stay unchanged.

**TDD approach**: Write the Step 2 test FIRST (before Step 1). Run it — it
will FAIL (proving the bug exists). Then apply the Step 1 fix. Run again — it
will PASS. This is the red-green cycle that proves the fix addresses the bug.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- verify-dispatch` exits 0; 3 new tests exist and pass
- [ ] `pnpm test` exits 0 (full suite — no regressions)
- [ ] `grep -n "shouldVerifyTask" src/verify/dispatch.ts` shows the call is INSIDE the try block (not before it)
- [ ] `grep -n "parseTaskResult(output)" src/verify/dispatch.ts` shows the call ABOVE the shouldVerifyTask gate
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- You discover `parseTaskResult` has side effects that make calling it unconditionally unsafe (it should be a pure parser — verify before proceeding).
- The existing test at line 608 starts failing after the restructure (the early-return semantics for non-task tools at line 335 must be preserved — that return stays OUTSIDE the try/finally because non-task tools have no child session to clean up).

## Maintenance notes

- **What a reviewer should scrutinize**: The `finally` block now runs for EVERY task tool call, including when verification is off. Make sure no verification-only side effects (e.g., `showRouterToast`, `logEvent.verification.*`) leaked into the `finally` — it must only contain cleanup.
- **Future changes**: If a new `shouldVerifyTask` return-false path is added, the cleanup will still run — that's the point. The `finally` is unconditional.
- **Related follow-up**: The `fix-delegate-cancellation` proposal (Engram #2311) addresses a different gap: the delegate tool ignoring `ToolContext.abort` on manual cancellation. That fix is orthogonal to this one — this plan fixes the *cleanup bypass*, not the *cancellation propagation*.
