// ---------------------------------------------------------------------------
// ValidateReasoning_test.res — RED-first tests for REASONING validators.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Ports the REASONING section from src/router/config-validate.ts:
//   - validateReasoningPolicy: top-level dispatcher
//   - validateReasoningPolicyMode: reasoningPolicy.mode validation
//   - validateAdaptivePolicy: reasoningPolicy.adaptive validation
//   - validateKeywordRules: keywordRules array validation
//   - validateKeywordRule: individual keyword rule validation (with regex fail-fast)
//   - validateAdaptiveTierDefaults: tierDefaults validation
//   - validateAdaptiveSurfaceDecision: surfaceDecision validation
//
// Note: Void-returning validators that throw on error are tested via:
//   1. Valid-input tests (GREEN on success, RED on ReferenceError if not yet built)
//   2. TypeScript vitest tests for exact error messages
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

// For void-returning validators: call the function and use dummy assertion
// to signal pass. If the function throws, the test fails (unhandled exception).
// For GREEN phase: valid input -> no throw -> assertion(0, 0) -> PASS
// For RED phase: function missing -> ReferenceError -> test fails
let assertionNoThrow = (~operator: string, fn: unit => unit): unit =>
  assertion(~operator, (_a, _b) => true, { fn(); 0 }, 0)

// ---------------------------------------------------------------------------
// validateReasoningPolicy — top-level dispatcher
// ---------------------------------------------------------------------------

test("validateReasoningPolicy: accepts a valid reasoningPolicy object", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{reasoningPolicy: {mode: "static"}}`)
  assertionNoThrow(~operator="valid reasoningPolicy", () => ValidateReasoning.validateReasoningPolicy(dict))
})

test("validateReasoningPolicy: passes silently when reasoningPolicy is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{activePreset: "default"}`)
  assertionNoThrow(~operator="absent reasoningPolicy", () => ValidateReasoning.validateReasoningPolicy(dict))
})

// ---------------------------------------------------------------------------
// validateReasoningPolicyMode tests
// ---------------------------------------------------------------------------

test("validateReasoningPolicyMode: accepts mode 'static'", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "static"}`)
  assertionNoThrow(~operator="mode static", () => ValidateReasoning.validateReasoningPolicyMode(dict))
})

test("validateReasoningPolicyMode: accepts mode 'manual'", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "manual"}`)
  assertionNoThrow(~operator="mode manual", () => ValidateReasoning.validateReasoningPolicyMode(dict))
})

test("validateReasoningPolicyMode: accepts mode 'adaptive'", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "adaptive"}`)
  assertionNoThrow(~operator="mode adaptive", () => ValidateReasoning.validateReasoningPolicyMode(dict))
})

test("validateReasoningPolicyMode: passes silently when mode is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{otherField: "value"}`)
  assertionNoThrow(~operator="absent mode", () => ValidateReasoning.validateReasoningPolicyMode(dict))
})

// ---------------------------------------------------------------------------
// validateAdaptivePolicy tests
// ---------------------------------------------------------------------------

