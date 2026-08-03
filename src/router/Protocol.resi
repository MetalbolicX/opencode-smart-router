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
  variant: Js.Nullable.t<string>,
  costRatio: Js.Nullable.t<float>,
  description: string,
  whenToUse: array<string>,
}

type modeConfig = {
  defaultTier: string,
  description: string,
  overrideRules: Js.Nullable.t<array<string>>,
}

type verifyConfig = {
  requireExplicitDoD: Js.Nullable.t<bool>,
}

type enforcementConfig = {
  verify: Js.Nullable.t<verifyConfig>,
}

type fallbackConfig = {
  global: Js.Nullable.t<Js.Dict.t<array<string>>>,
  presets: Js.Nullable.t<Js.Dict.t<Js.Dict.t<array<string>>>>,
}

type tierConfig = {
  activePreset: string,
  activeMode: Js.Nullable.t<string>,
  presets: Js.Dict.t<Js.Dict.t<tierDef>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Js.Nullable.t<fallbackConfig>,
  taskPatterns: Js.Nullable.t<Js.Dict.t<array<string>>>,
  modes: Js.Nullable.t<Js.Dict.t<modeConfig>>,
  enforcement: Js.Nullable.t<enforcementConfig>,
}

// ---------------------------------------------------------------------------
// Tier / mode helpers
// ---------------------------------------------------------------------------

let tierConfigFromDict: (Js.Dict.t<Js.Json.t>) => tierConfig

let modeDefaultTier: (modeConfig) => string

let getActiveTiers: (tierConfig) => Js.Dict.t<tierDef>

let getActiveMode: (tierConfig) => option<modeConfig>

// ---------------------------------------------------------------------------
// Fallback instructions builder
// ---------------------------------------------------------------------------

let buildFallbackInstructions: (tierConfig) => string

// ---------------------------------------------------------------------------
// Cost & taxonomy builders
// ---------------------------------------------------------------------------

let buildTaskTaxonomy: (tierConfig) => string

let buildDecomposeHint: (tierConfig) => string

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

let buildDelegationProtocol: (tierConfig) => string

// ---------------------------------------------------------------------------
// Claude-model helpers
// ---------------------------------------------------------------------------

let isClaudeModel: (Js.Nullable.t<string>) => bool

let claudeTierPrefix: Js.Dict.t<string>

let claudeOrchestratorPrefix: string

let claudeAntiNarration: string

// ---------------------------------------------------------------------------
// DoD protocol section
// ---------------------------------------------------------------------------

let buildDoDProtocolSection: (tierConfig) => string

// ---------------------------------------------------------------------------
// Assembled system prompt
// ---------------------------------------------------------------------------

let assembleSystemPrompt: (tierConfig, Js.Nullable.t<string>, bool) => string
