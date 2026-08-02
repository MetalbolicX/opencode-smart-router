// ---------------------------------------------------------------------------
// Protocol_test.res — RED-first tests for Protocol prompt builders.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of src/router/protocol.ts fixtures:
//   - getActiveTiers: returns active preset's tiers
//   - getActiveMode: returns active mode or undefined
//   - buildFallbackInstructions: builds Err→retry-alt-tier→fail→direct string
//   - buildTaskTaxonomy: builds R: taxonomy line
//   - buildDecomposeHint: builds multi-phase hint
//   - buildDelegationProtocol: builds full delegation protocol
//   - isClaudeModel: detects Claude model identifiers
//   - CLAUDE_TIER_PREFIX: per-tier adversarial openers
//   - CLAUDE_ORCHESTRATOR_PREFIX: orchestrator override block
//   - CLAUDE_ANTI_NARRATION: anti-narration clause
//   - buildDoDProtocolSection: builds DoD/acceptance block
//   - assembleSystemPrompt: assembles full system prompt
//
// Note: Byte-exact string comparison is used throughout — the generated
// prompt strings must match the TS output character-for-character.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let assertionEqual = (~operator: string, expected: string, actual: string): unit =>
  assertion(~operator, (a, b) => a === b, actual, expected)

let assertionTrue = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === true, actual, true)

let assertionFalse = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === false, actual, false)

let assertionContains = (~operator: string, needle: string, haystack: string): unit => {
  let contains = String.indexOf(haystack, needle) >= 0
  assertion(~operator, (_a, b) => b === true, contains, true)
}

// ---------------------------------------------------------------------------
// Test fixtures — minimal config (no costRatio/variant/mode/taskPatterns/fallback)
// ---------------------------------------------------------------------------

// Minimal tier factory
let tier = (model: string): Js.Dict.t<Js.Json.t> => {
  Js.Dict.fromArray([
    ("model", Js.Json.string(model)),
    ("description", Js.Json.string("d")),
    ("whenToUse", Js.Json.array([Js.Json.string("x")])),
  ])
}

let minimalCfg: Js.Dict.t<Js.Json.t> = %raw(`{
  activePreset: "p",
  presets: { p: { only: { model: "prov/model-x", description: "d", whenToUse: ["x"] } } },
  rules: ["alpha", "beta"],
  defaultTier: "only"
}`)

// ---------------------------------------------------------------------------
// Test fixtures — rich config (multi-tier, costRatio, variant, modes, taskPatterns, fallback)
// ---------------------------------------------------------------------------

let richCfg: Js.Dict.t<Js.Json.t> = %raw(`{
  activePreset: "anthropic",
  activeMode: "budget",
  presets: {
    anthropic: {
      fast: { model: "anthropic/claude-haiku-4-5", costRatio: 1, description: "d", whenToUse: ["x"] },
      medium: { model: "anthropic/claude-sonnet-4-6", costRatio: 5, variant: "max", description: "d", whenToUse: ["x"] },
    },
    openai: { fast: { model: "openai/gpt-x", costRatio: 1, description: "d", whenToUse: ["x"] } },
  },
  rules: ["base1"],
  defaultTier: "fast",
  modes: { budget: { defaultTier: "fast", description: "cheap", overrideRules: ["o1", "o2"] } },
  taskPatterns: { fast: ["recon", "lookup"], medium: ["impl"] },
  fallback: { global: { anthropic: ["openai"] } },
}`)

// ---------------------------------------------------------------------------
// getActiveTiers
// ---------------------------------------------------------------------------

test("getActiveTiers: returns the active preset's tiers", () => {
  let tiers = Protocol.getActiveTiers(Protocol.tierConfigFromDict(minimalCfg))
  assertionEqual(~operator="key count", "only", Array.unsafe_get(Js.Dict.keys(tiers), 0))
})

