// ---------------------------------------------------------------------------
// TierLadder_test.res — RED-first parity tests for TierLadder
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let arrayEqual = (a: array<string>, b: array<string>): unit =>
  assertion(~operator="arrayEqual", (a, b) => Belt.Array.eq(a, b, (x, y) => x === y), a, b)

let notSameRef = (a: array<string>, b: array<string>): unit =>
  assertion(~operator="notSameRef", (a, b) => a !== b, a, b)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/* makeCfg builds a Config.t from tier definitions.
   Each tier is a (name, model, costRatio) tuple.
   An optional explicit ladder array can be passed as 3rd parameter. */
let makeCfg = (
  tiers: array<(string, string, option<float>)>,
  explicitLadder: option<array<string>>,
): Config.t => {
  let tiersJson =
    tiers
    ->Array.map(((name, model, costRatio)) => {
      let costPart = switch costRatio {
      | Some(r) => `,"costRatio":${Float.toString(r)}`
      | None => ""
      }
      `    "${name}":{"model":"${model}","description":"","whenToUse":[]${costPart}}`
    })
    ->Array.joinUnsafe(",\n")

  let ladderJson = switch explicitLadder {
  | Some(arr) => {
      let items = arr->Array.map(s => `"${s}"`)->Array.joinUnsafe(",")
      `,"enforcement":{"escalate":{"ladder":[${items}]}}`
    }
  | None => ""
  }

  let jsonStr = `{
  "activePreset": "default",
  "presets": {"default": {
${tiersJson}
  }},
  "rules": [],
  "defaultTier": "medium"${ladderJson}
}`

  switch Config.parse(JSON.parseOrThrow(jsonStr)) {
  | Some(cfg) => cfg
  | None => JsError.throwWithMessage("makeCfg: failed to parse constructed JSON")
  }
}

// ---------------------------------------------------------------------------
// RED — explicit ladder precedence (3 fixtures)
// ---------------------------------------------------------------------------

test("explicit enforcement.escalate.ladder is returned unchanged", () => {
  let cfg = makeCfg([("fast", "a/f", None)], Some(["medium", "heavy"]))
  let result = TierLadder.resolveLadder(cfg)
  arrayEqual(result, ["medium", "heavy"])
})

test("explicit ladder is copied (not the same array reference)", () => {
  let cfg = makeCfg([("fast", "a/f", None)], Some(["medium", "heavy"]))
  let result = TierLadder.resolveLadder(cfg)
  notSameRef(result, ["medium", "heavy"])
  arrayEqual(result, ["medium", "heavy"])
})

test("explicit ladder wins over preset costRatio ordering", () => {
  let cfg = makeCfg(
    [("fast", "a/f", Some(1.0)), ("medium", "a/m", Some(5.0)), ("heavy", "a/h", Some(20.0))],
    Some(["heavy", "fast"]),
  )
  arrayEqual(TierLadder.resolveLadder(cfg), ["heavy", "fast"])
})

// ---------------------------------------------------------------------------
// RED — costRatio sort fallback (3 fixtures)
// ---------------------------------------------------------------------------

test("preset tiers sorted by costRatio ascending", () => {
  let cfg = makeCfg(
    [
      ("fast", "a/f", Some(1.0)),
      ("light", "a/l", Some(2.0)),
      ("medium", "a/m", Some(5.0)),
      ("focused", "a/fc", Some(10.0)),
      ("heavy", "a/h", Some(20.0)),
    ],
    None,
  )
  arrayEqual(TierLadder.resolveLadder(cfg), ["fast", "light", "medium", "focused", "heavy"])
})

test("missing costRatio sorts to end (stable insertion order tie-break)", () => {
  let cfg = makeCfg(
    [("alpha", "a/a", None), ("beta", "a/b", Some(1.0)), ("gamma", "a/g", None)],
    None,
  )
  // beta has costRatio=1, so it comes first; alpha and gamma have no costRatio, insertion order preserved
  arrayEqual(TierLadder.resolveLadder(cfg), ["beta", "alpha", "gamma"])
})

test("equal costRatio preserves insertion order (stable sort)", () => {
  let cfg = makeCfg(
    [("first", "a/f", Some(5.0)), ("second", "a/s", Some(5.0)), ("third", "a/t", Some(5.0))],
    None,
  )
  // Stable sort: insertion order preserved for equal costRatio
  arrayEqual(TierLadder.resolveLadder(cfg), ["first", "second", "third"])
})

