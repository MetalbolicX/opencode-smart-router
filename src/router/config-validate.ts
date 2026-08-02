// ---------------------------------------------------------------------------
// src/router/config-validate.ts — Config-shape validation and enforcement
// normalization.
//
// `validateConfig()` is the orchestrator and the single source of truth for
// what a parsed tiers.json (or merged multi-layer result) must look like. It
// delegates each top-level section to a focused, ≤60-line validator:
//
//   validateRootFields / validateRulesAndDefaultTier — primitive scalars
//   validatePresets → validatePreset → validateTier  — preset tree
//   validateModes   → validateMode                    — mode overrides
//   validateTierCaps / validateTierPrompts / validateTaskPatterns
//   validateEnforcement →
//     validateEnforcementMode / validateEnforcementVerify /
//     validateEnforcementEscalate → validateEscalateCostCeiling /
//     validateEnforcementPerTier / validateEnforcementGuard
//   validateReasoningPolicy →
//     validateReasoningPolicyMode / validateAdaptivePolicy →
//       validateKeywordRules → validateKeywordRule / validateAdaptiveTierDefaults
//
// Every sub-validator throws with a `tiers.json: …` prefix on the first
// failure so the operator sees the exact problem without re-running.
//
// `normalizeEnforcement()` collapses an optional `EnforcementConfig` into a
// record with a default `mode` of `"advisory"` so downstream consumers never
// branch on `undefined`.
// ---------------------------------------------------------------------------

import type { matchMode } from "../reasoning/Reasoning.res.mjs";
import { isPlainObject } from "./config-loader";
import type {
  EnforcementConfig,
  ReasoningLevel,
  RouterConfig,
} from "./config.types";
import { ENFORCEMENT_MODES, GRADER_POLICIES, VERIFY_REQUIRE_MODES } from "./config-resolve";
import {
  validateRootFields as validateRootFieldsReScript,
  validateRulesAndDefaultTier as validateRulesAndDefaultTierReScript,
} from "../validate/ValidateRoot.res.mjs";
import {
  validatePresets as validatePresetsReScript,
  validatePreset as validatePresetReScript,
  validateTier as validateTierReScript,
} from "../validate/ValidatePresets.res.mjs";
import {
  validateModes as validateModesReScript,
  validateMode as validateModeReScript,
} from "../validate/ValidateModes.res.mjs";
import {
  validateTierCaps as validateTierCapsReScript,
  validateTierPrompts as validateTierPromptsReScript,
  validateTaskPatterns as validateTaskPatternsReScript,
} from "../validate/ValidateSimple.res.mjs";
import {
  validateEnforcement as validateEnforcementReScript,
  validateEnforcementMode as validateEnforcementModeReScript,
  validateEnforcementVerify as validateEnforcementVerifyReScript,
  validateEnforcementEscalate as validateEnforcementEscalateReScript,
  validateEnforcementPerTier as validateEnforcementPerTierReScript,
  validateEnforcementGuard as validateEnforcementGuardReScript,
  validateEscalateCostCeiling as validateEscalateCostCeilingReScript,
} from "../validate/ValidateEnforcement.res.mjs";
// @ts-ignore TS bug: glob "Reasoning.res.mjs" matches "ValidateReasoning.res.mjs"
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ValidateReasoningReScript: any = require("../validate/ValidateReasoning.res.mjs");

const ENFORCEMENT_MODES_LIST = ENFORCEMENT_MODES.join("|");
const VERIFY_REQUIRE_MODES_LIST = VERIFY_REQUIRE_MODES.join("|");
const EXPECTED_GRADER_POLICY = GRADER_POLICIES[0];

// Reasoning-policy allow-lists. Mirrored from the `ReasoningLevel` type union
// in `src/reasoning/capability.ts` and the `MatchMode` union in
// `src/reasoning/match.ts`. Kept local here (not in `config-resolve.ts`) so
// PR3 of `robust-adaptive-trigger-words` stays a single-file validator
// change; promoting them to shared constants is a mechanical follow-up if
// any other module needs the same lists.
const REASONING_MODES = ["static", "manual", "adaptive"] as const;
const REASONING_LEVELS = ["minimal", "normal", "elevated", "max"] as const;
const MATCH_MODES = ["word", "stem", "substring", "regex"] as const;

