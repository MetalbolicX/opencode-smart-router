/*
 * TierLadder.resi
 *
 * Public API for tier-ladder resolution.
 */

type t = Config.t

/*
 * The five named tiers in costRatio order (canonical default fallback).
 */
let defaultTierNames: array<string>

/*
 * Resolve the canonical fallback tier ladder from a RouterConfig.
 *
 * Precedence:
 *   1. explicit enforcement.escalate.ladder  → returned as-is (copied)
 *   2. preset tiers sorted by costRatio ascending (stable insertion tie-break)
 *   3. default ["fast","medium","heavy"] when preset is absent/empty
 *
 * Returns a fresh array on every call. Never mutates cfg.
 */
let resolveLadder: Config.t => array<string>