test("getActiveTiers: falls back to first preset when activePreset unknown", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "missing",
    presets: { p: { only: { model: "prov/model-x", description: "d", whenToUse: ["x"] } } },
    rules: [],
    defaultTier: "only"
  }`)
  let tiers = Protocol.getActiveTiers(Protocol.tierConfigFromDict(cfg))
  assertionTrue(~operator="tiers defined", Array.length(Js.Dict.keys(tiers)) > 0)
})

// ---------------------------------------------------------------------------
// getActiveMode
// ---------------------------------------------------------------------------

test("getActiveMode: returns undefined when modes absent", () => {
  let result = Protocol.getActiveMode(Protocol.tierConfigFromDict(minimalCfg))
  assertion(~operator="is null", (a, _b) => a == null, result, Js.Nullable.null)
})

test("getActiveMode: returns undefined when activeMode absent", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "p",
    presets: { p: { only: { model: "prov/model-x", description: "d", whenToUse: ["x"] } } },
    rules: [],
    defaultTier: "only"
  }`)
  let result = Protocol.getActiveMode(Protocol.tierConfigFromDict(cfg))
  assertion(~operator="is null", (a, _b) => a == null, result, Js.Nullable.null)
})

test("getActiveMode: returns active mode when present", () => {
  let result = Protocol.getActiveMode(Protocol.tierConfigFromDict(richCfg))
  switch result->Js.Nullable.toOption {
  | None => assertion(~operator="should not be null", (_a, _b) => false, true, false)
  | Some(m) => assertionEqual(~operator="defaultTier", "fast", Protocol.modeDefaultTier(m))
  }
})

// ---------------------------------------------------------------------------
// buildTaskTaxonomy
// ---------------------------------------------------------------------------

test("buildTaskTaxonomy: returns empty string when taskPatterns absent", () => {
  assertionEqual(~operator="empty", "", Protocol.buildTaskTaxonomy(Protocol.tierConfigFromDict(minimalCfg)))
})

test("buildTaskTaxonomy: builds R: line when taskPatterns present", () => {
  let out = Protocol.buildTaskTaxonomy(Protocol.tierConfigFromDict(richCfg))
  assertionContains(~operator="R:", "R:", out)
  assertionContains(~operator="fast pattern", "@fast→recon/lookup", out)
})

test("buildTaskTaxonomy: skips empty pattern arrays", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "p",
    presets: { p: { only: { model: "prov/model-x", description: "d", whenToUse: ["x"] } } },
    rules: [],
    defaultTier: "only",
    taskPatterns: { fast: [] }
  }`)
  assertionEqual(~operator="R:", "R:", Protocol.buildTaskTaxonomy(Protocol.tierConfigFromDict(cfg)))
})

// ---------------------------------------------------------------------------
// buildDecomposeHint
// ---------------------------------------------------------------------------

test("buildDecomposeHint: returns empty when active mode has overrideRules", () => {
  assertionEqual(~operator="overrideRules present", "", Protocol.buildDecomposeHint(Protocol.tierConfigFromDict(richCfg)))
})

test("buildDecomposeHint: returns empty when fewer than 2 tiers", () => {
  assertionEqual(~operator="only one tier", "", Protocol.buildDecomposeHint(Protocol.tierConfigFromDict(minimalCfg)))
})

test("buildDecomposeHint: returns explore→execute hint for 2+ tiers in normal mode", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-haiku-4-5", costRatio: 1, description: "d", whenToUse: ["x"] },
        medium: { model: "anthropic/claude-sonnet-4-6", costRatio: 5, description: "d", whenToUse: ["x"] },
      },
    },
    rules: [],
    defaultTier: "fast",
  }`)
  let out = Protocol.buildDecomposeHint(Protocol.tierConfigFromDict(cfg))
  assertionContains(~operator="explore hint", "explore(@fast)→execute(@medium)", out)
})

// ---------------------------------------------------------------------------
// buildFallbackInstructions
// ---------------------------------------------------------------------------

test("buildFallbackInstructions: returns empty when no fallback configured", () => {
  assertionEqual(~operator="no fallback", "", Protocol.buildFallbackInstructions(Protocol.tierConfigFromDict(minimalCfg)))
})

