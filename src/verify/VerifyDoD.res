// src/verify/VerifyDoD.res
// PURE DoD (Definition of Done) schema, parser, and auto-inference.
// No fs/network/SDK — all pure functions.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type checkKind = [
  | #run
  | #fileExists
  | #schemaMatch
  | #testsPass
  | #buildPasses
  | #lintClean
]

type check = {
  kind: checkKind,
  command: Nullable.t<string>,
  expect: Nullable.t<string>,
  path: Nullable.t<string>,
  schema: Nullable.t<string>,
}

type dodKind = [#deterministic | #checker | #none]

type dodSource = [#explicit | #inferred | #annotation | #none]

type dod = {
  kind: dodKind,
  checks: array<check>,
  criteria: array<string>,
  deliverable: Nullable.t<string>,
  source: dodSource,
}

type inferHints = {
  testCommand: Nullable.t<string>,
  buildCommand: Nullable.t<string>,
  lintCommand: Nullable.t<string>,
  declaredPath: Nullable.t<string>,
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

let validCheckKinds: array<string> = [
  "run",
  "fileExists",
  "schemaMatch",
  "testsPass",
  "buildPasses",
  "lintClean",
]

let validDodKinds: array<string> = ["deterministic", "checker", "none"]

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let _stringInArray = (s: string, arr: array<string>): bool => {
  let found = ref(false)
  for i in 0 to Array.length(arr) - 1 {
    switch arr[i] {
    | Some(elem) if elem == s => found := true
    | _ => ()
    }
  }
  found.contents
}

// Parse key=value pairs: key="quoted" or key=bare
let parseKvPairs = (s: string): dict<string> => {
  let result = Dict.make()
  let parts = String.split(s, " ")
  for i in 0 to Array.length(parts) - 1 {
    switch parts[i] {
    | Some(part) =>
      let eqIdx = String.indexOf("=", part)
      if eqIdx > 0 {
        let key = String.substring(part, ~start=0, ~end=eqIdx)
        let rest = String.substring(part, ~start=eqIdx + 1, ~end=String.length(part))
        let val = if String.startsWith(rest, "\"") && String.endsWith(rest, "\"") {
          String.substring(rest, ~start=1, ~end=String.length(rest) - 1)
        } else {
          rest
        }
        Dict.set(result, key, val)
      }
    | None => ()
    }
  }
  result
}

// ---------------------------------------------------------------------------
// summarizeDispatch
// ---------------------------------------------------------------------------

let summarizeDispatch = (text: string): string => {
  if text === "" {
    ""
  } else {
    let lines = Js.String.split("\n", text)
    let rec go = (i: int, acc: string): string => {
      if i >= Array.length(lines) {
        acc
      } else {
        switch lines[i] {
        | Some(trimmed) =>
          let collapsed = String.replaceRegExp(String.trim(trimmed), /\\s+/, " ")
          if collapsed === "" {
            go(i + 1, acc)
          } else {
            let result = if String.length(collapsed) > 120 {
              Js.String.slice(collapsed, ~from=0, ~to_=120)
            } else {
              collapsed
            }
            result
          }
        | None => go(i + 1, acc)
        }
      }
    }
    go(0, "")
  }
}

// ---------------------------------------------------------------------------
// normalizeDoD
// ---------------------------------------------------------------------------

let normalizeDoD = (d: dod): dod => {
  let checks: array<check> = Array.isArray(d.checks) ? [...d.checks] : []
  let criteria: array<string> = Array.isArray(d.criteria) ? [...d.criteria] : []

  let kind: dodKind = if Array.length(checks) > 0 {
    #deterministic
  } else if Array.length(criteria) > 0 {
    #checker
  } else {
    #none
  }

  let rawDeliverable = switch d.deliverable->Nullable.toOption {
  | Some(v) => String.trim(v)
  | None => ""
  }
  let deliverable: Nullable.t<string> = if rawDeliverable !== "" {
    Nullable.make(rawDeliverable)
  } else {
    Nullable.null
  }

  {kind, checks, criteria, deliverable, source: d.source}
}

// ---------------------------------------------------------------------------
// parseAcceptanceBlock — FAIL-CLOSED on malformed input
// ---------------------------------------------------------------------------

let makeCheckKindSet = (): dict<bool> => {
  let s = Dict.make()
  for i in 0 to Array.length(validCheckKinds) - 1 {
    switch validCheckKinds[i] {
    | Some(k) => Dict.set(s, k, true)
    | None => ()
    }
  }
  s
}

let checkKindSet = makeCheckKindSet()

let makeDodKindSet = (): dict<bool> => {
  let s = Dict.make()
  for i in 0 to Array.length(validDodKinds) - 1 {
    switch validDodKinds[i] {
    | Some(k) => Dict.set(s, k, true)
    | None => ()
    }
  }
  s
}

let dodKindSet = makeDodKindSet()

let openTagRe = /^\s*\[(acceptance|dod)\]\s*$/i
let closeTagRe = /^\s*\[\/(acceptance|dod)\]\s*$/i

let findOpenTag = (lines: array<string>, start: int): int => {
  let rec go = (i: int): int => {
    if i >= Array.length(lines) {
      -1
    } else {
      switch lines[i] {
      | Some(line) =>
        if openTagRe->RegExp.test(line) {
          i
        } else {
          go(i + 1)
        }
      | None => go(i + 1)
      }
    }
  }
  go(start)
}

let findCloseTag = (lines: array<string>, start: int): int => {
  let rec go = (i: int): int => {
    if i >= Array.length(lines) {
      -1
    } else {
      switch lines[i] {
      | Some(line) =>
        if closeTagRe->RegExp.test(line) {
          i
        } else {
          go(i + 1)
        }
      | None => go(i + 1)
      }
    }
  }
  go(start)
}

let sliceInner = (lines: array<string>, start: int, end: int): array<string> => {
  let rec go = (i: int, acc: array<string>): array<string> => {
    if i >= end {
      acc
    } else {
      switch lines[i] {
      | Some(line) => go(i + 1, [...acc, line])
      | None => go(i + 1, acc)
      }
    }
  }
  go(start, [])
}

type parseState = {
  mutable checks: array<check>,
  mutable criteria: array<string>,
  mutable deliverable: Nullable.t<string>,
  mutable kindHint: Nullable.t<dodKind>,
  mutable invalidKindDirective: bool,
}

let makeInitialState = (): parseState => {
  {
    checks: [],
    criteria: [],
    deliverable: Nullable.null,
    kindHint: Nullable.null,
    invalidKindDirective: false,
  }
}

let kindStrToCheckKind = (s: string): checkKind => {
  switch s {
  | "run" => #run
  | "fileExists" => #fileExists
  | "schemaMatch" => #schemaMatch
  | "testsPass" => #testsPass
  | "buildPasses" => #buildPasses
  | "lintClean" => #lintClean
  | _ => #run
  }
}

let kindStrToDodKind = (s: string): dodKind => {
  switch s {
  | "deterministic" => #deterministic
  | "checker" => #checker
  | "none" => #none
  | _ => #none
  }
}

let processLine = (line: string, state: parseState): unit => {
  let trimmed = String.trim(line)
  if trimmed === "" {
    ()
  } else {
    let lline = String.toLowerCase(trimmed)

    if String.startsWith(lline, "check:") {
      if state.invalidKindDirective {
        ()
      } else {
        let rest = String.slice(trimmed, ~start=6, ~end=String.length(trimmed))
        let restTrimmed = String.trim(rest)
        let spaceIdx = String.indexOf(restTrimmed, " ")
        let kindStr = if spaceIdx === -1 {
          restTrimmed
        } else {
          String.slice(restTrimmed, ~start=0, ~end=spaceIdx)
        }
        let remainder = if spaceIdx === -1 {
          ""
        } else {
          String.slice(restTrimmed, ~start=spaceIdx + 1, ~end=String.length(restTrimmed))
        }

        if !Belt.Option.isSome(Dict.get(checkKindSet, kindStr)) {
          ()
        } else {
          let kvPairs = parseKvPairs(remainder)
          let check: check = {
            kind: kindStrToCheckKind(kindStr),
            command: switch Dict.get(kvPairs, "command") {
            | Some(v) => Nullable.make(v)
            | None => Nullable.null
            },
            expect: switch Dict.get(kvPairs, "expect") {
            | Some(v) => Nullable.make(v)
            | None => Nullable.null
            },
            path: switch Dict.get(kvPairs, "path") {
            | Some(v) => Nullable.make(v)
            | None => Nullable.null
            },
            schema: switch Dict.get(kvPairs, "schema") {
            | Some(v) => Nullable.make(v)
            | None => Nullable.null
            },
          }
          state.checks = [...state.checks, check]
        }
      }
    } else if String.startsWith(lline, "criteria:") {
      if state.invalidKindDirective {
        ()
      } else {
        let rest = String.slice(trimmed, ~start=9, ~end=String.length(trimmed))
        let restTrimmed = String.trim(rest)
        if restTrimmed !== "" {
          state.criteria = [...state.criteria, restTrimmed]
        }
      }
    } else if String.startsWith(lline, "deliverable:") {
      if state.invalidKindDirective {
        ()
      } else {
        let rest = String.slice(trimmed, ~start=12, ~end=String.length(trimmed))
        let restTrimmed = String.trim(rest)
        state.deliverable = if restTrimmed !== "" {
          Nullable.make(restTrimmed)
        } else {
          Nullable.null
        }
      }
    } else if String.startsWith(lline, "kind:") {
      let rest = String.slice(trimmed, ~start=5, ~end=String.length(trimmed))
      let restTrimmed = String.trim(String.toLowerCase(rest))
      if restTrimmed === "" {
        // Empty kind value — fail closed
        state.invalidKindDirective = true
        state.checks = []
        state.criteria = []
        state.deliverable = Nullable.null
        state.kindHint = Nullable.make(#none)
      } else if !Belt.Option.isSome(Dict.get(dodKindSet, restTrimmed)) {
        // Unknown kind value — fail closed
        state.invalidKindDirective = true
        state.checks = []
        state.criteria = []
        state.deliverable = Nullable.null
        state.kindHint = Nullable.make(#none)
      } else {
        state.kindHint = Nullable.make(kindStrToDodKind(restTrimmed))
      }
    } else {
      // Unknown directive: skip
      ()
    }
  }
}

let processLines = (lines: array<string>, state: parseState): unit => {
  for i in 0 to Array.length(lines) - 1 {
    switch lines[i] {
    | Some(line) => processLine(line, state)
    | None => ()
    }
  }
}

let parseAcceptanceBlock = (text: string, source: dodSource): Nullable.t<dod> => {
  let lines = Js.String.split("\n", text)

  let openIdx = findOpenTag(lines, 0)
  if openIdx === -1 {
    Nullable.null
  } else {
    let closeIdx = findCloseTag(lines, openIdx + 1)
    if closeIdx === -1 {
      Nullable.null
    } else {
      let innerLines = sliceInner(lines, openIdx + 1, closeIdx)
      let state = makeInitialState()
      processLines(innerLines, state)

      let finalKind: dodKind = if state.invalidKindDirective {
        #none
      } else {
        switch state.kindHint->Nullable.toOption {
        | Some(k) => k
        | None => #none
        }
      }

      let result: dod = {
        kind: finalKind,
        checks: state.checks,
        criteria: state.criteria,
        deliverable: state.deliverable,
        source,
      }

      Nullable.make(normalizeDoD(result))
    }
  }
}

// ---------------------------------------------------------------------------
// parseDoDFromDispatch / parseDoDFromAnnotation
// ---------------------------------------------------------------------------

let parseDoDFromDispatch = (dispatchText: string): Nullable.t<dod> => {
  parseAcceptanceBlock(dispatchText, #explicit)
}

let parseDoDFromAnnotation = (annotationText: string): Nullable.t<dod> => {
  parseAcceptanceBlock(annotationText, #annotation)
}

// ---------------------------------------------------------------------------
// inferDoD
// ---------------------------------------------------------------------------

let inferDoD = (dispatchText: string, _tier: string, hints: inferHints): dod => {
  let lower = String.toLowerCase(dispatchText)

  let hasDeclaredPath = switch hints.declaredPath->Nullable.toOption {
  | Some(p) => String.trim(p) !== ""
  | None => false
  }

  let category: string = if /\\b(bug|fix|broken|regression|failing)\\b/->RegExp.test(lower) {
    "bugfix"
  } else if /\\b(refactor|rename|extract|restructure|cleanup|clean up)\\b/->RegExp.test(lower) {
    "refactor"
  } else if /\\b(write|generate|emit|scaffold)\\b/->RegExp.test(lower) && hasDeclaredPath {
    "writeFile"
  } else if (
    /\\b(implement|add|feature|create|build|endpoint|function|component|fix)\\b/->RegExp.test(lower)
  ) {
    "impl"
  } else if /\\b(test|spec|coverage)\\b/->RegExp.test(lower) {
    "test"
  } else {
    "unknown"
  }

  // Build checks immutably via let-chaining
  let checks = if category === "bugfix" || category === "impl" {
    let buildCheck = switch hints.buildCommand->Nullable.toOption {
    | Some(cmd) if String.trim(cmd) !== "" =>
      Some({
        kind: #buildPasses,
        command: Nullable.make(cmd),
        expect: Nullable.null,
        path: Nullable.null,
        schema: Nullable.null,
      })
    | _ => None
    }
    let testCheck = switch hints.testCommand->Nullable.toOption {
    | Some(cmd) if String.trim(cmd) !== "" =>
      Some({
        kind: #testsPass,
        command: Nullable.make(cmd),
        expect: Nullable.null,
        path: Nullable.null,
        schema: Nullable.null,
      })
    | _ => None
    }
    switch (buildCheck, testCheck) {
    | (Some(bc), Some(tc)) => [bc, tc]
    | (Some(bc), None) => [bc]
    | (None, Some(tc)) => [tc]
    | (None, None) => []
    }
  } else if category === "refactor" {
    let buildCheck = switch hints.buildCommand->Nullable.toOption {
    | Some(cmd) if String.trim(cmd) !== "" =>
      Some({
        kind: #buildPasses,
        command: Nullable.make(cmd),
        expect: Nullable.null,
        path: Nullable.null,
        schema: Nullable.null,
      })
    | _ => None
    }
    let lintCheck = switch hints.lintCommand->Nullable.toOption {
    | Some(cmd) if String.trim(cmd) !== "" =>
      Some({
        kind: #lintClean,
        command: Nullable.make(cmd),
        expect: Nullable.null,
        path: Nullable.null,
        schema: Nullable.null,
      })
    | _ => None
    }
    switch (buildCheck, lintCheck) {
    | (Some(bc), Some(lc)) => [bc, lc]
    | (Some(bc), None) => [bc]
    | (None, Some(lc)) => [lc]
    | (None, None) => []
    }
  } else if category === "writeFile" {
    switch hints.declaredPath->Nullable.toOption {
    | Some(p) =>
      let trimmed = String.trim(p)
      if trimmed !== "" {
        [
          {
            kind: #fileExists,
            command: Nullable.null,
            expect: Nullable.null,
            path: Nullable.make(trimmed),
            schema: Nullable.null,
          },
        ]
      } else {
        []
      }
    | None => []
    }
  } else if category === "test" {
    switch hints.testCommand->Nullable.toOption {
    | Some(cmd) if String.trim(cmd) !== "" => [
        {
          kind: #testsPass,
          command: Nullable.make(cmd),
          expect: Nullable.null,
          path: Nullable.null,
          schema: Nullable.null,
        },
      ]
    | _ => []
    }
  } else {
    []
  }

  let criteria: array<string> = if Array.length(checks) === 0 {
    let summary = summarizeDispatch(dispatchText)
    let msg = if summary !== "" {
      summary
    } else {
      "the delegated task is completed as described in the dispatch"
    }
    [msg]
  } else {
    []
  }

  let rawPath = switch hints.declaredPath->Nullable.toOption {
  | Some(p) => String.trim(p)
  | None => ""
  }
  let deliverable: Nullable.t<string> = if rawPath !== "" {
    Nullable.make(rawPath)
  } else {
    Nullable.null
  }

  let kind: dodKind = if Array.length(checks) > 0 {
    #deterministic
  } else {
    #checker
  }

  normalizeDoD({
    kind,
    checks,
    criteria,
    deliverable,
    source: #inferred,
  })
}

// ---------------------------------------------------------------------------
// isCheckable
// ---------------------------------------------------------------------------

let isCheckable = (d: dod): bool => {
  switch d.kind {
  | #none => false
  | #deterministic => Array.length(d.checks) > 0
  | #checker => Array.length(d.criteria) > 0
  }
}

// ---------------------------------------------------------------------------
// Accessors for test assertions (nullable field access)
// ---------------------------------------------------------------------------

let getCheckCommand = (c: check): Nullable.t<string> => c.command
let getCheckExpect = (c: check): Nullable.t<string> => c.expect
let getCheckPath = (c: check): Nullable.t<string> => c.path
let getCheckSchema = (c: check): Nullable.t<string> => c.schema
let getCheckKind = (c: check): checkKind => c.kind
let getDodDeliverable = (d: dod): Nullable.t<string> => d.deliverable
let getDodKind = (d: dod): dodKind => d.kind
let getDodChecks = (d: dod): array<check> => d.checks
let getDodCriteria = (d: dod): array<string> => d.criteria
let getDodSource = (d: dod): dodSource => d.source