// ---------------------------------------------------------------------------
// RED — default filtered to present tiers (4 fixtures)
// ---------------------------------------------------------------------------

test("three-tier preset returns exactly three rungs", () => {
  let cfg = makeCfg(
    [("fast", "a/f", Some(1.0)), ("medium", "a/m", Some(5.0)), ("heavy", "a/h", Some(20.0))],
    None,
  )
  arrayEqual(TierLadder.resolveLadder(cfg), ["fast", "medium", "heavy"])
})

test("two-tier preset returns exactly two rungs", () => {
  let cfg = makeCfg([("fast", "a/f", Some(1.0)), ("heavy", "a/h", Some(20.0))], None)
  arrayEqual(TierLadder.resolveLadder(cfg), ["fast", "heavy"])
})

test("single-tier preset returns exactly one rung", () => {
  let cfg = makeCfg([("heavy", "a/h", Some(20.0))], None)
  arrayEqual(TierLadder.resolveLadder(cfg), ["heavy"])
})

test("preset with no costRatio returns present tiers in insertion order", () => {
  let cfg = makeCfg([("zebra", "a/z", None), ("alpha", "a/a", None)], None)
  arrayEqual(TierLadder.resolveLadder(cfg), ["zebra", "alpha"])
})

// ---------------------------------------------------------------------------
// RED — immutability (3 fixtures)
// ---------------------------------------------------------------------------

test("does not mutate the input cfg", () => {
  let cfg = makeCfg([("fast", "a/f", Some(1.0)), ("medium", "a/m", Some(5.0))], Some(["medium"]))
  let ladderBefore = cfg.enforcement
  TierLadder.resolveLadder(cfg)->ignore
  assertion(
    ~operator="cfgNotMutated",
    (before, after) => before === after,
    ladderBefore,
    cfg.enforcement,
  )
})

test("does not mutate the explicit ladder array", () => {
  let cfg = makeCfg([("fast", "a/f", None)], Some(["medium", "heavy"]))
  let getLadder = (cfg: Config.t): array<string> =>
    switch cfg.enforcement {
    | Some(e) =>
      switch e.escalate {
      | Some(esc) =>
        switch esc.ladder {
        | Some(l) => l
        | None => []
        }
      | None => []
      }
    | None => []
    }
  let cfgLadderBefore = getLadder(cfg)
  TierLadder.resolveLadder(cfg)->ignore
  let cfgLadderAfter = getLadder(cfg)
  assertion(
    ~operator="ladderNotMutated",
    (before, after) => Belt.Array.eq(before, after, (x, y) => x === y),
    cfgLadderBefore,
    cfgLadderAfter,
  )
})

test("returns a fresh array on every call", () => {
  let cfg = makeCfg([("fast", "a/f", Some(1.0)), ("medium", "a/m", Some(5.0))], None)
  let r1 = TierLadder.resolveLadder(cfg)
  let r2 = TierLadder.resolveLadder(cfg)
  notSameRef(r1, r2)
  arrayEqual(r1, r2)
})

// ---------------------------------------------------------------------------
// RED — backward-compatible three-tier (2 fixtures)
// ---------------------------------------------------------------------------

test("custom three-tier preset resolves to 3 rungs with no extra tiers", () => {
  let cfg = makeCfg(
    [("turbo", "a/t", Some(15.0)), ("fast", "a/f", Some(1.0)), ("heavy", "a/h", Some(20.0))],
    None,
  )
  let result = TierLadder.resolveLadder(cfg)
  assertion(~operator="length3", (r, _) => r == 3, result->Array.length, 3)
  arrayEqual(result, ["fast", "turbo", "heavy"])
})

test("enforcement absent returns preset tiers sorted by costRatio", () => {
  let cfg = makeCfg([("fast", "a/f", Some(3.0)), ("heavy", "a/h", Some(1.0))], None)
  arrayEqual(TierLadder.resolveLadder(cfg), ["heavy", "fast"])
})

// ---------------------------------------------------------------------------
// RED — skipTiers compatibility (1 fixture)
// ---------------------------------------------------------------------------

test("returns all tiers when skipTiers is not set", () => {
  let cfg = makeCfg(
    [("fast", "a/f", Some(1.0)), ("medium", "a/m", Some(5.0)), ("heavy", "a/h", Some(20.0))],
    None,
  )
  arrayEqual(TierLadder.resolveLadder(cfg), ["fast", "medium", "heavy"])
})