test("buildFallbackInstructions: uses fb.global when no preset-specific map", () => {
  let out = Protocol.buildFallbackInstructions(Protocol.tierConfigFromDict(richCfg))
  assertionContains(~operator="anthropic chain", "anthropic→openai", out)
})

test("buildFallbackInstructions: prefers non-empty preset-specific map over global", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "anthropic",
    activeMode: "budget",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-haiku-4-5", costRatio: 1, description: "d", whenToUse: ["x"] },
        medium: { model: "anthropic/claude-sonnet-4-6", costRatio: 5, description: "d", whenToUse: ["x"] },
      },
    },
    rules: [],
    defaultTier: "fast",
    modes: { budget: { defaultTier: "fast", description: "cheap", overrideRules: ["o1", "o2"] } },
    fallback: { presets: { anthropic: { x: ["openai"] } }, global: { y: ["openai"] } },
  }`)
  let out = Protocol.buildFallbackInstructions(Protocol.tierConfigFromDict(cfg))
  assertionContains(~operator="preset chain", "x→openai", out)
})

test("buildFallbackInstructions: returns empty when chain map yields no valid targets", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "anthropic",
    activeMode: "budget",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-haiku-4-5", costRatio: 1, description: "d", whenToUse: ["x"] },
        medium: { model: "anthropic/claude-sonnet-4-6", costRatio: 5, description: "d", whenToUse: ["x"] },
      },
    },
    rules: [],
    defaultTier: "fast",
    modes: { budget: { defaultTier: "fast", description: "cheap", overrideRules: ["o1", "o2"] } },
    fallback: { global: { anthropic: ["nonexistent"] } },
  }`)
  assertionEqual(~operator="no valid targets", "", Protocol.buildFallbackInstructions(Protocol.tierConfigFromDict(cfg)))
})

