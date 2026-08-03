// ---------------------------------------------------------------------------
// ValidateRoot.resi — Public interface for ROOT validators.
//
// Ports the ROOT section from src/router/config-validate.ts:
//   - validateRootFields: validates activePreset is a non-empty string
//   - validateRulesAndDefaultTier: validates rules is array of strings
//     and defaultTier is a string
//
// ABI boundary: input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// Validate the root-level scalar fields: activePreset must be a non-empty string.
let validateRootFields: (Js.Dict.t<Js.Json.t>) => unit

// Validate rules (array of strings) and defaultTier (string).
let validateRulesAndDefaultTier: (Js.Dict.t<Js.Json.t>) => unit
