// ---------------------------------------------------------------------------
// Ladder.res — Pure escalation ladder state machine.
//
// NO I/O imports. All filesystem, logging, and observability calls are
// handled by ladder-io.ts which wraps the pure functions in this module.
//
// References:
//   - src/escalate/ladder.ts (original TS implementation)
//   - design observation #3938 (Ladder contract + fixture inventory)
// ---------------------------------------------------------------------------

// Import defaultTierNames (pure) from TierLadder.res.mjs for fallback
let defaultTierNames = TierLadder.defaultTierNames

// ---------------------------------------------------------------------------
// Types (mirrors the TS interfaces)
// ---------------------------------------------------------------------------

type escalatePolicy = {
  ladder: array<string>,
  floorTier: option<string>,
  maxAttemptsPerTier: int,
  maxTotalAttempts: int,
  costMultiple: int,
}

type ladderState = {
  currentTier: string,
  attemptsThisTier: int,
  totalAttempts: int,
  escalations: int,
  firstAttemptCost: option<int>,
  cumulativeCost: int,
}

type ladderVerdict = {
  pass: bool,
  reasons: option<array<string>>,
}

// Variant: possible action kinds — declared BEFORE ladderAction
type ladderActionKind = [
  | #accept
  | #retry
  | #escalate
  | #give_up
]

// Type: action returned by the state machine
type ladderAction = {
  action: ladderActionKind,
  tier: option<string>,
  forcingMessage: option<string>,
  reason: option<string>,
}

// AbortSignal — defined as named type to avoid parser issues with inline mutable
type abortSignal = {mutable aborted: bool}

// External to read the .aborted property from a JS AbortSignal object
@val external _isAborted: abortSignal => bool = "aborted"

let isAborted = (signal: option<abortSignal>): bool => {
  switch signal {
  | None => false
  | Some(s) => _isAborted(s)
  }
}

// RouterConfig for buildEscalatePolicy
// Uses the EXACT same structure as Ladder.resi to ensure type compatibility
type routerConfig = {
  activePreset: string,
  presets: dict<dict<JSON.t>>,
  rules: array<string>,
  defaultTier: string,
  enforcement: option<{
    escalate: option<{
      floorTier: option<option<string>>,
      ladder: option<array<string>>,
      maxAttemptsPerTier: option<int>,
      maxTotalAttempts: option<int>,
      costCeiling: option<{base: option<string>, multiple: option<float>}>,
    }>,
  }>,
}

// ---------------------------------------------------------------------------
// tierRank — returns index of tier in ladder, or -1
// ---------------------------------------------------------------------------

let tierRank = (tier: string, ladder: array<string>): int => {
  ladder->Array.indexOf(tier)
}

// ---------------------------------------------------------------------------
// resolveStartTier — resolves the starting tier given producer + floor
// ---------------------------------------------------------------------------

let resolveStartTier = (producerTier: string, policy: escalatePolicy): string => {
  let pi = tierRank(producerTier, policy.ladder)
  let fi = switch policy.floorTier {
  | None => -1
  | Some(ft) => tierRank(ft, policy.ladder)
  }
  let startIdx = {
    let p = pi >= 0 ? pi : 0
    let f = fi >= 0 ? fi : 0
    p > f ? p : f
  }
  switch policy.ladder->Array.get(startIdx) {
  | Some(t) => t
  | None => producerTier
  }
}

// ---------------------------------------------------------------------------
// newLadderState — constructs initial state from producer tier and policy
// ---------------------------------------------------------------------------

let newLadderState = (producerTier: string, policy: escalatePolicy): ladderState => {
  {
    currentTier: resolveStartTier(producerTier, policy),
    attemptsThisTier: 0,
    totalAttempts: 0,
    escalations: 0,
    firstAttemptCost: None,
    cumulativeCost: 0,
  }
}

// ---------------------------------------------------------------------------
// recordAttempt — records an attempt with cost accumulation
// ---------------------------------------------------------------------------

let recordAttempt = (state: ladderState, ~costUnits: int=0): ladderState => {
  {
    currentTier: state.currentTier,
    attemptsThisTier: state.attemptsThisTier,
    totalAttempts: state.totalAttempts + 1,
    escalations: state.escalations,
    firstAttemptCost: state.firstAttemptCost == None ? Some(costUnits) : state.firstAttemptCost,
    cumulativeCost: state.cumulativeCost + costUnits,
  }
}

// ---------------------------------------------------------------------------
// nextTierAfter — returns the next tier or None
// ---------------------------------------------------------------------------

let nextTierAfter = (currentTier: string, policy: escalatePolicy): option<string> => {
  let ci = tierRank(currentTier, policy.ladder)
  if ci >= 0 && ci + 1 <= policy.ladder->Array.length - 1 {
    policy.ladder->Array.get(ci + 1)
  } else {
    None
  }
}

// ---------------------------------------------------------------------------
// buildLadderForcingMessage — builds the forcing message for the model
// ---------------------------------------------------------------------------

let buildLadderForcingMessage = (reasons: array<string>): string => {
  let list = {
    let len = reasons->Array.length
    if len === 0 {
      "- (no reasons provided)"
    } else {
      reasons->Array.map(r => "- " ++ r)->Array.join("\n")
    }
  }
  "[router escalation] previous attempt did not pass verification:\n" ++ list ++ "\nNEXT: retry with these failures addressed."
}

// ---------------------------------------------------------------------------
// nextAction — core decision logic
// ---------------------------------------------------------------------------

