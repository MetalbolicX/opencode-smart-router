// ---------------------------------------------------------------------------
// ValidateReasoning.resi - Public interface for REASONING validators.
//
// Ports the REASONING section from src/router/config-validate.ts:
//   - validateReasoningPolicy: top-level dispatcher
//   - validateReasoningPolicyMode: reasoningPolicy.mode in {static,manual,adaptive}
//   - validateAdaptivePolicy: reasoningPolicy.adaptive block validation
//   - validateKeywordRules: adaptive.keywordRules array validation
//   - validateKeywordRule: individual keyword rule validation
//   - validateAdaptiveTierDefaults: adaptive.tierDefaults object validation
//   - validateAdaptiveSurfaceDecision: adaptive.surfaceDecision boolean validation
//
// ABI boundary: input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// All validators return unit and throw with a "tiers.json:" prefix on error.
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

// Validate adaptive.keywordRules array (optional). Called internally by validateAdaptivePolicy.
let validateKeywordRules: dict<JSON.t> => unit

// Validate a single keyword rule at a given array index.
// Called internally by validateKeywordRules.
// extern'd so TS config-validate.ts can call it directly for per-rule errors.
let validateKeywordRule: (JSON.t, int) => unit

// Validate adaptive.tierDefaults object (optional).
// Each value must be a reasoning level string.
let validateAdaptiveTierDefaults: dict<JSON.t> => unit

// Validate adaptive.surfaceDecision (optional).
// Must be a boolean if present.
let validateAdaptiveSurfaceDecision: dict<JSON.t> => unit
