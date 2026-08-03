// ---------------------------------------------------------------------------
// ReasoningAdaptive.resi — Public API contract for the adaptive level selector.
//
// Pure function. No IO, no module state. Deterministic: same inputs always
// produce the same decision.
//
// Decision order (first match wins):
//   1. policy.adaptive absent          → { level: null, reason: "no adaptive config" }
//   2. signals.isTrivial                → { level: trivialLevel ?? null, reason: "trivial" }
//   3. tierDefaults[tierName]           → { level: that, reason: "tier default: <name>" }
//   4. keywordRules (array order)       → first rule whose keywords match AND whose
//                                        excludeKeywords do NOT match; default mode = stem
//   5. catch-all                       → { level: defaultLevel ?? null, reason: "default level" }
// ---------------------------------------------------------------------------

// Normalized reasoning level — same as ReasoningCapability
type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

// Match mode — same as ReasoningMatch
type matchMode = [
  | #word
  | #stem
  | #substring
  | #regex
]

// Adaptive signals (mirrors src/reasoning/adaptive.ts AdaptiveSignals)
type adaptiveSignals = {
  prompt: string,
  description: string,
  tierName: string,
  isTrivial: bool,
}

// Keyword rule shape (mirrors AdaptivePolicyConfig.keywordRules)
type keywordRule = {
  keywords: array<string>,
  level: string,
  match: option<string>,
  excludeKeywords: option<array<string>>,
}

// AdaptivePolicyConfig minimal shape
type adaptivePolicyConfig = {
  trivialLevel: option<string>,
  defaultLevel: option<string>,
  keywordRules: option<array<keywordRule>>,
  tierDefaults: option<dict<string>>,
  surfaceDecision: option<bool>,
}

// ReasoningPolicyConfig minimal shape (fields read by selectAdaptiveLevel)
type reasoningPolicyConfig = {
  mode: option<string>,
  defaultLevel: option<string>,
  surfaceLimits: option<bool>,
  adaptive: option<adaptivePolicyConfig>,
}

// Return type — level is Js.Nullable.t at the TS boundary
type adaptiveDecision = {
  level: Nullable.t<reasoningLevel>,
  reason: string,
}

// Main export: pure adaptive level selector
let selectAdaptiveLevel: (adaptiveSignals, option<reasoningPolicyConfig>) => adaptiveDecision

// Accessor helpers (for test assertions)
let getLevelNull: adaptiveDecision => Nullable.t<reasoningLevel>
let getLevelOption: adaptiveDecision => option<reasoningLevel>
let getReason: adaptiveDecision => string

// Test helper: build a ReasoningPolicyConfig with adaptive block
let makePolicyWithAdaptive: option<adaptivePolicyConfig> => reasoningPolicyConfig