const isReasoningLevel = (v: unknown): v is ReasoningLevel =>
  typeof v === "string" && (REASONING_LEVELS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// validateConfig — orchestrator
// ---------------------------------------------------------------------------

export const validateConfig = (raw: unknown): RouterConfig => {
  if (!isPlainObject(raw)) {
    throw new Error("tiers.json: expected a JSON object at root");
  }
  validateRootFields(raw);
  validatePresets(raw);
  validateRulesAndDefaultTier(raw);
  validateModes(raw);
  validateTierCapsReScript(raw);
  validateTierPromptsReScript(raw);
  validateTaskPatternsReScript(raw);
  validateEnforcement(raw);
  validateReasoningPolicy(raw);
  return raw as unknown as RouterConfig;
};

// ---------------------------------------------------------------------------
// Root scalars
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Root scalars — wired to ValidateRoot.res.mjs
// ---------------------------------------------------------------------------

export const validateRootFields = (obj: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateRoot.res.mjs)
  validateRootFieldsReScript(obj);
};

export const validateRulesAndDefaultTier = (obj: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateRoot.res.mjs)
  validateRulesAndDefaultTierReScript(obj);
};

// ---------------------------------------------------------------------------
// Presets — nested tree: presets → presetName → tierName → tier — wired to ValidatePresets.res.mjs
// ---------------------------------------------------------------------------

export const validatePresets = (obj: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidatePresets.res.mjs)
  validatePresetsReScript(obj);
};

export const validatePreset = (presetName: string, preset: unknown): void => {
  // Explicit guard: non-object inputs must be rejected with the expected error
  if (!isPlainObject(preset) || Array.isArray(preset)) {
    throw new Error(`tiers.json: preset '${presetName}' must be an object`);
  }
  // Delegate to ReScript implementation (ValidatePresets.res.mjs)
  validatePresetReScript(presetName, preset as Record<string, unknown>);
};

export const validateTier = (presetName: string, tierName: string, tier: unknown): void => {
  // Explicit guard: non-object inputs must be rejected with the expected error
  if (!isPlainObject(tier)) {
    throw new Error(`tiers.json: tier '${presetName}.${tierName}' must be an object`);
  }
  // Delegate to ReScript implementation (ValidatePresets.res.mjs)
  validateTierReScript(presetName, tierName, tier as Record<string, unknown>);
};

// ---------------------------------------------------------------------------
// Modes — wired to ValidateModes.res.mjs
// ---------------------------------------------------------------------------

export const validateModes = (obj: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateModes.res.mjs)
  validateModesReScript(obj);
};

export const validateMode = (modeName: string, mode: unknown): void => {
  // Explicit guard: non-object inputs must be rejected with the expected error
  if (!isPlainObject(mode)) {
    throw new Error(`tiers.json: mode '${modeName}' must be an object`);
  }
  // Delegate to ReScript implementation (ValidateModes.res.mjs)
  validateModeReScript(modeName, mode as Record<string, unknown>);
};

// ---------------------------------------------------------------------------
// Tier caps / prompts / patterns — simple Record<string, …> blocks
// ---------------------------------------------------------------------------

export const validateTierCaps = (obj: Record<string, unknown>): void => {
  if (obj.tierCaps === undefined) return;
  if (!isPlainObject(obj.tierCaps) || Array.isArray(obj.tierCaps)) {
    throw new Error("tiers.json: 'tierCaps' must be an object");
  }
  for (const [tierName, cap] of Object.entries(obj.tierCaps)) {
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
      throw new Error(`tiers.json: tierCaps.'${tierName}' must be a positive integer`);
    }
  }
};

export const validateTierPrompts = (obj: Record<string, unknown>): void => {
  if (obj.tierPrompts === undefined) return;
  if (!isPlainObject(obj.tierPrompts) || Array.isArray(obj.tierPrompts)) {
    throw new Error("tiers.json: 'tierPrompts' must be an object");
  }
  for (const [tierName, prompt] of Object.entries(obj.tierPrompts)) {
    if (typeof prompt !== "string") {
      throw new Error(`tiers.json: tierPrompts.'${tierName}' must be a string`);
    }
  }
};

export const validateTaskPatterns = (obj: Record<string, unknown>): void => {
  if (obj.taskPatterns === undefined) return;
  if (!isPlainObject(obj.taskPatterns) || Array.isArray(obj.taskPatterns)) {
    throw new Error("tiers.json: 'taskPatterns' must be an object");
  }
  for (const [tierName, patterns] of Object.entries(obj.taskPatterns)) {
    if (!Array.isArray(patterns)) {
      throw new Error(`tiers.json: taskPatterns.'${tierName}' must be an array of strings`);
    }
  }
};

// ---------------------------------------------------------------------------
// Enforcement — split into per-key validators
// ---------------------------------------------------------------------------

export const validateEnforcement = (obj: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEnforcementReScript(obj);
};

export const validateEnforcementMode = (enf: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEnforcementModeReScript(enf);
};

export const validateEnforcementVerify = (enf: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEnforcementVerifyReScript(enf);
};

export const validateEnforcementEscalate = (enf: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEnforcementEscalateReScript(enf);
};

export const validateEnforcementPerTier = (enf: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEnforcementPerTierReScript(enf);
};

