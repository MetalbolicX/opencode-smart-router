// src/verify/Verify.resi
// Public facade re-exporting from VerifyDoD and VerifyDispatchCore

// DoD types (re-exported from VerifyDoD)
type checkKind = VerifyDoD.checkKind
type check = VerifyDoD.check
type dodKind = VerifyDoD.dodKind
type dodSource = VerifyDoD.dodSource
type dod = VerifyDoD.dod
type inferHints = VerifyDoD.inferHints

// Dispatch core types
type changedFile = VerifyDispatchCore.changedFile
type changedFileStore = VerifyDispatchCore.changedFileStore
type parsedTaskResult = VerifyDispatchCore.parsedTaskResult
type tierModelResult = VerifyDispatchCore.tierModelResult
type escalationHint = VerifyDispatchCore.escalationHint
type delegationArgs = VerifyDispatchCore.delegationArgs

// DoD functions
let summarizeDispatch: (string) => string
let normalizeDoD: (dod) => dod
let parseAcceptanceBlock: (string, dodSource) => Js.Nullable.t<dod>
let parseDoDFromDispatch: (string) => Js.Nullable.t<dod>
let parseDoDFromAnnotation: (string) => Js.Nullable.t<dod>
let inferDoD: (string, string, inferHints) => dod
let isCheckable: (dod) => bool

// Check/Dod accessors
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

// Dispatch core functions
let extractChangedFile: (string, Js.Json.t) => Js.Nullable.t<changedFile>
let createChangedFileStore: (unit) => changedFileStore
let parseTaskResult: (Js.Json.t) => parsedTaskResult
let buildDelegationDoD: (delegationArgs, inferHints) => dod
let tierModel: (VerifyDispatchCore.protocolTierConfig, string) => Js.Nullable.t<tierModelResult>
let shouldVerifyTask: (string, string, Js.Nullable.t<string>) => bool
let buildForcingNote: (array<string>, Js.Nullable.t<escalationHint>) => string
let buildAcceptedSuffix: (string) => string
