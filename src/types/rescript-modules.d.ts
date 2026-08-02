// Hand-maintained ambient TypeScript types for ReScript-compiled modules.
// genType is out of scope; these are written by hand to match the .resi contracts.
// ReScript emits .res.mjs files; TypeScript sees them via these ambient declarations.

// ---------------------------------------------------------------------------
// Pilot (bootstrap verification module)
// ---------------------------------------------------------------------------
declare module "./Pilot.res.mjs" {
  export const add: (a: number, b: number) => number;
}

// Test smoke imports from test/smoke/pilot-smoke.ts
declare module "../../src/Pilot.res.mjs" {
  export const add: (a: number, b: number) => number;
}

// ---------------------------------------------------------------------------
// Router Config (src/router/Config.res)
// Uses a non-relative module name so TypeScript module resolution finds it
// from any file in the project, regardless of relative path.
// ---------------------------------------------------------------------------
declare module "Config.res.mjs" {
  // Reasoning levels validated by Config decoder
  export const reasoningLevels: string[];

  // JSON decoder: returns Some(Config) on success, None on invalid input
  export function parse(json: unknown): Config | null;

  // Type: enforcement mode variant
  export type ModeEnum = "off" | "advisory" | "enforced";

  // Type: tier capability variants
  export type TierCapability =
    | { kind: "TC_None" }
    | { kind: "Binary"; field: string; baseline: string | null; elevated: string }
    | { kind: "Discrete"; field: string; levels: string[] }
    | { kind: "Budgeted"; field: string; recommended: Record<string, number> };

  // Type: thinking block (budgetTokens)
  export type ThinkingBlock = { budgetTokens: number | null };

  // Type: reasoning block (effort + summary)
  export type ReasoningBlock = { effort: string | null; summary: string | null };

  // Type: per-tier configuration
  export type TierConfig = {
    model: string;
    variant: string | null;
    costRatio: number | null;
    description: string;
    whenToUse: string[];
    thinking: ThinkingBlock | null;
    reasoning: ReasoningBlock | null;
    capability: TierCapability | null;
  };

  // Type: preset = dict<tierConfig>
  export type Preset = Record<string, TierConfig>;

  // Type: enforcement guard
  export type EnforcementGuard = {
    readDraftCap: number | null;
    sameOpRetryCap: number | null;
    blockSelfScript: boolean | null;
    deliverableFirst: boolean | null;
    budget: number | null;
    blockScriptWrites: boolean | null;
  };

  // Type: cost ceiling block
  export type CostCeilingBlock = { base: string | null; multiple: number | null };

  // Type: enforcement escalate
  export type EnforcementEscalate = {
    floorTier: string | null;
    ladder: string[] | null;
    maxAttemptsPerTier: number | null;
    maxTotalAttempts: number | null;
    costCeiling: CostCeilingBlock | null;
  };

  // Type: enforcement verify
  export type EnforcementVerify = {
    require: string | null;
    requireExplicitDoD: boolean | null;
    preferDeterministic: boolean | null;
    graderPolicy: string | null;
    graderTemperature: number | null;
    minGraderTier: string | null;
    skipFastTier: boolean | null;
    skipTiers: string[] | null;
    hookTimeoutMs: number | null;
  };

  // Type: enforcement config
  export type EnforcementConfig = {
    mode: ModeEnum | null;
    envGate: string | null;
    perTier: Record<string, string> | null;
    guard: EnforcementGuard | null;
    verify: EnforcementVerify | null;
    escalate: EnforcementEscalate | null;
    proportional: { trivialBypass: boolean | null; trivialClassifier: string | null } | null;
  };

  // Type: keyword rule
  export type KeywordRule = {
    keywords: string[];
    level: string;
    match: string | null;
    excludeKeywords: string[] | null;
  };

  // Type: adaptive policy
  export type AdaptivePolicy = {
    trivialLevel: string | null;
    defaultLevel: string | null;
    keywordRules: KeywordRule[] | null;
    tierDefaults: Record<string, string> | null;
    surfaceDecision: boolean | null;
  };

  // Type: reasoning policy config
  export type ReasoningPolicyConfig = {
    mode: string | null;
    defaultLevel: string | null;
    surfaceLimits: boolean | null;
    adaptive: AdaptivePolicy | null;
  };

