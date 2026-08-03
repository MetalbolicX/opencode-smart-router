// ---------------------------------------------------------------------------
// Protocol.resi — Public interface for the Protocol module.
//
// ABI boundary: all functions accept Js.Dict.t<Js.Json.t> (raw JSON dict).
// Exports the same signatures as the TS protocol.ts for direct substitution.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types (matching Ladder.resi pattern — separate declarations, no `and` chain)
// ---------------------------------------------------------------------------

type tierDef = {
  model: string,
  variant: Nullable.t<string>,
  costRatio: Nullable.t<float>,
  description: string,
  whenToUse: array<string>,
}

type modeConfig = {
  defaultTier: string,
  description: string,
  overrideRules: Nullable.t<array<string>>,
}

type verifyConfig = {
  requireExplicitDoD: Nullable.t<bool>,
}

type enforcementConfig = {
  verify: Nullable.t<verifyConfig>,
}

type fallbackConfig = {
  global: Nullable.t<dict<array<string>>>,
  presets: Nullable.t<dict<dict<array<string>>>>,
}

type tierConfig = {
  activePreset: string,
  activeMode: Nullable.t<string>,
  presets: dict<dict<tierDef>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Nullable.t<fallbackConfig>,
  taskPatterns: Nullable.t<dict<array<string>>>,
  modes: Nullable.t<dict<modeConfig>>,
  enforcement: Nullable.t<enforcementConfig>,
}

// ---------------------------------------------------------------------------
// Tier / mode helpers
// ---------------------------------------------------------------------------

let tierConfigFromDict: dict<JSON.t> => tierConfig

let modeDefaultTier: modeConfig => string

let getActiveTiers: tierConfig => dict<tierDef>

let getActiveMode: tierConfig => option<modeConfig>

// ---------------------------------------------------------------------------
// Fallback instructions builder
// ---------------------------------------------------------------------------

let buildFallbackInstructions: tierConfig => string

// ---------------------------------------------------------------------------
// Cost & taxonomy builders
// ---------------------------------------------------------------------------

let buildTaskTaxonomy: tierConfig => string

let buildDecomposeHint: tierConfig => string

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

let buildDelegationProtocol: tierConfig => string

// ---------------------------------------------------------------------------
// Claude-model helpers
// ---------------------------------------------------------------------------

let isClaudeModel: Nullable.t<string> => bool

let claudeTierPrefix: dict<string>

let claudeOrchestratorPrefix: string

let claudeAntiNarration: string

// ---------------------------------------------------------------------------
// DoD protocol section
// ---------------------------------------------------------------------------

let buildDoDProtocolSection: tierConfig => string

// ---------------------------------------------------------------------------
// Assembled system prompt
// ---------------------------------------------------------------------------

let assembleSystemPrompt: (tierConfig, Nullable.t<string>, bool) => string
