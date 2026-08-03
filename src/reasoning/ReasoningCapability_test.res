// ---------------------------------------------------------------------------
// ReasoningCapability_test.res — RED-first parity tests for ReasoningCapability.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of capability.ts fixtures — inference precedence, capability channels,
// binary/discrete/budgeted/none variants.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let assertionEqual = (~operator: string, expected: 'a, actual: 'a): unit =>
  assertion(~operator, (a, b) => a === b, actual, expected)

let intEqual = (a: int, b: int): unit => assertion(~operator="int", (x, y) => x === y, a, b)

let stringEqual = (actual: string, expected: string): unit =>
  assertion(~operator="string", (a, b) => a === b, actual, expected)

// ---------------------------------------------------------------------------
// inferCapability — none (default)
// ---------------------------------------------------------------------------

test("inferCapability: no reasoning fields => none", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    description: "standard tier",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "none")
})

test("inferCapability: unknown variant => none", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "custom-unknown-variant",
    description: "unknown variant",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "none")
})

// ---------------------------------------------------------------------------
// inferCapability — discrete via reasoning.effort
// ---------------------------------------------------------------------------

test("inferCapability: reasoning.effort set => discrete/reasoning.effort", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    reasoning: {effort: "medium"},
    description: "effort tier",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "discrete")
  stringEqual(result.field->Belt.Option.getWithDefault(""), "reasoning.effort")
  assertionEqual(
    ~operator="levels_len",
    result.levels->Belt.Option.getWithDefault([])->Array.length,
    3,
  )
})

// ---------------------------------------------------------------------------
// inferCapability — budgeted via thinking.budgetTokens
// ---------------------------------------------------------------------------

test("inferCapability: thinking.budgetTokens set => budgeted/thinking.budgetTokens", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    thinking: {budgetTokens: 4096},
    description: "budget tier",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "budgeted")
  stringEqual(result.field->Belt.Option.getWithDefault(""), "thinking.budgetTokens")
  // recommended ladder is the default { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 }
  let rec__ = result.recommended
  let rec_normal = switch rec__ {
  | Some(r) => Dict.get(r, "normal")
  | None => None
  }
  switch rec_normal {
  | Some(v) => intEqual(Float.toInt(v), 4096)
  | None => intEqual(1, 0) // fail deliberately
  }
})

// ---------------------------------------------------------------------------
// inferCapability — discrete via positional variant
// ---------------------------------------------------------------------------

test("inferCapability: positional variant low/medium/high => discrete/variant", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "medium",
    description: "positional variant",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "discrete")
  stringEqual(result.field->Belt.Option.getWithDefault(""), "variant")
  assertionEqual(~operator="levels", result.levels->Belt.Option.getWithDefault([])->Array.length, 3)
})

test("inferCapability: positional variant xhigh => 4-level ladder", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "xhigh",
    description: "xhigh variant",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "discrete")
  assertionEqual(
    ~operator="xhigh_levels",
    result.levels->Belt.Option.getWithDefault([])->Array.length,
    4,
  )
})

// ---------------------------------------------------------------------------
// inferCapability — binary via named variant
// ---------------------------------------------------------------------------

test("inferCapability: named variant thinking => binary/variant", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "thinking",
    description: "thinking tier",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "binary")
  stringEqual(result.field->Belt.Option.getWithDefault(""), "variant")
  stringEqual(result.elevated->Belt.Option.getWithDefault(""), "thinking")
})

test("inferCapability: named variant max => binary/variant", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "max",
    description: "max tier",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.kind, "binary")
  stringEqual(result.elevated->Belt.Option.getWithDefault(""), "max")
})

// ---------------------------------------------------------------------------
// inferCapability — precedence (first match wins)
// ---------------------------------------------------------------------------

test("inferCapability: effort takes precedence over variant", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "thinking",
    reasoning: {effort: "low"},
    description: "both effort and variant set",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  // reasoning.effort check is first in precedence
  stringEqual(result.kind, "discrete")
})

test("inferCapability: thinking.budgetTokens takes precedence over variant", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "high",
    thinking: {budgetTokens: 8192},
    description: "both budget and variant set",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  // thinking.budgetTokens check is second in precedence
  stringEqual(result.kind, "budgeted")
})

// ---------------------------------------------------------------------------
// capability channel — field discriminator
// ---------------------------------------------------------------------------

test("inferCapability: discrete with reasoning.effort sets field correctly", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    reasoning: {effort: "high"},
    description: "effort",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.field->Belt.Option.getWithDefault(""), "reasoning.effort")
})

test("inferCapability: discrete with variant sets field correctly", () => {
  let tier: ReasoningCapability.tierConfig = {
    model: "provider/model",
    variant: "low",
    description: "positional",
    whenToUse: [],
  }
  let result = ReasoningCapability.inferCapability(tier)
  stringEqual(result.field->Belt.Option.getWithDefault(""), "variant")
})
