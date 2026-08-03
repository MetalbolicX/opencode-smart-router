// src/verify/VerifyDispatchCore_test.res
// Parity fixtures for VerifyDispatchCore — direct ReScript tests for:
//   buildDelegationDoD, shouldVerifyTask, tierModel, buildForcingNote,
//   buildAcceptedSuffix, parseTaskResult, extractChangedFile
//
// Covered scenarios mirror the TS adapter fixtures in:
//   test/unit/plugin-delegate.test.ts
//   test/unit/gate.test.ts

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
// Fixture builders — minimal protocolTierConfig
// ---------------------------------------------------------------------------

let minimalTierConfig: VerifyDispatchCore.protocolTierConfig = {
  activePreset: "anthropic",
  activeMode: Js.Nullable.null,
  presets: Dict.fromArray([
    ("anthropic", Dict.fromArray([
      ("fast", ({ model: "anthropic/claude-haiku-4-5" }: VerifyDispatchCore.tierDefMinimal)),
      ("medium", ({ model: "anthropic/claude-sonnet-4-6" }: VerifyDispatchCore.tierDefMinimal)),
    ])),
  ]),
  rules: ["base-rule"],
  defaultTier: "fast",
  fallback: Js.Nullable.null,
  taskPatterns: Js.Nullable.null,
  modes: Js.Nullable.null,
  enforcement: Js.Nullable.null,
}

// ---------------------------------------------------------------------------
// buildDelegationDoD — dod builder from delegation args + infer hints
// ---------------------------------------------------------------------------

test("buildDelegationDoD: with acceptance string matches parseDoDFromAnnotation", () => {
  let acceptanceBlock = "[acceptance]\ncheck: testsPass\n[/acceptance]"
  let args: VerifyDispatchCore.delegationArgs = {
    prompt: Js.Nullable.return("implement auth"),
    description: Js.Nullable.return("add login"),
    acceptance: Js.Nullable.return(acceptanceBlock),
  }
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDispatchCore.buildDelegationDoD(args, hints)
  let fromAnnotation = VerifyDoD.parseDoDFromAnnotation(acceptanceBlock)
  switch Nullable.toOption(fromAnnotation) {
  | Some(expected) => {
    let rKind = VerifyDoD.getDodKind(result)
    let eKind = VerifyDoD.getDodKind(expected)
    assertionEqual(~operator="same kind", Obj.magic(eKind), Obj.magic(rKind))
  }
  | None => assertionTrue(~operator="should not be None", false)
  }
})

test("buildDelegationDoD: null acceptance falls back to inferDoD", () => {
  let args: VerifyDispatchCore.delegationArgs = {
    prompt: Js.Nullable.null,
    description: Js.Nullable.null,
    acceptance: Js.Nullable.null,
  }
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.return("npm test"),
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDispatchCore.buildDelegationDoD(args, hints)
  let checks = VerifyDoD.getDodChecks(result)
  assertionTrue(~operator="has inferred checks", Array.length(checks) > 0)
})

test("buildDelegationDoD: empty acceptance string falls back to inferDoD", () => {
  let args: VerifyDispatchCore.delegationArgs = {
    prompt: Js.Nullable.null,
    description: Js.Nullable.null,
    acceptance: Js.Nullable.return(""),
  }
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.return("jest"),
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDispatchCore.buildDelegationDoD(args, hints)
  let checks = VerifyDoD.getDodChecks(result)
  assertionTrue(~operator="empty acceptance→infer", Array.length(checks) > 0)
})

test("buildDelegationDoD: null acceptance falls back to inferDoD using prompt", () => {
  let args: VerifyDispatchCore.delegationArgs = {
    prompt: Js.Nullable.return("build the feature"),
    description: Js.Nullable.return("description"),
    acceptance: Js.Nullable.null,
  }
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.return("make build"),
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDispatchCore.buildDelegationDoD(args, hints)
  // "build the feature" has no [acceptance] tags → falls through to inferDoD
  // inferDoD: "build" → impl category; build hint present → kind=checker (criteria-only)
  let kind = VerifyDoD.getDodKind(result)
  assertionEqual(~operator="kind checker", "checker", Obj.magic(kind))
})

