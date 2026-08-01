/*
 * TierLadder.res
 *
 * Pure tier-ladder resolution — the single canonical source of truth for the
 * fallback tier order used by escalation, checker, and dispatch.
 *
 * Precedence (spec: ladder-resolution precedence):
 *   1. explicit enforcement.escalate.ladder  → returned as-is (copied)
 *   2. preset tiers sorted by costRatio ascending (stable insertion tie-break)
 *   3. default ["fast","medium","heavy"] when preset is absent/empty
 *
 * This module is pure: resolveLadder never mutates its input cfg.
 */

type t = Config.t

let defaultTierNames: array<string> = ["fast", "light", "medium", "focused", "heavy"]

let resolveLadder = (cfg: Config.t): array<string> => {
  // 1. Explicit ladder wins — return a copy so callers can mutate safely
  switch cfg.enforcement {
  | Some(e) =>
    switch e.escalate {
    | Some(esc) =>
      switch esc.ladder {
      | Some(arr) => Array.copy(arr)
      | None => TierLadderHelpers.resolveFromPreset(cfg)
      }
    | None => TierLadderHelpers.resolveFromPreset(cfg)
    }
  | None => TierLadderHelpers.resolveFromPreset(cfg)
  }
}