  // Type: mode entry
  export type ModeEntry = {
    defaultTier: string;
    description: string;
    overrideRules: string[] | null;
  };

  // Type: main config record
  export type Config = {
    activePreset: string;
    activeMode: string | null;
    tierCaps: Record<string, number> | null;
    tierPrompts: Record<string, string> | null;
    presets: Record<string, Preset>;
    rules: string[];
    defaultTier: string;
    fallback: { global: Record<string, string[]> | null } | null;
    taskPatterns: Record<string, string[]> | null;
    modes: Record<string, ModeEntry> | null;
    enforcement: EnforcementConfig | null;
    reasoningPolicy: ReasoningPolicyConfig | null;
  };

  // Aliases for backward compatibility with existing TS code
  export type RouterConfig = Config;
  export type TierDefs = Preset;
}

// ---------------------------------------------------------------------------
// TierLadder (src/router/TierLadder.res)
// Pure tier-ladder resolution — depends on Config.
// Accepts the broader TS RouterConfig (which uses optional fields, not null).
// The ReScript implementation only reads `enforcement.escalate.ladder` and
// `presets[activePreset]`, both of which are safe with undefined-aware access.
// ---------------------------------------------------------------------------
declare module "*TierLadder.res.mjs" {
  export const defaultTierNames: string[];
  export const resolveLadder: (
    cfg: import("../router/config.types").RouterConfig,
  ) => string[];
}

// ---------------------------------------------------------------------------
// TierModelGuard (src/utils/TierModelGuard.res)
// Shared tier-resolution guard — resolves a tier name to {providerID, modelID}.
// Uses the broader TS RouterConfig (optional fields) at the boundary.
// ---------------------------------------------------------------------------
declare module "*TierModelGuard.res.mjs" {
  export type TierModelGuardModel = {
    providerID: string;
    modelID: string;
  };

  // Mirrors the original TS interface with optional properties for structural compat
  export type TierModelGuardResult = {
    ok: boolean;
    model?: TierModelGuardModel;
    reason?: "invalid model or provider configuration";
  };

  export const resolveTierModelGuard: (
    cfg: import("../router/config.types").RouterConfig,
    tierName: string,
  ) => TierModelGuardResult;
}

// ---------------------------------------------------------------------------
// Ladder (src/escalate/Ladder.res)
// Pure state machine — depends on RouterConfig from TS boundary.
// ---------------------------------------------------------------------------
declare module "*Ladder.res.mjs" {
  export type EscalatePolicy = {
    ladder: string[];
    floorTier?: string | null;
    maxAttemptsPerTier: number;
    maxTotalAttempts: number;
    costMultiple?: number | null;
  };

  export type LadderState = {
    currentTier: string;
    attemptsThisTier: number;
    totalAttempts: number;
    escalations: number;
    firstAttemptCost: number | null;
    cumulativeCost: number;
  };

  export type LadderVerdict = {
    pass: boolean;
    reasons?: string[] | null;
  };

  export type LadderActionKind = "accept" | "retry" | "escalate" | "give_up";

  export type LadderAction = {
    action: LadderActionKind;
    tier?: string | null;
    forcingMessage?: string | null;
    reason?: string | null;
  };

  export const tierRank: (tier: string, ladder: string[]) => number;
  export const resolveStartTier: (producerTier: string, policy: EscalatePolicy) => string;
  export const newLadderState: (producerTier: string, policy: EscalatePolicy) => LadderState;
  export const recordAttempt: (state: LadderState, costUnits?: number) => LadderState;
  export const nextTierAfter: (currentTier: string, policy: EscalatePolicy) => string | null;
  export const buildLadderForcingMessage: (reasons: string[]) => string;
  export const nextAction: (
    state: LadderState,
    verdict: LadderVerdict | null | undefined,
    policy: EscalatePolicy,
    signal?: { aborted: boolean },
  ) => LadderAction;
  export const advance: (state: LadderState, action: LadderAction) => LadderState;
  export const buildEscalatePolicy: (
    cfg: import("../router/config.types").RouterConfig,
  ) => EscalatePolicy;
  export const formatLadderScorecard: (
    state: LadderState,
    accepted: boolean,
    method: string,
  ) => string;
}