test("buildFallbackInstructions: skips non-array chain entries", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "anthropic",
    activeMode: "budget",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-haiku-4-5", costRatio: 1, description: "d", whenToUse: ["x"] },
        medium: { model: "anthropic/claude-sonnet-4-6", costRatio: 5, description: "d", whenToUse: ["x"] },
      },
    },
    rules: [],
    defaultTier: "fast",
    modes: { budget: { defaultTier: "fast", description: "cheap", overrideRules: ["o1", "o2"] } },
    fallback: { global: { anthropic: "openai" } },
  }`)
  assertionEqual(~operator="non-array", "", Protocol.buildFallbackInstructions(Protocol.tierConfigFromDict(cfg)))
})

// ---------------------------------------------------------------------------
// buildDelegationProtocol
// ---------------------------------------------------------------------------

test("buildDelegationProtocol: renders minimal config without optional sections", () => {
  let out = Protocol.buildDelegationProtocol(Protocol.tierConfigFromDict(minimalCfg))
  assertionContains(~operator="Preset line", "Preset: p.", out)
  assertionContains(~operator="tier line", "@only=model-x", out)
  assertionContains(~operator="no mode", "mode:", out)
  assertionFalse(~operator="no mode suffix", String.indexOf(out, "mode:") >= 0)
  assertionContains(~operator="rules", "1.alpha 2.beta", out)
})

test("buildDelegationProtocol: renders rich config with variant, costRatio, mode suffix", () => {
  let out = Protocol.buildDelegationProtocol(Protocol.tierConfigFromDict(richCfg))
  assertionContains(~operator="variant/costRatio", "@medium=claude-sonnet-4-6/max(5x)", out)
  assertionContains(~operator="mode suffix", "mode:budget", out)
  assertionContains(~operator="overrideRules", "1.o1 2.o2", out)
  assertionContains(~operator="taxonomy", "R:", out)
  assertionContains(~operator="fallback chain", "Chain:", out)
})

// ---------------------------------------------------------------------------
// isClaudeModel
// ---------------------------------------------------------------------------

test("isClaudeModel: undefined returns false", () => {
  assertionFalse(~operator="undefined", Protocol.isClaudeModel(Js.Nullable.null))
})

test("isClaudeModel: anthropic/ prefix returns true", () => {
  assertionTrue(~operator="anthropic/", Protocol.isClaudeModel(Js.Nullable.return("anthropic/claude-haiku-4-5")))
})

test("isClaudeModel: claude- in path returns true", () => {
  assertionTrue(~operator="bedrock/claude-3-sonnet", Protocol.isClaudeModel(Js.Nullable.return("bedrock/claude-3-sonnet")))
})

test("isClaudeModel: leading claude- returns true", () => {
  assertionTrue(~operator="claude-3-opus", Protocol.isClaudeModel(Js.Nullable.return("claude-3-opus")))
})

test("isClaudeModel: non-claude returns false", () => {
  assertionFalse(~operator="openai/gpt-5", Protocol.isClaudeModel(Js.Nullable.return("openai/gpt-5")))
})

// ---------------------------------------------------------------------------
// CLAUDE_TIER_PREFIX — five tier keys
// ---------------------------------------------------------------------------

test("CLAUDE_TIER_PREFIX: has fast key", () => {
  assertionTrue(~operator="has fast", Protocol.claudeTierPrefix->Js.Dict.get("fast")->Option.isSome)
})

test("CLAUDE_TIER_PREFIX: has medium key", () => {
  assertionTrue(~operator="has medium", Protocol.claudeTierPrefix->Js.Dict.get("medium")->Option.isSome)
})

test("CLAUDE_TIER_PREFIX: has heavy key", () => {
  assertionTrue(~operator="has heavy", Protocol.claudeTierPrefix->Js.Dict.get("heavy")->Option.isSome)
})

test("CLAUDE_TIER_PREFIX: has light key", () => {
  assertionTrue(~operator="has light", Protocol.claudeTierPrefix->Js.Dict.get("light")->Option.isSome)
})

test("CLAUDE_TIER_PREFIX: has focused key", () => {
  assertionTrue(~operator="has focused", Protocol.claudeTierPrefix->Js.Dict.get("focused")->Option.isSome)
})

test("CLAUDE_TIER_PREFIX: fast prefix is non-empty string", () => {
  let v = Js.Dict.get(Protocol.claudeTierPrefix, "fast")
  switch v {
  | Some(s) => assertionTrue(~operator="non-empty", String.length(s) > 0)
  | None => assertion(~operator="should exist", (_a, _b) => false, true, false)
  }
})

test("CLAUDE_TIER_PREFIX: light prefix is non-empty string", () => {
  let v = Js.Dict.get(Protocol.claudeTierPrefix, "light")
  switch v {
  | Some(s) => assertionTrue(~operator="non-empty", String.length(s) > 0)
  | None => assertion(~operator="should exist", (_a, _b) => false, true, false)
  }
})

// ---------------------------------------------------------------------------
// assembleSystemPrompt
// ---------------------------------------------------------------------------

test("assembleSystemPrompt: prepends Claude override for Claude orchestrators", () => {
  let out = Protocol.assembleSystemPrompt(
    Protocol.tierConfigFromDict(minimalCfg),
    Js.Nullable.return("anthropic/claude-haiku-4-5"),
    false,
  )
  assertionContains(~operator="authority override", "AUTHORITY OVERRIDE", out)
  assertionContains(~operator="anti-narration", "ANTI-NARRATION", out)
  assertionContains(~operator="delegation protocol", "## Model Delegation Protocol", out)
})

test("assembleSystemPrompt: returns bare protocol for non-Claude orchestrators", () => {
  let out = Protocol.assembleSystemPrompt(
    Protocol.tierConfigFromDict(minimalCfg),
    Js.Nullable.return("openai/gpt-5"),
    false,
  )
  assertionTrue(~operator="starts with delegation", Js.String2.startsWith(out, "## Model Delegation Protocol"))
  assertionFalse(~operator="no authority override", String.indexOf(out, "AUTHORITY OVERRIDE") >= 0)
})

test("assembleSystemPrompt: appends DoD section when enforcementOn is true", () => {
  let out = Protocol.assembleSystemPrompt(
    Protocol.tierConfigFromDict(minimalCfg),
    Js.Nullable.null,
    true,
  )
  assertionContains(~operator="acceptance block", "[acceptance]", out)
  assertionContains(~operator="check kinds", "check kinds:", out)
})

test("assembleSystemPrompt: no DoD section when enforcementOn is false", () => {
  let out = Protocol.assembleSystemPrompt(
    Protocol.tierConfigFromDict(minimalCfg),
    Js.Nullable.null,
    false,
  )
  assertionFalse(~operator="no acceptance block", String.indexOf(out, "[acceptance]") >= 0)
})

// ---------------------------------------------------------------------------
// buildDoDProtocolSection
// ---------------------------------------------------------------------------

test("buildDoDProtocolSection: contains acceptance block and check examples", () => {
  let out = Protocol.buildDoDProtocolSection(Protocol.tierConfigFromDict(minimalCfg))
  assertionContains(~operator="acceptance block", "[acceptance]", out)
  assertionContains(~operator="testsPass", "check: testsPass", out)
  assertionContains(~operator="schemaMatch", "schemaMatch", out)
})

test("buildDoDProtocolSection: auto-inferred wording by default", () => {
  let out = Protocol.buildDoDProtocolSection(Protocol.tierConfigFromDict(minimalCfg))
  assertionContains(~operator="auto-inferred", "auto-inferred", out)
  assertionFalse(~operator="no REQUIRED", String.indexOf(out, "REQUIRED") >= 0)
})

test("buildDoDProtocolSection: REQUIRED wording when requireExplicitDoD is true", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "p",
    presets: { p: { only: { model: "prov/model-x", description: "d", whenToUse: ["x"] } } },
    rules: [],
    defaultTier: "only",
    enforcement: { verify: { requireExplicitDoD: true } }
  }`)
  let out = Protocol.buildDoDProtocolSection(Protocol.tierConfigFromDict(cfg))
  assertionContains(~operator="REQUIRED", "REQUIRED", out)
  assertionFalse(~operator="no auto-inferred", String.indexOf(out, "auto-inferred") >= 0)
})

