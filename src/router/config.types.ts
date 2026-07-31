// ---------------------------------------------------------------------------
// src/router/config.types.ts — Type definitions and type guards.
//
// PR3 of the rescript-migration moves runtime functions to their own files:
//   - isPlainObject  → config-loader.ts (shared by loader + validate)
//
// All type definitions remain here for backward compatibility with existing TS
// consumers. Type imports from this file are NOT sourced from Config.res.mjs
// because the ReScript ABI types don't fully match the original TS interfaces
// (field names, nullability, and extra fields like prompt/steps/color differ).
// The ReScript Config module provides only the `parse` runtime function.
// ---------------------------------------------------------------------------

// Re-export the canonical reasoning types from `src/reasoning/capability.js`.
export type {
  ReasoningCapability,
  ReasoningField,
  ReasoningLevel,
} from "../reasoning/capability.js";

export interface ThinkingConfig {
  budgetTokens?: number;
}

export interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}

export interface TierConfig {
  model: string;
  variant?: string;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
  capability?: import("../reasoning/capability.js").ReasoningCapability;
}

export type Preset = Record<string, TierConfig>;

export interface FallbackConfig {
  global?: Record<string, string[]>;
  presets?: Record<string, Record<string, string[]>>;
}

export interface ModeConfig {
  defaultTier: string;
  description: string;
  overrideRules?: string[];
}

export interface EnforcementConfig {
  mode?: "off" | "advisory" | "enforced";
  envGate?: string;
  perTier?: Record<string, "off" | "advisory" | "enforced">;
  guard?: {
    readDraftCap?: number;
    sameOpRetryCap?: number;
    blockSelfScript?: boolean;
    deliverableFirst?: boolean;
    budget?: number;
    blockScriptWrites?: boolean;
  };
  verify?: {
    require?: "never" | "whenDoDPresent" | "always";
    requireExplicitDoD?: boolean;
    preferDeterministic?: boolean;
    graderPolicy?: "atLeastProducerTier";
    graderTemperature?: number;
    minGraderTier?: string;
    skipFastTier?: boolean;
    skipTiers?: string[];
    hookTimeoutMs?: number;
  };
  escalate?: {
    floorTier?: string | null;
    ladder?: string[];
    maxAttemptsPerTier?: number;
    maxTotalAttempts?: number;
    costCeiling?: { base?: string; multiple?: number };
  };
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

export interface AdaptiveKeywordRule {
  keywords: string[];
  level: import("../reasoning/capability.js").ReasoningLevel;
  match?: import("../reasoning/match.js").MatchMode;
  excludeKeywords?: string[];
}

export interface AdaptivePolicyConfig {
  trivialLevel?: import("../reasoning/capability.js").ReasoningLevel | null;
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel | null;
  keywordRules?: AdaptiveKeywordRule[];
  tierDefaults?: Record<string, import("../reasoning/capability.js").ReasoningLevel>;
  surfaceDecision?: boolean;
}

export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel;
  surfaceLimits?: boolean;
  adaptive?: AdaptivePolicyConfig;
}

export interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
  tierPrompts?: Record<string, string>;
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  experimental?: { verifiedDelegateTool?: boolean };
  reasoningPolicy?: ReasoningPolicyConfig;
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
  reasoningMode?: "static" | "manual" | "adaptive";
}

export type ConfigLayer = {
  kind: "bundled" | "global" | "local";
  path: string;
  required: boolean;
};