// ---------------------------------------------------------------------------
// ReasoningMatch (src/reasoning/ReasoningMatch.res)
// Pure word/stem/substring/regex matcher with module-level regex cache.
// Uses explicit pattern-string cache so %raw can access parameters directly.
// ---------------------------------------------------------------------------
declare module "*ReasoningMatch.res.mjs" {
  // Match mode variants — string literals matching TS MatchMode.
  export type matchMode = "word" | "stem" | "substring" | "regex";

  // Preprocess raw task text: lowercase → collapse whitespace → trim.
  export const normalizeSignalText: (raw: string) => string;

  // Test whether text matches keyword under mode.
  // Empty keyword → false; invalid regex → false (fail-soft).
  export const matchSignal: (text: string, keyword: string, mode: matchMode) => boolean;
}

// ---------------------------------------------------------------------------
// ReasoningCapability (src/reasoning/ReasoningCapability.res)
// Provider-agnostic reasoning capability inference from TierConfig fields.
// Pure helper — no I/O, no router state.
// ---------------------------------------------------------------------------
declare module "*ReasoningCapability.res.mjs" {
  // Normalized reasoning level — provider-agnostic rank.
  export type reasoningLevel = "minimal" | "normal" | "elevated" | "max";

  // Output channel a capability writes through.
  export type reasoningField = "variant" | "reasoning.effort" | "thinking.budgetTokens";

  // Capability discriminated union as plain record.
  // kind: "none" | "binary" | "discrete" | "budgeted"
  export type reasoningCapability = {
    kind: string;
    field?: reasoningField;
    baseline?: string;
    elevated?: string;
    levels?: Array<string>;
    recommended?: Record<string, number>;
  };

  // Minimal TierConfig shape — only fields read by inferCapability.
  export type tierConfig = {
    model: string;
    variant?: string;
    thinking?: { budgetTokens?: number };
    reasoning?: { effort?: string };
    description: string;
    whenToUse: Array<string>;
    capability?: reasoningCapability;
  };

  // Infer a capability from a TierConfig when no explicit capability is declared.
  // Inference precedence (first match wins):
  //   1. tier.reasoning?.effort  → discrete / "reasoning.effort"
  //   2. tier.thinking?.budgetTokens → budgeted / "thinking.budgetTokens"
  //   3. tier.variant in {low,medium,high} → discrete / "variant"
  //   4. tier.variant in {thinking,max}  → binary / "variant"
  //   5. otherwise → { kind: "none" }
  export const inferCapability: (tier: tierConfig) => reasoningCapability;
}

// ---------------------------------------------------------------------------
// ReasoningAdaptive (src/reasoning/ReasoningAdaptive.res)
// Deterministic adaptive level selector — pure function, no IO, no module state.
// Decision order: isTrivial → tierDefaults → keywordRules → defaultLevel.
// Uses ReasoningMatch.matchSignal internally for keyword matching.
// ---------------------------------------------------------------------------
declare module "*ReasoningAdaptive.res.mjs" {
  // Normalized reasoning level — same as ReasoningCapability
  export type reasoningLevel = "minimal" | "normal" | "elevated" | "max";

  // Match mode — same as ReasoningMatch
  export type matchMode = "word" | "stem" | "substring" | "regex";

  // Adaptive signals: signals available at dispatch time
  export type adaptiveSignals = {
    prompt: string;
    description: string;
    tierName: string;
    isTrivial: boolean;
  };

  // Keyword rule shape (mirrors AdaptivePolicyConfig.keywordRules)
  export type keywordRule = {
    keywords: string[];
    level: string;
    match: string | null;
    excludeKeywords: string[] | null;
  };

  // AdaptivePolicyConfig minimal shape
  export type adaptivePolicyConfig = {
    trivialLevel: string | null;
    defaultLevel: string | null;
    keywordRules: keywordRule[] | null;
    tierDefaults: Record<string, string> | null;
    surfaceDecision: boolean | null;
  };

  // ReasoningPolicyConfig minimal shape (fields read by selectAdaptiveLevel)
  export type reasoningPolicyConfig = {
    mode: string | null;
    defaultLevel: string | null;
    surfaceLimits: boolean | null;
    adaptive: adaptivePolicyConfig | null;
  };

  // Return type — level is Js.Nullable.t at the TS boundary
  export type adaptiveDecision = {
    level: reasoningLevel | null; // Js.Nullable.t maps to nullable in TS
    reason: string;
  };

