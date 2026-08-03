// ---------------------------------------------------------------------------
// ValidatePresets.resi — Public interface for PRESETS validators.
//
// Ports the PRESETS section from src/router/config-validate.ts:
//   - validatePresets: presets must be a non-null object with at least one key
//   - validatePreset: each preset must be an object, iterates over tiers
//   - validateTier: tier.model (non-empty + slash format), description, whenToUse
//
// ABI boundary: input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// Validate the top-level presets block.
let validatePresets: dict<JSON.t> => unit

// Validate a single preset (named by presetName for error messages).
let validatePreset: (string, dict<JSON.t>) => unit

// Validate a single tier within a preset.
let validateTier: (string, string, dict<JSON.t>) => unit
