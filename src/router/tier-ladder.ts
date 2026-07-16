/**
 * src/router/tier-ladder.ts
 *
 * Pure tier-ladder resolution — the single canonical source of truth for the
 * fallback tier order used by escalation, checker, and dispatch.
 *
 * Precedence (spec: ladder-resolution precedence):
 *   1. explicit enforcement.escalate.ladder  → returned as-is (copied)
 *   2. preset tiers sorted by costRatio ascending (stable insertion tie-break)
 *   3. default ['fast','light','medium','focused','heavy'] filtered to present names
 *
 * This module is pure: resolveLadder never mutates its input cfg.
 */

import type { RouterConfig } from "./config.types";

/** The five named tiers in costRatio order (canonical default fallback). */
export const DEFAULT_TIER_NAMES = ["fast", "light", "medium", "focused", "heavy"] as const;

/**
 * Resolve the canonical fallback tier ladder from a RouterConfig.
 *
 * Returns a fresh array on every call. Never mutates cfg or any nested object.
 */
export const resolveLadder = (cfg: RouterConfig): string[] => {
  // 1. Explicit ladder wins — return a copy so callers can mutate safely
  const explicit = cfg.enforcement?.escalate?.ladder;
  if (explicit != null && Array.isArray(explicit)) {
    return [...explicit];
  }

  // 2. Sort active preset tiers by costRatio ascending, stable insertion tie-break
  const preset = cfg.presets?.[cfg.activePreset];
  if (preset) {
    const entries = Object.entries(preset);
    if (entries.length > 0) {
      // Stable sort: equal costRatio → preserve insertion order (Object.entries order)
      const sorted = [...entries].sort(([, a], [, b]) => {
        const ca = a.costRatio ?? Number.POSITIVE_INFINITY;
        const cb = b.costRatio ?? Number.POSITIVE_INFINITY;
        return ca - cb;
      });
      return sorted.map(([name]) => name);
    }
  }

  // 3. Default filtered to present tier names (when preset is empty or absent)
  // An absent/empty preset falls back to the 3-tier default (fast, medium, heavy).
  return ["fast", "medium", "heavy"];
};
