// ---------------------------------------------------------------------------
// src/plugin/hooks/tool-guards.ts — Three extracted tool-guards helpers.
//
// Split out of `handleToolExecuteBefore` in Phase 2 of the
// plugin-decomposition change. Each helper is a pure, independently-callable
// function that takes only the inputs it needs (no implicit `ctx` capture
// beyond `PluginContext` field access). The dispatcher in `tool-execute.ts`
// invokes them in this order:
//
//   1. assertNestedDelegationAllowed(sid, tool, sessionStore) — throws on
//      depth-based nested delegation.
//   2. applyOrchestratorReasoningPatch({ ctx, sid, tool, output }) —
//      returns `true` when the orchestrator path was consumed (dispatcher
//      must NOT fall through to the subagent guard) and `false` when the
//      caller is not on the orchestrator path.
//   3. runSubagentGuard({ ctx, sid, tool, output }) — subagent-only
//      guard evaluation; throws when the subagent calls the built-in
//      `task` tool, when `guardBeforeCall` blocks, and records a
//      trajectory tool-event on block.
//
// Bodies are verbatim extractions from `src/plugin/hooks.ts` (pre-split
// monolith) at the line ranges documented in `sdd/plugin-decomposition/design`
// § Phase 2. No shared mutable state across helpers; no import from
// `runtime.ts`, `commands/*`, or `router/*` (the dep graph stays acyclic).
// ---------------------------------------------------------------------------

import type { beforeResult as BeforeResult } from "../../guard/Guard.res.mjs";
import { guardBeforeCall } from "../../guard/Guard.res.mjs";
// Type imports from original TS files (type definitions preserved for backward compat)
import type { adaptiveSignals as AdaptiveSignals } from "../../reasoning/Reasoning.res.mjs";
// Value imports from ReScript facade
import { selectAdaptiveLevel, normalizeSignalText, resolveReasoningOverride } from "../../reasoning/Reasoning.res.mjs";
import { applyReasoningPatch } from "../../router/agents";
import { getActiveTiers } from "../../router/protocol";
import { READ_ONLY_TOOLS } from "../../router/tools";
import { log } from "../../utils/observability";
import { resolveTierModelGuard } from "../../utils/TierModelGuard.res.mjs";
import type { PluginContext } from "../context";
import { asTaskToolArgs, type HookPayload } from "../types";

/**
 * Narrow structural type that the helper accepts. Mirrors the relevant
 * fields of `PluginContext["sessionStore"]` so the helper can be tested
 * with a plain stub (the helper tolerates older stores that lack
 * `isDescendant`).
 */
export interface SessionStoreLike {
  isSubagent(sessionID: string): boolean;
  isDescendant?(sessionID: string): boolean;
  isTrivial(sessionID: string): boolean;
  getTier(sessionID: string): string | null;
}

/**
 * Plan 020: depth-based nested-delegation guard.
 *
 * Verbatim from hooks.ts lines 127-133. Blocks descendants (depth >= 1)
 * from calling both "task" (built-in) and "delegate" tools. The guard
 * uses isDescendant() (backed by depth()) rather than isSubagent()
 * because a descendant session may not yet be registered as a subagent
 * via chat.message — the parentID is recorded at session.created before
 * the child's first tool call reaches this hook.
 *
 * Throws a `Nested subagent delegation is not allowed` error when the
 * caller is a descendant session calling `task` or `delegate`. Defensive:
 * bails out early if `isDescendant` is not a function on the store
 * (older implementations).
 */
export const assertNestedDelegationAllowed = (
  sid: string,
  tool: string,
  sessionStore: SessionStoreLike,
): void => {
  if (sid && (tool === "task" || tool === "delegate")) {
    if (typeof sessionStore.isDescendant === "function" && sessionStore.isDescendant(sid)) {
      throw new Error(
        "Nested subagent delegation is not allowed: subagent sessions cannot call the built-in task or delegate tools",
      );
    }
  }
};

/**
 * PR 2 of adaptive-reasoning: resolve the per-session override and patch
 * the targeted tier agent on the live `opencodeConfig` BEFORE the task
 * call spawns its child session. The patch lasts only for the duration
 * of the tool call; the dispatcher calls the corresponding `restoreAgentBaseline`
 * from the after-hook once the task returns.
 *
 * This block must run for the ORCHESTRATOR (the only session that calls
 * the built-in `task` tool to dispatch subagents). It is gated by
 * `!isSubagent(sid)` so it cannot fire for subagent sessions — those
 * are blocked at the nested-task guard below.
 *
 * Verbatim from hooks.ts lines 162-309, with the trailing `return;`
 * at line 308 replaced by `return true;` so the dispatcher can decide
 * whether to fall through to the subagent guard.
 *
 * Returns `true` when the orchestrator path was consumed (dispatcher
 * must NOT fall through to the subagent guard). Returns `false` when
 * the caller is not on the orchestrator path (sid falsy, tool !== "task",
 * or caller is a subagent).
 */
export const applyOrchestratorReasoningPatch = async (params: {
  ctx: PluginContext;
  sid: string | undefined;
  tool: string | undefined;
  output: HookPayload;
}): Promise<boolean> => {
  const { ctx, sid, tool, output } = params;
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
              return true;
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
            const resolved = resolveReasoningOverride(
              tier,
              cfg.reasoningPolicy as unknown as import("../../reasoning/Reasoning.res.mjs").reasoningPolicyConfig | null,
              override as import("../../reasoning/Reasoning.res.mjs").reasoningLevel | null,
              signals,
            );
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
              const decision = selectAdaptiveLevel(
                signals,
                cfg.reasoningPolicy as unknown as import("../../reasoning/Reasoning.res.mjs").reasoningPolicyConfig | null,
              );
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
    return true;
  }

  return false;
};

/**
 * Subagent-only guard evaluation. Verbatim from hooks.ts lines 311-351.
 *
 * Two responsibilities:
 *   1. Nested-delegation fast-fail: a subagent session must never call the
 *      built-in `task` tool. Creating child sessions under a subagent
 *      session hangs the opencode runtime permanently.
 *   2. `guardBeforeCall` evaluation: enforce the per-tier guard policy
 *      against the subagent's tool call. On block, record a trajectory
 *      tool-event and throw with `res.message`.
 *
 * Fail-soft: guard-internal errors from `guardBeforeCall` are swallowed
 * (never break a real session on a guard-internal error).
 */
export const runSubagentGuard = async (params: {
  ctx: PluginContext;
  sid: string | undefined;
  tool: string | undefined;
  output: HookPayload;
}): Promise<void> => {
  const { ctx, sid, tool, output } = params;

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
      toolArgs: (output?.args as Record<string, unknown> | undefined) ?? null,
      store: ctx.guardStore,
      env: Object.fromEntries(
        Object.entries(process.env).map(([k, v]) => [k, v ?? null]),
      ) as Record<string, string | null>,
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
    throw new Error(res.message ?? "");
  }
};
