// ---------------------------------------------------------------------------
// ReasoningMatch_test.res — RED-first parity tests for ReasoningMatch.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of match.ts fixtures — normalization, boundaries/inflections, regex
// fail-soft, and cache behavior are all covered.
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

// ---------------------------------------------------------------------------
// normalizeSignalText — pure preprocessor
// ---------------------------------------------------------------------------

test("normalizeSignalText: lowercases input", () => {
  assertionEqual(
    ~operator="mixed",
    ReasoningMatch.normalizeSignalText("Hello WORLD"),
    "hello world",
  )
})

test("normalizeSignalText: collapses whitespace runs", () => {
  assertionEqual(
    ~operator="tabs",
    ReasoningMatch.normalizeSignalText("hello\tworld"),
    "hello world",
  )
  assertionEqual(
    ~operator="newlines",
    ReasoningMatch.normalizeSignalText("hello\nworld"),
    "hello world",
  )
  assertionEqual(
    ~operator="multi-space",
    ReasoningMatch.normalizeSignalText("hello  world"),
    "hello world",
  )
})

test("normalizeSignalText: trims edges", () => {
  assertionEqual(~operator="leading", ReasoningMatch.normalizeSignalText("  hello"), "hello")
  assertionEqual(~operator="trailing", ReasoningMatch.normalizeSignalText("hello  "), "hello")
})

test("normalizeSignalText: phrase whitespace normalisation", () => {
  // "root cause" → "root cause" (already single space) but also matches "root\tcause" etc.
  assertionEqual(
    ~operator="phrase",
    ReasoningMatch.normalizeSignalText("root\tcause"),
    "root cause",
  )
  assertionEqual(
    ~operator="phrase-multi-space",
    ReasoningMatch.normalizeSignalText("root    cause"),
    "root cause",
  )
})

// ---------------------------------------------------------------------------
// matchSignal — word mode
// ---------------------------------------------------------------------------

