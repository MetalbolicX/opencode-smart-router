// Import TierLadder for defaultTierNames reference
// NOTE: TierLadder open removed - unused

// ---------------------------------------------------------------------------
// Ladder_test.res — RED-first parity tests for Ladder pure state machine.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of ladder.test.ts fixtures — every case from the TS test is replicated
// here using rescript-test 8.0.0 syntax.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let assertionEqual = (~operator: string, expected: 'a, actual: 'a): unit =>
  assertion(~operator, (a, b) => a === b, actual, expected)

let assertionTrue = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === true, actual, true)

let assertionFalse = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === false, actual, false)

// Simple string contains check using String.indexOf
let stringContains = (haystack: string, needle: string): bool =>
  String.indexOf(haystack, needle) >= 0

// ---------------------------------------------------------------------------
// Test helpers — use Ladder module types
// ---------------------------------------------------------------------------

let makePolicy = (
  ~ladder: array<string>=["fast", "medium", "heavy"],
  ~floorTier: Nullable.t<string>=Nullable.null,
  ~maxAttemptsPerTier: int=1,
  ~maxTotalAttempts: int=4,
  ~costMultiple: Nullable.t<int>=Nullable.make(4),
  (),
): Ladder.escalatePolicy => {
  {
    ladder,
    floorTier,
    maxAttemptsPerTier,
    maxTotalAttempts,
    costMultiple,
  }
}

let makeState = (
  ~currentTier: string="fast",
  ~attemptsThisTier: int=0,
  ~totalAttempts: int=0,
  ~escalations: int=0,
  ~firstAttemptCost: Nullable.t<int>=Nullable.null,
  ~cumulativeCost: int=0,
  (),
): Ladder.ladderState => {
  {
    currentTier,
    attemptsThisTier,
    totalAttempts,
    escalations,
    firstAttemptCost,
    cumulativeCost,
  }
}

// ---------------------------------------------------------------------------
// tierRank
// ---------------------------------------------------------------------------

test("tierRank: known tier returns correct index", () => {
  let ladder = ["fast", "medium", "heavy"]
  assertionEqual(~operator="fast", Ladder.tierRank("fast", ladder), 0)
  assertionEqual(~operator="medium", Ladder.tierRank("medium", ladder), 1)
  assertionEqual(~operator="heavy", Ladder.tierRank("heavy", ladder), 2)
})

test("tierRank: unknown tier returns -1", () => {
  let ladder = ["fast", "medium", "heavy"]
  assertionEqual(~operator="ultra", Ladder.tierRank("ultra", ladder), -1)
  assertionEqual(~operator="empty", Ladder.tierRank("", ladder), -1)
})

test("tierRank: empty ladder returns -1", () => {
  assertionEqual(~operator="empty", Ladder.tierRank("fast", []), -1)
})

// ---------------------------------------------------------------------------
// resolveStartTier
// ---------------------------------------------------------------------------

test("resolveStartTier: producer in ladder, no floor => returns producerTier", () => {
  let p = makePolicy()
  assertionEqual(~operator="fast", Ladder.resolveStartTier("fast", p), "fast")
  assertionEqual(~operator="medium", Ladder.resolveStartTier("medium", p), "medium")
  assertionEqual(~operator="heavy", Ladder.resolveStartTier("heavy", p), "heavy")
})

test("resolveStartTier: producer below floorTier => returns floorTier", () => {
  let p = makePolicy(~floorTier=Nullable.make("medium"), ())
  assertionEqual(~operator="below", Ladder.resolveStartTier("fast", p), "medium")
})

test("resolveStartTier: producer at floorTier => returns producerTier (same)", () => {
  let p = makePolicy(~floorTier=Nullable.make("medium"), ())
  assertionEqual(~operator="at", Ladder.resolveStartTier("medium", p), "medium")
})

test("resolveStartTier: producer above floorTier => returns producerTier", () => {
  let p = makePolicy(~floorTier=Nullable.make("fast"), ())
  assertionEqual(~operator="above", Ladder.resolveStartTier("heavy", p), "heavy")
})

