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

import type { MatchMode } from "../reasoning/match.js";
import {
  DEFAULT_FANOUT_CONFIG,
  type EnforcementConfig,
  isPlainObject,
  type RouterConfig,
} from "./config.types";
import { RouterConfigError } from "./config-errors";
import { ENFORCEMENT_MODES, GRADER_POLICIES, VERIFY_REQUIRE_MODES } from "./config-resolve";

const ENFORCEMENT_MODES_LIST = ENFORCEMENT_MODES.join("|");
const VERIFY_REQUIRE_MODES_LIST = VERIFY_REQUIRE_MODES.join("|");
const EXPECTED_GRADER_POLICY = GRADER_POLICIES[0];

// Reasoning-policy validation uses configured profile IDs. The match modes
// mirror the `MatchMode` union in
// `src/reasoning/match.ts`. Kept local here (not in `config-resolve.ts`) so
// PR3 of `robust-adaptive-trigger-words` stays a single-file validator
// change; promoting them to shared constants is a mechanical follow-up if
// any other module needs the same lists.
const REASONING_MODES = ["static", "manual", "adaptive"] as const;
const MATCH_MODES = ["word", "stem", "substring", "regex"] as const;

const isConfiguredLevel = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Throw a typed validation error while preserving the historical message. */
const fail = (detail: string): never => {
  const reason = detail.startsWith("tiers.json: ") ? detail.slice("tiers.json: ".length) : detail;
  throw new RouterConfigError("invalid", "tiers.json", new Error(reason), "tiers.json");
};

// ---------------------------------------------------------------------------
// validateConfig — orchestrator
// ---------------------------------------------------------------------------

export const validateConfig = (raw: unknown): RouterConfig => {
  if (!isPlainObject(raw)) {
    throw fail("expected a JSON object at root");
  }
  validateRootFields(raw);
  const policy = isPlainObject(raw.reasoningPolicy) ? raw.reasoningPolicy : undefined;
  validatePresets(raw, Array.isArray(policy?.profiles) ? policy.profiles : undefined);
  validateRulesAndDefaultTier(raw);
  validateModes(raw);
  validateTierCaps(raw);
  validateTierPrompts(raw);
  validateTaskPatterns(raw);
  validateEnforcement(raw);
  validateReasoningPolicy(raw);
  validateFanout(raw);
  return raw as unknown as RouterConfig;
};

// ---------------------------------------------------------------------------
// Root scalars
// ---------------------------------------------------------------------------

export const validateRootFields = (obj: Record<string, unknown>): void => {
  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw fail("'activePreset' must be a non-empty string");
  }
};

