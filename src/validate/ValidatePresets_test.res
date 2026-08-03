// ---------------------------------------------------------------------------
// ValidatePresets_test.res — RED-first tests for PRESETS validators.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of the PRESETS section from src/router/config-validate.ts:
//   - validatePresets: presets must be a non-null object with at least one key
//   - validatePreset: each preset must be an object
//   - validateTier: tier.model (non-empty + slash format), description, whenToUse
//
// Note: Void-returning validators that throw on error are tested via:
//   1. Valid-input tests (GREEN on success, RED on ReferenceError if not yet built)
//   2. TypeScript vitest tests for exact error messages
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers (mirrors ValidateRoot_test.res pattern)
// ---------------------------------------------------------------------------

// For void-returning validators: call the function and use dummy assertion
// to signal pass. If the function throws, the test fails (unhandled exception).
// For GREEN phase: valid input → no throw → assertion(0, 0) → PASS
// For RED phase: function missing → ReferenceError → test fails
let assertionNoThrow = (~operator: string, fn: unit => unit): unit =>
  assertion(~operator, (_a, _b) => true, { fn(); 0 }, 0)

// ---------------------------------------------------------------------------
// validatePresets tests
// ---------------------------------------------------------------------------

test("validatePresets: accepts a valid presets object with one preset", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{presets: {fast: {tier1: {model: "anthropic/claude-3-5-sonnet", description: "Fast tier", whenToUse: ["quick tasks"]}}}}`)
  assertionNoThrow(~operator="valid single-preset", () => ValidatePresets.validatePresets(dict))
})

test("validatePresets: accepts multiple presets", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{presets: {fast: {tier1: {model: "anthropic/claude-3-5-sonnet", description: "Fast", whenToUse: ["quick"]}}, heavy: {tier1: {model: "anthropic/claude-3-5-opus", description: "Heavy", whenToUse: ["complex"]}}}}`)
  assertionNoThrow(~operator="valid multi-preset", () => ValidatePresets.validatePresets(dict))
})

// ---------------------------------------------------------------------------
// validatePreset tests
// ---------------------------------------------------------------------------

test("validatePreset: accepts a preset with a single tier", () => {
  let preset: Js.Dict.t<Js.Json.t> = %raw(`{standard: {model: "openai/gpt-4o", description: "Standard tier", whenToUse: ["general"]}}`)
  assertionNoThrow(~operator="preset single tier", () => ValidatePresets.validatePreset("myPreset", preset))
})

test("validatePreset: accepts a preset with multiple tiers", () => {
  let preset: Js.Dict.t<Js.Json.t> = %raw(`{tier1: {model: "openai/gpt-4o", description: "Standard", whenToUse: ["general"]}, tier2: {model: "anthropic/claude-3-5-opus", description: "Premium", whenToUse: ["complex"]}}`)
  assertionNoThrow(~operator="preset multi tier", () => ValidatePresets.validatePreset("myPreset", preset))
})

// ---------------------------------------------------------------------------
// validateTier tests
// ---------------------------------------------------------------------------

test("validateTier: accepts a fully-specified valid tier", () => {
  let tier: Js.Dict.t<Js.Json.t> = %raw(`{model: "anthropic/claude-3-5-sonnet-20241022", description: "Fast and capable", whenToUse: ["quick tasks", "simple queries"]}`)
  assertionNoThrow(~operator="valid full tier", () => ValidatePresets.validateTier("myPreset", "fast", tier))
})

test("validateTier: accepts model with provider/model slash format", () => {
  let tier: Js.Dict.t<Js.Json.t> = %raw(`{model: "x/x", description: "Minimal", whenToUse: ["test"]}`)
  assertionNoThrow(~operator="valid slash model", () => ValidatePresets.validateTier("myPreset", "x", tier))
})

test("validateTier: accepts whenToUse array with single element", () => {
  let tier: Js.Dict.t<Js.Json.t> = %raw(`{model: "anthropic/claude-3-5-sonnet", description: "Desc", whenToUse: ["only"]}`)
  assertionNoThrow(~operator="single whenToUse", () => ValidatePresets.validateTier("myPreset", "t1", tier))
})
