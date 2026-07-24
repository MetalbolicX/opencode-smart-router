// ---------------------------------------------------------------------------
// src/plugin/hooks/tool-execute.ts — Tool execute hook handlers.
//
// Carries the two tool execute hooks: `handleToolExecuteBefore` (nested-
// delegation guard, reasoning patch, subagent guard) and
// `handleToolExecuteAfter` (cap banners, changed-file tracking, baseline
// restore, verify dispatch).
//
// In Phase 1 the bodies are verbatim copies from the original
// `src/plugin/hooks.ts` monolith. Phase 2 extracts the three tool-guards
// (`assertNestedDelegationAllowed`, `applyOrchestratorReasoningPatch`,
// `runSubagentGuard`) into `tool-guards.ts` and refactors
// `handleToolExecuteBefore` into a thin dispatcher. `handleToolExecuteAfter`
// stays as-is.
// ---------------------------------------------------------------------------

import { type BeforeResult, guardAfterCall, guardBeforeCall } from "../../guard/enforce";
import { type AdaptiveSignals, selectAdaptiveLevel } from "../../reasoning/adaptive.js";
import { normalizeSignalText } from "../../reasoning/match.js";
import { resolveReasoningOverride } from "../../reasoning/policy.js";
import { applyReasoningPatch, restoreAgentBaseline } from "../../router/agents";
import { getActiveTiers } from "../../router/protocol";
import { READ_ONLY_TOOLS } from "../../router/tools";
import { log } from "../../utils/observability";
import { resolveTierModelGuard } from "../../utils/tier-model-guard";
import { verifyTaskAfterHook } from "../../verify/dispatch";
import type { PluginContext } from "../context";
import { asTaskToolArgs, asToolCallInput, type HookPayload } from "../types";

// ---------------------------------------------------------------------------
// tool.execute.before — Layer 1 guard check; throws to abort when blocked.
// ---------------------------------------------------------------------------

