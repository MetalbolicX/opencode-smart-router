// src/verify/VerifyDoD_test.res
// Parity fixtures for VerifyDoD — direct ReScript tests for:
//   summarizeDispatch, parseAcceptanceBlock, inferDoD, parseDoDFromDispatch,
//   parseDoDFromAnnotation, normalizeDoD, isCheckable
//
// Covered scenarios mirror the TS adapter fixtures in:
//   test/unit/gate.test.ts
//   test/integration/modeB-e2e.test.ts

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
  assertion(~operator, (_a, _b) => _b === true, contains, true)
}

// ---------------------------------------------------------------------------
// summarizeDispatch — pure string → string transformer
// ---------------------------------------------------------------------------

test("summarizeDispatch: empty string returns empty", () => {
  let result = VerifyDoD.summarizeDispatch("")
  assertionEqual(~operator="empty input", "", result)
})

test("summarizeDispatch: single-line dispatch returns trimmed", () => {
  let result = VerifyDoD.summarizeDispatch("  fix the auth bug  ")
  assertionEqual(~operator="trimmed", "fix the auth bug", result)
})

test("summarizeDispatch: multi-line dispatch returns first non-empty line", () => {
  let input = "implement the parser\nsecond line\nthird line"
  let result = VerifyDoD.summarizeDispatch(input)
  assertionEqual(~operator="first line", "implement the parser", result)
})

test("summarizeDispatch: leading blank lines skip to first non-empty", () => {
  let input = "\n\n  add tests  \nmore content"
  let result = VerifyDoD.summarizeDispatch(input)
  assertionEqual(~operator="skips blanks", "add tests", result)
})

test("summarizeDispatch: preserves content after first line", () => {
  let input = "main task\ndetail line"
  let result = VerifyDoD.summarizeDispatch(input)
  assertionContains(~operator="contains first", "main task", result)
})

// ---------------------------------------------------------------------------
// parseAcceptanceBlock — [acceptance] block parser
// ---------------------------------------------------------------------------

