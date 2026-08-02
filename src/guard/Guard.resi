// ---------------------------------------------------------------------------
// Guard.resi — Public interface for the guard engine.
//
// Ports:
//   - src/guard/guards.ts → pure classification/evaluation logic
//   - src/guard/enforce.ts → policy building and before/after hooks
//
// ABI boundary: all nullable fields use Js.Nullable.t<T> for explicit null
// handling at the TS boundary.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// guardKind: classifies a tool call into one of 5 buckets
type guardKind = [
  | #finish
  | #read
  | #mutation
  | #self_script
  | #other
]

// guardPolicy: configuration for the guard engine
type guardPolicy = {
  budget: int,
  readDraftCap: int,
  sameOpRetryCap: int,
  blockSelfScript: bool,
  deliverableFirst: bool,
  // Optional fields use Js.Nullable.t for null handling at TS boundary
  deliverableSignal: Js.Nullable.t<string>,
  deliverablePath: Js.Nullable.t<string>,
  deliverableIsScript: Js.Nullable.t<bool>,
  blockScriptWrites: Js.Nullable.t<bool>,
}

// guardCall: a tool call to be evaluated
type guardCall = {
  tool: string,
  args?: Js.Nullable.t<Js.Dict.t<Js.Json.t>>,
}

// guardDecision: result of evaluateGuards
type guardDecision = {
  allow: bool,
  guard: Js.Nullable.t<string>,
  observation: Js.Nullable.t<string>,
}

// guardState: mutable state tracked across a delegation session
type guardState = {
  mutable budget: int,
  mutable toolCallCount: int,
  mutable readCount: int,
  mutable execCount: int,
  mutable selfScriptCount: int,
  mutable redundantCount: int,
  mutable blockedCount: int,
  mutable consecutiveNonProducing: int,
  mutable deliverableExecuted: bool,
  mutable ttfa: Js.Nullable.t<int>,
  // seen: raw JS Map for fingerprint deduplication
  mutable seen: Js.Dict.t<int>,
  mutable lastBlock: Js.Nullable.t<string>,
}

// guardStoreLike: interface for guard state persistence
// (implemented by guard/store.ts in TypeScript)
type guardStoreLike = {
  ensure: (string, guardPolicy) => guardState,
  get: (string) => Js.Nullable.t<guardState>,
  setPendingNote: (string, string) => unit,
  takePendingNote: (string) => Js.Nullable.t<string>,
}

// beforeResult: result of guardBeforeCall
type beforeResult = {
  block: bool,
  message: Js.Nullable.t<string>,
  mode: string,
  guard: Js.Nullable.t<string>,
}

// updateState opts
type updateStateOpts = {ok: bool}

// minimal RouterConfig shape for guard policy building
type routerConfigMinimal = {
  enforcement: option<{
    guard: option<{
      budget: option<int>,
      readDraftCap: option<int>,
      sameOpRetryCap: option<int>,
      blockSelfScript: option<bool>,
      deliverableFirst: option<bool>,
      blockScriptWrites: option<bool>,
    }>,
    proportional: option<{
      trivialBypass: option<bool>,
    }>,
  }>,
}

// makePolicyWithDefaults partial type
type makePolicyPartial = {
  budget?: int,
  readDraftCap?: int,
  sameOpRetryCap?: int,
  blockSelfScript?: bool,
  deliverableFirst?: bool,
  deliverableSignal?: Js.Nullable.t<string>,
  blockScriptWrites?: Js.Nullable.t<bool>,
}

// guardBeforeCall params
type guardBeforeCallParams = {
  cfg: routerConfigMinimal,
  tier: Js.Nullable.t<string>,
  sessionID: string,
  tool: string,
  toolArgs: Js.Nullable.t<Js.Dict.t<Js.Json.t>>,
  store: guardStoreLike,
  env: Js.Dict.t<Js.Nullable.t<string>>,
  trivial: Js.Nullable.t<bool>,
}

// guardAfterCall params
type guardAfterCallParams = {
  cfg: routerConfigMinimal,
  tier: Js.Nullable.t<string>,
  sessionID: string,
  tool: string,
  toolArgs: Js.Nullable.t<Js.Dict.t<Js.Json.t>>,
  output: {mutable output: Js.Nullable.t<Js.Json.t>},
  store: guardStoreLike,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// defaultGuardBudget: default total tool-call ceiling for enforced subagent
let defaultGuardBudget: int

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

// newGuardState: creates initial guard state from policy
let newGuardState: (guardPolicy) => guardState

// updateState: updates state after a tool call (mutates in place)
let updateState: (guardState, guardCall, updateStateOpts, guardPolicy) => guardState

// recordBlock: records a block decision (mutates in place)
let recordBlock: (guardState, guardDecision) => guardState

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// isSelfScript: checks if a call is a self-script pattern
let isSelfScript: (guardCall, guardPolicy) => bool

// classify: classifies a tool call into a guard kind
let classify: (guardCall, guardPolicy) => guardKind

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// evaluateGuards: evaluates all guard clauses against current state
let evaluateGuards: (guardState, guardCall, guardPolicy) => guardDecision

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

// forcingMessage: builds the forcing message for the model
let forcingMessage: (guardState, guardPolicy) => string

// trajectoryMetrics: returns snake_case metrics dict
let trajectoryMetrics: (guardState) => Js.Dict.t<unknown>

// observationOk: heuristic — did the tool output indicate success?
let observationOk: (Js.Json.t) => bool

// ---------------------------------------------------------------------------
// Policy building (used by enforce.ts hooks)
// ---------------------------------------------------------------------------

// buildGuardPolicy: builds a GuardPolicy from RouterConfig for a given tier
let buildGuardPolicy: (routerConfigMinimal, Js.Nullable.t<string>) => guardPolicy

// formatScorecard: compact per-delegation scorecard string
let formatScorecard: (guardState, Js.Nullable.t<string>) => string

// ---------------------------------------------------------------------------
// Hook functions (used by plugin/hooks)
// ---------------------------------------------------------------------------

// guardBeforeCall: decides whether a subagent tool call must be hard-blocked
let guardBeforeCall: (guardBeforeCallParams) => beforeResult

// guardAfterCall: updates guard state after an allowed call has executed
let guardAfterCall: (guardAfterCallParams) => unit

// ---------------------------------------------------------------------------
// Test helpers (for Guard_test.res)
// ---------------------------------------------------------------------------

// makePolicyDefault: creates a default policy for testing
let makePolicyDefault: (unit) => guardPolicy

// makePolicyWithDefaults: creates a policy with custom fields
let makePolicyWithDefaults: (makePolicyPartial) => guardPolicy

// makePolicyWithBlockScriptWrites: creates a policy with blockScriptWrites set
let makePolicyWithBlockScriptWrites: (bool) => guardPolicy

// makePolicyWithDeliverablePath: creates a policy with a deliverable path
let makePolicyWithDeliverablePath: (string) => guardPolicy

// makePolicyWithDeliverablePathAndBlockScript: creates a policy with deliverablePath and blockScriptWrites
let makePolicyWithDeliverablePathAndBlockScript: (string, bool) => guardPolicy

// makePolicyWithDeliverableIsScript: creates a policy with deliverableIsScript
let makePolicyWithDeliverableIsScript: (bool) => guardPolicy