export const handleToolExecuteBefore = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;

  // Plan 020: depth-based nested-delegation guard.
  // Fire BEFORE the orchestrator reasoning-patch branch and BEFORE the Plan 008
  // flat-isSubagent guard. Blocks descendants (depth >= 1) from calling both
  // "task" (built-in) and "delegate" tools. Depth is recorded synchronously at
  // session.created via registerFromSessionCreated, so it is available from the
  // very first tool call of any child session.
  //
  // The guard uses isDescendant() (backed by depth()) rather than isSubagent()
  // because a descendant session may not yet be registered as a subagent via
  // chat.message — the parentID is recorded at session.created before the child's
  // first tool call reaches this hook.
  if (sid && (tool === "task" || tool === "delegate")) {
    if (typeof ctx.sessionStore.isDescendant === "function" && ctx.sessionStore.isDescendant(sid)) {
      throw new Error(
        "Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task or delegate tools",
      );
    }
  }

  // PR 2 of adaptive-reasoning: resolve the per-session override and patch
  // the targeted tier agent on the live `opencodeConfig` BEFORE the task
  // call spawns its child session. The patch lasts only for the duration
  // of the tool call; `handleToolExecuteAfter` restores the baseline once
  // the task returns.
  //
  // This block must run for the ORCHESTRATOR (the only session that calls
  // the built-in `task` tool to dispatch subagents). It is gated by
  // `!isSubagent(sid)` so it cannot fire for subagent sessions — those
  // are blocked at the nested-task guard below.
  //
  // Reads:
  //   - `ctx.reasoningStore.getOverride(sid)` — session override from
  //     /model-router-reasoning
  //   - `ctx.reasoningStore.acquireTierOwner(tierName, sid)` — per-tier
  //     in-flight ownership; a second same-tier dispatch observes
  //     `false` and is skipped before any mutation
  //   - `cfg.reasoningPolicy` — mode + defaultLevel + surfaceLimits
  //   - `ctx.opencodeConfig.agent[tierName]` — the agent def to mutate
  //
  // The patch is a no-op when:
  //   - tool is not `task` (the only tool that reads a tier agent by name)
  //   - subagent_type is absent or not in the active preset
  //   - no override is set AND no defaultLevel is configured
  //   - policy mode is `static` (primary regression guard)
  //   - the resolved patch is `null` (e.g. `none` capability, or `manual`
  //     with no level)
  if (sid && tool === "task" && !ctx.sessionStore.isSubagent(sid)) {
    if (ctx.opencodeConfig?.agent) {
      try {
        const taskArgs = asTaskToolArgs(output?.args);
        const subagentType = taskArgs?.subagent_type;
        const prompt = taskArgs?.prompt ?? "";
        const description = taskArgs?.description ?? "";
        const agentDef = subagentType ? ctx.opencodeConfig.agent[subagentType] : undefined;
        if (subagentType && agentDef) {
          // fix-ghost-build-subagent: mode guard — reject any resolved agent
          // whose mode is not "subagent". Only tier agents (fast/medium/heavy)
          // and skill subagents (mode:"subagent") are valid Task targets.
          // The "build" agent and other built-in primary agents resolve from
          // opencodeConfig.agent but are not router-managed subagents.
          const mode = (agentDef as { mode?: unknown }).mode;
          if (mode !== "subagent") {
            const err = new Error(
              `Built-in task rejected: "${subagentType}" is not a router-managed subagent target`,
            ) as Error & { __tierGuardError?: true };
            err.__tierGuardError = true;
            throw err;
          }

          const cfg = await ctx.getConfig();
          const tiers = getActiveTiers(cfg);
          const tier = tiers[subagentType];
          if (tier) {
            // Defense-in-depth runtime guard (PR 2 of fix-task-model-fallback-cleanup).
            // The config validator (PR 1) already rejects malformed `provider/model`
            // strings at load time, but a malformed model that somehow reaches
            // this path must hard-fail BEFORE the per-tier in-flight owner is
            // acquired or any reasoning patch is applied. This is the last safe
            // boundary before patching/dispatch side effects; the built-in `task`
            // path bypasses the delegate's fail-soft behavior, so the throw
            // MUST escape the best-effort `try/catch` below.
            const guard = resolveTierModelGuard(cfg, subagentType);
            if (!guard.ok) {
              const guardError = new Error(
                `Built-in task rejected: cannot register tier agent "${subagentType}" — ${guard.reason}`,
              );
              // Marker so the outer catch propagates the guard error
              // instead of swallowing it as a best-effort patch failure.
              (guardError as Error & { __tierGuardError?: true }).__tierGuardError = true;
              throw guardError;
            }

            // Per-tier in-flight guard: only one patch may be active per tier
            // at a time. A second same-tier dispatch observes a `false` from
            // `acquireTierOwner` and skips the patch — overwriting an
            // in-flight agent def would scramble the active subagent.
            const acquired = ctx.reasoningStore.acquireTierOwner(subagentType, sid);
            if (!acquired) {
              const owner = ctx.reasoningStore.getTierOwner(subagentType);
              log.debug({
                event: "reasoning.patch_skipped_concurrent",
                session: sid,
                tier: subagentType,
                owner,
              });
              return;
            }
            const override = ctx.reasoningStore.getOverride(sid);
            // PR 3 of adaptive-reasoning: thread the real Task-tool prompt +
            // description into the selector. Both are routed through
            // `normalizeSignalText` (lowercase + whitespace collapse + trim)
            // so phrase keywords like `root cause` match across any
            // whitespace input and the selector's word/stem regex shapes see
            // a single canonical form. The selector assumes caller-side
            // normalisation — see `AdaptiveSignals` JSDoc.
            const signals: AdaptiveSignals = {
              prompt: normalizeSignalText(prompt),
              description: normalizeSignalText(description),
              tierName: subagentType,
              isTrivial: ctx.sessionStore.isTrivial(sid),
            };
            const resolved = resolveReasoningOverride(tier, cfg.reasoningPolicy, override, signals);
            if (resolved) {
              applyReasoningPatch(agentDef, resolved);
              // Surface-only advisory: emit a debug log when the policy opted in
              // to surfacing limits AND the resolved patch carries the
              // documented 3-level-ladder collapse quirk.
              if (cfg.reasoningPolicy?.surfaceLimits === true) {
                log.debug({
                  event: "reasoning.patch_applied",
                  session: sid,
                  tier: subagentType,
                  override: override ?? cfg.reasoningPolicy?.defaultLevel ?? null,
                  patch: resolved,
                });
              }
            } else if (override && cfg.reasoningPolicy?.surfaceLimits === true) {
              // Override was set but resolved to null — log so operators can
              // see why the requested level wasn't applied.
              log.debug({
                event: "reasoning.patch_unsupported",
                session: sid,
                tier: subagentType,
                override,
              });
            }
            // PR 3 of adaptive-reasoning: when the policy opted in to surface
            // adaptive decisions, emit a debug event carrying the selector's
            // pure decision (level + reason) on every dispatch under adaptive
            // mode. Independent from `surfaceLimits` — that flag controls
            // patch_applied / patch_unsupported. The selector is pure so this
            // re-evaluation is cheap; we keep it separate from the resolver's
            // call so the event payload stays machine-friendly (level + reason
            // string, not the translated patch).
            if (
              cfg.reasoningPolicy?.mode === "adaptive" &&
              cfg.reasoningPolicy?.adaptive?.surfaceDecision === true
            ) {
              const decision = selectAdaptiveLevel(signals, cfg.reasoningPolicy);
              log.debug({
                event: "reasoning.adaptive_selected",
                session: sid,
                tier: subagentType,
                level: decision.level,
                reason: decision.reason,
              });
            }
          }
        }
      } catch (err) {
        // PR 2 of fix-task-model-fallback-cleanup: guard errors MUST
        // propagate — the runtime tier-model guard is a hard-fail, not a
        // best-effort patch. Anything else is a recoverable patch-internal
        // error and is logged without blocking the task.
        if (
          err &&
          typeof err === "object" &&
          (err as { __tierGuardError?: true }).__tierGuardError === true
        ) {
          throw err;
        }
        // best-effort: a reasoning patch failure must never block the task.
        log.warn({
          event: "reasoning.patch_failed",
          session: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Orchestrator task calls never need the guard evaluation that follows
    // (the guard is subagent-only — see ADR 0001). Return so we don't fall
    // through into the subagent guard path.
    return;
  }

  if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof tool !== "string") {
    return;
  }
  // Fail-fast nested-delegation guard: a subagent session must never call the
  // built-in `task` tool. Creating child sessions under a subagent session
  // hangs the opencode runtime permanently (see `verifyTaskAfterHook` parent
  // handling and `src/verify/dispatch.ts` for the prior debugging notes). The
  // session store tracks subagent identity but not parent/depth, so the only
  // signal we need here is `isSubagent(sid) && tool === "task"`. Blocking at
  // the before-hook keeps the unsafe path from ever creating a grandchild.
  if (tool === "task") {
    throw new Error(
      "Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task tool",
    );
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
        toolArgs: input?.args,
        output,
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
