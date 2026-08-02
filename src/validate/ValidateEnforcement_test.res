// ---------------------------------------------------------------------------
// ValidateEnforcement_test.res — RED-first tests for ENFORCEMENT validators.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Ports the ENFORCEMENT section from src/router/config-validate.ts:
//   - validateEnforcement: top-level dispatcher
//   - validateEnforcementMode: enforcement.mode validation
//   - validateEnforcementVerify: enforcement.verify validation
//   - validateEnforcementEscalate: enforcement.escalate validation
//   - validateEnforcementPerTier: enforcement.perTier validation
//   - validateEnforcementGuard: enforcement.guard validation
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
// For GREEN phase: valid input -> no throw -> assertion(0, 0) -> PASS
// For RED phase: function missing -> ReferenceError -> test fails
let assertionNoThrow = (~operator: string, fn: unit => unit): unit =>
  assertion(~operator, (_a, _b) => true, { fn(); 0 }, 0)

// ---------------------------------------------------------------------------
// validateEnforcement — top-level dispatcher
// ---------------------------------------------------------------------------

test("validateEnforcement: accepts a valid enforcement object", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{enforcement: {mode: "advisory"}}`)
  assertionNoThrow(~operator="valid enforcement", () => ValidateEnforcement.validateEnforcement(dict))
})

test("validateEnforcement: passes silently when enforcement is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{activePreset: "default"}`)
  assertionNoThrow(~operator="absent enforcement", () => ValidateEnforcement.validateEnforcement(dict))
})

// ---------------------------------------------------------------------------
// validateEnforcementMode tests
// ---------------------------------------------------------------------------

test("validateEnforcementMode: accepts mode 'off'", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "off"}`)
  assertionNoThrow(~operator="mode off", () => ValidateEnforcement.validateEnforcementMode(dict))
})

test("validateEnforcementMode: accepts mode 'advisory'", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "advisory"}`)
  assertionNoThrow(~operator="mode advisory", () => ValidateEnforcement.validateEnforcementMode(dict))
})

test("validateEnforcementMode: accepts mode 'enforced'", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "enforced"}`)
  assertionNoThrow(~operator="mode enforced", () => ValidateEnforcement.validateEnforcementMode(dict))
})

test("validateEnforcementMode: passes silently when mode is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{otherField: "value"}`)
  assertionNoThrow(~operator="absent mode", () => ValidateEnforcement.validateEnforcementMode(dict))
})

// ---------------------------------------------------------------------------
// validateEnforcementVerify tests
// ---------------------------------------------------------------------------

test("validateEnforcementVerify: accepts a valid verify block", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{verify: {require: "whenDoDPresent"}}`)
  assertionNoThrow(~operator="valid verify", () => ValidateEnforcement.validateEnforcementVerify(dict))
})

test("validateEnforcementVerify: accepts verify with all optional fields", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{verify: {require: "always", preferDeterministic: true, graderPolicy: "atLeastProducerTier"}}`)
  assertionNoThrow(~operator="full verify", () => ValidateEnforcement.validateEnforcementVerify(dict))
})

test("validateEnforcementVerify: passes silently when verify is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "off"}`)
  assertionNoThrow(~operator="absent verify", () => ValidateEnforcement.validateEnforcementVerify(dict))
})

// ---------------------------------------------------------------------------
// validateEnforcementEscalate tests
// ---------------------------------------------------------------------------

test("validateEnforcementEscalate: accepts a valid escalate block with ladder", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{escalate: {ladder: ["tier1", "tier2"]}}`)
  assertionNoThrow(~operator="valid escalate", () => ValidateEnforcement.validateEnforcementEscalate(dict))
})

test("validateEnforcementEscalate: accepts floorTier as string", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{escalate: {floorTier: "fast"}}`)
  assertionNoThrow(~operator="floorTier string", () => ValidateEnforcement.validateEnforcementEscalate(dict))
})

test("validateEnforcementEscalate: accepts floorTier as null", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{escalate: {floorTier: null}}`)
  assertionNoThrow(~operator="floorTier null", () => ValidateEnforcement.validateEnforcementEscalate(dict))
})

test("validateEnforcementEscalate: passes silently when escalate is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "off"}`)
  assertionNoThrow(~operator="absent escalate", () => ValidateEnforcement.validateEnforcementEscalate(dict))
})

test("validateEnforcementEscalate: accepts zero maxAttemptsPerTier", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{escalate: {maxAttemptsPerTier: 0}}`)
  assertionNoThrow(~operator="zero maxAttemptsPerTier", () => ValidateEnforcement.validateEnforcementEscalate(dict))
})

// ---------------------------------------------------------------------------
// validateEnforcementPerTier tests
// ---------------------------------------------------------------------------

test("validateEnforcementPerTier: accepts a valid perTier object", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{perTier: {fast: "off", heavy: "enforced"}}`)
  assertionNoThrow(~operator="valid perTier", () => ValidateEnforcement.validateEnforcementPerTier(dict))
})

test("validateEnforcementPerTier: passes silently when perTier is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "off"}`)
  assertionNoThrow(~operator="absent perTier", () => ValidateEnforcement.validateEnforcementPerTier(dict))
})

// ---------------------------------------------------------------------------
// validateEnforcementGuard tests
// ---------------------------------------------------------------------------

test("validateEnforcementGuard: accepts a valid guard block", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{guard: {budget: 100, blockScriptWrites: true}}`)
  assertionNoThrow(~operator="valid guard", () => ValidateEnforcement.validateEnforcementGuard(dict))
})

test("validateEnforcementGuard: accepts guard with all optional fields", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{guard: {readDraftCap: 5, sameOpRetryCap: 3, blockSelfScript: true, deliverableFirst: false, budget: 500, blockScriptWrites: false}}`)
  assertionNoThrow(~operator="full guard", () => ValidateEnforcement.validateEnforcementGuard(dict))
})

test("validateEnforcementGuard: passes silently when guard is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "off"}`)
  assertionNoThrow(~operator="absent guard", () => ValidateEnforcement.validateEnforcementGuard(dict))
})