test("validateAdaptivePolicy: accepts a valid adaptive object", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {defaultLevel: "normal"}}`)
  assertionNoThrow(~operator="valid adaptive", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: passes silently when adaptive is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{mode: "static"}`)
  assertionNoThrow(~operator="absent adaptive", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: accepts trivialLevel as null", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {trivialLevel: null}}`)
  assertionNoThrow(~operator="trivialLevel null", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: accepts defaultLevel as null", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {defaultLevel: null}}`)
  assertionNoThrow(~operator="defaultLevel null", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: accepts valid keywordRules", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {keywordRules: [{keywords: ["bug"], level: "minimal"}]}}`)
  assertionNoThrow(~operator="valid keywordRules", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: accepts valid tierDefaults", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {tierDefaults: {fast: "minimal", heavy: "max"}}}`)
  assertionNoThrow(~operator="valid tierDefaults", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: accepts surfaceDecision as true", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {surfaceDecision: true}}`)
  assertionNoThrow(~operator="surfaceDecision true", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

test("validateAdaptivePolicy: accepts surfaceDecision as false", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{adaptive: {surfaceDecision: false}}`)
  assertionNoThrow(~operator="surfaceDecision false", () => ValidateReasoning.validateAdaptivePolicy(dict))
})

// ---------------------------------------------------------------------------
// validateKeywordRules — array-level tests
// ---------------------------------------------------------------------------

test("validateKeywordRules: accepts empty keywordRules array", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{keywordRules: []}`)
  assertionNoThrow(~operator="empty keywordRules", () => ValidateReasoning.validateKeywordRules(dict))
})

// ---------------------------------------------------------------------------
// validateKeywordRule — individual rule tests
// ---------------------------------------------------------------------------

test("validateKeywordRule: accepts valid rule with level", () => {
  let rule: Js.Json.t = %raw(`{keywords: ["bug", "error"], level: "minimal"}`)
  assertionNoThrow(~operator="valid rule", () => ValidateReasoning.validateKeywordRule(rule, 0))
})

test("validateKeywordRule: accepts rule with match field", () => {
  let rule: Js.Json.t = %raw(`{keywords: ["crash"], level: "minimal", match: "word"}`)
  assertionNoThrow(~operator="rule with match", () => ValidateReasoning.validateKeywordRule(rule, 0))
})

test("validateKeywordRule: accepts rule with excludeKeywords", () => {
  let rule: Js.Json.t = %raw(`{keywords: ["slow"], level: "normal", excludeKeywords: ["fast"]}`)
  assertionNoThrow(~operator="rule with excludeKeywords", () => ValidateReasoning.validateKeywordRule(rule, 0))
})

test("validateKeywordRule: accepts rule with match=stem (default)", () => {
  let rule: Js.Json.t = %raw(`{keywords: ["analyzing"], level: "elevated", match: "stem"}`)
  assertionNoThrow(~operator="rule with stem match", () => ValidateReasoning.validateKeywordRule(rule, 0))
})

test("validateKeywordRule: accepts rule with match=substring", () => {
  let rule: Js.Json.t = %raw(`{keywords: ["analyze"], level: "elevated", match: "substring"}`)
  assertionNoThrow(~operator="rule with substring match", () => ValidateReasoning.validateKeywordRule(rule, 0))
})

test("validateKeywordRule: accepts rule with match=regex (valid pattern)", () => {
  let rule: Js.Json.t = %raw(`{keywords: ["bug[0-9]+"], level: "minimal", match: "regex"}`)
  assertionNoThrow(~operator="valid regex", () => ValidateReasoning.validateKeywordRule(rule, 0))
})

// ---------------------------------------------------------------------------
// validateAdaptiveTierDefaults tests
// ---------------------------------------------------------------------------

test("validateAdaptiveTierDefaults: accepts empty tierDefaults", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierDefaults: {}}`)
  assertionNoThrow(~operator="empty tierDefaults", () => ValidateReasoning.validateAdaptiveTierDefaults(dict))
})

test("validateAdaptiveTierDefaults: accepts single tierDefault", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{tierDefaults: {fast: "minimal"}}`)
  assertionNoThrow(~operator="single tierDefault", () => ValidateReasoning.validateAdaptiveTierDefaults(dict))
})

test("validateAdaptiveTierDefaults: passes silently when tierDefaults is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{otherField: "value"}`)
  assertionNoThrow(~operator="absent tierDefaults", () => ValidateReasoning.validateAdaptiveTierDefaults(dict))
})

// ---------------------------------------------------------------------------
// validateAdaptiveSurfaceDecision tests
// ---------------------------------------------------------------------------

test("validateAdaptiveSurfaceDecision: passes silently when surfaceDecision is absent", () => {
  let dict: Js.Dict.t<Js.Json.t> = %raw(`{otherField: "value"}`)
  assertionNoThrow(~operator="absent surfaceDecision", () => ValidateReasoning.validateAdaptiveSurfaceDecision(dict))
})