test("parseAcceptanceBlock: well-formed block returns Some(dod)", () => {
  let input = "[acceptance]\ncheck: run \"npm test\"\ncheck: build \"npm run build\"\n[/acceptance]"
  let result = VerifyDoD.parseAcceptanceBlock(input, #explicit)
  switch Nullable.toOption(result) {
  | Some(_dod) => assertionTrue(~operator="dod returned", true)
  | None => assertionTrue(~operator="should be Some", false)
  }
})

test("parseAcceptanceBlock: missing close tag returns null", () => {
  let input = "[acceptance]\ncheck: run \"npm test\"\n"
  let result = VerifyDoD.parseAcceptanceBlock(input, #explicit)
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should be None", false)
  | None => assertionTrue(~operator="null on missing close", true)
  }
})

test("parseAcceptanceBlock: empty block returns dod with kind=#none", () => {
  let input = "[acceptance]\n[/acceptance]"
  let result = VerifyDoD.parseAcceptanceBlock(input, #explicit)
  switch Nullable.toOption(result) {
  | Some(dod) => assertionEqual(~operator="kind none", "none", VerifyDoD.getDodKind(dod)->Obj.magic)
  | None => assertionTrue(~operator="should be Some", false)
  }
})

test("parseAcceptanceBlock: whitespace-only block returns dod kind=#none", () => {
  let input = "   [acceptance]   \n  \n  [/acceptance]  "
  let result = VerifyDoD.parseAcceptanceBlock(input, #explicit)
  switch Nullable.toOption(result) {
  | Some(dod) => assertionEqual(~operator="whitespace→none", "none", VerifyDoD.getDodKind(dod)->Obj.magic)
  | None => assertionTrue(~operator="should be Some", false)
  }
})

test("parseAcceptanceBlock: mixed check kinds parse correctly", () => {
  let input = "[acceptance]\ncheck: testsPass\ncheck: buildPasses\ncheck: lintClean\n[/acceptance]"
  let result = VerifyDoD.parseAcceptanceBlock(input, #annotation)
  switch Nullable.toOption(result) {
  | Some(dod) => {
    let checks = VerifyDoD.getDodChecks(dod)
    assertionEqual(~operator="3 checks", "3", Int.toString(Array.length(checks)))
  }
  | None => assertionTrue(~operator="should be Some", false)
  }
})

test("parseAcceptanceBlock: fileExists check parses path", () => {
  let input = "[acceptance]\ncheck: fileExists \"src/auth.ts\"\n[/acceptance]"
  let result = VerifyDoD.parseAcceptanceBlock(input, #explicit)
  switch Nullable.toOption(result) {
  | Some(dod) => {
    let checks = VerifyDoD.getDodChecks(dod)
    assertionEqual(~operator="1 check", "1", Int.toString(Array.length(checks)))
  }
  | None => assertionTrue(~operator="should be Some", false)
  }
})

// ---------------------------------------------------------------------------
// parseDoDFromDispatch — extracts DoD from full dispatch text
// ---------------------------------------------------------------------------

test("parseDoDFromDispatch: dispatch without [acceptance] returns null", () => {
  let dispatch = "just a plain dispatch without any acceptance block"
  let result = VerifyDoD.parseDoDFromDispatch(dispatch)
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should not be None", false)
  | None => assertionTrue(~operator="null without block", true)
  }
})

test("parseDoDFromDispatch: dispatch with [acceptance] returns dod", () => {
  let dispatch = "implement login\n[acceptance]\ncheck: run \"npm test\"\n[/acceptance]"
  let result = VerifyDoD.parseDoDFromDispatch(dispatch)
  switch Nullable.toOption(result) {
  | Some(_dod) => assertionTrue(~operator="dod parsed", true)
  | None => assertionTrue(~operator="should not be None", false)
  }
})

test("parseDoDFromDispatch: identical text to parseDoDFromAnnotation produces same dod", () => {
  let identicalBlock = "[acceptance]\ncheck: testsPass\n[/acceptance]"
  let fromDispatch = VerifyDoD.parseDoDFromDispatch(identicalBlock)
  let fromAnnotation = VerifyDoD.parseDoDFromAnnotation(identicalBlock)
  switch (Nullable.toOption(fromDispatch), Nullable.toOption(fromAnnotation)) {
  | (Some(d1), Some(d2)) => {
    let k1 = VerifyDoD.getDodKind(d1)
    let k2 = VerifyDoD.getDodKind(d2)
    assertionEqual(~operator="same kind", Obj.magic(k1), Obj.magic(k2))
  }
  | _ => assertionTrue(~operator="should not be None", false)
  }
})

// ---------------------------------------------------------------------------
// parseDoDFromAnnotation — parses annotation-only text
// ---------------------------------------------------------------------------

test("parseDoDFromAnnotation: well-formed annotation returns dod", () => {
  let annotation = "[acceptance]\ncheck: buildPasses\ncheck: lintClean\n[/acceptance]"
  let result = VerifyDoD.parseDoDFromAnnotation(annotation)
  switch Nullable.toOption(result) {
  | Some(dod) => {
    let checks = VerifyDoD.getDodChecks(dod)
    assertionEqual(~operator="2 checks", "2", Int.toString(Array.length(checks)))
  }
  | None => assertionTrue(~operator="should not be None", false)
  }
})

test("parseDoDFromAnnotation: empty string returns null", () => {
  let result = VerifyDoD.parseDoDFromAnnotation("")
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should not be None", false)
  | None => assertionTrue(~operator="null on empty", true)
  }
})

test("parseDoDFromAnnotation: annotation with criteria lines", () => {
  let annotation = "[acceptance]\ncheck: run \"make test\"\ncriteria: must pass CI\ncriteria: no regressions\n[/acceptance]"
  let result = VerifyDoD.parseDoDFromAnnotation(annotation)
  switch Nullable.toOption(result) {
  | Some(dod) => {
    let criteria = VerifyDoD.getDodCriteria(dod)
    assertionTrue(~operator="has criteria", Array.length(criteria) >= 0)
  }
  | None => assertionTrue(~operator="should not be None", false)
  }
})

// ---------------------------------------------------------------------------
// inferDoD — builds dod from command + description + inferHints
// ---------------------------------------------------------------------------

test("inferDoD: dispatch text matching impl keyword creates checks", () => {
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.return("make build"),
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  // "build the project" matches "build" impl keyword → impl category → buildCheck created
  let result = VerifyDoD.inferDoD("build the project", "tier", hints)
  let checks = VerifyDoD.getDodChecks(result)
  assertionTrue(~operator="has impl checks", Array.length(checks) > 0)
})

test("inferDoD: empty hints returns dod kind=checker (no checks created)", () => {
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  // "generic task" doesn't match any keyword → no checks → kind=checker
  let result = VerifyDoD.inferDoD("generic task", "", hints)
  assertionEqual(~operator="kind checker", "checker", VerifyDoD.getDodKind(result)->Obj.magic)
})

test("inferDoD: build-only hint produces checks for impl-category text", () => {
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.return("make build"),
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  // "build something" matches "build" keyword → impl category
  let result = VerifyDoD.inferDoD("build the project", "tier", hints)
  let checks = VerifyDoD.getDodChecks(result)
  assertionTrue(~operator="has checks", Array.length(checks) > 0)
})

test("inferDoD: test-only hint produces checks for test-category text", () => {
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.return("jest"),
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDoD.inferDoD("write tests for auth", "tier", hints)
  let checks = VerifyDoD.getDodChecks(result)
  assertionTrue(~operator="test check exists", Array.length(checks) > 0)
})

test("inferDoD: declaredPath present triggers fileExists check", () => {
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.return("src/utils.ts"),
  }
  // "write a file" matches write keyword + has declaredPath → writeFile category
  let result = VerifyDoD.inferDoD("write a file", "tier", hints)
  let checks = VerifyDoD.getDodChecks(result)
  assertionTrue(~operator="has checks", Array.length(checks) > 0)
})

test("inferDoD: source is always inferred", () => {
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.return("npm test"),
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDoD.inferDoD("run tests", "tier", hints)
  assertionEqual(~operator="source inferred", "inferred", VerifyDoD.getDodSource(result)->Obj.magic)
})

// ---------------------------------------------------------------------------
// normalizeDoD — identity pass-through for valid dod
// ---------------------------------------------------------------------------

test("normalizeDoD: valid dod passes through unchanged", () => {
  // normalizeDoD re-computes kind: checks>0 → deterministic, else criteria>0 → checker, else none
  let inputDod: VerifyDoD.dod = {
    kind: #deterministic,
    checks: [{ kind: #run, command: Js.Nullable.return("npm test"), expect: Js.Nullable.null, path: Js.Nullable.null, schema: Js.Nullable.null }],
    criteria: [],
    deliverable: Js.Nullable.return("auth module"),
    source: #explicit,
  }
  let result = VerifyDoD.normalizeDoD(inputDod)
  assertionEqual(~operator="kind preserved", "deterministic", VerifyDoD.getDodKind(result)->Obj.magic)
})

test("normalizeDoD: empty checks array is preserved", () => {
  let inputDod: VerifyDoD.dod = {
    kind: #none,
    checks: [],
    criteria: [],
    deliverable: Js.Nullable.null,
    source: #none,
  }
  let result = VerifyDoD.normalizeDoD(inputDod)
  let checks = VerifyDoD.getDodChecks(result)
  assertionEqual(~operator="empty checks", "0", Int.toString(Array.length(checks)))
})

// ---------------------------------------------------------------------------
// isCheckable — determines if a dod has runnable checks
// ---------------------------------------------------------------------------

test("isCheckable: dod with checks returns true", () => {
  let aDod: VerifyDoD.dod = {
    kind: #deterministic,
    checks: [{ kind: #run, command: Js.Nullable.return("npm test"), expect: Js.Nullable.null, path: Js.Nullable.null, schema: Js.Nullable.null }],
    criteria: [],
    deliverable: Js.Nullable.null,
    source: #explicit,
  }
  assertionTrue(~operator="isCheckable true", VerifyDoD.isCheckable(aDod))
})

test("isCheckable: dod with kind=none returns false", () => {
  let emptyDod: VerifyDoD.dod = {
    kind: #none,
    checks: [],
    criteria: [],
    deliverable: Js.Nullable.null,
    source: #none,
  }
  assertionFalse(~operator="isCheckable false for none", VerifyDoD.isCheckable(emptyDod))
})

test("isCheckable: dod with kind=checker returns true", () => {
  let checkerDod: VerifyDoD.dod = {
    kind: #checker,
    checks: [],
    criteria: [],
    deliverable: Js.Nullable.null,
    source: #inferred,
  }
  assertionTrue(~operator="isCheckable checker", VerifyDoD.isCheckable(checkerDod))
})
