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
  command: Js.Nullable.t<string>,
  expect: Js.Nullable.t<string>,
  path: Js.Nullable.t<string>,
  schema: Js.Nullable.t<string>,
}

type dodKind = [ #deterministic | #checker | #none ]
type dodSource = [ #explicit | #inferred | #annotation | #none ]

type dod = {
  kind: dodKind,
  checks: array<check>,
  criteria: array<string>,
  deliverable: Js.Nullable.t<string>,
  source: dodSource,
}

type inferHints = {
  testCommand: Js.Nullable.t<string>,
  buildCommand: Js.Nullable.t<string>,
  lintCommand: Js.Nullable.t<string>,
  declaredPath: Js.Nullable.t<string>,
}

let summarizeDispatch: (string) => string
let normalizeDoD: (dod) => dod
let parseAcceptanceBlock: (string, dodSource) => Js.Nullable.t<dod>
let parseDoDFromDispatch: (string) => Js.Nullable.t<dod>
let parseDoDFromAnnotation: (string) => Js.Nullable.t<dod>
let inferDoD: (string, string, inferHints) => dod
let isCheckable: (dod) => bool

// Accessors for test assertions (nullable field access)
let getCheckCommand: (check) => Js.Nullable.t<string>
let getCheckExpect: (check) => Js.Nullable.t<string>
let getCheckPath: (check) => Js.Nullable.t<string>
let getCheckSchema: (check) => Js.Nullable.t<string>
let getCheckKind: (check) => checkKind
let getDodDeliverable: (dod) => Js.Nullable.t<string>
let getDodKind: (dod) => dodKind
let getDodChecks: (dod) => array<check>
let getDodCriteria: (dod) => array<string>
let getDodSource: (dod) => dodSource
