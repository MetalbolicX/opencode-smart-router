// ---------------------------------------------------------------------------
// ValidateSimple.resi — Public interface for SIMPLE validators.
//
// Ports the SIMPLE section from src/router/config-validate.ts:
//   - validateTierCaps: tierCaps values must be positive integers
//   - validateTierPrompts: tierPrompts values must be strings
//   - validateTaskPatterns: taskPatterns values must be arrays of strings
//
// ABI boundary: input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// Validate the tierCaps block: each cap must be a finite positive integer.
// tierCaps is optional — no-op if absent.
let validateTierCaps: dict<JSON.t> => unit

// Validate the tierPrompts block: each prompt must be a string.
// tierPrompts is optional — no-op if absent.
let validateTierPrompts: dict<JSON.t> => unit

// Validate the taskPatterns block: each patterns value must be an array of strings.
// taskPatterns is optional — no-op if absent.
let validateTaskPatterns: dict<JSON.t> => unit