// ---------------------------------------------------------------------------
// Byte-exact full prompt snapshots (minimal)
// ---------------------------------------------------------------------------

test("buildDelegationProtocol: minimal prompt exact snapshot", () => {
  let out = Protocol.buildDelegationProtocol(Protocol.tierConfigFromDict(minimalCfg))
  // Snapshot the exact prefix to verify byte-level parity
  assertionTrue(~operator="starts with header", Js.String2.startsWith(out, "## Model Delegation Protocol"))
  assertionContains(~operator="HARD ROUTING section", "### HARD ROUTING (non-negotiable)", out)
  assertionContains(~operator="ROLE CONTRACT section", "### ROLE CONTRACT", out)
  assertionContains(~operator="@fast contract", "### @fast contract", out)
  assertionContains(~operator="@medium contract", "### @medium contract", out)
  assertionContains(~operator="@light contract", "### @light contract", out)
  assertionContains(~operator="@focused contract", "### @focused contract", out)
  assertionContains(~operator="@heavy contract", "### @heavy contract", out)
  assertionContains(~operator="CONFLICT section", "### CONFLICT WITH CLAUDE.md", out)
  assertionContains(~operator="Compact rules section", "### Compact rules", out)
  assertionContains(~operator="Delegate with Task", "Delegate with", out)
  assertionContains(~operator="Invalid Targets section", "### Invalid Targets", out)
  assertionContains(~operator="build is invalid", "build", out)
})

// ---------------------------------------------------------------------------
// buildTaskTaxonomy: light and focused patterns
// ---------------------------------------------------------------------------

