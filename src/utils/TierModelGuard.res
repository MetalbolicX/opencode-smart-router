// ---------------------------------------------------------------------------
// TierModelGuard.res — Shared tier-resolution guard.
//
// Resolves a tier name to `{ providerID, modelID }` via the active preset,
// returning a discriminated result so callers (delegate.ts and dispatch.ts)
// keep ownership of telemetry, attempt counts, and return contracts.
//
// This module replicates the `tierModel()` logic from `dispatch.ts` directly
// to avoid a circular import — dispatch.ts imports resolveTierModelGuard,
// which would then need tierModel, which lives in dispatch.ts.
//
// The canonical reason `"invalid model or provider configuration"` is the
// single string used across all fail-closed paths, regardless of which caller
// invoked the guard.
//
// Uses records (not variants) so the compiled JS object has the exact
// `ok` / `reason` shape that the TS interface expects.
// ---------------------------------------------------------------------------

type model = {
  providerID: string,
  modelID: string,
}

/*
 * Result of `resolveTierModelGuard`. Discriminated by `ok`.
 * Uses a record type so it compiles to { ok: true, model: {...} } or
 * { ok: false, reason: "..." } — matching the original TS interface.
 */
type result = {
  ok: bool,
  model?: model,
  reason?: string,
}

let resolveTierModelGuard = (cfg: Config.t, tierName: string): result => {
  // Get active preset tiers — same logic as dispatch.ts getActiveTiers + tierModel
  switch Dict.get(cfg.presets, cfg.activePreset) {
  | None => {ok: false, reason: "invalid model or provider configuration"}
  | Some(tiers) =>
    switch Dict.get(tiers, tierName) {
    | None => {ok: false, reason: "invalid model or provider configuration"}
    | Some(tier) =>
      // model field must be a non-empty string with a slash not at boundaries
      let modelStr = tier.model
      let slashPos = modelStr->String.indexOf("/")
      if slashPos <= 0 || slashPos >= String.length(modelStr) - 1 {
        {ok: false, reason: "invalid model or provider configuration"}
      } else {
        {
          ok: true,
          model: {
            providerID: modelStr->String.slice(~start=0, ~end=slashPos),
            modelID: modelStr->String.slice(~start=slashPos + 1, ~end=String.length(modelStr)),
          },
        }
      }
    }
  }
}
