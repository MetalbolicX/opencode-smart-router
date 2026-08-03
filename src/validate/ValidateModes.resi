// ---------------------------------------------------------------------------
// ValidateModes.resi — Public interface for MODES validators.
//
// Ports the MODES section from src/router/config-validate.ts:
//   - validateModes: modes must be an object if present
//   - validateMode: mode must be an object; defaultTier/description must be strings
//
// ABI boundary: input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// Validate the top-level modes block.
let validateModes: dict<JSON.t> => unit

// Validate a single mode (named by modeName for error messages).
let validateMode: (string, dict<JSON.t>) => unit