let nextAction = (
  state: ladderState,
  verdict: option<ladderVerdict>,
  policy: escalatePolicy,
  signal: option<abortSignal>,
): ladderAction => {
  // (1) pass — accept immediately
  switch verdict {
  | Some(v) if v.pass === true =>
    { action: #accept, tier: None, forcingMessage: None, reason: None }
  | _ => {
    // (2) abort guard — once cancelled, never retry or escalate
    if isAborted(signal) {
      { action: #give_up, tier: None, forcingMessage: None, reason: Some("aborted") }
    } else {
      // (3) cost check — costMultiple is always int (default 4 applied)
      let costExceeded = switch state.firstAttemptCost {
      | Some(fc) => state.cumulativeCost > fc * policy.costMultiple
      | None => false
      }

      // (4) max total attempts
      if state.totalAttempts >= policy.maxTotalAttempts {
        { action: #give_up, tier: None, forcingMessage: None, reason: Some("max total attempts (" ++ Belt.Int.toString(policy.maxTotalAttempts) ++ ") reached") }
      } else if costExceeded {
        // (5) cost ceiling
        { action: #give_up, tier: None, forcingMessage: None, reason: Some("cost ceiling exceeded") }
      } else if state.attemptsThisTier < policy.maxAttemptsPerTier {
        // (6) retry within tier
        let reasons = switch verdict {
        | Some(v) => v.reasons->Belt.Option.getWithDefault([])
        | None => []
        }
        { action: #retry, tier: Some(state.currentTier), forcingMessage: Some(buildLadderForcingMessage(reasons)), reason: None }
      } else {
        // (7) escalate or give_up
        switch nextTierAfter(state.currentTier, policy) {
        | None =>
          { action: #give_up, tier: None, forcingMessage: None, reason: Some("no higher tier (already at top of ladder)") }
        | Some(next) => {
            let reasons = switch verdict {
            | Some(v) => v.reasons->Belt.Option.getWithDefault([])
            | None => []
            }
            { action: #escalate, tier: Some(next), forcingMessage: Some(buildLadderForcingMessage(reasons)), reason: None }
          }
        }
      }
    }
  }
  }
}

// ---------------------------------------------------------------------------
// advance — applies an action to produce the next state
// ---------------------------------------------------------------------------

let advance = (state: ladderState, action: ladderAction): ladderState => {
  switch action.action {
  | #retry => {
      currentTier: state.currentTier,
      attemptsThisTier: state.attemptsThisTier + 1,
      totalAttempts: state.totalAttempts,
      escalations: state.escalations,
      firstAttemptCost: state.firstAttemptCost,
      cumulativeCost: state.cumulativeCost,
    }
  | #escalate =>
    switch action.tier {
    | None => state // defensive — escalate always carries tier
    | Some(t) => {
        currentTier: t,
        attemptsThisTier: 0,
        totalAttempts: state.totalAttempts,
        escalations: state.escalations + 1,
        firstAttemptCost: state.firstAttemptCost,
        cumulativeCost: state.cumulativeCost,
      }
    }
  | #accept
  | #give_up => state // terminal, unchanged
  }
}

// ---------------------------------------------------------------------------
// buildEscalatePolicy — builds policy from RouterConfig
// ---------------------------------------------------------------------------

let buildEscalatePolicy = (cfg: routerConfig): escalatePolicy => {
  // Read the optional escalate block
  let esc = switch cfg.enforcement {
  | None => None
  | Some(enf) => enf.escalate
  }

  // ladder: use explicit value or fall back to defaultTierNames
  // (same fallback as TierLadder.resolveLadder when no preset is available)
  let explicitLadder = switch esc {
  | None => None
  | Some(e) => e.ladder
  }
  let ladder = explicitLadder->Belt.Option.getWithDefault(defaultTierNames)

  // floorTier: flatten option<option<string>> -> option<string>
  // (None = absent/undefined; Some(None) = null means no floor; Some(Some(s)) = floor value)
  let floorTier = switch esc {
  | None => None
  | Some(e) => Belt.Option.flatMap(e.floorTier, x => x)
  }

  // maxAttemptsPerTier: default 1
  let maxAttemptsPerTier = switch esc {
  | None => None
  | Some(e) => e.maxAttemptsPerTier
  }

  // maxTotalAttempts: default 4
  let maxTotalAttempts = switch esc {
  | None => None
  | Some(e) => e.maxTotalAttempts
  }

  // costMultiple: esc?.costCeiling?.multiple ?? 4 (TS line 179)
  let costMultiple = switch esc {
  | None => None
  | Some(e) =>
    switch e.costCeiling {
    | None => None
    | Some(cc) => cc.multiple->Belt.Option.map(v => Float.toInt(v))
    }
  }

  {
    ladder: ladder,
    floorTier: floorTier,
    maxAttemptsPerTier: maxAttemptsPerTier->Belt.Option.getWithDefault(1),
    maxTotalAttempts: maxTotalAttempts->Belt.Option.getWithDefault(4),
    costMultiple: costMultiple->Belt.Option.getWithDefault(4),
  }
}

// ---------------------------------------------------------------------------
// formatLadderScorecard — one-line scorecard string
// ---------------------------------------------------------------------------

let formatLadderScorecard = (state: ladderState, accepted: bool, method: string): string => {
  let verdictStr = accepted ? "PASS" : "UNMET"
  "[router delegate scorecard | final_tier=" ++ state.currentTier ++
  " | attempts=" ++ Belt.Int.toString(state.totalAttempts) ++
  " | escalations=" ++ Belt.Int.toString(state.escalations) ++
  " | cost=" ++ Belt.Int.toString(state.cumulativeCost) ++
  " | verdict=" ++ verdictStr ++
  " | method=" ++ method ++ "]"
}
