// ---------------------------------------------------------------------------
// Ladder.resi — Public API contract for Ladder pure state machine.
//
// NO I/O imports. This module contains only pure functions for the escalation
// ladder state machine: tier ranking, state transitions, next-action decisions,
// and scorecard formatting.
//
// The I/O wrappers (dumpDelegateScorecard, logEscalation, logDelegation) live
// in ladder-io.ts and import from this module's generated .res.mjs output.
// ---------------------------------------------------------------------------

// Type: escalation policy configuration
type escalatePolicy = {
  ladder: array<string>,
  floorTier: option<string>,
  maxAttemptsPerTier: int,
  maxTotalAttempts: int,
  costMultiple: int,
}

// Type: mutable ladder state (tracks progress through tiers)
type ladderState = {
  currentTier: string,
  attemptsThisTier: int,
  totalAttempts: int,
  escalations: int,
  firstAttemptCost: option<int>,
  cumulativeCost: int,
}

// Type: verdict from the verification/grader step
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

// AbortSignal type (JS runtime object — checked via external)
// Defined as a named type to avoid parser issues with inline mutable in externals
type abortSignal = {mutable aborted: bool}

// Type: RouterConfig from TS boundary (broader type with optional fields)
type routerConfig = {
  activePreset: string,
  presets: dict<dict<JSON.t>>,
  rules: array<string>,
  defaultTier: string,
  enforcement: option<{escalate: option<{
    floorTier: option<option<string>>,
    ladder: option<array<string>>,
    maxAttemptsPerTier: option<int>,
    maxTotalAttempts: option<int>,
    costCeiling: option<{base: option<string>, multiple: option<float>}>,
  }>}>,
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

// Returns the index of `tier` in `ladder`, or -1 if not found
let tierRank: (string, array<string>) => int

// Resolves the starting tier given a producer tier and policy
let resolveStartTier: (string, escalatePolicy) => string

// Constructs a fresh ladder state from a producer tier and policy
let newLadderState: (string, escalatePolicy) => ladderState

// Records an attempt, incrementing counters and accumulating cost
// costUnits defaults to 0
let recordAttempt: (ladderState, ~costUnits: int=?) => ladderState

// Returns the next tier after the current one, or None if at the top
let nextTierAfter: (string, escalatePolicy) => option<string>

// Builds the forcing message shown to the model when retrying/escalating
let buildLadderForcingMessage: (array<string>) => string

// Decides the next action given current state, verdict, and policy
// signal is optional — None means no abort, Some(signal) checks s.aborted
let nextAction: (
  ladderState,
  option<ladderVerdict>,
  escalatePolicy,
  option<abortSignal>,
) => ladderAction

// Applies an action to produce the next state (pure transition)
let advance: (ladderState, ladderAction) => ladderState

// Builds an EscalatePolicy from a RouterConfig
// resolveLadder is imported from TierLadder.res.mjs (pure)
let buildEscalatePolicy: (routerConfig) => escalatePolicy

// Formats a scorecard string for a finished delegation
let formatLadderScorecard: (ladderState, bool, string) => string
