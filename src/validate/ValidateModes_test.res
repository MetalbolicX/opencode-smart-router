// ---------------------------------------------------------------------------
// ValidateModes_test.res — RED-first tests for MODES validators.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of the MODES section from src/router/config-validate.ts:
//   - validateModes: modes must be an object if present
//   - validateMode: mode must be an object; defaultTier/description must be strings
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
  assertion(
    ~operator,
    (_a, _b) => true,
    {
      fn()
      0
    },
    0,
  )

// ---------------------------------------------------------------------------
// validateModes tests
// ---------------------------------------------------------------------------

test("validateModes: accepts a modes object with one valid mode", () => {
  let dict: dict<JSON.t> = %raw(`{modes: {auto: {defaultTier: "fast", description: "Auto mode"}}}`)
  assertionNoThrow(~operator="valid single mode", () => ValidateModes.validateModes(dict))
})

test("validateModes: accepts a modes object with multiple valid modes", () => {
  let dict: dict<
    JSON.t,
  > = %raw(`{modes: {auto: {defaultTier: "fast", description: "Auto"}, careful: {defaultTier: "heavy", description: "Careful"}}}`)
  assertionNoThrow(~operator="valid multi mode", () => ValidateModes.validateModes(dict))
})

test("validateModes: accepts empty modes object", () => {
  let dict: dict<JSON.t> = %raw(`{modes: {}}`)
  assertionNoThrow(~operator="empty modes", () => ValidateModes.validateModes(dict))
})

// ---------------------------------------------------------------------------
// validateMode tests
// ---------------------------------------------------------------------------

test("validateMode: accepts a fully-specified valid mode", () => {
  let mode: dict<JSON.t> = %raw(`{defaultTier: "fast", description: "Fast auto mode"}`)
  assertionNoThrow(~operator="valid full mode", () => ValidateModes.validateMode("myMode", mode))
})

test("validateMode: accepts mode with minimal required fields", () => {
  let mode: dict<JSON.t> = %raw(`{defaultTier: "tier1", description: "Minimal mode"}`)
  assertionNoThrow(~operator="minimal mode", () => ValidateModes.validateMode("modeA", mode))
})
