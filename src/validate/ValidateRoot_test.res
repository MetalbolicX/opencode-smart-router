// ---------------------------------------------------------------------------
// ValidateRoot_test.res — RED-first tests for ValidateRoot validators.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of the ROOT section from src/router/config-validate.ts:
//   - validateRootFields: activePreset must be a non-empty string
//   - validateRulesAndDefaultTier: rules must be array of strings,
//     defaultTier must be a string
//
// Note: Void-returning validators that throw on error are tested via:
//   1. Valid-input tests (GREEN on success, RED on ReferenceError if not yet built)
//   2. TypeScript vitest tests (test/unit/validate-root.test.ts) for exact error messages
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

// For void-returning validators: call the function and use dummy assertion
// to signal pass. If the function throws, the test fails (unhandled exception).
// For GREEN phase: valid input → no throw → assertion(0, 0) → PASS
// For RED phase: function missing → ReferenceError → test fails
let assertionNoThrow = (~operator: string, fn: unit => unit): unit =>
  assertion(~operator, (_a, _b) => true, { fn(); 0 }, 0)

// ---------------------------------------------------------------------------
// validateRootFields tests
// ---------------------------------------------------------------------------

test("validateRootFields: accepts non-empty string activePreset", () => {
  // Build a minimal valid dict and call validateRootFields
  let dict = Js.Dict.empty()
  Js.Dict.set(dict, "activePreset", Js.Json.string("anthropic"))
  assertionNoThrow(~operator="valid activePreset", () => ValidateRoot.validateRootFields(dict))
})

test("validateRootFields: accepts any non-empty string preset name", () => {
  let dict = Js.Dict.empty()
  Js.Dict.set(dict, "activePreset", Js.Json.string("my-preset"))
  assertionNoThrow(~operator="non-empty string", () => ValidateRoot.validateRootFields(dict))
})

// ---------------------------------------------------------------------------
// validateRulesAndDefaultTier tests
// ---------------------------------------------------------------------------

test("validateRulesAndDefaultTier: accepts rules array + string defaultTier", () => {
  let dict = Js.Dict.empty()
  Js.Dict.set(dict, "rules", Js.Json.stringArray(["rule1", "rule2"]))
  Js.Dict.set(dict, "defaultTier", Js.Json.string("fast"))
  assertionNoThrow(~operator="valid rules+defaultTier", () => ValidateRoot.validateRulesAndDefaultTier(dict))
})

test("validateRulesAndDefaultTier: accepts empty rules array", () => {
  let dict = Js.Dict.empty()
  Js.Dict.set(dict, "rules", Js.Json.stringArray([]))
  Js.Dict.set(dict, "defaultTier", Js.Json.string("medium"))
  assertionNoThrow(~operator="empty rules array", () => ValidateRoot.validateRulesAndDefaultTier(dict))
})

test("validateRulesAndDefaultTier: accepts single-rule array", () => {
  let dict = Js.Dict.empty()
  Js.Dict.set(dict, "rules", Js.Json.stringArray(["only-rule"]))
  Js.Dict.set(dict, "defaultTier", Js.Json.string("heavy"))
  assertionNoThrow(~operator="single rule", () => ValidateRoot.validateRulesAndDefaultTier(dict))
})
