// ---------------------------------------------------------------------------
// src/plugin/hooks/tool-execute.ts — Tool execute hook handlers.
//
// Carries the two tool execute hooks: `handleToolExecuteBefore` (a thin
// dispatcher that invokes the three tool-guards in order) and
// `handleToolExecuteAfter` (cap banners, changed-file tracking, baseline
// restore, verify dispatch).
//
// In Phase 2 the dispatcher's body was extracted into three pure helpers
// in `tool-guards.ts` (`assertNestedDelegationAllowed`,
// `applyOrchestratorReasoningPatch`, `runSubagentGuard`). The dispatcher
// preserves the exact order of the pre-extraction implementation:
//
//   1. assertNestedDelegationAllowed  (depth-based nested-delegation guard)
//   2. applyOrchestratorReasoningPatch (orchestrator reasoning patch —
//      returns true when the orchestrator path was consumed, signalling
//      the dispatcher to NOT fall through to the subagent guard)
//   3. runSubagentGuard              (subagent-only nested-task throw +
//      guardBeforeCall evaluation)
//
// `handleToolExecuteAfter` stays as-is.
// ---------------------------------------------------------------------------

import { guardAfterCall } from "../../guard/Guard.res.mjs";
import { restoreAgentBaseline } from "../../router/agents";
import { READ_ONLY_TOOLS } from "../../router/tools";
import { log } from "../../utils/observability";
import { verifyTaskAfterHook } from "../../verify/dispatch-io";
import type { PluginContext } from "../context";
import { asToolCallInput, type HookPayload } from "../types";
import {
  applyOrchestratorReasoningPatch,
  assertNestedDelegationAllowed,
  runSubagentGuard,
} from "./tool-guards";

// ---------------------------------------------------------------------------
// tool.execute.before — Thin dispatcher for the three tool-guards.
//
// Order matches the pre-extraction implementation:
//   1. Plan 020 depth-based nested-delegation guard (assertNestedDelegationAllowed).
//   2. PR 2 of adaptive-reasoning: orchestrator reasoning patch
//      (applyOrchestratorReasoningPatch). Returns `consumed = true` when the
//      orchestrator path was taken — the dispatcher MUST NOT fall through
//      to the subagent guard in that case.
//   3. Subagent-only guard evaluation (runSubagentGuard). Self-gates on
//      `!isSubagent(sid)` so it is a no-op for non-subagent sessions.
// ---------------------------------------------------------------------------

export const handleToolExecuteBefore = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;
  if (!sid || typeof tool !== "string") return;

  assertNestedDelegationAllowed(sid, tool, ctx.sessionStore);
  const consumed = await applyOrchestratorReasoningPatch({ ctx, sid, tool, output });
  if (consumed) return;
  await runSubagentGuard({ ctx, sid, tool, output });
};

// ---------------------------------------------------------------------------
// tool.execute.after — cap banners, changed-file tracking, verify dispatch.
// ---------------------------------------------------------------------------

export const handleToolExecuteAfter = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const toolInput = asToolCallInput(input);
  if (toolInput) {
    ctx.sessionStore.recordToolCall(toolInput, output);
  }

  // Record-only trajectory observation (mutates internal maps only; never
  // touches output, so emitted banners/observations stay byte-identical).
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;

  // PR 2 of adaptive-reasoning: restore the tier agent baseline AFTER the
  // task call returns. Pairs with the patch in `handleToolExecuteBefore`.
  // The baseline was captured at `handleConfig` time and stashed in
  // `ctx.reasoningStore` so the next dispatch starts from a clean slate.
  if (tool === "task" && ctx.opencodeConfig?.agent) {
    try {
      const subagentType = (input?.args as Record<string, unknown> | undefined)?.subagent_type as
        | string
        | undefined;
      const agentDef = subagentType ? ctx.opencodeConfig.agent[subagentType] : undefined;
      if (subagentType && agentDef) {
        const baseline = ctx.reasoningStore.getBaseline(subagentType);
        if (baseline) {
          restoreAgentBaseline(agentDef, baseline);
        }
        // Release the per-tier in-flight ownership acquired in
        // `handleToolExecuteBefore`. `releaseTierOwner` is owner-checked —
        // a foreign release (e.g. an after-hook that fires for a different
        // session than the one that acquired) returns `false` and leaves
        // the lock intact.
        if (sid) {
          ctx.reasoningStore.releaseTierOwner(subagentType, sid);
        }
      }
    } catch (err) {
      // best-effort: a baseline restore failure must never crash the session.
      // The agent def will still be functional — next registerTierAgents call
      // (config reload) overwrites it.
      log.warn({
        event: "reasoning.restore_failed",
        session: sid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Attribute changed files to whichever session made the edit (any session).
  if (sid && typeof tool === "string") {
    ctx.changedFileStore.record(sid, tool, input?.args);
  }

  if (sid && ctx.sessionStore.isSubagent(sid) && typeof tool === "string") {
    ctx.trajectoryStore.recordToolEvent(sid, {
      tool,
      readOnly: READ_ONLY_TOOLS.has(tool),
    });
    try {
      const cfg = await ctx.getConfig();
      guardAfterCall({
        cfg,
        tier: ctx.sessionStore.getTier(sid),
        sessionID: sid,
        tool,
        toolArgs: input?.args as Record<string, unknown> | null,
        output: { output: (output as Record<string, unknown>).output as unknown | null },
        store: ctx.guardStore,
      });
    } catch {
      // best-effort: enforcement must never crash a real session
    }
  }

  // Option (i): verify-dispatch around the built-in `task` tool (advisory-grade —
  // we observe the finished task result and append a forcing note if it is not
  // accepted; we cannot retry a task call that already finished).
  //
  // Parent for grader sessions is read metadata-first from
  // `output.metadata.parentSessionId` (or `parentSessionID`) inside
  // `verifyTaskAfterHook`. We intentionally do NOT forward `sid` (the subagent
  // session id) here. Passing it as `parentSessionID` caused grader session
  // creation to hang because the SDK cannot create child sessions of subagent
  // sessions (SDD change: fix-subagent-session-hang). When the metadata field
  // is missing or malformed, `input.sessionID` MUST NEVER be substituted as
  // the grader parent — grader creation simply stays parentless instead
  // (SDD change: fix-task-verifier-session-parenting).
  await verifyTaskAfterHook(ctx, input, output);
};
