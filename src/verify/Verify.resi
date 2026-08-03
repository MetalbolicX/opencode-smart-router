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
let summarizeDispatch: string => string
let normalizeDoD: dod => dod
let parseAcceptanceBlock: (string, dodSource) => Nullable.t<dod>
let parseDoDFromDispatch: string => Nullable.t<dod>
let parseDoDFromAnnotation: string => Nullable.t<dod>
let inferDoD: (string, string, inferHints) => dod
let isCheckable: dod => bool

// Check/Dod accessors
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

// Dispatch core functions
let extractChangedFile: (string, JSON.t) => Nullable.t<changedFile>
let createChangedFileStore: unit => changedFileStore
let parseTaskResult: JSON.t => parsedTaskResult
let buildDelegationDoD: (delegationArgs, inferHints) => dod
let tierModel: (VerifyDispatchCore.protocolTierConfig, string) => Nullable.t<tierModelResult>
let shouldVerifyTask: (string, string, Nullable.t<string>) => bool
let buildForcingNote: (array<string>, Nullable.t<escalationHint>) => string
let buildAcceptedSuffix: string => string
