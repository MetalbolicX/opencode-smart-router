// ---------------------------------------------------------------------------
// src/reasoning/policy.ts — Resolve an effective reasoning override for a tier
// given the configured policy mode and a per-session override.
//
// This is the SINGLE place policy mode semantics live. The function is pure:
// no IO, no mutation, no module-level state. The runtime hooks
// (`src/plugin/runtime.ts`) and the `/reasoning` command handler both call it
// with the same inputs and get the same outputs.
//
// Modes:
//   - `static`   → ALWAYS null (primary regression guard). Even if a session
//                  override exists, static mode ignores it and the agent def
//                  is left exactly as `registerTierAgents` produced it. This
//                  preserves today's behaviour when `reasoningPolicy` is
//                  absent or `mode === "static"`.
//   - `manual`   → resolve `sessionOverride ?? policy.defaultLevel`, translate
//                  through the tier's capability. If both are undefined → null
//                  (no-op).
//   - `adaptive` → STUB. Returns null. A future plan will wire an adaptive
//                  engine that picks the level based on task class / risk
//                  signals. Until then, adaptive mode behaves identically to
//                  no override.
// ---------------------------------------------------------------------------

import type { ReasoningPolicyConfig, TierConfig } from "../router/config.types.js";
import { inferCapability, type ReasoningLevel } from "./capability.js";
import { type ResolvedReasoning, translateLevel } from "./translate.js";

/**
 * Resolve the effective reasoning patch for a tier under the configured policy.
 *
 * The `sessionOverride` is sourced from `reasoningStore.get(sessionID)`. The
 * hook layer decides whether to thread it (manual mode reads it; static mode
 * ignores it; adaptive mode ignores it for now).
 *
 * Returns `null` when:
 *   - the policy mode is `static` or `adaptive` (no override applied), OR
 *   - the resolved level is missing AND no `defaultLevel` is configured, OR
 *   - the tier's capability cannot satisfy the level (`none`, or `binary` with
 *     no baseline for a low-rank level — see `translateLevel`).
 *
 * `surfaceLimits` is intentionally NOT consulted here — surfacing is a
 * presentation concern owned by the `/reasoning` command handler and the
 * runtime log layer. The flag's only effect on this function is that the
 * resolved patch is identical regardless of its value (proved in
 * `reasoning-policy.test.ts`).
 */
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride?: ReasoningLevel,
): ResolvedReasoning => {
  const mode = policy?.mode ?? "static";
  // Primary regression guard: static mode is a hard no-op, regardless of any
  // session override. This keeps `pnpm test -- router-agents` identical to
  // pre-Plan-010 behaviour when no `reasoningPolicy` is configured.
  if (mode !== "manual") return null;

  const level = sessionOverride ?? policy?.defaultLevel;
  if (!level) return null;

  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
};
