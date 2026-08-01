/*
 * TierLadderHelpers.res
 *
 * Internal helpers for tier-ladder resolution.
 */

let getCostRatio = (tier: Config.tierConfig): float =>
  switch tier.costRatio {
  | Some(r) => r
  | None => 1.0e15
  }

let defaultThreeTier = (): array<string> => ["fast", "medium", "heavy"]

let resolveFromPreset = (cfg: Config.t): array<string> => {
  let preset = Js.Dict.get(cfg.presets, cfg.activePreset)
  switch preset {
  | Some(p) => {
      let tierNames = Js.Dict.keys(p)
      let len = Array.length(tierNames)
      if len > 0 {
        // Build array of (name, costRatio) pairs
        let pairs = Array.map(tierNames, name => {
          let tier = Dict.getUnsafe(p, name)
          (name, getCostRatio(tier))
        })
        // Sort by costRatio ascending
        let sorted = Array.toSorted(pairs, ((_, costA), (_, costB)) => costA -. costB)
        Array.map(sorted, ((name, _)) => name)
      } else {
        defaultThreeTier()
      }
    }
  | None => defaultThreeTier()
  }
}
