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
// Js.Nullable.t is used for all boundary types to ensure the JS output
// serializes absent values as explicit `null` rather than `undefined`.
// ---------------------------------------------------------------------------

type escalatePolicy = {
  ladder: array<string>,
  floorTier: Js.Nullable.t<string>,
  maxAttemptsPerTier: int,
  maxTotalAttempts: int,
  costMultiple: Js.Nullable.t<int>,
}

type ladderState = {
  currentTier: string,
  attemptsThisTier: int,
  totalAttempts: int,
  escalations: int,
  firstAttemptCost: Js.Nullable.t<int>,
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
  tier: Js.Nullable.t<string>,
  forcingMessage: Js.Nullable.t<string>,
  reason: Js.Nullable.t<string>,
}

// AbortSignal — defined as named type to avoid parser issues with inline mutable
type abortSignal = {mutable aborted: bool}

// Access the .aborted property from a JS AbortSignal object
let isAborted = (signal: option<abortSignal>): bool => {
  switch signal {
  | None => false
  | Some(s) => s.aborted
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
  // floorTier is Js.Nullable.t — use Js.Nullable.isNullable to detect absent value
  let fi = switch policy.floorTier->Js.Nullable.toOption {
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
    firstAttemptCost: Js.Nullable.null,
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
    // Js.Nullable.isNullable returns true for both null AND undefined from JS boundary
    firstAttemptCost: state.firstAttemptCost->Js.Nullable.isNullable
      ? Js.Nullable.return(costUnits)
      : state.firstAttemptCost,
    cumulativeCost: state.cumulativeCost + costUnits,
  }
}

// ---------------------------------------------------------------------------
// nextTierAfter — returns the next tier or None
// ---------------------------------------------------------------------------

let nextTierAfter = (currentTier: string, policy: escalatePolicy): Js.Nullable.t<string> => {
  let ci = tierRank(currentTier, policy.ladder)
  if ci >= 0 && ci + 1 <= policy.ladder->Array.length - 1 {
    switch policy.ladder->Array.get(ci + 1) {
    | Some(t) => Js.Nullable.return(t)
    | None => Js.Nullable.null
    }
  } else {
    Js.Nullable.null
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
  verdict: Js.Nullable.t<ladderVerdict>,
  policy: escalatePolicy,
  signal: option<abortSignal>,
): ladderAction => {
  // verdict: Js.Nullable.t handles both null and undefined from TS boundary.
  // Convert to option<ladderVerdict> for internal pattern matching.
  let verdictOpt = verdict->Js.Nullable.toOption
  // (1) pass — accept immediately
  let isAccept = switch verdictOpt {
  | Some(v) => v.pass
  | None => false
  }
  if isAccept {
    { action: #accept, tier: Js.Nullable.null, forcingMessage: Js.Nullable.null, reason: Js.Nullable.null }
  } else {
    // (2) abort guard — once cancelled, never retry or escalate
    if isAborted(signal) {
      { action: #give_up, tier: Js.Nullable.null, forcingMessage: Js.Nullable.null, reason: Js.Nullable.return("aborted") }
    } else {
      // (3) cost check — costMultiple null means "no ceiling"
      // firstAttemptCost is Js.Nullable.t; use toOption then multiply only when Some
      let costExceeded = switch state.firstAttemptCost->Js.Nullable.toOption {
      | Some(fc) =>
        switch policy.costMultiple->Js.Nullable.toOption {
        | None => false  // null/undefined from JS boundary means no ceiling
        | Some(cm) => cm >= 0 && state.cumulativeCost > fc * cm
        }
      | None => false
      }

      // (4) max total attempts
      if state.totalAttempts >= policy.maxTotalAttempts {
        { action: #give_up, tier: Js.Nullable.null, forcingMessage: Js.Nullable.null, reason: Js.Nullable.return("max total attempts (" ++ Belt.Int.toString(policy.maxTotalAttempts) ++ ") reached") }
      } else if costExceeded {
        // (5) cost ceiling
        { action: #give_up, tier: Js.Nullable.null, forcingMessage: Js.Nullable.null, reason: Js.Nullable.return("cost ceiling exceeded") }
      } else if state.attemptsThisTier < policy.maxAttemptsPerTier {
        // (6) retry within tier
        let reasons = switch verdictOpt {
        | Some(v) => v.reasons->Belt.Option.getWithDefault([])
        | None => []
        }
        { action: #retry, tier: Js.Nullable.return(state.currentTier), forcingMessage: Js.Nullable.return(buildLadderForcingMessage(reasons)), reason: Js.Nullable.null }
      } else {
        // (7) escalate or give_up — nextTierAfter returns Js.Nullable.t
        switch nextTierAfter(state.currentTier, policy)->Js.Nullable.toOption {
        | None =>
          { action: #give_up, tier: Js.Nullable.null, forcingMessage: Js.Nullable.null, reason: Js.Nullable.return("no higher tier (already at top of ladder)") }
        | Some(next) => {
            let reasons = switch verdictOpt {
            | Some(v) => v.reasons->Belt.Option.getWithDefault([])
            | None => []
            }
            { action: #escalate, tier: Js.Nullable.return(next), forcingMessage: Js.Nullable.return(buildLadderForcingMessage(reasons)), reason: Js.Nullable.null }
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
    switch action.tier->Js.Nullable.toOption {
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

let buildEscalatePolicy = (_cfg: routerConfig): escalatePolicy => {
  // Read the optional escalate block
  let esc = switch _cfg.enforcement {
  | None => None
  | Some(enf) => enf.escalate
  }

  // ladder: use explicit value or fall back to the 3-tier default
  // (matches old TS: esc?.ladder ?? resolveLadder(cfg) — for an empty cfg
  // resolveLadder returns ["fast","medium","heavy"]. The full preset-aware
  // resolution path is exercised by TierLadder.resolveLadder itself; for the
  // policy default we only need the no-preset fallback to match TS behavior.)
  let explicitLadder = switch esc {
  | None => None
  | Some(e) => e.ladder
  }
  let ladder = explicitLadder->Belt.Option.getWithDefault(["fast", "medium", "heavy"])

  // floorTier: flatten option<option<string>> -> Js.Nullable.t<string>
  // Js.Nullable.null represents absent/null from the TS boundary.
  // Belt.Option.flatMap handles the double-option: Some(None) -> None, Some(Some(s)) -> Some(s)
  let floorTier = switch esc {
  | None => Js.Nullable.null
  | Some(e) =>
    switch Belt.Option.flatMap(e.floorTier, x => x) {
    | None => Js.Nullable.null
    | Some(ft) => Js.Nullable.return(ft)
    }
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
  // - esc absent (None): default 4 (enabled)
  // - costCeiling absent (None): default 4 (enabled) — matches old TS: esc?.costCeiling?.multiple ?? 4
  // - costCeiling present but multiple null: disabled (null)
  // - costCeiling.multiple present: use that value
  let costMultiple: Js.Nullable.t<int> = switch esc {
  | None => Js.Nullable.return(4)  // default: enabled with multiplier 4
  | Some(e) =>
    switch e.costCeiling {
    | None => Js.Nullable.return(4)  // costCeiling absent => default 4 (enabled)
    | Some(cc) =>
      switch cc.multiple {
      | None => Js.Nullable.null  // multiple null => disabled
      | Some(v) =>
        let cm: int = Float.toInt(v)
        Js.Nullable.return(cm)
      }
    }
  }

  {
    ladder: ladder,
    floorTier: floorTier,
    maxAttemptsPerTier: maxAttemptsPerTier->Belt.Option.getWithDefault(1),
    maxTotalAttempts: maxTotalAttempts->Belt.Option.getWithDefault(4),
    costMultiple: costMultiple,
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
