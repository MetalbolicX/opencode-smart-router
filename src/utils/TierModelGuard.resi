/*
 * TierModelGuard.resi
 *
 * Public API for tier-model guard resolution.
 */

type model = {
  providerID: string,
  modelID: string,
}

/*
 * Result of `resolveTierModelGuard`. Discriminated by `ok`.
 */
type result = {
  ok: bool,
  model?: model,
  reason?: string,
}

/*
 * Resolve a tier name to `{ providerID, modelID }` via the active preset,
 * returning a discriminated result.
 *
 * Failure modes (any of which => Error):
 *   - The tier name is absent from the active preset.
 *   - The tier's `model` field is missing or not a string.
 *   - The model string is malformed (no `provider/model` slash, or the slash
 *     is at the first/last position so provider or model would be empty).
 *
 * The canonical reason is `"invalid model or provider configuration"` so
 * every fail-closed path produces the same operator-visible string.
 *
 * This module is intentionally pure: it does NOT log, does NOT throw,
 * and does NOT format the caller-visible message.
 */
let resolveTierModelGuard: (Config.t, string) => result
