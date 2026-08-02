// ---------------------------------------------------------------------------
// ValidateSimple_test.res — RED-first tests for SIMPLE validators.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of the SIMPLE section from src/router/config-validate.ts:
//   - validateTierCaps: tierCaps values must be positive integers (>= 1)
//   - validateTierPrompts: tierPrompts values must be strings
//   - validateTaskPatterns: taskPatterns values must be arrays of strings
//
// Note: Void-returning validators that throw on error are tested via:
//   1. Valid-input tests (GREEN on success, RED on ReferenceError if not yet built)
//   2. TypeScript vitest tests for exact error messages
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers (mirrors ValidateModes_test.res pattern)
// ---------------------------------------------------------------------------

// For void-returning validators: call the function and use dummy assertion
// to signal pass. If the function throws, the test fails (unhandled exception).
// For GREEN phase: valid input → no throw → assertion(0, 0) → PASS
// For RED phase: function missing → ReferenceError → test fails
let assertionNoThrow = (~operator: string, fn: unit => unit): unit =>
  assertion(~operator, (_a, _b) => true, { fn(); 0 }, 0)

// ---------------------------------------------------------------------------
// validateTierCaps tests
// ---------------------------------------------------------------------------

test("validateTierCaps: accepts a valid tierCaps object with one cap", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierCaps: {fast: 100, heavy: 50}}`)
  assertionNoThrow(~operator="valid caps", () => ValidateSimple.validateTierCaps(dict))
})

test("validateTierCaps: accepts tierCaps with various positive integers", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierCaps: {tier1: 1, tier2: 10, tier3: 1000}}`)
  assertionNoThrow(~operator="various positive ints", () => ValidateSimple.validateTierCaps(dict))
})

test("validateTierCaps: passes silently when tierCaps is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{activePreset: "default"}`)
  assertionNoThrow(~operator="absent tierCaps", () => ValidateSimple.validateTierCaps(dict))
})

test("validateTierCaps: accepts tierCaps with large positive integers", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierCaps: {big: 999999999}}`)
  assertionNoThrow(~operator="large positive int", () => ValidateSimple.validateTierCaps(dict))
})

// ---------------------------------------------------------------------------
// validateTierPrompts tests
// ---------------------------------------------------------------------------

test("validateTierPrompts: accepts a valid tierPrompts object with one prompt", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierPrompts: {fast: "Use fast model", heavy: "Use heavy model"}}`)
  assertionNoThrow(~operator="valid prompts", () => ValidateSimple.validateTierPrompts(dict))
})

test("validateTierPrompts: accepts tierPrompts with various string values", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierPrompts: {tier1: "", tier2: "Hello", tier3: "Multi-word prompt"}}`)
  assertionNoThrow(~operator="various string prompts", () => ValidateSimple.validateTierPrompts(dict))
})

test("validateTierPrompts: passes silently when tierPrompts is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{activePreset: "default"}`)
  assertionNoThrow(~operator="absent tierPrompts", () => ValidateSimple.validateTierPrompts(dict))
})

test("validateTierPrompts: accepts tierPrompts with empty string values", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierPrompts: {empty: ""}}`)
  assertionNoThrow(~operator="empty string prompt", () => ValidateSimple.validateTierPrompts(dict))
})

// ---------------------------------------------------------------------------
// validateTaskPatterns tests
// ---------------------------------------------------------------------------

test("validateTaskPatterns: accepts a valid taskPatterns object with one pattern array", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{taskPatterns: {read: ["*.md", "*.txt"], write: ["*.ts"]}}`)
  assertionNoThrow(~operator="valid patterns", () => ValidateSimple.validateTaskPatterns(dict))
})

test("validateTaskPatterns: accepts taskPatterns with empty arrays", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{taskPatterns: {empty: []}}`)
  assertionNoThrow(~operator="empty pattern arrays", () => ValidateSimple.validateTaskPatterns(dict))
})

test("validateTaskPatterns: passes silently when taskPatterns is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{activePreset: "default"}`)
  assertionNoThrow(~operator="absent taskPatterns", () => ValidateSimple.validateTaskPatterns(dict))
})

test("validateTaskPatterns: accepts taskPatterns with multiple patterns", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{taskPatterns: {docs: ["*.md", "*.rst", "*.adoc"]}}`)
  assertionNoThrow(~operator="multi-pattern array", () => ValidateSimple.validateTaskPatterns(dict))
})