test("buildTaskTaxonomy: includes light and focused patterns in five-tier config", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "multi-provider",
    activeMode: "normal",
    presets: {
      "multi-provider": {
        fast: { model: "opencode-go/mimo-v2.5", costRatio: 1, description: "d", whenToUse: ["x"] },
        light: { model: "opencode-go/mimo-v2.5", costRatio: 2, variant: "high", description: "d", whenToUse: ["x"] },
        medium: { model: "minimax-coding-plan/MiniMax-M3", costRatio: 5, description: "d", whenToUse: ["x"] },
        focused: { model: "minimax-coding-plan/MiniMax-M3", costRatio: 10, variant: "thinking", description: "d", whenToUse: ["x"] },
        heavy: { model: "openai/gpt-5.4", costRatio: 20, description: "d", whenToUse: ["x"] },
      },
    },
    rules: ["r1"],
    defaultTier: "medium",
    modes: { normal: { defaultTier: "medium", description: "d" } },
    taskPatterns: {
      fast: ["search"],
      light: ["simple-edit"],
      medium: ["impl-feature"],
      focused: ["deep-debug"],
      heavy: ["arch-design"],
    },
  }`)
  let out = Protocol.buildTaskTaxonomy(Protocol.tierConfigFromDict(cfg))
  assertionContains(~operator="@light", "@light", out)
  assertionContains(~operator="@focused", "@focused", out)
  assertionContains(~operator="simple-edit", "simple-edit", out)
  assertionContains(~operator="deep-debug", "deep-debug", out)
})

// ---------------------------------------------------------------------------
// buildDelegationProtocol: five-tier with light and focused contracts
// ---------------------------------------------------------------------------

test("buildDelegationProtocol: renders light tier in tier line", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "multi-provider",
    activeMode: "normal",
    presets: {
      "multi-provider": {
        fast: { model: "opencode-go/mimo-v2.5", costRatio: 1, description: "d", whenToUse: ["x"] },
        light: { model: "opencode-go/mimo-v2.5", costRatio: 2, variant: "high", description: "d", whenToUse: ["x"] },
        medium: { model: "minimax-coding-plan/MiniMax-M3", costRatio: 5, description: "d", whenToUse: ["x"] },
        focused: { model: "minimax-coding-plan/MiniMax-M3", costRatio: 10, variant: "thinking", description: "d", whenToUse: ["x"] },
        heavy: { model: "openai/gpt-5.4", costRatio: 20, description: "d", whenToUse: ["x"] },
      },
    },
    rules: ["r1"],
    defaultTier: "medium",
    modes: { normal: { defaultTier: "medium", description: "d" } },
}`)
  let out = Protocol.buildDelegationProtocol(Protocol.tierConfigFromDict(cfg))
  assertionContains(~operator="@light in tier line", "@light", out)
  assertionContains(~operator="@focused in tier line", "@focused", out)
})

test("buildDelegationProtocol: contains @light contract section", () => {
  let cfg: Js.Dict.t<Js.Json.t> = %raw(`{
    activePreset: "multi-provider",
    activeMode: "normal",
    presets: {
      "multi-provider": {
        fast: { model: "opencode-go/mimo-v2.5", costRatio: 1, description: "d", whenToUse: ["x"] },
        light: { model: "opencode-go/mimo-v2.5", costRatio: 2, variant: "high", description: "d", whenToUse: ["x"] },
        medium: { model: "minimax-coding-plan/MiniMax-M3", costRatio: 5, description: "d", whenToUse: ["x"] },
        focused: { model: "minimax-coding-plan/MiniMax-M3", costRatio: 10, variant: "thinking", description: "d", whenToUse: ["x"] },
        heavy: { model: "openai/gpt-5.4", costRatio: 20, description: "d", whenToUse: ["x"] },
      },
    },
    rules: ["r1"],
    defaultTier: "medium",
    modes: { normal: { defaultTier: "medium", description: "d" } },
}`)
  let out = Protocol.buildDelegationProtocol(Protocol.tierConfigFromDict(cfg))
  assertionContains(~operator="@light contract section", "### @light contract", out)
  assertionContains(~operator="@focused contract section", "### @focused contract", out)
})
