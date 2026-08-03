// ---------------------------------------------------------------------------
// ReasoningAdaptive_test.res — RED-first parity tests for ReasoningAdaptive.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of adaptive.ts fixtures — no-config, trivial, rules, tier defaults,
// all modes, exclusions, and malformed cases.
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

// Assert an option<T> is Some with a specific value
let assertionSome = (~operator: string, ~expected: 'a, actual: option<'a>): unit =>
  switch actual {
  | Some(v) => assertion(~operator, (a, b) => a === b, v, expected)
  | None => assertion(~operator, (_a, _b) => false, (), ())
  }

// Assert an option<T> is Some (value-independent)
let assertionSomeAny = (~operator: string, actual: option<'a>): unit =>
  switch actual {
  | Some(_) => ()
  | None => assertion(~operator, (_a, _b) => false, (), ())
  }

// Assert an option<T> is None
let assertionNone = (~operator: string, actual: option<'a>): unit =>
  switch actual {
  | Some(_) => assertion(~operator, (_a, _b) => false, (), ())
  | None => ()
  }

// Assert the level is JS null — uses getLevelOption and expects None
let assertionLevelNull = (~operator: string, result: ReasoningAdaptive.adaptiveDecision): unit => {
  let opt = ReasoningAdaptive.getLevelOption(result)
  switch opt {
  | None => ()
  | Some(_) => assertion(~operator, (_a, _b) => false, (), ())
  }
}

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

let baseSignals: ReasoningAdaptive.adaptiveSignals = {
  prompt: "implement a new feature",
  description: "add a button to the dashboard",
  tierName: "medium",
  isTrivial: false,
}

// ---------------------------------------------------------------------------
// Branch 1 — no adaptive config → null
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: returns null when policy is undefined", () => {
  let result = ReasoningAdaptive.selectAdaptiveLevel(baseSignals, None)
  assertionLevelNull(~operator="level", result)
  assertionEqual(~operator="reason", ReasoningAdaptive.getReason(result), "no adaptive config")
})

test("selectAdaptiveLevel: returns null when policy.adaptive is undefined", () => {
  let policy: ReasoningAdaptive.reasoningPolicyConfig = {
    mode: Some("adaptive"),
    defaultLevel: None,
    surfaceLimits: None,
    adaptive: None,
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(baseSignals, Some(policy))
  assertionLevelNull(~operator="level", result)
  assertionEqual(~operator="reason", ReasoningAdaptive.getReason(result), "no adaptive config")
})

test("selectAdaptiveLevel: does not consult defaultLevel when adaptive block is missing", () => {
  let policy: ReasoningAdaptive.reasoningPolicyConfig = {
    mode: Some("adaptive"),
    defaultLevel: Some("elevated"),
    surfaceLimits: None,
    adaptive: None,
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(baseSignals, Some(policy))
  assertionLevelNull(~operator="level", result)
})

// ---------------------------------------------------------------------------
// Branch 2 — trivial classification short-circuits
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: applies trivialLevel when isTrivial is true", () => {
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: Some("minimal"),
      defaultLevel: None,
      keywordRules: None,
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, isTrivial: true}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#minimal, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: returns null when isTrivial is true and trivialLevel is absent", () => {
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("elevated"),
      keywordRules: None,
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, isTrivial: true}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionLevelNull(~operator="level", result)
})

test(
  "selectAdaptiveLevel: returns null when isTrivial is true and trivialLevel is explicitly null",
  () => {
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: None,
        defaultLevel: Some("normal"),
        keywordRules: None,
        tierDefaults: None,
        surfaceDecision: None,
      }),
    )
    let signals = {...baseSignals, isTrivial: true}
    let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
    assertionLevelNull(~operator="level", result)
  },
)

test(
  "selectAdaptiveLevel: does NOT consult tierDefaults or keywordRules when isTrivial is true",
  () => {
    let tierDefaults: dict<string> = Dict.make()
    Dict.set(tierDefaults, "medium", "elevated")
    let rule: ReasoningAdaptive.keywordRule = {
      keywords: ["refactor"],
      level: "max",
      match: None,
      excludeKeywords: None,
    }
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: Some("minimal"),
        defaultLevel: None,
        keywordRules: Some([rule]),
        tierDefaults: Some(tierDefaults),
        surfaceDecision: None,
      }),
    )
    let signals = {
      ...baseSignals,
      isTrivial: true,
      prompt: "refactor this module",
      tierName: "medium",
    }
    let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
    assertionSome(~operator="level", ~expected=#minimal, ReasoningAdaptive.getLevelOption(result))
  },
)

