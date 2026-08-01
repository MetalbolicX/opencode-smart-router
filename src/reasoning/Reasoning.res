// ---------------------------------------------------------------------------
// Reasoning.res — Public facade for the reasoning engine.
//
// Re-exports the public API of the five reasoning sub-modules so TS consumers
// have a single stable import path: `Reasoning.res.mjs`.
//
// Sub-modules (internal, not for direct import):
//   ReasoningMatch        — word/stem/substring/regex keyword matcher
//   ReasoningCapability  — capability inference from TierConfig fields
//   ReasoningTranslate   — level-to-patch translator
//   ReasoningPolicy     — policy-mode resolver (static/manual/adaptive)
//   ReasoningAdaptive   — deterministic adaptive level selector
//
// TS consumers import from this facade, NOT from the individual sub-modules.
// Functions are re-exported directly; types are re-exported via value aliases
// so the compiled .res.mjs exports them as named values that TS can use.
// ---------------------------------------------------------------------------

// Module aliases for internal reference (for calling into sub-modules)
module Match = ReasoningMatch
module Capability = ReasoningCapability
module Translate = ReasoningTranslate
module Policy = ReasoningPolicy
module Adaptive = ReasoningAdaptive

// Re-export types as value aliases so TS can import them via .d.ts
// (ReScript compiles these to JS values; TS reads them from the .d.ts)
type reasoningLevel = ReasoningCapability.reasoningLevel
type reasoningField = ReasoningCapability.reasoningField
type reasoningCapability = ReasoningCapability.reasoningCapability
type tierConfig = ReasoningCapability.tierConfig
type matchMode = ReasoningMatch.matchMode
type adaptiveSignals = ReasoningAdaptive.adaptiveSignals
type adaptivePolicyConfig = ReasoningAdaptive.adaptivePolicyConfig
type reasoningPolicyConfig = ReasoningAdaptive.reasoningPolicyConfig
type keywordRule = ReasoningAdaptive.keywordRule
type resolvedReasoning = ReasoningTranslate.resolvedReasoning
type adaptiveDecision = ReasoningAdaptive.adaptiveDecision

// Re-export functions directly so TS consumers can use:
//   import { normalizeSignalText } from "Reasoning.res.mjs"
let normalizeSignalText = ReasoningMatch.normalizeSignalText
let matchSignal = ReasoningMatch.matchSignal
let inferCapability = ReasoningCapability.inferCapability
let translateLevel = ReasoningTranslate.translateLevel
let resolveReasoningOverride = ReasoningPolicy.resolveReasoningOverride
let selectAdaptiveLevel = ReasoningAdaptive.selectAdaptiveLevel

// Accessor helpers for Adaptive
let getLevelNull = ReasoningAdaptive.getLevelNull
let getLevelOption = ReasoningAdaptive.getLevelOption
let getReason = ReasoningAdaptive.getReason
let makePolicyWithAdaptive = ReasoningAdaptive.makePolicyWithAdaptive
