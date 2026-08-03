// ---------------------------------------------------------------------------
// ReasoningPolicy_test.res — RED-first parity tests for ReasoningPolicy.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of policy.ts fixtures — static regression guard, manual mode precedence,
// unknown mode fail-soft, and binary/discrete/budgeted capability translation.
//
// NOTE: adaptive mode is stubbed for Phase 1 (selectAdaptiveLevel not yet
// ported). Phase 2 will replace this stub with full adaptive mode tests.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

// assertionNull: check that actual is null.
// Handles both None (undefined) and Some(null) — loose equality makes both pass.
let assertionNull = (~operator: string, actual: Nullable.t<'a>): unit =>
  assertion(~operator, (a, _b) => a == null, actual, Nullable.null)

// assertionNotNull: check that actual is not null (not undefined).
// Returns true when actual is not null.
let assertionNotNull = (~operator: string, actual: Nullable.t<'a>): unit =>
  assertion(~operator, (a, _b) => a != null, actual, Nullable.null)

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

// Base tier config
let baseTier: ReasoningPolicy.tierConfig = {
  model: "test/model",
  description: "test tier",
  whenToUse: [],
}

// Tier with binary capability
let binaryTier: ReasoningPolicy.tierConfig = {
  ...baseTier,
  variant: "thinking",
}

// Tier with discrete capability (reasoning.effort)
let discreteTier: ReasoningPolicy.tierConfig = {
  ...baseTier,
  reasoning: {effort: "high"},
}

// Tier with budgeted capability
let budgetedTier: ReasoningPolicy.tierConfig = {
  ...baseTier,
  thinking: {budgetTokens: 4096},
}

// Tier with none capability (no reasoning fields)
let noneTier: ReasoningPolicy.tierConfig = baseTier

// Static policy config
let staticPolicy: ReasoningPolicy.reasoningPolicyConfig = {
  mode: Some("static"),
  defaultLevel: None,
  surfaceLimits: None,
  adaptive: None,
}

// Manual policy config
let manualPolicy: ReasoningPolicy.reasoningPolicyConfig = {
  mode: Some("manual"),
  defaultLevel: None,
  surfaceLimits: None,
  adaptive: None,
}

// Manual policy with defaultLevel
let manualPolicyWithDefault = (dl: string): ReasoningPolicy.reasoningPolicyConfig => {
  mode: Some("manual"),
  defaultLevel: Some(dl),
  surfaceLimits: None,
  adaptive: None,
}

// Unknown mode policy helper
let unknownPolicy = (mode: string): ReasoningPolicy.reasoningPolicyConfig => {
  mode: Some(mode),
  defaultLevel: None,
  surfaceLimits: None,
  adaptive: None,
}

// Empty signals placeholder
let emptySignals: ReasoningPolicy.adaptiveSignals = {
  prompt: "",
  description: "",
  tierName: "",
  isTrivial: false,
}

// ---------------------------------------------------------------------------
// resolveReasoningOverride — static mode (primary regression guard)
// ---------------------------------------------------------------------------

test("resolveReasoningOverride: static returns null for every level", () => {
  assertionNull(
    ~operator="minimal",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(staticPolicy),
      Some(#minimal),
      emptySignals,
    ),
  )
  assertionNull(
    ~operator="elevated",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(staticPolicy),
      Some(#elevated),
      emptySignals,
    ),
  )
  assertionNull(
    ~operator="max",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(staticPolicy),
      Some(#max),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: static ignores session override", () => {
  assertionNull(
    ~operator="with-override",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(staticPolicy),
      Some(#elevated),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: static when policy is undefined", () => {
  assertionNull(
    ~operator="no-policy",
    ReasoningPolicy.resolveReasoningOverride(binaryTier, None, Some(#elevated), emptySignals),
  )
})

// ---------------------------------------------------------------------------
// resolveReasoningOverride — manual mode: session override ?? defaultLevel
// ---------------------------------------------------------------------------

test("resolveReasoningOverride: manual translates session override (binary)", () => {
  // binary: elevated/max → {variant: "thinking"}, minimal/normal → null (no baseline defined)
  assertionNotNull(
    ~operator="elevated",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(manualPolicy),
      Some(#elevated),
      emptySignals,
    ),
  )
  assertionNotNull(
    ~operator="max",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(manualPolicy),
      Some(#max),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: manual uses defaultLevel when no override", () => {
  // binary: elevated → {variant: "thinking"}
  assertionNotNull(
    ~operator="with-default",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(manualPolicyWithDefault("elevated")),
      None,
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: manual returns null when no override and no defaultLevel", () => {
  assertionNull(
    ~operator="no-override",
    ReasoningPolicy.resolveReasoningOverride(binaryTier, Some(manualPolicy), None, emptySignals),
  )
})

test("resolveReasoningOverride: manual session override wins over defaultLevel", () => {
  // override = #max, defaultLevel = "minimal"
  // binary: max → elevated variant ("thinking")
  assertionNotNull(
    ~operator="override-wins",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(manualPolicyWithDefault("minimal")),
      Some(#max),
      emptySignals,
    ),
  )
})

// ---------------------------------------------------------------------------
// resolveReasoningOverride — manual mode with different capability types
// ---------------------------------------------------------------------------

test("resolveReasoningOverride: manual with discrete tier (reasoning.effort)", () => {
  // discrete: elevated → medium (3-level ladder)
  assertionNotNull(
    ~operator="discrete",
    ReasoningPolicy.resolveReasoningOverride(
      discreteTier,
      Some(manualPolicy),
      Some(#elevated),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: manual with budgeted tier", () => {
  // budgeted: max → 16000
  assertionNotNull(
    ~operator="budgeted",
    ReasoningPolicy.resolveReasoningOverride(
      budgetedTier,
      Some(manualPolicy),
      Some(#max),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: manual with none-capability tier returns null", () => {
  assertionNull(
    ~operator="none-cap",
    ReasoningPolicy.resolveReasoningOverride(
      noneTier,
      Some(manualPolicy),
      Some(#elevated),
      emptySignals,
    ),
  )
  assertionNull(
    ~operator="none-cap-max",
    ReasoningPolicy.resolveReasoningOverride(
      noneTier,
      Some(manualPolicy),
      Some(#max),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: explicit capability wins over inference", () => {
  let cap: ReasoningPolicy.reasoningCapability = {
    kind: "binary",
    field: "variant",
    elevated: "max",
  }
  let tierWithCap: ReasoningPolicy.tierConfig = {
    ...binaryTier,
    capability: cap,
  }
  // explicit cap says elevated="max", not "thinking"
  assertionNotNull(
    ~operator="explicit-cap",
    ReasoningPolicy.resolveReasoningOverride(
      tierWithCap,
      Some(manualPolicy),
      Some(#elevated),
      emptySignals,
    ),
  )
})

// ---------------------------------------------------------------------------
// resolveReasoningOverride — unknown mode (fail-soft)
// ---------------------------------------------------------------------------

test("resolveReasoningOverride: unknown mode returns null", () => {
  assertionNull(
    ~operator="typo-mode",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(unknownPolicy("adaptive-typo")),
      Some(#elevated),
      emptySignals,
    ),
  )
  assertionNull(
    ~operator="auto-mode",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(unknownPolicy("auto")),
      Some(#elevated),
      emptySignals,
    ),
  )
  assertionNull(
    ~operator="empty-mode",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(unknownPolicy("")),
      Some(#elevated),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: unknown mode ignores session override", () => {
  assertionNull(
    ~operator="override-ignored",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(unknownPolicy("adaptive-typo")),
      Some(#max),
      emptySignals,
    ),
  )
})

test("resolveReasoningOverride: unknown mode ignores adaptive block", () => {
  // even if an adaptive block is present, unknown mode must not consult it
  let policyWithAdaptive: ReasoningPolicy.reasoningPolicyConfig = {
    mode: Some("foo"),
    defaultLevel: None,
    surfaceLimits: None,
    adaptive: None, // would match if consulted — but never runs for unknown mode
  }
  assertionNull(
    ~operator="adaptive-block-ignored",
    ReasoningPolicy.resolveReasoningOverride(
      binaryTier,
      Some(policyWithAdaptive),
      None,
      emptySignals,
    ),
  )
})

// ---------------------------------------------------------------------------
// resolveReasoningOverride — adaptive mode stub (Phase 1)
// ---------------------------------------------------------------------------

test("resolveReasoningOverride: adaptive mode returns null (Phase 1 stub)", () => {
  let adaptivePolicy: ReasoningPolicy.reasoningPolicyConfig = {
    mode: Some("adaptive"),
    defaultLevel: None,
    surfaceLimits: None,
    adaptive: None,
  }
  // Phase 1 stub: adaptive returns null until selectAdaptiveLevel is ported
  assertionNull(
    ~operator="adaptive-stub",
    ReasoningPolicy.resolveReasoningOverride(
      discreteTier,
      Some(adaptivePolicy),
      None,
      emptySignals,
    ),
  )
})