  // Main export: pure adaptive level selector
  export const selectAdaptiveLevel: (
    signals: adaptiveSignals,
    policy: reasoningPolicyConfig | null,
  ) => adaptiveDecision;

  // Accessor helpers (for test assertions)
  export const getLevelNull: (d: adaptiveDecision) => reasoningLevel | null;
  export const getLevelOption: (d: adaptiveDecision) => reasoningLevel | null | undefined;
  export const getReason: (d: adaptiveDecision) => string;

  // Test helper: build a ReasoningPolicyConfig with adaptive block
  export const makePolicyWithAdaptive: (adaptive: adaptivePolicyConfig | null) => reasoningPolicyConfig;
}

// ---------------------------------------------------------------------------
// Reasoning (src/reasoning/Reasoning.res)
// Public facade re-exporting from five reasoning sub-modules.
// TS consumers import from this single stable path, not the sub-modules.
// ---------------------------------------------------------------------------
declare module "*Reasoning.res.mjs" {
  // Normalized reasoning level
  export type reasoningLevel = "minimal" | "normal" | "elevated" | "max";

  // Match mode variants
  export type matchMode = "word" | "stem" | "substring" | "regex";

  // Output channel discriminator
  export type reasoningField = "variant" | "reasoning.effort" | "thinking.budgetTokens";

  // Capability discriminated union (JS object form)
  export type reasoningCapability = {
    kind: string;
    field?: reasoningField;
    baseline?: string;
    elevated?: string;
    levels?: Array<string>;
    recommended?: Record<string, number>;
  };

  // Minimal TierConfig shape (fields read by inferCapability)
  export type tierConfig = {
    model: string;
    variant?: string;
    thinking?: { budgetTokens?: number };
    reasoning?: { effort?: string };
    description: string;
    whenToUse: Array<string>;
    capability?: reasoningCapability;
  };

  // Adaptive signals: dispatch-time signals for adaptive level selection
  export type adaptiveSignals = {
    prompt: string;
    description: string;
    tierName: string;
    isTrivial: boolean;
  };

  // Keyword rule shape
  export type keywordRule = {
    keywords: string[];
    level: string;
    match: string | null;
    excludeKeywords: string[] | null;
  };

  // Adaptive policy config
  export type adaptivePolicyConfig = {
    trivialLevel: string | null;
    defaultLevel: string | null;
    keywordRules: keywordRule[] | null;
    tierDefaults: Record<string, string> | null;
    surfaceDecision: boolean | null;
  };

  // Reasoning policy config (static | manual | adaptive modes)
  export type reasoningPolicyConfig = {
    mode: string | null;
    defaultLevel: string | null;
    surfaceLimits: boolean | null;
    adaptive: adaptivePolicyConfig | null;
  };

  // Resolved reasoning: provider-specific patch or null for no-op
  // variant and options are optional fields; null means no patch
  export type resolvedReasoning = {
    variant?: string;
    options?: Record<string, unknown>;
  } | null;

  // Adaptive decision
  export type adaptiveDecision = {
    level: reasoningLevel | null; // Js.Nullable.t maps to nullable
    reason: string;
  };

  // Module aliases for sub-module types (values are undefined at runtime)
  export const Match: typeof import("./ReasoningMatch.res.mjs");
  export const Capability: typeof import("./ReasoningCapability.res.mjs");
  export const Translate: typeof import("./ReasoningTranslate.res.mjs");
  export const Policy: typeof import("./ReasoningPolicy.res.mjs");
  export const Adaptive: typeof import("./ReasoningAdaptive.res.mjs");

  // Re-exported functions
  export const normalizeSignalText: (raw: string) => string;
  export const matchSignal: (text: string, keyword: string, mode: matchMode) => boolean;
  export const inferCapability: (tier: tierConfig) => reasoningCapability;
  export const translateLevel: (cap: reasoningCapability, level: reasoningLevel) => resolvedReasoning | null;
  export const resolveReasoningOverride: (
    tier: tierConfig,
    policy: reasoningPolicyConfig | null,
    sessionOverride: reasoningLevel | null,
    signals: adaptiveSignals,
  ) => resolvedReasoning | null;
  export const selectAdaptiveLevel: (
    signals: adaptiveSignals,
    policy: reasoningPolicyConfig | null,
  ) => adaptiveDecision;
  export const getLevelNull: (d: adaptiveDecision) => reasoningLevel | null;
  export const getLevelOption: (d: adaptiveDecision) => reasoningLevel | null | undefined;
  export const getReason: (d: adaptiveDecision) => string;
  export const makePolicyWithAdaptive: (adaptive: adaptivePolicyConfig | null) => reasoningPolicyConfig;
}