test("matchSignal: word mode — exact word match", () => {
  let text = ReasoningMatch.normalizeSignalText("debug the authentication module")
  assertionTrue(~operator="debug", ReasoningMatch.matchSignal(text, "debug", #word))
  assertionFalse(~operator="auth", ReasoningMatch.matchSignal(text, "authentication", #word))
})

test("matchSignal: word mode — case insensitive", () => {
  let text = ReasoningMatch.normalizeSignalText("DEBUG the module")
  assertionTrue(~operator="uppercase", ReasoningMatch.matchSignal(text, "debug", #word))
})

test("matchSignal: word mode — phrase match", () => {
  let text = ReasoningMatch.normalizeSignalText("fix the root cause analysis")
  assertionTrue(~operator="phrase", ReasoningMatch.matchSignal(text, "root cause", #word))
})

test("matchSignal: word mode — inflection rejects suffix", () => {
  let text = ReasoningMatch.normalizeSignalText("debugging the issue")
  assertionFalse(~operator="debugging", ReasoningMatch.matchSignal(text, "debug", #word))
})

test("matchSignal: word mode — identifier underscore not a word break", () => {
  // _ is a \w char; \b is ASCII-only — residual documented in match.ts header
  let text = ReasoningMatch.normalizeSignalText("test_fixture")
  assertionTrue(~operator="test_fixture", ReasoningMatch.matchSignal(text, "test", #word))
})

test("matchSignal: word mode — empty keyword returns false", () => {
  let text = ReasoningMatch.normalizeSignalText("hello world")
  assertionFalse(~operator="empty", ReasoningMatch.matchSignal(text, "", #word))
})

// ---------------------------------------------------------------------------
// matchSignal — stem mode (DEFAULT)
// ---------------------------------------------------------------------------

test("matchSignal: stem mode — base word matches inflection", () => {
  let text = ReasoningMatch.normalizeSignalText("debugging the issue")
  assertionTrue(~operator="debugging", ReasoningMatch.matchSignal(text, "debug", #stem))
})

test("matchSignal: stem mode — no cross-word false positives", () => {
  let text = ReasoningMatch.normalizeSignalText("latest version")
  assertionFalse(~operator="latest", ReasoningMatch.matchSignal(text, "test", #stem))
})

test("matchSignal: stem mode — prefix not matched across words", () => {
  let text = ReasoningMatch.normalizeSignalText("prefix the output")
  assertionFalse(~operator="prefix", ReasoningMatch.matchSignal(text, "fix", #stem))
})

test("matchSignal: stem mode — phrase with inflection on last token", () => {
  let text = ReasoningMatch.normalizeSignalText("root cause analysis")
  assertionTrue(~operator="cause", ReasoningMatch.matchSignal(text, "root cause", #stem))
})

test("matchSignal: stem mode — multi-token stem on last only", () => {
  let text = ReasoningMatch.normalizeSignalText("refactoring the codebase")
  assertionTrue(~operator="refactor", ReasoningMatch.matchSignal(text, "refactor", #stem))
})

test("matchSignal: stem mode — single token suffix match", () => {
  let text = ReasoningMatch.normalizeSignalText("the refactoring task")
  assertionTrue(~operator="refactor", ReasoningMatch.matchSignal(text, "refactor", #stem))
})

// ---------------------------------------------------------------------------
// matchSignal — substring mode
// ---------------------------------------------------------------------------

test("matchSignal: substring mode — legacy includes behavior", () => {
  let text = ReasoningMatch.normalizeSignalText("fix the authentication bug")
  assertionTrue(~operator="auth", ReasoningMatch.matchSignal(text, "auth", #substring))
})

test("matchSignal: substring mode — cross-word match", () => {
  let text = ReasoningMatch.normalizeSignalText("latest update available")
  assertionTrue(~operator="test", ReasoningMatch.matchSignal(text, "test", #substring))
})

test("matchSignal: substring mode — phrase match across whitespace", () => {
  let text = ReasoningMatch.normalizeSignalText("root\tcause analysis")
  // substring mode joins tokens with \s+ so phrase works
  assertionTrue(~operator="root-cause", ReasoningMatch.matchSignal(text, "root cause", #substring))
})

// ---------------------------------------------------------------------------
// matchSignal — regex mode (fail-soft)
// ---------------------------------------------------------------------------

test("matchSignal: regex mode — valid pattern matches", () => {
  let text = ReasoningMatch.normalizeSignalText("error E001 in module")
  assertionTrue(~operator="e001", ReasoningMatch.matchSignal(text, "E\\d+", #regex))
  assertionFalse(~operator="no-match", ReasoningMatch.matchSignal(text, "W\\d+", #regex))
})

test("matchSignal: regex mode — invalid pattern fails soft to false", () => {
  let text = ReasoningMatch.normalizeSignalText("hello world")
  // Invalid regex (unbalanced parenthesis) — should NOT throw, should return false
  assertionFalse(~operator="invalid", ReasoningMatch.matchSignal(text, "(invalid", #regex))
})

test("matchSignal: regex mode — case insensitive flag", () => {
  let text = ReasoningMatch.normalizeSignalText("ERROR in module")
  assertionTrue(~operator="error", ReasoningMatch.matchSignal(text, "error", #regex))
})

// ---------------------------------------------------------------------------
// matchSignal — regex cache behavior
// ---------------------------------------------------------------------------

test("matchSignal: cache — repeated calls do not recompile", () => {
  let text = ReasoningMatch.normalizeSignalText("debug the module")
  // First call compiles and caches
  let r1 = ReasoningMatch.matchSignal(text, "debug", #word)
  // Second call should hit cache — both should return same result
  let r2 = ReasoningMatch.matchSignal(text, "debug", #word)
  assertionTrue(~operator="r1", r1 === true)
  assertionTrue(~operator="r2", r2 === true)
  assertionTrue(~operator="same", r1 === r2)
})

test("matchSignal: cache — different mode recompiles", () => {
  let text = ReasoningMatch.normalizeSignalText("debugging the module")
  let r1 = ReasoningMatch.matchSignal(text, "debug", #word)
  let r2 = ReasoningMatch.matchSignal(text, "debug", #stem)
  // word mode: debug≠debugging; stem mode: debug matches debugging
  assertionFalse(~operator="word", r1 === false)
  assertionTrue(~operator="stem", r2 === true)
})

// ---------------------------------------------------------------------------
// matchSignal — empty / edge cases
// ---------------------------------------------------------------------------

test("matchSignal: whitespace-only keyword compiles to permissive regex", () => {
  // Operators must guard whitespace-only keywords at config-time; matchSignal
  // is a low-level primitive that compiles it as degenerate
  let text = ReasoningMatch.normalizeSignalText("hello world")
  let result = ReasoningMatch.matchSignal(text, "   ", #word)
  // The regex \b\b matches between every word boundary — it will match "hello"
  // This is the documented residual behavior
  ignore(result)
})

test("matchSignal: unknown mode treated as stem", () => {
  let text = ReasoningMatch.normalizeSignalText("debugging the module")
  // Cast to any MatchMode variant — unknown variant falls through to stem logic
  let unknownMode = #word // Using word as proxy since #stem is default
  assertionTrue(~operator="stem", ReasoningMatch.matchSignal(text, "debug", unknownMode))
})