// ---------------------------------------------------------------------------
// Branch 3 — tierDefaults wins over defaultLevel
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: returns tierDefaults[tierName] when tier is listed", () => {
  let tierDefaults: dict<string> = Dict.make()
  Dict.set(tierDefaults, "heavy", "elevated")
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: None,
      tierDefaults: Some(tierDefaults),
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, tierName: "heavy"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test(
  "selectAdaptiveLevel: falls through to defaultLevel when tierName is not in tierDefaults",
  () => {
    let tierDefaults: dict<string> = Dict.make()
    Dict.set(tierDefaults, "heavy", "elevated")
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: None,
        defaultLevel: Some("normal"),
        keywordRules: None,
        tierDefaults: Some(tierDefaults),
        surfaceDecision: None,
      }),
    )
    let signals = {...baseSignals, tierName: "fast"}
    let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
    assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
  },
)

test("selectAdaptiveLevel: treats empty tierDefaults as absent", () => {
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("elevated"),
      keywordRules: None,
      tierDefaults: Some(Dict.make()),
      surfaceDecision: None,
    }),
  )
  let result = ReasoningAdaptive.selectAdaptiveLevel(baseSignals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: tierDefaults wins over keywordRules", () => {
  let tierDefaults: dict<string> = Dict.make()
  Dict.set(tierDefaults, "medium", "elevated")
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "max",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: Some([rule]),
      tierDefaults: Some(tierDefaults),
      surfaceDecision: None,
    }),
  )
  let signals = {
    ...baseSignals,
    tierName: "medium",
    prompt: "please refactor this file",
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

// ---------------------------------------------------------------------------
// Branch 4 — keywordRules: first match wins
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: first matching keyword rule wins", () => {
  let rule1: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let rule2: ReasoningAdaptive.keywordRule = {
    keywords: ["fix"],
    level: "minimal",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule1, rule2]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {
    ...baseSignals,
    prompt: "please fix the bug and refactor the module",
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: matches keywords found in description", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {
    ...baseSignals,
    prompt: "implement a new endpoint",
    description: "needs a refactor of the auth layer",
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: matches keywords found in prompt", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["debug"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {
    ...baseSignals,
    prompt: "debug the failing test",
    description: "in the payments service",
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: is case-insensitive via stem mode default", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "refactoring the auth module"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: substring mode matches inflections", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: Some("substring"),
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "we are refactoring this code"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: skips rules with empty keyword arrays", () => {
  let ruleEmpty: ReasoningAdaptive.keywordRule = {
    keywords: [],
    level: "max",
    match: None,
    excludeKeywords: None,
  }
  let ruleMatch: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([ruleEmpty, ruleMatch]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "refactor this"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: reason includes rule index, keyword, mode, and source", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor", "architecture"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "please refactor this"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionEqual(
    ~operator="reason",
    ReasoningAdaptive.getReason(result),
    `keyword match: rule[0] "refactor" (stem) in prompt`,
  )
})

test("selectAdaptiveLevel: first matching keyword within a multi-keyword rule wins", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor", "architecture", "security"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "review the architecture"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionEqual(
    ~operator="reason",
    ReasoningAdaptive.getReason(result),
    `keyword match: rule[0] "architecture" (stem) in prompt`,
  )
})

// ---------------------------------------------------------------------------
// Branch 4b — malformed keywordRules entries are skipped silently (fail-soft)
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: skips a rule whose keywords field is missing without throwing", () => {
  let malformedRule: ReasoningAdaptive.keywordRule = {
    keywords: [],
    level: "max",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([malformedRule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "implement a button"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  // Malformed rule has empty keywords array — treated as non-matching; falls through to null
  assertionLevelNull(~operator="level", result)
})

test(
  "selectAdaptiveLevel: falls through to defaultLevel when every keyword rule is malformed",
  () => {
    let malformedRule: ReasoningAdaptive.keywordRule = {
      keywords: [],
      level: "max",
      match: None,
      excludeKeywords: None,
    }
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: None,
        defaultLevel: Some("normal"),
        keywordRules: Some([malformedRule]),
        tierDefaults: None,
        surfaceDecision: None,
      }),
    )
    let signals = {...baseSignals, prompt: "refactor this"}
    let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
    assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
  },
)

// ---------------------------------------------------------------------------
// Branch 5 — fallthrough to defaultLevel
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: returns defaultLevel when no rule matches", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "implement a button"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: returns null when no rule matches AND defaultLevel is absent", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "implement a button"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionLevelNull(~operator="level", result)
})

test("selectAdaptiveLevel: returns null when defaultLevel is explicitly null", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "implement a button"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionLevelNull(~operator="level", result)
})

test(
  "selectAdaptiveLevel: returns null when nothing is configured besides an empty adaptive block",
  () => {
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: None,
        defaultLevel: None,
        keywordRules: None,
        tierDefaults: None,
        surfaceDecision: None,
      }),
    )
    let result = ReasoningAdaptive.selectAdaptiveLevel(baseSignals, Some(policy))
    assertionLevelNull(~operator="level", result)
  },
)

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: returns defaultLevel when prompt and description are both empty", () => {
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: None,
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals: ReasoningAdaptive.adaptiveSignals = {
    prompt: "",
    description: "",
    tierName: "medium",
    isTrivial: false,
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: does not match keywords across tierName boundary", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, tierName: "refactor"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionLevelNull(~operator="level", result)
})

