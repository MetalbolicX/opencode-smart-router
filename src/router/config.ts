// ---------------------------------------------------------------------------
// src/router/config.ts — Re-export barrel.
//
// PR2 of the core-refactor-plan splits this file into four focused modules:
//   - `./config.types`     — type interfaces and `isPlainObject`
//   - `./config-loader`    — layer loading, merging, paths
//   - `./config-validate`  — [DELETED — validators now in Validate.res.mjs]
//   - `./config-state`     — `readState()`, `writeState()`, `saveActive*()`
//
// PR3a adds two shared modules so `resolvePresetName()` and the
// enforcement-mode constants are not duplicated:
//   - `./config-resolve`   — `resolvePresetName()`, `ENFORCEMENT_MODES`,
//                            `VERIFY_REQUIRE_MODES`
//   - `./config-errors`    — typed errors (`RouterStateError`)
//
// Phase 3 Validate cutover: validators are now in `../validate/Validate.res.mjs`.
// `normalizeEnforcement` is in `./enforcement-normalize.ts`.
//
// All public exports are re-exported from here so existing imports of the
// shape `from "./config"` continue to resolve unchanged.
// ---------------------------------------------------------------------------

export * from "./config.types";
export * from "./config-errors";
export * from "./config-loader";
export * from "./config-resolve";
export * from "./config-state";
export * from "./enforcement-normalize";

// Re-export all validators from the Validate facade
export {
  validateConfig,
  validateRootFields,
  validateRulesAndDefaultTier,
  validatePresets,
  validatePreset,
  validateTier,
  validateModes,
  validateMode,
  validateTierCaps,
  validateTierPrompts,
  validateTaskPatterns,
  validateEnforcement,
  validateEnforcementMode,
  validateEnforcementVerify,
  validateEnforcementEscalate,
  validateEnforcementPerTier,
  validateEnforcementGuard,
  validateEscalateCostCeiling,
  validateReasoningPolicy,
  validateReasoningPolicyMode,
  validateAdaptivePolicy,
  validateKeywordRules,
  validateKeywordRule,
  validateAdaptiveTierDefaults,
  validateAdaptiveSurfaceDecision,
} from "../validate/Validate.res.mjs";