test("resolveStartTier: floorTier heavy with producer fast => starts at heavy", () => {
  let p = makePolicy(~floorTier=Nullable.make("heavy"), ())
  assertionEqual(~operator="heavyFloor", Ladder.resolveStartTier("fast", p), "heavy")
})

test("resolveStartTier: unknown producer not in ladder => uses ladder[0]", () => {
  let p = makePolicy()
  assertionEqual(~operator="unknown", Ladder.resolveStartTier("unknown", p), "fast")
})

test("resolveStartTier: unknown producer + floor medium => starts at medium", () => {
  let p = makePolicy(~floorTier=Nullable.make("medium"), ())
  assertionEqual(~operator="unknownFloor", Ladder.resolveStartTier("unknown", p), "medium")
})

test("resolveStartTier: empty ladder, no floor => returns producerTier as fallback", () => {
  let p = makePolicy(~ladder=[], ())
  assertionEqual(~operator="empty", Ladder.resolveStartTier("medium", p), "medium")
})

test("resolveStartTier: floorTier not in ladder => acts as -1", () => {
  let p = makePolicy(~floorTier=Nullable.make("nonexistent"), ())
  assertionEqual(~operator="unknownFloor", Ladder.resolveStartTier("fast", p), "fast")
})

// ---------------------------------------------------------------------------
// newLadderState
// ---------------------------------------------------------------------------

test("newLadderState: initialises all counters to zero/null", () => {
  let p = makePolicy()
  let s = Ladder.newLadderState("fast", p)
  assertionEqual(~operator="currentTier", s.currentTier, "fast")
  assertionEqual(~operator="attemptsThisTier", s.attemptsThisTier, 0)
  assertionEqual(~operator="totalAttempts", s.totalAttempts, 0)
  assertionEqual(~operator="escalations", s.escalations, 0)
  assertionEqual(~operator="firstAttemptCost", s.firstAttemptCost->Nullable.toOption, None)
  assertionEqual(~operator="cumulativeCost", s.cumulativeCost, 0)
})

test("newLadderState: applies floorTier to currentTier", () => {
  let p = makePolicy(~floorTier=Nullable.make("medium"), ())
  let s = Ladder.newLadderState("fast", p)
  assertionEqual(~operator="floor", s.currentTier, "medium")
})

test("newLadderState: does not mutate input policy", () => {
  let p = makePolicy()
  let pJson = JSON.stringifyAny(p)
  let _ = Ladder.newLadderState("fast", p)
  let pJsonAfter = JSON.stringifyAny(p)
  assertionEqual(~operator="noMutate", pJson, pJsonAfter)
})

// ---------------------------------------------------------------------------
// recordAttempt
// ---------------------------------------------------------------------------

test("recordAttempt: increments totalAttempts and cumulativeCost", () => {
  let s = makeState()
  let s2 = Ladder.recordAttempt(s, ~costUnits=5)
  assertionEqual(~operator="total", s2.totalAttempts, 1)
  assertionEqual(~operator="cumulative", s2.cumulativeCost, 5)
  assertionEqual(~operator="first", s2.firstAttemptCost->Nullable.toOption, Some(5))
})

test("recordAttempt: firstAttemptCost set only once", () => {
  let s = makeState()
  let s1 = Ladder.recordAttempt(s, ~costUnits=3)
  let s2 = Ladder.recordAttempt(s1, ~costUnits=10)
  assertionEqual(~operator="first", s2.firstAttemptCost->Nullable.toOption, Some(3))
  assertionEqual(~operator="cumulative", s2.cumulativeCost, 13)
  assertionEqual(~operator="total", s2.totalAttempts, 2)
})

test("recordAttempt: default cost is 0", () => {
  let s = makeState()
  let s2 = Ladder.recordAttempt(s)
  assertionEqual(~operator="cumulative", s2.cumulativeCost, 0)
  assertionEqual(~operator="first", s2.firstAttemptCost->Nullable.toOption, Some(0))
})

