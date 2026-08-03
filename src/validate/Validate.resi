// ---------------------------------------------------------------------------
// Validate.resi — Public interface for the Validate module.
//
// Re-exports the public signatures of all six Validate sub-modules plus the
// top-level `validateConfig` orchestrator. TS consumers use `Validate.res.mjs`
// via this ABI bridge entry.
//
// ABI boundary: all validators accept Js.Dict.t<Js.Json.t> (maps to
// TS Record<string, unknown>). All validators return unit and throw with a
// "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Root validators
// ---------------------------------------------------------------------------

// Validate the root-level scalar fields: activePreset must be a non-empty string.
let validateRootFields: dict<JSON.t> => unit

// Validate rules (array of strings) and defaultTier (string).
let validateRulesAndDefaultTier: dict<JSON.t> => unit

// ---------------------------------------------------------------------------
// Presets validators
// ---------------------------------------------------------------------------

// Validate the top-level presets block.
let validatePresets: dict<JSON.t> => unit

// Validate a single preset (named by presetName for error messages).
let validatePreset: (string, dict<JSON.t>) => unit

// Validate a single tier within a preset.
let validateTier: (string, string, dict<JSON.t>) => unit

// ---------------------------------------------------------------------------
// Modes validators
// ---------------------------------------------------------------------------

// Validate the top-level modes block.
let validateModes: dict<JSON.t> => unit

// Validate a single mode (named by modeName for error messages).
let validateMode: (string, dict<JSON.t>) => unit

// ---------------------------------------------------------------------------
// Simple validators (tierCaps, tierPrompts, taskPatterns)
// ---------------------------------------------------------------------------

// Validate the tierCaps block: each cap must be a finite positive integer.
// tierCaps is optional — no-op if absent.
let validateTierCaps: dict<JSON.t> => unit

// Validate the tierPrompts block: each prompt must be a string.
// tierPrompts is optional — no-op if absent.
let validateTierPrompts: dict<JSON.t> => unit

// Validate the taskPatterns block: each patterns value must be an array of strings.
// taskPatterns is optional — no-op if absent.
let validateTaskPatterns: dict<JSON.t> => unit

// ---------------------------------------------------------------------------
// Enforcement validators
// ---------------------------------------------------------------------------

// Top-level enforcement dispatcher.
// Throws if enforcement is present but not a plain object.
let validateEnforcement: dict<JSON.t> => unit

// Validate enforcement.mode in {off, advisory, enforced}.
// Silently skips if mode is absent (field is optional).
let validateEnforcementMode: dict<JSON.t> => unit

// Validate enforcement.verify block (optional).
// Permissive: non-object verify values are silently ignored.
let validateEnforcementVerify: dict<JSON.t> => unit

// Validate enforcement.escalate block (optional).
// Permissive: non-object escalate values are silently ignored.
let validateEnforcementEscalate: dict<JSON.t> => unit

// Validate enforcement.perTier block (optional).
// Permissive: non-object perTier values are silently ignored.
let validateEnforcementPerTier: dict<JSON.t> => unit

// Validate enforcement.guard block (optional).
// Permissive: non-object guard values are silently ignored.
let validateEnforcementGuard: dict<JSON.t> => unit

// Validate enforcement.escalate.costCeiling block (optional).
// Permissive: non-object costCeiling values are silently ignored.
let validateEscalateCostCeiling: dict<JSON.t> => unit

// ---------------------------------------------------------------------------
// Reasoning policy validators
// ---------------------------------------------------------------------------

// Top-level reasoningPolicy dispatcher.
// Throws if reasoningPolicy is present but not a plain object.
let validateReasoningPolicy: dict<JSON.t> => unit

// Validate reasoningPolicy.mode in {static, manual, adaptive}.
// Silently skips if mode is absent (field is optional).
let validateReasoningPolicyMode: dict<JSON.t> => unit

// Validate reasoningPolicy.adaptive block (optional).
// Validates: trivialLevel (level | null), defaultLevel (level | null),
//   keywordRules (array), tierDefaults (object), surfaceDecision (boolean).
let validateAdaptivePolicy: dict<JSON.t> => unit

// Validate adaptive.keywordRules array (optional).
// Called internally by validateAdaptivePolicy.
let validateKeywordRules: dict<JSON.t> => unit

// Validate a single keyword rule at a given array index.
let validateKeywordRule: (JSON.t, int) => unit

// Validate adaptive.tierDefaults object (optional).
// Each value must be a reasoning level string.
let validateAdaptiveTierDefaults: dict<JSON.t> => unit

// Validate adaptive.surfaceDecision (optional).
// Must be a boolean if present.
let validateAdaptiveSurfaceDecision: dict<JSON.t> => unit

// ---------------------------------------------------------------------------
// validateConfig — orchestrator
//
// Validates a full config object by delegating each section to the
// appropriate sub-module validator. Returns the input dict unchanged (the
// caller is responsible for the JS-object → RouterConfig cast via the ABI).
//
// Throws with a "tiers.json:" prefix on the first failure.
// ---------------------------------------------------------------------------

let validateConfig: dict<JSON.t> => dict<JSON.t>