export const validateEnforcementGuard = (enf: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEnforcementGuardReScript(enf);
};

// ---------------------------------------------------------------------------
// Enforcement helpers (internal, called by validateEnforcementEscalate)
// ---------------------------------------------------------------------------

export const validateEscalateCostCeiling = (escalate: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateEnforcement.res.mjs)
  validateEscalateCostCeilingReScript(escalate);
};

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export const normalizeEnforcement = (
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } => {
  return { mode: e?.mode ?? "advisory" };
};

// ---------------------------------------------------------------------------
// Reasoning policy (PR 3 of robust-adaptive-trigger-words)
//
// Validation contract:
//   - `reasoningPolicy` is optional; missing ⇒ no-op.
//   - `reasoningPolicy.mode` (optional) ∈ {static,manual,adaptive}.
//   - `reasoningPolicy.adaptive` (optional) must be a plain object.
//   - `adaptive.trivialLevel` / `adaptive.defaultLevel` (optional) ∈
//     {minimal,normal,elevated,max} or `null`. Null means "no patch".
//   - `adaptive.keywordRules` (optional) is an array; each rule needs:
//       - non-empty `keywords` array of strings (rejects `[]`);
//       - `level` from the level set;
//       - `match` (optional) from {word,stem,substring,regex};
//       - `excludeKeywords` (optional) array of strings;
//       - when `match === "regex"`, every keyword must compile (`new
//         RegExp(keyword)`) — failed patterns fail fast at config load
//         instead of silently dropping at runtime.
//   - `adaptive.tierDefaults` (optional) plain object whose values are
//     drawn from the level set (no null allowed — nulls are reserved for
//     `trivialLevel`/`defaultLevel` semantics).
//   - `adaptive.surfaceDecision` (optional) boolean.
//
// Permissive skip policy matches the rest of the file: a top-level
// `reasoningPolicy` that isn't a plain object throws; nested optional
// blocks (`adaptive`, `keywordRules`, `tierDefaults`) that are present but
// malformed also throw so operators see the exact misconfiguration.
// ---------------------------------------------------------------------------

const REASONING_MODES_LIST = REASONING_MODES.join("|");
const REASONING_LEVELS_LIST = REASONING_LEVELS.join("|");
const MATCH_MODES_LIST = MATCH_MODES.join("|");

export const validateReasoningPolicy = (obj: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateReasoning.res.mjs)
  ValidateReasoningReScript.validateReasoningPolicy(obj);
};

export const validateReasoningPolicyMode = (policy: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateReasoning.res.mjs)
  ValidateReasoningReScript.validateReasoningPolicyMode(policy);
};

export const validateAdaptivePolicy = (policy: Record<string, unknown>): void => {
  // Delegate to ReScript implementation (ValidateReasoning.res.mjs)
  ValidateReasoningReScript.validateAdaptivePolicy(policy);
};

export const validateKeywordRules = (rules: unknown): void => {
  // Called by validateAdaptivePolicy internally; also exported for direct use.
  // ReScript validateKeywordRule is called per-element in the TS loop.
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    throw new Error("tiers.json: reasoningPolicy.adaptive.keywordRules must be an array");
  }
  for (const [index, rule] of rules.entries()) {
    validateKeywordRule(rule, index);
  }
};

export const validateKeywordRule = (rule: unknown, index: number): void => {
  // Delegate to ReScript implementation (ValidateReasoning.res.mjs)
  ValidateReasoningReScript.validateKeywordRule(rule as Record<string, unknown>, index);
};

export const validateAdaptiveTierDefaults = (td: unknown): void => {
  // Called by validateAdaptivePolicy internally; also exported for direct use.
  // TS API: skip if absent, throw if not an object.
  if (td === undefined) return;
  if (!isPlainObject(td) || Array.isArray(td)) {
    throw new Error("tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object");
  }
  // The ReScript function expects an adaptive dict with tierDefaults inside.
  // For direct-call TS usage (from config-validate-sections.test.ts), wrap td
  // in an object so the ReScript function can find it.
  const adaptive: Record<string, unknown> = { tierDefaults: td };
  ValidateReasoningReScript.validateAdaptiveTierDefaults(adaptive as Record<string, unknown>);
};

export const validateAdaptiveSurfaceDecision = (value: unknown): void => {
  // Called by validateAdaptivePolicy internally; also exported for direct use.
  // ReScript validateAdaptiveSurfaceDecision is called with the adaptive dict.
  // For the TS direct-call case, pass a dict with surfaceDecision.
  const dict: Record<string, unknown> = {};
  if (value !== undefined) {
    dict["surfaceDecision"] = value;
  }
  ValidateReasoningReScript.validateAdaptiveSurfaceDecision(dict as Record<string, unknown>);
};