test("recordAttempt: does NOT mutate input state", () => {
  let s = makeState(~totalAttempts=0, ~cumulativeCost=0, ())
  let sOrig = JSON.stringifyAny(s)
  let _ = Ladder.recordAttempt(s, ~costUnits=7)
  let sAfter = JSON.stringifyAny(s)
  assertionEqual(~operator="noMutate", sOrig, sAfter)
})

test("recordAttempt: accumulates cost across many calls", () => {
  let s = makeState()
  let s1 = Ladder.recordAttempt(s, ~costUnits=1)
  let s2 = Ladder.recordAttempt(s1, ~costUnits=2)
  let s3 = Ladder.recordAttempt(s2, ~costUnits=3)
  let s4 = Ladder.recordAttempt(s3, ~costUnits=4)
  assertionEqual(~operator="cumulative", s4.cumulativeCost, 10)
  assertionEqual(~operator="first", s4.firstAttemptCost->Nullable.toOption, Some(1))
  assertionEqual(~operator="total", s4.totalAttempts, 4)
})

// ---------------------------------------------------------------------------
// nextTierAfter
// ---------------------------------------------------------------------------

test("nextTierAfter: fast => medium", () => {
  let p = makePolicy()
  assertionEqual(
    ~operator="fast",
    Ladder.nextTierAfter("fast", p)->Nullable.toOption,
    Some("medium"),
  )
})

test("nextTierAfter: medium => heavy", () => {
  let p = makePolicy()
  assertionEqual(
    ~operator="medium",
    Ladder.nextTierAfter("medium", p)->Nullable.toOption,
    Some("heavy"),
  )
})

test("nextTierAfter: heavy (top) => null", () => {
  let p = makePolicy()
  assertionEqual(~operator="top", Ladder.nextTierAfter("heavy", p)->Nullable.toOption, None)
})

test("nextTierAfter: unknown tier => null", () => {
  let p = makePolicy()
  assertionEqual(~operator="unknown", Ladder.nextTierAfter("unknown", p)->Nullable.toOption, None)
})

test("nextTierAfter: single-tier ladder => null", () => {
  let p = makePolicy(~ladder=["medium"], ())
  assertionEqual(~operator="single", Ladder.nextTierAfter("medium", p)->Nullable.toOption, None)
})

// ---------------------------------------------------------------------------
// buildLadderForcingMessage
// ---------------------------------------------------------------------------

test("buildLadderForcingMessage: includes header line", () => {
  let msg = Ladder.buildLadderForcingMessage(["reason A"])
  assertionTrue(~operator="header", stringContains(msg, "[router escalation]"))
})

test("buildLadderForcingMessage: includes NEXT line", () => {
  let msg = Ladder.buildLadderForcingMessage(["x"])
  assertionTrue(~operator="next", stringContains(msg, "NEXT: retry with these failures addressed."))
})

test("buildLadderForcingMessage: formats each reason as a bullet", () => {
  let msg = Ladder.buildLadderForcingMessage(["foo", "bar"])
  assertionTrue(~operator="foo", stringContains(msg, "- foo"))
  assertionTrue(~operator="bar", stringContains(msg, "- bar"))
})

test("buildLadderForcingMessage: empty reasons uses fallback bullet", () => {
  let msg = Ladder.buildLadderForcingMessage([])
  assertionTrue(~operator="fallback", stringContains(msg, "- (no reasons provided)"))
  assertionFalse(~operator="noFoo", stringContains(msg, "- foo"))
})

test("buildLadderForcingMessage: multiple reasons all present", () => {
  let msg = Ladder.buildLadderForcingMessage(["err1", "err2", "err3"])
  assertionTrue(~operator="err1", stringContains(msg, "- err1"))
  assertionTrue(~operator="err2", stringContains(msg, "- err2"))
  assertionTrue(~operator="err3", stringContains(msg, "- err3"))
})

test("buildLadderForcingMessage: pure pass-through (no scrubbing)", () => {
  let msg = Ladder.buildLadderForcingMessage(["secret=abc123"])
  assertionTrue(~operator="passThrough", stringContains(msg, "secret=abc123"))
})

