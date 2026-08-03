// ---------------------------------------------------------------------------
// Validate.res — Public facade for the Validate module.
//
// Re-exports the public API of the six Validate sub-modules so TS consumers
// have a single stable import path: `Validate.res.mjs`.
//
// Sub-modules (internal, not for direct import):
//   ValidateRoot       — root-level scalars: activePreset, rules, defaultTier
//   ValidatePresets    — preset tree: presets → presetName → tierName → tier
//   ValidateModes      — mode overrides: modes → modeName → mode
//   ValidateSimple     — simple dict blocks: tierCaps, tierPrompts, taskPatterns
//   ValidateEnforcement — enforcement config: mode/verify/escalate/perTier/guard
//   ValidateReasoning  — reasoning policy: mode/adaptive/keyword/tierDefaults
//
// TS consumers import from this facade, NOT from the individual sub-modules.
// Functions are re-exported directly so the compiled .res.mjs exports them as
// named values that TS can use via the ABI bridge.
//
// The facade also provides the top-level `validateConfig` orchestrator that
// delegates each section to the appropriate sub-module validator.
// ---------------------------------------------------------------------------

// Module aliases for internal reference (calling into sub-modules)
module Root = ValidateRoot
module Presets = ValidatePresets
module Modes = ValidateModes
module Simple = ValidateSimple
module Enforcement = ValidateEnforcement
module Reasoning = ValidateReasoning

// ---------------------------------------------------------------------------
// Root validators
// ---------------------------------------------------------------------------

// Validate the root-level scalar fields: activePreset must be a non-empty string.
let validateRootFields = ValidateRoot.validateRootFields

// Validate rules (array of strings) and defaultTier (string).
let validateRulesAndDefaultTier = ValidateRoot.validateRulesAndDefaultTier

// ---------------------------------------------------------------------------
// Presets validators
// ---------------------------------------------------------------------------

// Validate the top-level presets block.
let validatePresets = ValidatePresets.validatePresets

// Validate a single preset (named by presetName for error messages).
let validatePreset = ValidatePresets.validatePreset

// Validate a single tier within a preset.
let validateTier = ValidatePresets.validateTier

// ---------------------------------------------------------------------------
// Modes validators
// ---------------------------------------------------------------------------

// Validate the top-level modes block.
let validateModes = ValidateModes.validateModes

// Validate a single mode (named by modeName for error messages).
let validateMode = ValidateModes.validateMode

// ---------------------------------------------------------------------------
// Simple validators (tierCaps, tierPrompts, taskPatterns)
// ---------------------------------------------------------------------------

// Validate the tierCaps block: each cap must be a finite positive integer.
let validateTierCaps = ValidateSimple.validateTierCaps

// Validate the tierPrompts block: each prompt must be a string.
let validateTierPrompts = ValidateSimple.validateTierPrompts

// Validate the taskPatterns block: each patterns value must be an array of strings.
let validateTaskPatterns = ValidateSimple.validateTaskPatterns

// ---------------------------------------------------------------------------
// Enforcement validators
// ---------------------------------------------------------------------------

// Top-level enforcement dispatcher.
let validateEnforcement = ValidateEnforcement.validateEnforcement

// Validate enforcement.mode in {off, advisory, enforced}.
let validateEnforcementMode = ValidateEnforcement.validateEnforcementMode

// Validate enforcement.verify block (optional).
let validateEnforcementVerify = ValidateEnforcement.validateEnforcementVerify

// Validate enforcement.escalate block (optional).
let validateEnforcementEscalate = ValidateEnforcement.validateEnforcementEscalate

// Validate enforcement.perTier block (optional).
let validateEnforcementPerTier = ValidateEnforcement.validateEnforcementPerTier

// Validate enforcement.guard block (optional).
let validateEnforcementGuard = ValidateEnforcement.validateEnforcementGuard

// Validate enforcement.escalate.costCeiling block (optional).
let validateEscalateCostCeiling = ValidateEnforcement.validateEscalateCostCeiling

// ---------------------------------------------------------------------------
// Reasoning policy validators
// ---------------------------------------------------------------------------

// Top-level reasoningPolicy dispatcher.
let validateReasoningPolicy = ValidateReasoning.validateReasoningPolicy

// Validate reasoningPolicy.mode in {static, manual, adaptive}.
let validateReasoningPolicyMode = ValidateReasoning.validateReasoningPolicyMode

// Validate reasoningPolicy.adaptive block (optional).
let validateAdaptivePolicy = ValidateReasoning.validateAdaptivePolicy

// Validate adaptive.keywordRules array (optional).
let validateKeywordRules = ValidateReasoning.validateKeywordRules

// Validate a single keyword rule at a given array index.
let validateKeywordRule = ValidateReasoning.validateKeywordRule

// Validate adaptive.tierDefaults object (optional).
let validateAdaptiveTierDefaults = ValidateReasoning.validateAdaptiveTierDefaults

// Validate adaptive.surfaceDecision (optional).
let validateAdaptiveSurfaceDecision = ValidateReasoning.validateAdaptiveSurfaceDecision

// ---------------------------------------------------------------------------
// validateConfig — orchestrator
//
// Validates a full config object by delegating each section to the
// appropriate sub-module validator. Returns the input dict unchanged (cast
// to Js.Dict.t by the TS consumer via the ABI bridge).
//
// Throws with a "tiers.json:" prefix on the first failure.
// ---------------------------------------------------------------------------

let validateConfig = (obj: Js.Dict.t<Js.Json.t>): Js.Dict.t<Js.Json.t> => {
  // Root-level checks
  ValidateRoot.validateRootFields(obj)
  ValidateRoot.validateRulesAndDefaultTier(obj)

  // Presets tree
  ValidatePresets.validatePresets(obj)

  // Modes
  ValidateModes.validateModes(obj)

  // Simple dict blocks
  ValidateSimple.validateTierCaps(obj)
  ValidateSimple.validateTierPrompts(obj)
  ValidateSimple.validateTaskPatterns(obj)

  // Enforcement
  ValidateEnforcement.validateEnforcement(obj)

  // Reasoning policy
  ValidateReasoning.validateReasoningPolicy(obj)

  obj
}
