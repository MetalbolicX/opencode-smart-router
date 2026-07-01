// ---------------------------------------------------------------------------
// src/reasoning/translate.ts — Translate a normalized reasoning level into a
// provider-specific patch, routed by the capability's `field` channel.
//
// Pure function. No router state, no side effects, no IO. Policy resolution
// (static / manual / adaptive) lives in `policy.ts` (Phase 2); the surface
// detected by this module is purely "given a capability + a level, what patch
// would I emit if the policy asked for one?".
// ---------------------------------------------------------------------------

import type { ReasoningCapability, ReasoningLevel } from "./capability.js";

/**
 * Provider-specific reasoning patch to apply on top of the static agent def.
 * Exactly one of `variant` or `options` MAY be set per call (a given capability
 * routes through one channel only — see `cap.field`).
 *
 * `null` is the canonical "no-op / capability can't satisfy this level"
 * sentinel. Callers honor `surfaceLimits` to decide whether to emit a note.
 */
export type ResolvedReasoning = { variant?: string; options?: Record<string, unknown> } | null;

/**
 * Discrete input rank. Out-of-range ranks (e.g. from `Math.round`) are clamped
 * downstream via `Math.min(idx, len-1)` so this stays a trivial lookup.
 */
const DISCRETE_RANK: Record<ReasoningLevel, number> = {
  minimal: 0,
  normal: 1,
  elevated: 2,
  max: 3,
};

/**
 * Translate a normalized reasoning level into the provider-specific patch for
 * this capability. Routes output by `cap.field`:
 *
 *   - `field: "variant"`               → `ResolvedReasoning.variant`
 *   - `field: "reasoning.effort"`      → `ResolvedReasoning.options.reasoning_effort`
 *   - `field: "thinking.budgetTokens"` → `ResolvedReasoning.options.budget_tokens`
 *   - `kind: "none"`                   → `null` (never mutated; silent no-op)
 *
 * Discrete ladders clamp to the nearest available level via
 *   `Math.round((rank / 3) * (len - 1))`
 * so a 2-level ladder still produces a valid pickup for every normalized
 * input. `budgeted` falls back to `recommended["normal"]` when the requested
 * level has no entry, and returns `null` if even the fallback is absent.
 */
export const translateLevel = (
  cap: ReasoningCapability,
  level: ReasoningLevel,
): ResolvedReasoning => {
  switch (cap.kind) {
    case "none":
      return null;

    case "binary": {
      // minimal | normal → baseline (or null if no baseline declared)
      if (level === "elevated" || level === "max") {
        return { variant: cap.elevated };
      }
      return cap.baseline ? { variant: cap.baseline } : null;
    }

    case "discrete": {
      const target = DISCRETE_RANK[level];
      const rawIdx = Math.round((target / 3) * (cap.levels.length - 1));
      const idx = Math.min(rawIdx, cap.levels.length - 1);
      const picked = cap.levels[idx];
      if (picked === undefined) return null;

      return cap.field === "variant"
        ? { variant: picked }
        : { options: { reasoning_effort: picked } };
    }

    case "budgeted": {
      const tokens = cap.recommended[level] ?? cap.recommended.normal;
      if (tokens === undefined) return null;
      return { options: { budget_tokens: tokens } };
    }
  }
};