export const validateRulesAndDefaultTier = (obj: Record<string, unknown>): void => {
  if (!Array.isArray(obj.rules)) {
    throw fail("'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw fail("'defaultTier' must be a string");
  }
};

// ---------------------------------------------------------------------------
// Presets — nested tree: presets → presetName → tierName → tier
// ---------------------------------------------------------------------------

export const validatePresets = (obj: Record<string, unknown>, profiles?: unknown[]): void => {
  if (!isPlainObject(obj.presets) || Array.isArray(obj.presets)) {
    throw fail("'presets' must be a non-null object");
  }
  if (Object.keys(obj.presets).length === 0) {
    throw fail("'presets' must have at least one preset");
  }
  for (const [presetName, preset] of Object.entries(obj.presets)) {
    validatePreset(presetName, preset, profiles);
  }
};

export const validatePreset = (presetName: string, preset: unknown, profiles?: unknown[]): void => {
  if (!isPlainObject(preset) || Array.isArray(preset)) {
    throw fail(`preset '${presetName}' must be an object`);
  }
  for (const [tierName, tier] of Object.entries(preset)) {
    validateTier(presetName, tierName, tier, profiles);
  }
};

export const validateTier = (
  presetName: string,
  tierName: string,
  tier: unknown,
  profiles?: unknown[],
): void => {
  if (!isPlainObject(tier)) {
    throw fail(`tier '${presetName}.${tierName}' must be an object`);
  }
  if (typeof tier.model !== "string" || !tier.model) {
    throw fail(`'${presetName}.${tierName}.model' must be a non-empty string`);
  }
  if ("capability" in tier) {
    throw fail(
      `'${presetName}.${tierName}.capability' is removed; migrate to 'reasoningControl' in docs/CONFIG_REFERENCE.md`,
    );
  }
  // provider/model slash predicate (PR 1 of fix-task-model-fallback-cleanup).
  // Mirrors the runtime rule used by tierModel() in src/verify/dispatch.ts so
  // malformed values fail fast at config load instead of silently returning
  // null downstream. `slash <= 0` covers missing-or-leading slash; `slash >=
  // length - 1` covers missing-or-trailing slash.
  const slash = tier.model.indexOf("/");
  if (slash <= 0 || slash >= tier.model.length - 1) {
    throw fail(
      `'${presetName}.${tierName}.model' must be provider/model (got ${JSON.stringify(tier.model)})`,
    );
  }
  if (typeof tier.description !== "string") {
    throw fail(`'${presetName}.${tierName}.description' must be a string`);
  }
  if (!Array.isArray(tier.whenToUse)) {
    throw fail(`'${presetName}.${tierName}.whenToUse' must be an array`);
  }
  validateReasoningControl(presetName, tierName, tier.reasoningControl, profiles);
};

const validateReasoningControl = (
  presetName: string,
  tierName: string,
  control: unknown,
  profiles?: unknown[],
): void => {
  if (control === undefined) return;
  const prefix = `tiers.json: '${presetName}.${tierName}.reasoningControl'`;
  if (!isPlainObject(control) || Array.isArray(control)) {
    throw fail(`${prefix} must be an object`);
  }
  const channels = ["variant", "reasoning.effort", "thinking.budgetTokens"];
  if (typeof control.channel !== "string" || !channels.includes(control.channel)) {
    throw fail(`${prefix}.channel must be one of ${channels.join("|")}`);
  }
  if (!Array.isArray(control.levels) || control.levels.length === 0) {
    throw fail(`${prefix}.levels must be a non-empty array`);
  }
  const levels = control.levels as unknown[];
  const numeric = control.channel === "thinking.budgetTokens";
  if (
    !control.levels.every(
      (level: unknown) =>
        (numeric && typeof level === "number" && Number.isFinite(level) && level >= 0) ||
        (!numeric && typeof level === "string" && level.length > 0),
    )
  ) {
    throw fail(
      `${prefix}.levels must contain valid ${numeric ? "non-negative numbers" : "non-empty strings"}`,
    );
  }
  if (new Set(levels).size !== levels.length) {
    throw fail(`${prefix}.levels must contain unique values`);
  }
  if (
    numeric &&
    levels.some(
      (level: unknown, i: number) =>
        i > 0 && typeof level === "number" && level <= (levels[i - 1] as number),
    )
  ) {
    throw fail(`${prefix}.levels must be strictly ascending`);
  }
  if (!isPlainObject(control.profileMap) || Array.isArray(control.profileMap)) {
    throw fail(`${prefix}.profileMap must be an object`);
  }
  for (const [profile, native] of Object.entries(control.profileMap)) {
    if (!profile.trim()) throw fail(`${prefix}.profileMap keys must be non-empty strings`);
    if (!levels.includes(native)) {
      throw fail(`${prefix}.profileMap.${profile} must reference a value in levels`);
    }
  }
  if (profiles !== undefined) {
    const mapKeys = Object.keys(control.profileMap);
    const missing = profiles.filter((profile) => !mapKeys.includes(String(profile)));
    const extra = mapKeys.filter((profile) => !profiles.includes(profile));
    if (missing.length > 0 || extra.length > 0) {
      throw fail(
        `${prefix}.profileMap keys must exactly match reasoningPolicy.profiles (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
      );
    }
  }
  const maxBumps = typeof control.maxBumps === "number" ? control.maxBumps : Number.NaN;
  if (!Number.isInteger(maxBumps) || maxBumps < 0 || maxBumps > levels.length - 1) {
    throw fail(`${prefix}.maxBumps must be an integer from 0 to ${levels.length - 1}`);
  }
};

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export const validateModes = (obj: Record<string, unknown>): void => {
  if (obj.modes === undefined) return;
  if (!isPlainObject(obj.modes) || Array.isArray(obj.modes)) {
    throw fail("'modes' must be an object");
  }
  for (const [modeName, mode] of Object.entries(obj.modes)) {
    validateMode(modeName, mode);
  }
};

export const validateMode = (modeName: string, mode: unknown): void => {
  if (!isPlainObject(mode)) {
    throw fail(`mode '${modeName}' must be an object`);
  }
  if (typeof mode.defaultTier !== "string") {
    throw fail(`mode '${modeName}.defaultTier' must be a string`);
  }
  if (typeof mode.description !== "string") {
    throw fail(`mode '${modeName}.description' must be a string`);
  }
};

// ---------------------------------------------------------------------------
// Tier caps / prompts / patterns — simple Record<string, …> blocks
// ---------------------------------------------------------------------------

export const validateTierCaps = (obj: Record<string, unknown>): void => {
  if (obj.tierCaps === undefined) return;
  if (!isPlainObject(obj.tierCaps) || Array.isArray(obj.tierCaps)) {
    throw fail("'tierCaps' must be an object");
  }
  for (const [tierName, cap] of Object.entries(obj.tierCaps)) {
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
      throw fail(`tierCaps.'${tierName}' must be a positive integer`);
    }
  }
};

export const validateTierPrompts = (obj: Record<string, unknown>): void => {
  if (obj.tierPrompts === undefined) return;
  if (!isPlainObject(obj.tierPrompts) || Array.isArray(obj.tierPrompts)) {
    throw fail("'tierPrompts' must be an object");
  }
  for (const [tierName, prompt] of Object.entries(obj.tierPrompts)) {
    if (typeof prompt !== "string") {
      throw fail(`tierPrompts.'${tierName}' must be a string`);
    }
  }
};

export const validateTaskPatterns = (obj: Record<string, unknown>): void => {
  if (obj.taskPatterns === undefined) return;
  if (!isPlainObject(obj.taskPatterns) || Array.isArray(obj.taskPatterns)) {
    throw fail("'taskPatterns' must be an object");
  }
  for (const [tierName, patterns] of Object.entries(obj.taskPatterns)) {
    if (!Array.isArray(patterns)) {
      throw fail(`taskPatterns.'${tierName}' must be an array of strings`);
    }
  }
};

// ---------------------------------------------------------------------------
// Enforcement — split into per-key validators
// ---------------------------------------------------------------------------

export const validateEnforcement = (obj: Record<string, unknown>): void => {
  if (obj.enforcement === undefined) return;
  if (!isPlainObject(obj.enforcement) || Array.isArray(obj.enforcement)) {
    throw fail("enforcement must be an object");
  }
  const enf = obj.enforcement;
  validateEnforcementMode(enf);
  validateEnforcementVerify(enf);
  validateEnforcementEscalate(enf);
  validateEnforcementPerTier(enf);
  validateEnforcementGuard(enf);
};

export const validateEnforcementMode = (enf: Record<string, unknown>): void => {
  if (enf.mode === undefined) return;
  if (
    typeof enf.mode !== "string" ||
    !(ENFORCEMENT_MODES as readonly string[]).includes(enf.mode)
  ) {
    throw fail(`enforcement.mode must be one of ${ENFORCEMENT_MODES_LIST}`);
  }
};

export const validateEnforcementVerify = (enf: Record<string, unknown>): void => {
  if (enf.verify === undefined) return;
  // Permissive skip: a non-object verify is ignored so older configs survive.
  if (!isPlainObject(enf.verify)) return;
  const verify = enf.verify;
  if (
    verify.graderPolicy !== undefined &&
    !(GRADER_POLICIES as readonly string[]).includes(verify.graderPolicy as string)
  ) {
    throw fail(`enforcement.verify.graderPolicy must be "${EXPECTED_GRADER_POLICY}"`);
  }
  if (verify.require !== undefined) {
    if (
      typeof verify.require !== "string" ||
      !(VERIFY_REQUIRE_MODES as readonly string[]).includes(verify.require)
    ) {
      throw fail(
        `enforcement.verify.require must be one of ${VERIFY_REQUIRE_MODES_LIST} (got ${JSON.stringify(verify.require)})`,
      );
    }
  }
};

export const validateEnforcementEscalate = (enf: Record<string, unknown>): void => {
  if (enf.escalate === undefined) return;
  // Permissive skip: a non-object escalate is ignored so older configs survive.
  if (!isPlainObject(enf.escalate)) return;
  const escalate = enf.escalate;
  const legacyEscalationKey = "reasoning" + "Escalation";
  if (legacyEscalationKey in escalate) {
    throw fail(
      `enforcement.escalate.${legacyEscalationKey} is removed; migrate to per-tier reasoningControl.maxBumps in docs/CONFIG_REFERENCE.md`,
    );
  }
  validateEscalateCostCeiling(escalate);
  if (escalate.ladder !== undefined) {
    if (
      !Array.isArray(escalate.ladder) ||
      !escalate.ladder.every((s: unknown) => typeof s === "string")
    ) {
      throw fail("enforcement.escalate.ladder must be an array of strings");
    }
  }
  if (escalate.maxAttemptsPerTier !== undefined) {
    if (
      typeof escalate.maxAttemptsPerTier !== "number" ||
      !Number.isInteger(escalate.maxAttemptsPerTier) ||
      escalate.maxAttemptsPerTier < 0
    ) {
      throw fail("enforcement.escalate.maxAttemptsPerTier must be an integer >= 0");
    }
  }
  if (escalate.maxTotalAttempts !== undefined) {
    if (
      typeof escalate.maxTotalAttempts !== "number" ||
      !Number.isInteger(escalate.maxTotalAttempts) ||
      escalate.maxTotalAttempts < 1
    ) {
      throw fail("enforcement.escalate.maxTotalAttempts must be an integer >= 1");
    }
  }
  if (
    escalate.floorTier !== undefined &&
    escalate.floorTier !== null &&
    typeof escalate.floorTier !== "string"
  ) {
    throw fail("enforcement.escalate.floorTier must be a string or null");
  }
};

export const validateEscalateCostCeiling = (escalate: Record<string, unknown>): void => {
  if (escalate.costCeiling === undefined) return;
  // Permissive skip: a non-object costCeiling is ignored so older configs survive.
  if (!isPlainObject(escalate.costCeiling)) return;
  const costCeiling = escalate.costCeiling;
  if (costCeiling.multiple !== undefined) {
    if (typeof costCeiling.multiple !== "number" || costCeiling.multiple <= 0) {
      throw fail("enforcement.escalate.costCeiling.multiple must be a number > 0");
    }
  }
};

export const validateEnforcementPerTier = (enf: Record<string, unknown>): void => {
  if (enf.perTier === undefined) return;
  // Permissive skip: a non-object perTier is ignored so older configs survive.
  if (!isPlainObject(enf.perTier) || Array.isArray(enf.perTier)) return;
  for (const [tierName, tierMode] of Object.entries(enf.perTier)) {
    if (
      typeof tierMode !== "string" ||
      !(ENFORCEMENT_MODES as readonly string[]).includes(tierMode)
    ) {
      throw fail(`enforcement.perTier.${tierName} must be one of ${ENFORCEMENT_MODES_LIST}`);
    }
  }
};

export const validateEnforcementGuard = (enf: Record<string, unknown>): void => {
  if (enf.guard === undefined) return;
  // Permissive skip: a non-object guard is ignored so older configs survive.
  if (!isPlainObject(enf.guard)) return;
  const guard = enf.guard;
  if (guard.budget !== undefined) {
    if (typeof guard.budget !== "number" || !Number.isFinite(guard.budget) || guard.budget < 1) {
      throw new Error("enforcement.guard.budget must be a number >= 1");
    }
  }
  if (guard.blockScriptWrites !== undefined) {
    if (typeof guard.blockScriptWrites !== "boolean") {
      throw new Error("enforcement.guard.blockScriptWrites must be a boolean");
    }
  }
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
const MATCH_MODES_LIST = MATCH_MODES.join("|");

export const validateReasoningPolicy = (obj: Record<string, unknown>): void => {
  if (obj.reasoningPolicy === undefined) return;
  if (!isPlainObject(obj.reasoningPolicy) || Array.isArray(obj.reasoningPolicy)) {
    throw fail("'reasoningPolicy' must be an object");
  }
  const policy = obj.reasoningPolicy;
  validateReasoningPolicyMode(policy);
  if (policy.profiles !== undefined || policy.defaultProfile !== undefined) {
    validateReasoningPolicyV2(policy);
    return;
  }
  validateAdaptivePolicy(policy);
};

const validateReasoningPolicyV2 = (policy: Record<string, unknown>): void => {
  if (!Array.isArray(policy.profiles) || policy.profiles.length === 0) {
    throw fail("reasoningPolicy.profiles must be a non-empty array of strings");
  }
  if (
    !policy.profiles.every(
      (profile: unknown) => typeof profile === "string" && profile.trim().length > 0,
    ) ||
    new Set(policy.profiles).size !== policy.profiles.length
  ) {
    throw fail("reasoningPolicy.profiles must contain unique non-empty strings");
  }
  if (
    policy.mode !== "static" &&
    policy.mode !== undefined &&
    (typeof policy.defaultProfile !== "string" || !policy.profiles.includes(policy.defaultProfile))
  ) {
    throw fail("reasoningPolicy.defaultProfile must be a registered profile");
  }
  if (policy.defaultProfile !== undefined && !policy.profiles.includes(policy.defaultProfile)) {
    throw fail("reasoningPolicy.defaultProfile must be a registered profile");
  }
  if (policy.surfaceLimits !== undefined && typeof policy.surfaceLimits !== "boolean") {
    throw fail("reasoningPolicy.surfaceLimits must be a boolean");
  }
  if (policy.adaptive === undefined) return;
  if (!isPlainObject(policy.adaptive) || Array.isArray(policy.adaptive)) {
    throw fail("reasoningPolicy.adaptive must be an object");
  }
  const adaptive = policy.adaptive;
  validateProfileOrNull(
    adaptive.trivialProfile,
    "reasoningPolicy.adaptive.trivialProfile",
    policy.profiles,
  );
  validateProfileDefaults(adaptive.tierProfileDefaults, policy.profiles);
  validateProfileRules(adaptive.rules, policy.profiles);
  validateAdaptiveSurfaceDecision(adaptive.surfaceDecision);
};

const validateProfileOrNull = (value: unknown, path: string, profiles: unknown[]): void => {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !profiles.includes(value)) {
    throw fail(`${path} must be a registered profile or null`);
  }
};

const validateProfileDefaults = (value: unknown, profiles: unknown[]): void => {
  if (value === undefined) return;
  if (!isPlainObject(value) || Array.isArray(value)) {
    throw fail("reasoningPolicy.adaptive.tierProfileDefaults must be an object");
  }
  for (const [tier, profile] of Object.entries(value)) {
    if (typeof profile !== "string" || !profiles.includes(profile)) {
      throw fail(
        `reasoningPolicy.adaptive.tierProfileDefaults.${tier} must be a registered profile`,
      );
    }
  }
};

const validateProfileRules = (value: unknown, profiles: unknown[]): void => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw fail("reasoningPolicy.adaptive.rules must be an array");
  }
  for (const [index, rule] of value.entries()) {
    const prefix = `reasoningPolicy.adaptive.rules[${index}]`;
    if (!isPlainObject(rule) || Array.isArray(rule)) {
      throw fail(`${prefix} must be an object`);
    }
    if (
      !Array.isArray(rule.keywords) ||
      rule.keywords.length === 0 ||
      !rule.keywords.every((k: unknown) => typeof k === "string")
    ) {
      throw fail(`${prefix}.keywords must be a non-empty array of strings`);
    }
    if (typeof rule.profile !== "string" || !profiles.includes(rule.profile)) {
      throw fail(`${prefix}.profile must be a registered profile`);
    }
    if (
      rule.match !== undefined &&
      (typeof rule.match !== "string" || !(MATCH_MODES as readonly string[]).includes(rule.match))
    ) {
      throw fail(`${prefix}.match must be one of ${MATCH_MODES_LIST}`);
    }
    if (
      rule.excludeKeywords !== undefined &&
      (!Array.isArray(rule.excludeKeywords) ||
        !rule.excludeKeywords.every((k: unknown) => typeof k === "string"))
    ) {
      throw fail(`${prefix}.excludeKeywords must be an array of strings`);
    }
  }
};

export const validateReasoningPolicyMode = (policy: Record<string, unknown>): void => {
  if (policy.mode === undefined) return;
  if (
    typeof policy.mode !== "string" ||
    !(REASONING_MODES as readonly string[]).includes(policy.mode)
  ) {
    throw fail(
      `reasoningPolicy.mode must be one of ${REASONING_MODES_LIST} (got ${JSON.stringify(policy.mode)})`,
    );
  }
};

export const validateAdaptivePolicy = (policy: Record<string, unknown>): void => {
  if (policy.adaptive === undefined) return;
  if (!isPlainObject(policy.adaptive) || Array.isArray(policy.adaptive)) {
    throw fail("reasoningPolicy.adaptive must be an object");
  }
  const adaptive = policy.adaptive;
  validateLevelOrNull(adaptive.trivialLevel, "reasoningPolicy.adaptive.trivialLevel");
  validateLevelOrNull(adaptive.defaultLevel, "reasoningPolicy.adaptive.defaultLevel");
  validateKeywordRules(adaptive.keywordRules);
  validateAdaptiveTierDefaults(adaptive.tierDefaults);
  validateAdaptiveSurfaceDecision(adaptive.surfaceDecision);
};

/**
 * Validate an adaptive level slot that admits `null` (e.g. `trivialLevel`,
 * `defaultLevel`). Null/absent means "no patch"; any other value must be a
 * member of the reasoning level set.
 */
const validateLevelOrNull = (value: unknown, path: string): void => {
  if (value === undefined || value === null) return;
  if (!isConfiguredLevel(value)) {
    throw fail(
      `${path} must be a non-empty configured profile or null (got ${JSON.stringify(value)})`,
    );
  }
};

export const validateKeywordRules = (rules: unknown): void => {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) {
    throw fail("reasoningPolicy.adaptive.keywordRules must be an array");
  }
  for (const [index, rule] of rules.entries()) {
    validateKeywordRule(rule, index);
  }
};

export const validateKeywordRule = (rule: unknown, index: number): void => {
  const prefix = `reasoningPolicy.adaptive.keywordRules[${index}]`;
  if (!isPlainObject(rule) || Array.isArray(rule)) {
    throw fail(`${prefix} must be an object`);
  }
  // keywords: REQUIRED, non-empty array of strings
  if (!Array.isArray(rule.keywords)) {
    throw fail(`${prefix}.keywords must be an array of strings`);
  }
  if (rule.keywords.length === 0) {
    throw fail(`${prefix}.keywords must be a non-empty array of strings`);
  }
  if (!rule.keywords.every((k: unknown) => typeof k === "string")) {
    throw fail(`${prefix}.keywords must be an array of strings`);
  }
  // level: REQUIRED, must be in the level set
  if (!isConfiguredLevel(rule.level)) {
    throw fail(
      `${prefix}.level must be a non-empty configured profile (got ${JSON.stringify(rule.level)})`,
    );
  }
  // match: OPTIONAL; must be one of the four mode literals
  if (rule.match !== undefined) {
    if (
      typeof rule.match !== "string" ||
      !(MATCH_MODES as readonly string[]).includes(rule.match as MatchMode)
    ) {
      throw fail(
        `${prefix}.match must be one of ${MATCH_MODES_LIST} (got ${JSON.stringify(rule.match)})`,
      );
    }
  }
  // excludeKeywords: OPTIONAL; array of strings (may be empty)
  if (rule.excludeKeywords !== undefined) {
    if (
      !Array.isArray(rule.excludeKeywords) ||
      !rule.excludeKeywords.every((k: unknown) => typeof k === "string")
    ) {
      throw fail(`${prefix}.excludeKeywords must be an array of strings`);
    }
  }
  // regex fail-fast: any keyword that does not compile under `new RegExp`
  // throws at config load. Runtime (`matchSignal`) keeps fail-soft as a
  // safety net, but malformed configs should not ship.
  if (rule.match === "regex") {
    for (const kw of rule.keywords as string[]) {
      try {
        new RegExp(kw);
      } catch (err) {
        throw fail(`${prefix} has invalid regex '${kw}': ${(err as Error).message}`);
      }
    }
  }
};

export const validateAdaptiveTierDefaults = (td: unknown): void => {
  if (td === undefined) return;
  if (!isPlainObject(td) || Array.isArray(td)) {
    throw fail("reasoningPolicy.adaptive.tierDefaults must be an object");
  }
  for (const [tierName, level] of Object.entries(td)) {
    if (!isConfiguredLevel(level)) {
      throw fail(
        `reasoningPolicy.adaptive.tierDefaults.${tierName} must be a non-empty configured profile (got ${JSON.stringify(level)})`,
      );
    }
  }
};

const validateAdaptiveSurfaceDecision = (value: unknown): void => {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw fail(
      `reasoningPolicy.adaptive.surfaceDecision must be a boolean (got ${JSON.stringify(value)})`,
    );
  }
};

// ---------------------------------------------------------------------------
// Fanout configuration (Plan 044)
//
// Validation rules:
//   - fanout is optional; absent or {} means all defaults applied.
//   - enabled must be boolean (default false).
//   - All numeric limits must be positive integers.
//   - batchTimeoutMs must be >= workerTimeoutMs.
//   - maxConcurrentPerTier keys must be within active-preset tiers ∩ {fast,light,medium}.
//   - breaker.failureThreshold and breaker.cooldownMs must be positive integers.
// ---------------------------------------------------------------------------

export const validateFanout = (raw: Record<string, unknown>): void => {
  const fanout = raw.fanout;
  if (fanout === undefined) return;
  if (!isPlainObject(fanout)) {
    throw fail("'fanout' must be an object");
  }

  // enabled: boolean
  if (fanout.enabled !== undefined && typeof fanout.enabled !== "boolean") {
    throw fail("fanout.enabled must be a boolean");
  }

  // maxWorkersPerBatch: positive integer
  if (fanout.maxWorkersPerBatch !== undefined) {
    if (
      typeof fanout.maxWorkersPerBatch !== "number" ||
      !Number.isFinite(fanout.maxWorkersPerBatch) ||
      !Number.isInteger(fanout.maxWorkersPerBatch) ||
      fanout.maxWorkersPerBatch < 1
    ) {
      throw fail("fanout.maxWorkersPerBatch must be a positive integer");
    }
  }

  // maxConcurrentGlobal: positive integer
  if (fanout.maxConcurrentGlobal !== undefined) {
    if (
      typeof fanout.maxConcurrentGlobal !== "number" ||
      !Number.isFinite(fanout.maxConcurrentGlobal) ||
      !Number.isInteger(fanout.maxConcurrentGlobal) ||
      fanout.maxConcurrentGlobal < 1
    ) {
      throw fail("fanout.maxConcurrentGlobal must be a positive integer");
    }
  }

  // workerTimeoutMs: positive integer
  if (fanout.workerTimeoutMs !== undefined) {
    if (
      typeof fanout.workerTimeoutMs !== "number" ||
      !Number.isFinite(fanout.workerTimeoutMs) ||
      !Number.isInteger(fanout.workerTimeoutMs) ||
      fanout.workerTimeoutMs < 1
    ) {
      throw fail("fanout.workerTimeoutMs must be a positive integer");
    }
  }

  // batchTimeoutMs: positive integer
  if (fanout.batchTimeoutMs !== undefined) {
    if (
      typeof fanout.batchTimeoutMs !== "number" ||
      !Number.isFinite(fanout.batchTimeoutMs) ||
      !Number.isInteger(fanout.batchTimeoutMs) ||
      fanout.batchTimeoutMs < 1
    ) {
      throw fail("fanout.batchTimeoutMs must be a positive integer");
    }
  }

  // batchTimeoutMs >= workerTimeoutMs
  const workerTimeout = fanout.workerTimeoutMs ?? DEFAULT_FANOUT_CONFIG.workerTimeoutMs;
  const batchTimeout = fanout.batchTimeoutMs ?? DEFAULT_FANOUT_CONFIG.batchTimeoutMs;
  if (batchTimeout < workerTimeout) {
    throw fail(
      `fanout.batchTimeoutMs (${batchTimeout}) must be >= fanout.workerTimeoutMs (${workerTimeout})`,
    );
  }

  // maxConcurrentPerTier: validate keys against active preset
  if (fanout.maxConcurrentPerTier !== undefined) {
    if (!isPlainObject(fanout.maxConcurrentPerTier)) {
      throw fail("fanout.maxConcurrentPerTier must be an object");
    }
    // Determine which tiers are in the active preset
    const activePreset = raw.activePreset as string | undefined;
    const presets = raw.presets as Record<string, Record<string, unknown>> | undefined;
    const presetTiers =
      activePreset && presets?.[activePreset] ? Object.keys(presets[activePreset]) : [];
    // Only tiers that are in BOTH the active preset AND the fanout domain are valid
    const fanoutDomain = new Set(["fast", "light", "medium"]);
    const validKeys = new Set(presetTiers.filter((t) => fanoutDomain.has(t)));
    for (const key of Object.keys(fanout.maxConcurrentPerTier)) {
      if (!validKeys.has(key)) {
        throw fail(`fanout.maxConcurrentPerTier contains unknown tier key '${key}'`);
      }
      const val = (fanout.maxConcurrentPerTier as Record<string, unknown>)[key];
      if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val) || val < 1) {
        throw fail(`fanout.maxConcurrentPerTier.${key} must be a positive integer`);
      }
    }
  }

  // breaker: object with positive integer failureThreshold and cooldownMs
  if (fanout.breaker !== undefined) {
    if (!isPlainObject(fanout.breaker)) {
      throw fail("fanout.breaker must be an object");
    }
    const breaker = fanout.breaker as Record<string, unknown>;
    if (breaker.failureThreshold !== undefined) {
      if (
        typeof breaker.failureThreshold !== "number" ||
        !Number.isFinite(breaker.failureThreshold) ||
        !Number.isInteger(breaker.failureThreshold) ||
        breaker.failureThreshold < 1
      ) {
        throw fail("fanout.breaker.failureThreshold must be a positive integer");
      }
    }
    if (breaker.cooldownMs !== undefined) {
      if (
        typeof breaker.cooldownMs !== "number" ||
        !Number.isFinite(breaker.cooldownMs) ||
        !Number.isInteger(breaker.cooldownMs) ||
        breaker.cooldownMs < 1
      ) {
        throw fail("fanout.breaker.cooldownMs must be a positive integer");
      }
    }
  }
};
