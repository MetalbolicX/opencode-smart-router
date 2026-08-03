// ---------------------------------------------------------------------------
// ReasoningPolicy.resi — Public API contract for resolveReasoningOverride.
//
// Pure function. Resolves an effective reasoning override for a tier given
// the configured policy mode and per-session override.
//
// Modes:
//   - "static"   → ALWAYS null (primary regression guard)
//   - "manual"   → resolve sessionOverride ?? policy.defaultLevel, translate
//   - "adaptive" → consult selectAdaptiveLevel (precedence: override >
//                  selector > defaultLevel > null), translate
//
// Unknown mode values fail soft to null — adaptive selection never runs.
// ---------------------------------------------------------------------------

// Reasoning level — same as ReasoningCapability
type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

// Capability type (mirrors ReasoningCapability.reasoningCapability)
type reasoningCapability = {
  kind: string,
  field?: string,
  baseline?: string,
  elevated?: string,
  levels?: array<string>,
  recommended?: dict<float>,
}

// TierConfig minimal shape (fields actually read by resolveReasoningOverride)
type tierConfig = {
  model: string,
  variant?: string,
  thinking?: {budgetTokens?: int},
  reasoning?: {effort?: string},
  description: string,
  whenToUse: array<string>,
  capability?: reasoningCapability,
}

// Adaptive signals (mirrors src/reasoning/adaptive.ts AdaptiveSignals)
type adaptiveSignals = {
  prompt: string,
  description: string,
  tierName: string,
  isTrivial: bool,
}

// ReasoningPolicyConfig minimal shape (fields read by resolveReasoningOverride)
type rec reasoningPolicyConfig = {
  mode: option<string>,
  defaultLevel: option<string>,
  surfaceLimits: option<bool>,
  adaptive: option<adaptivePolicyConfig>,
}

// Adaptive policy config minimal shape
and adaptivePolicyConfig = {
  trivialLevel: option<string>,
  adaptive_defaultLevel: option<string>,
  keywordRules: option<array<keywordRule>>,
  tierDefaults: option<dict<string>>,
  surfaceDecision: option<bool>,
}

// Keyword rule shape (matches src/router/config.types.ts KeywordRule)
and keywordRule = {
  keywords: array<string>,
  level: string,
  match: option<string>,
  excludeKeywords: option<array<string>>,
}

// Resolved reasoning patch (matches ReasoningTranslate.resolvedReasoning)
type resolvedReasoning = {
  variant?: string,
  options?: dict<JSON.t>,
}

// Main export: resolve the effective reasoning patch for a tier.
let resolveReasoningOverride: (
  tierConfig,
  option<reasoningPolicyConfig>,
  option<reasoningLevel>,
  adaptiveSignals,
) => Nullable.t<resolvedReasoning>
