// ---------------------------------------------------------------------------
// TierModelGuard_test.res — RED-first parity tests for TierModelGuard
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
// Port of dispatch.test.ts resolveTierModelGuard fixtures.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let resultEqual = (
  res: TierModelGuard.result,
  expected: TierModelGuard.result,
): unit =>
  assertion(
    ~operator="resultEqual",
    (a: TierModelGuard.result, b: TierModelGuard.result) => {
      a.ok === b.ok &&
      (switch (a.ok, b.ok) {
      | (true, true) =>
        switch (a.model, b.model) {
        | (Some(ma), Some(mb)) => ma.providerID === mb.providerID && ma.modelID === mb.modelID
        | _ => false
        }
      | (false, false) => a.reason === b.reason
      | _ => false
      })
    },
    res,
    expected,
  )

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/* makeCfg builds a Config.t directly from tier definitions.
   Each tier is a (name, model) tuple.
   We construct the config directly to bypass Config.parse validation
   (which rejects model strings without a slash), so we can test
   TierModelGuard's own slash-validation independently. */
let makeCfg = (tiers: array<(string, string)>): Config.t => {
  let tiersDict: Config.preset = Js.Dict.empty()
  tiers->Array.forEach(((name, model)) => {
    let tierCfg: Config.tierConfig = {
      model: model,
      variant: None,
      costRatio: None,
      description: "",
      whenToUse: [],
      thinking: None,
      reasoning: None,
      capability: None,
    }
    Js.Dict.set(tiersDict, name, tierCfg)
  })
  let presets: dict<Config.preset> = Js.Dict.empty()
  Js.Dict.set(presets, "p", tiersDict)
  {
    activePreset: "p",
    activeMode: None,
    tierCaps: None,
    tierPrompts: None,
    presets: presets,
    rules: [],
    defaultTier: "fast",
    fallback: None,
    taskPatterns: None,
    modes: None,
    enforcement: None,
    reasoningPolicy: None,
  }
}

// ---------------------------------------------------------------------------
// RED — known tier with well-formed model string
// ---------------------------------------------------------------------------

test("passes through a known tier with a well-formed model string", () => {
  let cfg = makeCfg([(("fast", "anthropic/claude-haiku-4-5"))])
  let result = TierModelGuard.resolveTierModelGuard(cfg, "fast")
  resultEqual(
    result,
    { ok: true, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } },
  )
})

// ---------------------------------------------------------------------------
// RED — unknown tier
// ---------------------------------------------------------------------------

test("fails closed on an unknown tier with the canonical reason", () => {
  let cfg = makeCfg([(("fast", "anthropic/claude-haiku-4-5"))])
  let result = TierModelGuard.resolveTierModelGuard(cfg, "nope")
  resultEqual(
    result,
    { ok: false, reason: "invalid model or provider configuration" },
  )
})

// ---------------------------------------------------------------------------
// RED — tier exists but model string has no slash
// ---------------------------------------------------------------------------

test("fails closed when the tier exists but the model string has no slash", () => {
  // "weird" is configured as "noslash" — tierModel returns null for it.
  let cfg = makeCfg([(("weird", "noslash"))])
  let result = TierModelGuard.resolveTierModelGuard(cfg, "weird")
  resultEqual(
    result,
    { ok: false, reason: "invalid model or provider configuration" },
  )
})

// ---------------------------------------------------------------------------
// RED — tier exists but model string has trailing slash (empty modelID)
// ---------------------------------------------------------------------------

test("fails closed when the model string has a trailing slash", () => {
  // "empty" is configured as "anthropic/" — slash at the end.
  let cfg = makeCfg([(("empty", "anthropic/"))])
  let result = TierModelGuard.resolveTierModelGuard(cfg, "empty")
  resultEqual(
    result,
    { ok: false, reason: "invalid model or provider configuration" },
  )
})

// ---------------------------------------------------------------------------
// RED — canonical reason is identical across all failure modes
// ---------------------------------------------------------------------------

test("returns the same canonical reason regardless of underlying failure mode", () => {
  let cfg = makeCfg([(("weird", "noslash")), (("empty", "anthropic/"))])
  let r1 = TierModelGuard.resolveTierModelGuard(cfg, "nope")
  let r2 = TierModelGuard.resolveTierModelGuard(cfg, "weird")
  let r3 = TierModelGuard.resolveTierModelGuard(cfg, "empty")
  assertion(
    ~operator="r1Fail",
    (a, b) => a === b,
    r1.ok,
    false,
  )
  assertion(
    ~operator="r1Reason",
    (a, b) => a === b,
    r1.reason,
    Some("invalid model or provider configuration"),
  )
  assertion(
    ~operator="r2Fail",
    (a, b) => a === b,
    r2.ok,
    false,
  )
  assertion(
    ~operator="r2Reason",
    (a, b) => a === b,
    r2.reason,
    Some("invalid model or provider configuration"),
  )
  assertion(
    ~operator="r3Fail",
    (a, b) => a === b,
    r3.ok,
    false,
  )
  assertion(
    ~operator="r3Reason",
    (a, b) => a === b,
    r3.reason,
    Some("invalid model or provider configuration"),
  )
})

// ---------------------------------------------------------------------------
// RED — pass-through shape matches tierModel()'s output exactly
// ---------------------------------------------------------------------------

test("is a thin wrapper — pass-through shape matches tierModel output exactly", () => {
  let cfg = makeCfg([(("fast", "anthropic/claude-haiku-4-5"))])
  let result = TierModelGuard.resolveTierModelGuard(cfg, "fast")
  switch result.model {
  | Some({ providerID, modelID }) =>
    assertion(
      ~operator="providerID",
      (a, b) => a === b,
      providerID,
      "anthropic",
    )
    assertion(
      ~operator="modelID",
      (a, b) => a === b,
      modelID,
      "claude-haiku-4-5",
    )
  | None =>
    Js.Exn.raiseError("Expected Ok but got None")
  }
})
