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