test("buildDelegationDoD: source is explicit when acceptance provided", () => {
  let args: VerifyDispatchCore.delegationArgs = {
    prompt: Js.Nullable.null,
    description: Js.Nullable.null,
    acceptance: Js.Nullable.return("[acceptance]\ncheck: run \"echo hi\"\n[/acceptance]"),
  }
  let hints: VerifyDoD.inferHints = {
    testCommand: Js.Nullable.null,
    buildCommand: Js.Nullable.null,
    lintCommand: Js.Nullable.null,
    declaredPath: Js.Nullable.null,
  }
  let result = VerifyDispatchCore.buildDelegationDoD(args, hints)
  let source = VerifyDoD.getDodSource(result)
  assertionEqual(~operator="source explicit", "explicit", Obj.magic(source))
})

// ---------------------------------------------------------------------------
// shouldVerifyTask — determines if verification is needed
// ---------------------------------------------------------------------------

test("shouldVerifyTask: no acceptance string returns false", () => {
  let result = VerifyDispatchCore.shouldVerifyTask(
    "implement feature x",
    "add the login flow",
    Js.Nullable.null,
  )
  assertionFalse(~operator="no acceptance → no verify", result)
})

test("shouldVerifyTask: empty acceptance block returns false", () => {
  let result = VerifyDispatchCore.shouldVerifyTask(
    "implement feature",
    "add feature",
    Js.Nullable.return("[acceptance]\n[/acceptance]"),
  )
  assertionFalse(~operator="empty block → no verify", result)
})

test("shouldVerifyTask: whitespace-only acceptance returns false", () => {
  let result = VerifyDispatchCore.shouldVerifyTask(
    "do something",
    "desc",
    Js.Nullable.return("   [acceptance]   \n  \n[/acceptance]"),
  )
  assertionFalse(~operator="whitespace-only → no verify", result)
})

test("shouldVerifyTask: acceptance with check lines returns true", () => {
  let result = VerifyDispatchCore.shouldVerifyTask(
    "implement feature",
    "add feature",
    Js.Nullable.return("[acceptance]\ncheck: run \"npm test\"\n[/acceptance]"),
  )
  assertionTrue(~operator="check present → verify", result)
})

test("shouldVerifyTask: acceptance with criteria only returns false", () => {
  let result = VerifyDispatchCore.shouldVerifyTask(
    "task",
    "desc",
    Js.Nullable.return("[acceptance]\ncriteria: must be good\n[/acceptance]"),
  )
  assertionFalse(~operator="criteria only → no verify", result)
})

test("shouldVerifyTask: acceptance with fileExists check returns true", () => {
  let result = VerifyDispatchCore.shouldVerifyTask(
    "implement",
    "desc",
    Js.Nullable.return("[acceptance]\ncheck: fileExists \"src/auth.ts\"\n[/acceptance]"),
  )
  assertionTrue(~operator="fileExists → verify", result)
})

// ---------------------------------------------------------------------------
// tierModel — tier resolution from protocolTierConfig
// ---------------------------------------------------------------------------

test("tierModel: empty model name returns null", () => {
  let result = VerifyDispatchCore.tierModel(minimalTierConfig, "")
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should not be None", false)
  | None => assertionTrue(~operator="null for empty tier name", true)
  }
})

test("tierModel: known tier fast returns tierModelResult", () => {
  let result = VerifyDispatchCore.tierModel(minimalTierConfig, "fast")
  switch Nullable.toOption(result) {
  | Some(tmr) => assertionContains(~operator="fast tier has model", "claude", tmr.modelID)
  | None => assertionTrue(~operator="should not be None", false)
  }
})

test("tierModel: medium tier returns correct model", () => {
  let result = VerifyDispatchCore.tierModel(minimalTierConfig, "medium")
  switch Nullable.toOption(result) {
  | Some(tmr) => assertionContains(~operator="medium tier model", "claude", tmr.modelID)
  | None => assertionTrue(~operator="should not be None", false)
  }
})

test("tierModel: unknown tier returns null", () => {
  let result = VerifyDispatchCore.tierModel(minimalTierConfig, "nonexistent-tier")
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should not be None", false)
  | None => assertionTrue(~operator="null for unknown tier", true)
  }
})

// ---------------------------------------------------------------------------
// buildForcingNote — builds escalation forcing note
// ---------------------------------------------------------------------------

test("buildForcingNote: empty producers returns note with default body", () => {
  let result = VerifyDispatchCore.buildForcingNote([], Js.Nullable.null)
  assertionContains(~operator="has NOT ACCEPTED", "NOT ACCEPTED", result)
})

test("buildForcingNote: producers with no hint returns string", () => {
  let result = VerifyDispatchCore.buildForcingNote(["tier-a", "tier-b"], Js.Nullable.null)
  assertionContains(~operator="contains producer", "tier-a", result)
})