// ---------------------------------------------------------------------------
// ValidateRoot (src/validate/ValidateRoot.res)
// ROOT section validators: validateRootFields and validateRulesAndDefaultTier.
// Input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// ---------------------------------------------------------------------------
declare module "*ValidateRoot.res.mjs" {
  // Validate root-level activePreset is a non-empty string
  export const validateRootFields: (obj: Record<string, unknown>) => void;

  // Validate rules (array of strings) and defaultTier (string)
  export const validateRulesAndDefaultTier: (obj: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// ValidatePresets (src/validate/ValidatePresets.res)
// PRESETS section validators: validatePresets, validatePreset, validateTier.
// Input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// ---------------------------------------------------------------------------
declare module "*ValidatePresets.res.mjs" {
  // Validate the top-level presets block: must be a non-null object with at least one key
  export const validatePresets: (obj: Record<string, unknown>) => void;

  // Validate a single preset (named by presetName for error messages)
  export const validatePreset: (presetName: string, preset: Record<string, unknown>) => void;

  // Validate a single tier within a preset
  export const validateTier: (presetName: string, tierName: string, tier: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// MODES section validators: validateModes, validateMode.
// Input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// ---------------------------------------------------------------------------
declare module "*ValidateModes.res.mjs" {
  // Validate the top-level modes block (modes is optional — no-op if absent)
  export const validateModes: (obj: Record<string, unknown>) => void;

  // Validate a single mode (named by modeName for error messages)
  export const validateMode: (modeName: string, mode: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// ValidateSimple (src/validate/ValidateSimple.res)
// SIMPLE section validators: validateTierCaps, validateTierPrompts,
// validateTaskPatterns. Input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// ---------------------------------------------------------------------------
declare module "*ValidateSimple.res.mjs" {
  // Validate the tierCaps block: each cap must be a finite positive integer.
  // tierCaps is optional — no-op if absent.
  export const validateTierCaps: (obj: Record<string, unknown>) => void;

  // Validate the tierPrompts block: each prompt must be a string.
  // tierPrompts is optional — no-op if absent.
  export const validateTierPrompts: (obj: Record<string, unknown>) => void;

  // Validate the taskPatterns block: each patterns value must be an array of strings.
  // taskPatterns is optional — no-op if absent.
  export const validateTaskPatterns: (obj: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// ENFORCEMENT section validators: validateEnforcement, validateEnforcementMode,
// validateEnforcementVerify, validateEnforcementEscalate, validateEnforcementPerTier,
// validateEnforcementGuard. Input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// ---------------------------------------------------------------------------
declare module "*ValidateEnforcement.res.mjs" {
  // Top-level enforcement dispatcher. Throws if enforcement is present but not a plain object.
  export const validateEnforcement: (obj: Record<string, unknown>) => void;

  // Validate enforcement.mode in {off, advisory, enforced}. Silently skips if absent.
  export const validateEnforcementMode: (enf: Record<string, unknown>) => void;

  // Validate enforcement.verify block (optional). Permissive: non-object verify values are ignored.
  export const validateEnforcementVerify: (enf: Record<string, unknown>) => void;

  // Validate enforcement.escalate block (optional). Permissive: non-object escalate values are ignored.
  export const validateEnforcementEscalate: (enf: Record<string, unknown>) => void;

  // Validate enforcement.perTier block (optional). Permissive: non-object perTier values are ignored.
  export const validateEnforcementPerTier: (enf: Record<string, unknown>) => void;

  // Validate enforcement.guard block (optional). Permissive: non-object guard values are ignored.
  export const validateEnforcementGuard: (enf: Record<string, unknown>) => void;

  // Validate enforcement.escalate.costCeiling block (optional).
  // Permissive: non-object costCeiling values are ignored.
  export const validateEscalateCostCeiling: (escalate: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// REASONING section validators: validateReasoningPolicy, validateReasoningPolicyMode,
// validateAdaptivePolicy, validateKeywordRule, validateAdaptiveTierDefaults,
// validateAdaptiveSurfaceDecision. Input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// Uses Js.Nullable.t<T> at ABI boundary for explicit null handling.
// ---------------------------------------------------------------------------
declare module "*ValidateReasoning.res.mjs" {
  // Top-level reasoningPolicy dispatcher. Throws if reasoningPolicy is present but not a plain object.
  export const validateReasoningPolicy: (obj: Record<string, unknown>) => void;

  // Validate reasoningPolicy.mode in {static, manual, adaptive}. Silently skips if absent.
  export const validateReasoningPolicyMode: (policy: Record<string, unknown>) => void;

  // Validate reasoningPolicy.adaptive block (optional). Validates trivialLevel, defaultLevel,
  // keywordRules, tierDefaults, surfaceDecision.
  export const validateAdaptivePolicy: (policy: Record<string, unknown>) => void;

  // Validate adaptive.keywordRules array (optional). Called internally by validateAdaptivePolicy.
  export const validateKeywordRules: (adaptive: Record<string, unknown>) => void;

  // Validate a single keyword rule at a given array index.
  // Used internally and by TS config-validate for per-rule error messages.
  export const validateKeywordRule: (ruleJson: unknown, index: number) => void;

  // Validate adaptive.tierDefaults object (optional). Each value must be a reasoning level string.
  export const validateAdaptiveTierDefaults: (adaptive: Record<string, unknown>) => void;

  // Validate adaptive.surfaceDecision (optional). Must be a boolean if present.
  export const validateAdaptiveSurfaceDecision: (adaptive: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Validate (src/validate/Validate.res)
// Public facade re-exporting all validators from the six sub-modules.
// Uses Js.Nullable.t<T> at ABI boundary for explicit null handling.
// ---------------------------------------------------------------------------
declare module "*Validate.res.mjs" {
  import type { RouterConfig } from "../router/config.types";

  // Note: validateConfig returns Record<string, unknown> at the .res.mjs boundary.
  // The TS consumer (config-loader.ts) casts it to RouterConfig via
  // `as unknown as RouterConfig`, preserving the old TS API contract.
  // The return type below reflects the TS consumer's view, not the raw ReScript output.
  export function validateConfig(obj: Record<string, unknown>): RouterConfig;
  // Validate the root-level scalar fields: activePreset must be a non-empty string.
  export const validateRootFields: (obj: Record<string, unknown>) => void;

  // Validate rules (array of strings) and defaultTier (string).
  export const validateRulesAndDefaultTier: (obj: Record<string, unknown>) => void;

  // Validate the top-level presets block.
  export const validatePresets: (obj: Record<string, unknown>) => void;

  // Validate a single preset (named by presetName for error messages).
  export const validatePreset: (presetName: string, preset: Record<string, unknown>) => void;

  // Validate a single tier within a preset.
  export const validateTier: (presetName: string, tierName: string, tier: Record<string, unknown>) => void;

  // Validate the top-level modes block.
  export const validateModes: (obj: Record<string, unknown>) => void;

  // Validate a single mode (named by modeName for error messages).
  export const validateMode: (modeName: string, mode: Record<string, unknown>) => void;

  // Validate the tierCaps block: each cap must be a finite positive integer.
  // tierCaps is optional — no-op if absent.
  export const validateTierCaps: (obj: Record<string, unknown>) => void;

  // Validate the tierPrompts block: each prompt must be a string.
  // tierPrompts is optional — no-op if absent.
  export const validateTierPrompts: (obj: Record<string, unknown>) => void;

  // Validate the taskPatterns block: each patterns value must be an array of strings.
  // taskPatterns is optional — no-op if absent.
  export const validateTaskPatterns: (obj: Record<string, unknown>) => void;

  // Top-level enforcement dispatcher. Throws if enforcement is present but not a plain object.
  export const validateEnforcement: (obj: Record<string, unknown>) => void;

  // Validate enforcement.mode in {off, advisory, enforced}. Silently skips if absent.
  export const validateEnforcementMode: (enf: Record<string, unknown>) => void;

  // Validate enforcement.verify block (optional). Permissive: non-object verify values are ignored.
  export const validateEnforcementVerify: (enf: Record<string, unknown>) => void;

  // Validate enforcement.escalate block (optional). Permissive: non-object escalate values are ignored.
  export const validateEnforcementEscalate: (enf: Record<string, unknown>) => void;

  // Validate enforcement.perTier block (optional). Permissive: non-object perTier values are ignored.
  export const validateEnforcementPerTier: (enf: Record<string, unknown>) => void;

  // Validate enforcement.guard block (optional). Permissive: non-object guard values are ignored.
  export const validateEnforcementGuard: (enf: Record<string, unknown>) => void;

  // Validate enforcement.escalate.costCeiling block (optional).
  // Permissive: non-object costCeiling values are ignored.
  export const validateEscalateCostCeiling: (escalate: Record<string, unknown>) => void;

  // Top-level reasoningPolicy dispatcher. Throws if reasoningPolicy is present but not a plain object.
  export const validateReasoningPolicy: (obj: Record<string, unknown>) => void;

  // Validate reasoningPolicy.mode in {static, manual, adaptive}. Silently skips if absent.
  export const validateReasoningPolicyMode: (policy: Record<string, unknown>) => void;

  // Validate reasoningPolicy.adaptive block (optional). Validates trivialLevel, defaultLevel,
  // keywordRules, tierDefaults, surfaceDecision.
  export const validateAdaptivePolicy: (policy: Record<string, unknown>) => void;

  // Validate adaptive.keywordRules array (optional). Called internally by validateAdaptivePolicy.
  export const validateKeywordRules: (adaptive: Record<string, unknown>) => void;

  // Validate a single keyword rule at a given array index.
  // Used internally and by TS config-validate for per-rule error messages.
  export const validateKeywordRule: (ruleJson: unknown, index: number) => void;

  // Validate adaptive.tierDefaults object (optional). Each value must be a reasoning level string.
  export const validateAdaptiveTierDefaults: (adaptive: Record<string, unknown>) => void;

  // Validate adaptive.surfaceDecision (optional). Must be a boolean if present.
  export const validateAdaptiveSurfaceDecision: (adaptive: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Guard (src/guard/Guard.res)
// Guard engine: threat matrix, state tracking, before/after hooks.
// Uses Js.Nullable.t<T> at ABI boundary for explicit null handling.
// ---------------------------------------------------------------------------
declare module "*Guard.res.mjs" {
  // Guard kind: classifies a tool call into one of 5 buckets
  export type guardKind = "finish" | "read" | "mutation" | "self_script" | "other";

  // Guard policy: configuration for the guard engine
  export type guardPolicy = {
    budget: number;
    readDraftCap: number;
    sameOpRetryCap: number;
    blockSelfScript: boolean;
    deliverableFirst: boolean;
    deliverableSignal: string | null;
    deliverablePath: string | null;
    deliverableIsScript: boolean | null;
    blockScriptWrites: boolean | null;
  };

  // Guard call: a tool call to be evaluated
  export type guardCall = {
    tool: string;
    args?: Record<string, unknown>;
  };

  // Guard decision: result of evaluateGuards
  export type guardDecision = {
    allow: boolean;
    guard: string | null;
    observation: string | null;
  };

  // Guard state: mutable state tracked across a delegation session
  export type guardState = {
    budget: number;
    toolCallCount: number;
    readCount: number;
    execCount: number;
    selfScriptCount: number;
    redundantCount: number;
    blockedCount: number;
    consecutiveNonProducing: number;
    deliverableExecuted: boolean;
    ttfa: number | null;
    seen: Record<string, number>;
    lastBlock: string | null;
  };

  // Before result: result of guardBeforeCall
  export type beforeResult = {
    block: boolean;
    message: string | null;
    mode: string;
    guard: string | null;
  };

  // Guard store-like interface
  export type guardStoreLike = {
    ensure: (sessionID: string, policy: guardPolicy) => guardState;
    get: (sessionID: string) => guardState | undefined;
    setPendingNote: (sessionID: string, note: string) => void;
    takePendingNote: (sessionID: string) => string | undefined;
  };

  // Router config minimal shape
  export type routerConfigMinimal = {
    enforcement?: {
      guard?: {
        budget?: number;
        readDraftCap?: number;
        sameOpRetryCap?: number;
        blockSelfScript?: boolean;
        deliverableFirst?: boolean;
        blockScriptWrites?: boolean;
      };
      proportional?: {
        trivialBypass?: boolean;
      };
    };
  };

  // PascalCase type aliases for backward compat with TS consumers
  export type GuardKind = guardKind;
  export type GuardPolicy = guardPolicy;
  export type GuardCall = guardCall;
  export type GuardDecision = guardDecision;
  export type GuardState = guardState;
  export type BeforeResult = beforeResult;

  // Functions
  export const defaultGuardBudget: number;
  export const newGuardState: (policy: guardPolicy) => guardState;
  export const updateState: (state: guardState, call: guardCall, opts: { ok: boolean }, policy: guardPolicy) => guardState;
  export const recordBlock: (state: guardState, decision: guardDecision) => guardState;
  export const isSelfScript: (call: guardCall, policy: guardPolicy) => boolean;
  export const classify: (call: guardCall, policy: guardPolicy) => guardKind;
  export const evaluateGuards: (state: guardState, call: guardCall, policy: guardPolicy) => guardDecision;
  export const forcingMessage: (state: guardState, policy: guardPolicy) => string;
  export const trajectoryMetrics: (state: guardState) => Record<string, unknown>;
  export const observationOk: (output: unknown) => boolean;
  export const buildGuardPolicy: (cfg: routerConfigMinimal, tier: string | null) => guardPolicy;
  export const formatScorecard: (state: guardState, tier: string | null) => string;
  export const guardBeforeCall: (params: {
    cfg: routerConfigMinimal;
    tier: string | null;
    sessionID: string;
    tool: string;
    toolArgs: Record<string, unknown> | null;
    store: guardStoreLike;
    env: Record<string, string | null>;
    trivial: boolean | null;
  }) => beforeResult;
  export const guardAfterCall: (params: {
    cfg: routerConfigMinimal;
    tier: string | null;
    sessionID: string;
    tool: string;
    toolArgs: Record<string, unknown> | null;
    output: { output: unknown | null };
    store: guardStoreLike;
  }) => void;
}

declare module "*Protocol.res.mjs" {
  // Tier definition
  export type tierDef = {
    model: string;
    variant: string | null;
    costRatio: number | null;
    description: string;
    whenToUse: string[];
  };

  // Mode configuration
  export type modeConfig = {
    defaultTier: string;
    description: string;
    overrideRules: string[] | null;
  };

  // Verify configuration
  export type verifyConfig = {
    requireExplicitDoD: boolean | null;
  };

  // Enforcement configuration
  export type enforcementConfig = {
    verify: verifyConfig | null;
  };

  // Fallback configuration
  export type fallbackConfig = {
    global: Record<string, string[]> | null;
    presets: Record<string, Record<string, string[]>> | null;
  };

  // Tier configuration (root config shape for Protocol)
  export type tierConfig = {
    activePreset: string;
    activeMode: string | null;
    presets: Record<string, Record<string, tierDef>>;
    rules: string[];
    defaultTier: string;
    fallback: fallbackConfig | null;
    taskPatterns: Record<string, string[]> | null;
    modes: Record<string, modeConfig> | null;
    enforcement: enforcementConfig | null;
  };

  // Tier / mode helpers
  export const tierConfigFromDict: (raw: Record<string, any>) => tierConfig;
  export const modeDefaultTier: (mode: modeConfig) => string;
  export const getActiveTiers: (tierConfig: tierConfig) => Record<string, tierDef>;
  export const getActiveMode: (tierConfig: tierConfig) => modeConfig | null;

  // Fallback instructions builder
  export const buildFallbackInstructions: (tierConfig: tierConfig) => string;

  // Cost & taxonomy builders
  export const buildTaskTaxonomy: (tierConfig: tierConfig) => string;
  export const buildDecomposeHint: (tierConfig: tierConfig) => string;

  // System prompt builder
  export const buildDelegationProtocol: (tierConfig: tierConfig) => string;

  // Claude-model helpers
  export const isClaudeModel: (model: string | null) => boolean;
  export const claudeTierPrefix: Record<string, string>;
  export const claudeOrchestratorPrefix: string;
  export const claudeAntiNarration: string;

  // DoD protocol section
  export const buildDoDProtocolSection: (tierConfig: tierConfig) => string;

  // Assembled system prompt
  export const assembleSystemPrompt: (
    tierConfig: tierConfig,
    claudeVersion: string | null,
    hasFallback: boolean,
  ) => string;
}
