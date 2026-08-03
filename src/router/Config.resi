type modeEnum = [#off | #advisory | #enforced]

type tierCapability =
  | TC_None
  | Binary({field: string, baseline: option<string>, elevated: string})
  | Discrete({field: string, levels: array<string>})
  | Budgeted({field: string, recommended: dict<float>})

type thinkingBlock = {budgetTokens: option<int>}
and reasoningBlock = {effort: option<string>, summary: option<string>}

type tierConfig = {
  model: string,
  variant: option<string>,
  costRatio: option<float>,
  description: string,
  whenToUse: array<string>,
  thinking: option<thinkingBlock>,
  reasoning: option<reasoningBlock>,
  capability: option<tierCapability>,
}

type preset = dict<tierConfig>

type enforcementVerify = {
  require: option<string>,
  requireExplicitDoD: option<bool>,
  preferDeterministic: option<bool>,
  graderPolicy: option<string>,
  graderTemperature: option<float>,
  minGraderTier: option<string>,
  skipFastTier: option<bool>,
  skipTiers: option<array<string>>,
  hookTimeoutMs: option<int>,
}

type rec enforcementEscalate = {
  floorTier: option<option<string>>,
  ladder: option<array<string>>,
  maxAttemptsPerTier: option<int>,
  maxTotalAttempts: option<int>,
  costCeiling: option<costCeilingBlock>,
}

and costCeilingBlock = {base: option<string>, multiple: option<float>}

type enforcementGuard = {
  readDraftCap: option<int>,
  sameOpRetryCap: option<int>,
  blockSelfScript: option<bool>,
  deliverableFirst: option<bool>,
  budget: option<int>,
  blockScriptWrites: option<bool>,
}

type enforcementConfig = {
  mode: option<[modeEnum]>,
  envGate: option<string>,
  perTier: option<dict<string>>,
  guard: option<enforcementGuard>,
  verify: option<enforcementVerify>,
  escalate: option<enforcementEscalate>,
  proportional: option<{trivialBypass: option<bool>, trivialClassifier: option<string>}>,
}

type keywordRule = {
  keywords: array<string>,
  level: string,
  match: option<string>,
  excludeKeywords: option<array<string>>,
}

type adaptivePolicy = {
  trivialLevel: option<string>,
  defaultLevel: option<string>,
  keywordRules: option<array<keywordRule>>,
  tierDefaults: option<dict<string>>,
  surfaceDecision: option<bool>,
}

type reasoningPolicyConfig = {
  mode: option<string>,
  defaultLevel: option<string>,
  surfaceLimits: option<bool>,
  adaptive: option<adaptivePolicy>,
}

type modeEntry = {
  defaultTier: string,
  description: string,
  overrideRules: option<array<string>>,
}

type t = {
  activePreset: string,
  activeMode: option<string>,
  tierCaps: option<dict<int>>,
  tierPrompts: option<dict<string>>,
  presets: dict<preset>,
  rules: array<string>,
  defaultTier: string,
  fallback: option<{global: option<dict<array<string>>>}>,
  taskPatterns: option<dict<array<string>>>,
  modes: option<dict<modeEntry>>,
  enforcement: option<enforcementConfig>,
  reasoningPolicy: option<reasoningPolicyConfig>,
}

let reasoningLevels: array<string>
let parse: Js.Json.t => option<t>