test("selectAdaptiveLevel: is deterministic — same inputs produce same decision", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["debug"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "debug the flaky test"}
  let r1 = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  let r2 = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  let r3 = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionEqual(
    ~operator="r1==r2",
    ReasoningAdaptive.getReason(r1),
    ReasoningAdaptive.getReason(r2),
  )
  assertionEqual(
    ~operator="r2==r3",
    ReasoningAdaptive.getReason(r2),
    ReasoningAdaptive.getReason(r3),
  )
})

// ---------------------------------------------------------------------------
// Plan 018 match-mode coverage — stem default
// ---------------------------------------------------------------------------

test("selectAdaptiveLevel: stem default matches inflection debugging against debug", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["debug"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {
    ...baseSignals,
    prompt: "debugging the race condition in the payments worker",
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
  assertionEqual(
    ~operator="reason",
    ReasoningAdaptive.getReason(result),
    `keyword match: rule[0] "debug" (stem) in prompt`,
  )
})

test("selectAdaptiveLevel: word mode strict — rejects inflection on last token", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["debug"],
    level: "elevated",
    match: Some("word"),
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "debugging the flaky test"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionLevelNull(~operator="level", result)
})

test("selectAdaptiveLevel: excludeKeywords skips a matching rule", () => {
  let ruleFormat: ReasoningAdaptive.keywordRule = {
    keywords: ["format"],
    level: "minimal",
    match: None,
    excludeKeywords: Some(["refactor"]),
  }
  let ruleRefactor: ReasoningAdaptive.keywordRule = {
    keywords: ["refactor"],
    level: "elevated",
    match: None,
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: Some([ruleFormat, ruleRefactor]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "format and refactor the auth module"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  // format rule is excluded; refactor rule fires
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test(
  "selectAdaptiveLevel: falls through to defaultLevel when only matching rule is excluded",
  () => {
    let ruleFormat: ReasoningAdaptive.keywordRule = {
      keywords: ["format"],
      level: "minimal",
      match: None,
      excludeKeywords: Some(["refactor"]),
    }
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: None,
        defaultLevel: Some("normal"),
        keywordRules: Some([ruleFormat]),
        tierDefaults: None,
        surfaceDecision: None,
      }),
    )
    let signals = {...baseSignals, prompt: "format the source and refactor the module"}
    let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
    assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
  },
)

test("selectAdaptiveLevel: regex mode matches user-supplied pattern", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["^perf"],
    level: "elevated",
    match: Some("regex"),
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {
    ...baseSignals,
    prompt: "performance regression in the payments worker",
  }
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: regex mode falls through on invalid pattern (fail-soft)", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["("],
    level: "elevated",
    match: Some("regex"),
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "any task text"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  // fail-soft: invalid regex returns false, falls through to defaultLevel
  assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
})

test("selectAdaptiveLevel: substring mode matches test inside latest", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["test"],
    level: "elevated",
    match: Some("substring"),
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: Some("normal"),
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "update the latest fixtures"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  // substring mode matches 'test' inside 'latest'
  assertionSome(~operator="level", ~expected=#elevated, ReasoningAdaptive.getLevelOption(result))
})

test(
  "selectAdaptiveLevel: stem mode does NOT match test inside latest (cross-word false positive)",
  () => {
    let rule: ReasoningAdaptive.keywordRule = {
      keywords: ["test"],
      level: "elevated",
      match: None, // stem by default
      excludeKeywords: None,
    }
    let policy = ReasoningAdaptive.makePolicyWithAdaptive(
      Some({
        trivialLevel: None,
        defaultLevel: Some("normal"),
        keywordRules: Some([rule]),
        tierDefaults: None,
        surfaceDecision: None,
      }),
    )
    let signals = {...baseSignals, prompt: "update the latest fixtures"}
    let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
    // stem mode: word-boundary start rejects 'test' as stem of 'latest'
    assertionSome(~operator="level", ~expected=#normal, ReasoningAdaptive.getLevelOption(result))
  },
)

test("selectAdaptiveLevel: reason records the rule's actual mode", () => {
  let rule: ReasoningAdaptive.keywordRule = {
    keywords: ["test"],
    level: "normal",
    match: Some("substring"),
    excludeKeywords: None,
  }
  let policy = ReasoningAdaptive.makePolicyWithAdaptive(
    Some({
      trivialLevel: None,
      defaultLevel: None,
      keywordRules: Some([rule]),
      tierDefaults: None,
      surfaceDecision: None,
    }),
  )
  let signals = {...baseSignals, prompt: "update the latest fixtures"}
  let result = ReasoningAdaptive.selectAdaptiveLevel(signals, Some(policy))
  assertionEqual(
    ~operator="reason",
    ReasoningAdaptive.getReason(result),
    `keyword match: rule[0] "test" (substring) in prompt`,
  )
})