// ---------------------------------------------------------------------------
// nextAction — core decision logic
// ---------------------------------------------------------------------------

test("nextAction: verdict.pass=true => accept", () => {
  let p = makePolicy()
  let s = makeState(~totalAttempts=1, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: true, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #accept)
})

test("nextAction: verdict null => treated as FAIL", () => {
  let p = makePolicy(~maxAttemptsPerTier=2, ~maxTotalAttempts=4, ())
  let s = makeState(~totalAttempts=1, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(s, Nullable.null, p, None)
  assertionFalse(~operator="notAccept", a.action === #accept)
})

test("nextAction: verdict undefined => treated as FAIL", () => {
  let p = makePolicy(~maxAttemptsPerTier=2, ~maxTotalAttempts=4, ())
  let s = makeState(~totalAttempts=1, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(s, Nullable.null, p, None)
  assertionFalse(~operator="notAccept", a.action === #accept)
})

test("nextAction: maxTotalAttempts reached => give_up with message", () => {
  let p = makePolicy(~maxTotalAttempts=3, ())
  let s = makeState(~totalAttempts=3, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #give_up)
  switch a.reason->Nullable.toOption {
  | Some(r) => assertionTrue(~operator="reason", stringContains(r, "max total attempts (3)"))
  | None => assertionTrue(~operator="reason", false)
  }
})

test("nextAction: maxTotalAttempts check precedes retry", () => {
  let p = makePolicy(~maxTotalAttempts=2, ~maxAttemptsPerTier=5, ())
  let s = makeState(~totalAttempts=2, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="giveUp", a.action, #give_up)
})

test("nextAction: cost ceiling exceeded => give_up", () => {
  let p = makePolicy(~costMultiple=Nullable.make(2), ~maxTotalAttempts=10, ())
  let s = makeState(~totalAttempts=2, ~firstAttemptCost=Nullable.make(5), ~cumulativeCost=11, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #give_up)
  assertionEqual(~operator="reason", a.reason->Nullable.toOption, Some("cost ceiling exceeded"))
})

test("nextAction: cost ceiling at exact threshold is NOT exceeded", () => {
  let p = makePolicy(~costMultiple=Nullable.make(2), ~maxTotalAttempts=10, ())
  let s = makeState(
    ~totalAttempts=2,
    ~firstAttemptCost=Nullable.make(5),
    ~cumulativeCost=10,
    ~attemptsThisTier=0,
    (),
  )
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="retry", a.action, #retry)
})

test("nextAction: retry when attemptsThisTier < maxAttemptsPerTier", () => {
  let p = makePolicy(~maxAttemptsPerTier=2, ~maxTotalAttempts=10, ())
  let s = makeState(~totalAttempts=1, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #retry)
  assertionEqual(~operator="tier", a.tier->Nullable.toOption, Some("fast"))
  assertionTrue(~operator="forcing", a.forcingMessage->Nullable.toOption !== None)
})

test("nextAction: retry includes forcingMessage from verdict reasons", () => {
  let p = makePolicy(~maxAttemptsPerTier=3, ~maxTotalAttempts=10, ())
  let s = makeState(~totalAttempts=1, ~attemptsThisTier=0, ())
  let verdict: Ladder.ladderVerdict = {pass: false, reasons: Some(["bad output"])}
  let a = Ladder.nextAction(s, Nullable.make(verdict), p, None)
  assertionEqual(~operator="action", a.action, #retry)
  switch a.forcingMessage->Nullable.toOption {
  | Some(msg) => assertionTrue(~operator="forcing", stringContains(msg, "bad output"))
  | None => assertionTrue(~operator="forcing", false)
  }
})

test(
  "nextAction: escalate when attemptsThisTier >= maxAttemptsPerTier and next tier exists",
  () => {
    let p = makePolicy(~maxAttemptsPerTier=1, ~maxTotalAttempts=10, ())
    let s = makeState(~currentTier="fast", ~totalAttempts=1, ~attemptsThisTier=1, ())
    let a = Ladder.nextAction(
      s,
      Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
      p,
      None,
    )
    assertionEqual(~operator="action", a.action, #escalate)
    assertionEqual(~operator="tier", a.tier->Nullable.toOption, Some("medium"))
    assertionTrue(~operator="forcing", a.forcingMessage->Nullable.toOption !== None)
  },
)

test("nextAction: give_up at top of ladder", () => {
  let p = makePolicy(~maxAttemptsPerTier=1, ~maxTotalAttempts=10, ())
  let s = makeState(~currentTier="heavy", ~totalAttempts=1, ~attemptsThisTier=1, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #give_up)
  assertionEqual(
    ~operator="reason",
    a.reason->Nullable.toOption,
    Some("no higher tier (already at top of ladder)"),
  )
})

test("nextAction: maxAttemptsPerTier 0 => escalate immediately", () => {
  let p = makePolicy(
    ~maxAttemptsPerTier=0,
    ~maxTotalAttempts=10,
    ~ladder=["fast", "medium", "heavy"],
    (),
  )
  let s = makeState(~currentTier="fast", ~totalAttempts=1, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #escalate)
  assertionEqual(~operator="tier", a.tier->Nullable.toOption, Some("medium"))
})

test("nextAction: single-tier ladder retries up to cap then give_up", () => {
  let p = makePolicy(~ladder=["medium"], ~maxAttemptsPerTier=2, ~maxTotalAttempts=10, ())
  let s = makeState(~currentTier="medium", ~totalAttempts=3, ~attemptsThisTier=2, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #give_up)
  assertionEqual(
    ~operator="reason",
    a.reason->Nullable.toOption,
    Some("no higher tier (already at top of ladder)"),
  )
})

test("nextAction: no forcingMessage on give_up", () => {
  let p = makePolicy(~maxTotalAttempts=1, ())
  let s = makeState(~totalAttempts=1, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #give_up)
  assertionEqual(~operator="noForcing", a.forcingMessage->Nullable.toOption, None)
})

test("nextAction: costMultiple=0 => cost check never triggers", () => {
  let p = makePolicy(
    ~costMultiple=Nullable.make(0),
    ~maxTotalAttempts=10,
    ~maxAttemptsPerTier=1,
    (),
  )
  let s = makeState(
    ~totalAttempts=2,
    ~attemptsThisTier=0,
    ~firstAttemptCost=Nullable.make(1),
    ~cumulativeCost=99999,
    (),
  )
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionFalse(~operator="notGiveUp", a.action === #give_up)
})

test("nextAction: firstAttemptCost null => cost check never triggers", () => {
  let p = makePolicy(
    ~costMultiple=Nullable.make(2),
    ~maxTotalAttempts=10,
    ~maxAttemptsPerTier=3,
    (),
  )
  let s = makeState(
    ~totalAttempts=1,
    ~attemptsThisTier=0,
    ~firstAttemptCost=Nullable.null,
    ~cumulativeCost=100,
    (),
  )
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionFalse(~operator="notGiveUp", a.action === #give_up)
})

test("nextAction: accept takes priority over cost/attempt checks", () => {
  let p = makePolicy(~costMultiple=Nullable.make(1), ~maxTotalAttempts=1, ())
  let s = makeState(~totalAttempts=5, ~firstAttemptCost=Nullable.make(1), ~cumulativeCost=100, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: true, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="action", a.action, #accept)
})

// ---------------------------------------------------------------------------
// advance — state transitions
// ---------------------------------------------------------------------------

test("advance: retry increments attemptsThisTier only", () => {
  let s = makeState(~attemptsThisTier=0, ~currentTier="fast", ())
  let action: Ladder.ladderAction = {
    action: #retry,
    tier: Nullable.make("fast"),
    forcingMessage: Nullable.null,
    reason: Nullable.null,
  }
  let s2 = Ladder.advance(s, action)
  assertionEqual(~operator="attempts", s2.attemptsThisTier, 1)
  assertionEqual(~operator="tier", s2.currentTier, "fast")
  assertionEqual(~operator="escalations", s2.escalations, 0)
  assertionEqual(~operator="totalUnchanged", s2.totalAttempts, 0)
})

test("advance: escalate updates currentTier resets attemptsThisTier increments escalations", () => {
  let s = makeState(~currentTier="fast", ~attemptsThisTier=1, ~escalations=0, ())
  let action: Ladder.ladderAction = {
    action: #escalate,
    tier: Nullable.make("medium"),
    forcingMessage: Nullable.null,
    reason: Nullable.null,
  }
  let s2 = Ladder.advance(s, action)
  assertionEqual(~operator="tier", s2.currentTier, "medium")
  assertionEqual(~operator="attempts", s2.attemptsThisTier, 0)
  assertionEqual(~operator="escalations", s2.escalations, 1)
})

test("advance: accept => state unchanged", () => {
  let s = makeState(~currentTier="medium", ~totalAttempts=3, ())
  let action: Ladder.ladderAction = {
    action: #accept,
    tier: Nullable.null,
    forcingMessage: Nullable.null,
    reason: Nullable.null,
  }
  let s2 = Ladder.advance(s, action)
  assertionEqual(~operator="same", s2, s)
})

test("advance: give_up => state unchanged", () => {
  let s = makeState(~totalAttempts=4, ~currentTier="heavy", ())
  let action: Ladder.ladderAction = {
    action: #give_up,
    tier: Nullable.null,
    forcingMessage: Nullable.null,
    reason: Nullable.make("done"),
  }
  let s2 = Ladder.advance(s, action)
  assertionEqual(~operator="same", s2, s)
})

test("advance: does NOT mutate input state on retry", () => {
  let s = makeState(~attemptsThisTier=2, ())
  let sOrig = JSON.stringifyAny(s)
  let action: Ladder.ladderAction = {
    action: #retry,
    tier: Nullable.make("fast"),
    forcingMessage: Nullable.null,
    reason: Nullable.null,
  }
  let _ = Ladder.advance(s, action)
  let sAfter = JSON.stringifyAny(s)
  assertionEqual(~operator="noMutate", sOrig, sAfter)
})

test("advance: does NOT mutate input state on escalate", () => {
  let s = makeState(~currentTier="fast", ~escalations=0, ())
  let sOrig = JSON.stringifyAny(s)
  let action: Ladder.ladderAction = {
    action: #escalate,
    tier: Nullable.make("medium"),
    forcingMessage: Nullable.null,
    reason: Nullable.null,
  }
  let _ = Ladder.advance(s, action)
  let sAfter = JSON.stringifyAny(s)
  assertionEqual(~operator="noMutate", sOrig, sAfter)
})

// ---------------------------------------------------------------------------
// buildEscalatePolicy — uses RouterConfig from the broader TS type
// ---------------------------------------------------------------------------

test("buildEscalatePolicy: all defaults when enforcement absent", () => {
  let cfg: Ladder.routerConfig = {
    activePreset: "default",
    presets: Dict.make(),
    rules: [],
    defaultTier: "fast",
    enforcement: None,
  }
  let p = Ladder.buildEscalatePolicy(cfg)
  // ladder falls back to the 3-tier default ["fast","medium","heavy"]
  // (matches old TS: esc?.ladder ?? resolveLadder(cfg) — for an empty cfg
  // resolveLadder returns this 3-tier list. See Ladder.res buildEscalatePolicy.)
  assertion(~operator="ladderDeepEqual", (a, b) => a == b, p.ladder, ["fast", "medium", "heavy"])
  assertionEqual(~operator="floorTier", p.floorTier->Nullable.toOption, None)
  assertionEqual(~operator="maxAttempts", p.maxAttemptsPerTier, 1)
  assertionEqual(~operator="maxTotal", p.maxTotalAttempts, 4)
  // costMultiple: when enforcement absent, default is 4 (TS: esc?.costCeiling?.multiple ?? 4)
  assertionEqual(~operator="costMultiple", p.costMultiple->Nullable.toOption, Some(4))
})

// ---------------------------------------------------------------------------
// formatLadderScorecard
// ---------------------------------------------------------------------------

test("formatLadderScorecard: accepted=true => verdict=PASS", () => {
  let s = makeState(~currentTier="medium", ~totalAttempts=2, ~escalations=1, ~cumulativeCost=8, ())
  let result = Ladder.formatLadderScorecard(s, true, "grader")
  assertionTrue(~operator="PASS", stringContains(result, "verdict=PASS"))
  assertionTrue(~operator="tier", stringContains(result, "final_tier=medium"))
  assertionTrue(~operator="attempts", stringContains(result, "attempts=2"))
  assertionTrue(~operator="escalations", stringContains(result, "escalations=1"))
  assertionTrue(~operator="cost", stringContains(result, "cost=8"))
  assertionTrue(~operator="method", stringContains(result, "method=grader"))
})

test("formatLadderScorecard: accepted=false => verdict=UNMET", () => {
  let s = makeState()
  let result = Ladder.formatLadderScorecard(s, false, "heuristic")
  assertionTrue(~operator="UNMET", stringContains(result, "verdict=UNMET"))
  assertionFalse(~operator="noPASS", stringContains(result, "verdict=PASS"))
})

// ---------------------------------------------------------------------------
// Integration scenarios (edge cases)
// ---------------------------------------------------------------------------

test("edge: FAIL at heavy with no retries left => give_up no higher tier", () => {
  let p = makePolicy(~maxAttemptsPerTier=1, ~maxTotalAttempts=10, ())
  let s = makeState(~currentTier="heavy", ~totalAttempts=1, ~attemptsThisTier=1, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="giveUp", a.action, #give_up)
  assertionEqual(
    ~operator="reason",
    a.reason->Nullable.toOption,
    Some("no higher tier (already at top of ladder)"),
  )
})

test("edge: maxTotalAttempts mid-ladder => give_up max total attempts", () => {
  let p = makePolicy(~maxTotalAttempts=2, ~maxAttemptsPerTier=5, ())
  let s = makeState(~currentTier="medium", ~totalAttempts=2, ~attemptsThisTier=0, ())
  let a = Ladder.nextAction(
    s,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="giveUp", a.action, #give_up)
  switch a.reason->Nullable.toOption {
  | Some(r) => assertionTrue(~operator="reason", stringContains(r, "max total attempts (2)"))
  | None => assertionTrue(~operator="reason", false)
  }
})

test("edge: retry then PASS => accept on second call", () => {
  let p = makePolicy(~maxAttemptsPerTier=2, ~maxTotalAttempts=10, ())
  let s = makeState()
  let s2 = Ladder.recordAttempt(s, ~costUnits=1)
  let a1 = Ladder.nextAction(
    s2,
    Nullable.make(({pass: false, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="retry1", a1.action, #retry)
  let s3 = Ladder.advance(s2, a1)
  let s4 = Ladder.recordAttempt(s3, ~costUnits=1)
  let a2 = Ladder.nextAction(
    s4,
    Nullable.make(({pass: true, reasons: None}: Ladder.ladderVerdict)),
    p,
    None,
  )
  assertionEqual(~operator="accept2", a2.action, #accept)
})

test("edge: floorTier heavy with producer fast => starts at heavy", () => {
  let p = makePolicy(~floorTier=Nullable.make("heavy"), ())
  let s = Ladder.newLadderState("fast", p)
  assertionEqual(~operator="startsHeavy", s.currentTier, "heavy")
})

test("edge: producer below floor => starts at floor", () => {
  let p = makePolicy(~floorTier=Nullable.make("medium"), ())
  let s = Ladder.newLadderState("fast", p)
  assertionEqual(~operator="startsFloor", s.currentTier, "medium")
})

test("edge: unknown producer not in ladder => starts at ladder[0]", () => {
  let p = makePolicy(~floorTier=Nullable.null, ())
  let s = Ladder.newLadderState("turbo", p)
  assertionEqual(~operator="startsLadder0", s.currentTier, "fast")
})
