// ---------------------------------------------------------------------------
// src/router/config.types.ts — Type definitions and type guards.
//
// Pure types and small predicates. No file IO, no module-level state.
// ---------------------------------------------------------------------------

// Re-export the canonical reasoning types from `src/reasoning/capability.ts`.
// `capability.ts` is the canonical home (single source of truth for the
// capability model + inference); `config.types.ts` re-exports so existing
// `import { ReasoningCapability } from "./config"` style keeps working
// without forcing every consumer to learn the new module path.
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
  /**
   * Optional explicit capability declaration for this tier. When present,
   * `resolveReasoningOverride` (PR 2 of adaptive-reasoning) consults this
   * before falling back to `inferCapability(tier)`. Leaving it absent keeps
   * pre-Plan-010 configs working unchanged.
   */
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

/**
 * Single keyword rule inside `AdaptivePolicyConfig.keywordRules`.
 *
 * `keywords` are matched against either the task prompt or the task
 * description under the rule's `match` mode (default `"stem"`: word-boundary
 * start with suffix inflections allowed on the LAST token only — so
 * `debug` still matches `debugging` but `latest` no longer matches `test`).
 * Order in the parent array is the priority order — first match wins, so
 * high-precision rules MUST come before catch-alls.
 *
 * See `src/reasoning/match.ts` for the full mode semantics and the
 * memoized compiler used at runtime.
 */
export interface AdaptiveKeywordRule {
  /** Case-insensitive terms; a match in prompt OR description wins. */
  keywords: string[];
  /** Level applied when any keyword matches. */
  level: import("../reasoning/capability.js").ReasoningLevel;
  /**
   * Match strategy for this rule's `keywords` AND `excludeKeywords`. Defaults
   * to `"stem"` (word-boundary start; suffix inflections allowed on the LAST
   * token only). Other options: `"word"` (strict), `"substring"` (legacy
   * cross-word `includes` behavior — opt-in escape hatch), `"regex"` (user
   * pattern; compile-checked at config load).
   */
  match?: import("../reasoning/match.js").MatchMode;
  /**
   * Optional disqualifiers: if any entry matches (under the rule's `match`
   * mode), the whole rule is skipped — even if a `keywords` entry would
   * otherwise hit. Useful for carving out exceptions to a catch-all.
   */
  excludeKeywords?: string[];
}

/**
 * Adaptive-mode policy knobs (Plan 015). All fields are optional — the
 * selector (`selectAdaptiveLevel`) treats every missing/null field as a
 * fall-through to the next decision branch.
 *
 * - `trivialLevel` is the level applied when the dispatch-time trivial
 *   classifier marks the session trivial. `null` (or absent) means "skip
 *   trivial tasks entirely" — no patch is emitted.
 * - `defaultLevel` is the catch-all for non-trivial tasks that match no
 *   keyword rule. Same null/undefined semantics as `trivialLevel`.
 * - `keywordRules` are evaluated in array order; first match wins.
 * - `tierDefaults` lets operators pin a level per tier name. A tier default
 *   wins over `keywordRules` and `defaultLevel`, losing only to
 *   `trivialLevel` (decision order: trivial → tierDefault → keywordRules
 *   → defaultLevel).
 * - `surfaceDecision` opts into debug logs describing every adaptive
 *   decision (selected level + reason). Off by default — production should
 *   leave it `false` to avoid log noise.
 *
 * `trivialLevel` and `defaultLevel` deliberately accept `null` so configs
 * can explicitly opt out (e.g. `base.json` ships `"trivialLevel": null`
 * meaning "do not patch trivial sessions").
 */
export interface AdaptivePolicyConfig {
  /** Level for tasks the classifier marks trivial. `null`/absent → no patch. */
  trivialLevel?: import("../reasoning/capability.js").ReasoningLevel | null;
  /** Level for non-trivial tasks that match no keyword rule. `null`/absent → no patch. */
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel | null;
  /**
   * Keyword rules: each rule's `keywords` are matched in prompt OR
   * description under the rule's `match` mode (default `"stem"` —
   * word-boundary start with suffix inflections on the LAST token).
   * `excludeKeywords` (optional) are checked first under the same mode and
   * skip the rule on hit. First match wins (array order = priority).
   */
  keywordRules?: AdaptiveKeywordRule[];
  /** Per-tier default override. Keyed by tier name. Wins over `keywordRules`
   *  and `defaultLevel`, loses only to `trivialLevel`. */
  tierDefaults?: Record<string, import("../reasoning/capability.js").ReasoningLevel>;
  /** When true, emit a debug log for every adaptive decision (level + reason). */
  surfaceDecision?: boolean;
}

/**
 * Reasoning policy mode and per-session override knobs.
 *
 * - `mode` defaults to `"static"` (today's behaviour preserved). With mode
 *   `"adaptive"`, the resolver delegates to `selectAdaptiveLevel()` over the
 *   `adaptive` config block.
 * - `defaultLevel` is the level applied under `manual` mode when the session
 *   has no per-session override, AND under `adaptive` mode when the selector
 *   falls through to the policy default. Defaults to undefined (no implicit
 *   level).
 * - `surfaceLimits` defaults to `false` — unsupported-level requests stay
 *   silent. Set to `true` to emit a debug log + `/reasoning` advisory note
 *   when a tier's capability cannot satisfy the requested level.
 * - `adaptive` is the optional adaptive-mode config block. Absent under
 *   `static`/`manual` modes; consulted only when `mode === "adaptive"`.
 */
export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel;
  surfaceLimits?: boolean;
  /** Adaptive-mode knobs. Only consulted when `mode === "adaptive"`. */
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
  /** Global default prompts per tier name. A preset-level tier.prompt overrides this. */
  tierPrompts?: Record<string, string>;
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  /** Experimental, opt-in features. Off by default. */
  experimental?: { verifiedDelegateTool?: boolean };
  /** PR 2 of adaptive-reasoning: per-tier override + runtime patch wiring.
   *  All fields optional → pre-change configs work unedited. */
  reasoningPolicy?: ReasoningPolicyConfig;
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
  /**
   * Persisted reasoning policy mode overlay. Set via
   * `saveReasoningMode()` and applied by `applyStateOverlay()` over
   * `cfg.reasoningPolicy.mode`. All three modes (`static`, `manual`,
   * `adaptive`) round-trip through the persisted overlay as of Plan 015.
   */
  reasoningMode?: "static" | "manual" | "adaptive";
}

export type ConfigLayer = {
  kind: "bundled" | "global" | "local";
  path: string;
  required: boolean;
};

export const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  return typeof v === "object" && v !== null && !Array.isArray(v);
};