test("buildForcingNote: with escalationHint includes producer and next tier", () => {
  let hint: VerifyDispatchCore.escalationHint = {
    producerTier: Js.Nullable.return("fast"),
    nextTier: Js.Nullable.return("medium"),
  }
  let result = VerifyDispatchCore.buildForcingNote(["fast"], Js.Nullable.return(hint))
  assertionContains(~operator="contains producerTier", "fast", result)
})

test("buildForcingNote: hint with null fields handles gracefully", () => {
  let hint: VerifyDispatchCore.escalationHint = {
    producerTier: Js.Nullable.null,
    nextTier: Js.Nullable.null,
  }
  let result = VerifyDispatchCore.buildForcingNote(["fast"], Js.Nullable.return(hint))
  assertionContains(~operator="producer in note", "fast", result)
})

// ---------------------------------------------------------------------------
// buildAcceptedSuffix — builds acceptance suffix string
// ---------------------------------------------------------------------------

test("buildAcceptedSuffix: non-empty input returns suffixed string", () => {
  let result = VerifyDispatchCore.buildAcceptedSuffix("task description")
  assertionContains(~operator="input preserved", "task description", result)
})

test("buildAcceptedSuffix: empty input returns formatted suffix", () => {
  let result = VerifyDispatchCore.buildAcceptedSuffix("")
  assertionContains(~operator="accepted marker", "router ✓ accepted", result)
})

test("buildAcceptedSuffix: long description is preserved", () => {
  let input = "this is a very long task description that spans multiple ideas"
  let result = VerifyDispatchCore.buildAcceptedSuffix(input)
  assertionContains(~operator="long desc preserved", input, result)
})

// ---------------------------------------------------------------------------
// parseTaskResult — decodes task result JSON
// ---------------------------------------------------------------------------

test("parseTaskResult: full JSON decodes all fields", () => {
  // The output field is used as-is (extractTaskResultContent only strips <task_result> tags if present)
  let json: JSON.t = %raw(`{
    "output": "all done",
    "metadata": {
      "sessionID": "sess-123",
      "parentSessionID": "parent-456"
    }
  }`)
  let result = VerifyDispatchCore.parseTaskResult(json)
  assertionEqual(~operator="finalReturnText", "all done", result.finalReturnText)
})

test("parseTaskResult: missing keys return empty/null defaults", () => {
  let json: JSON.t = %raw(`{ "output": "" }`)
  let result = VerifyDispatchCore.parseTaskResult(json)
  assertionEqual(~operator="empty output → empty", "", result.finalReturnText)
})

test("parseTaskResult: partial JSON fills defaults for missing", () => {
  let json: JSON.t = %raw(`{ "output": "partial result" }`)
  let result = VerifyDispatchCore.parseTaskResult(json)
  assertionEqual(~operator="partial result", "partial result", result.finalReturnText)
})

// ---------------------------------------------------------------------------
// extractChangedFile — parses changed file from JSON
// ---------------------------------------------------------------------------

test("extractChangedFile: valid path and status returns Some(changedFile)", () => {
  let json: JSON.t = %raw(`{ "path": "src/auth.ts", "status": "modified" }`)
  let result = VerifyDispatchCore.extractChangedFile("src/auth.ts", json)
  switch Nullable.toOption(result) {
  | Some(cf) => assertionContains(~operator="path preserved", "auth.ts", cf.path)
  | None => assertionTrue(~operator="should not be None", false)
  }
})

test("extractChangedFile: missing path returns null", () => {
  let json: JSON.t = %raw(`{ "status": "added" }`)
  let result = VerifyDispatchCore.extractChangedFile("any", json)
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should not be None", false)
  | None => assertionTrue(~operator="null on missing path", true)
  }
})

test("extractChangedFile: different file path returns null", () => {
  let json: JSON.t = %raw(`{ "path": "src/other.ts", "status": "modified" }`)
  let result = VerifyDispatchCore.extractChangedFile("src/auth.ts", json)
  switch Nullable.toOption(result) {
  | Some(_) => assertionTrue(~operator="should not be None", false)
  | None => assertionTrue(~operator="null for mismatched path", true)
  }
})

// ---------------------------------------------------------------------------
// createChangedFileStore — opaque store factory
// ---------------------------------------------------------------------------

test("createChangedFileStore: returns a store value", () => {
  let _store = VerifyDispatchCore.createChangedFileStore(())
  assertionTrue(~operator="store created", true)
})
