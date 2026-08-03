// src/verify/VerifyDoD.resi
// Public interface for DoD parser

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

let summarizeDispatch: string => string
let normalizeDoD: dod => dod
let parseAcceptanceBlock: (string, dodSource) => Nullable.t<dod>
let parseDoDFromDispatch: string => Nullable.t<dod>
let parseDoDFromAnnotation: string => Nullable.t<dod>
let inferDoD: (string, string, inferHints) => dod
let isCheckable: dod => bool

// Accessors for test assertions (nullable field access)
let getCheckCommand: check => Nullable.t<string>
let getCheckExpect: check => Nullable.t<string>
let getCheckPath: check => Nullable.t<string>
let getCheckSchema: check => Nullable.t<string>
let getCheckKind: check => checkKind
let getDodDeliverable: dod => Nullable.t<string>
let getDodKind: dod => dodKind
let getDodChecks: dod => array<check>
let getDodCriteria: dod => array<string>
let getDodSource: dod => dodSource
