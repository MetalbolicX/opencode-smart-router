// src/verify/Verify.res
// Public facade re-exporting DoD parser and pure dispatch core.

// NOTE: VerifyDoD and VerifyDispatchCore module opens removed - unused

// Re-export all DoD types (type aliases — no export keyword needed for types)
type checkKind = VerifyDoD.checkKind
type check = VerifyDoD.check
type dodKind = VerifyDoD.dodKind
type dodSource = VerifyDoD.dodSource
type dod = VerifyDoD.dod
type inferHints = VerifyDoD.inferHints

// Re-export all dispatch core types
type changedFile = VerifyDispatchCore.changedFile
type changedFileStore = VerifyDispatchCore.changedFileStore
type parsedTaskResult = VerifyDispatchCore.parsedTaskResult
type tierModelResult = VerifyDispatchCore.tierModelResult
type escalationHint = VerifyDispatchCore.escalationHint
type delegationArgs = VerifyDispatchCore.delegationArgs

// Re-export DoD functions
let summarizeDispatch = VerifyDoD.summarizeDispatch
let normalizeDoD = VerifyDoD.normalizeDoD
let parseAcceptanceBlock = VerifyDoD.parseAcceptanceBlock
let parseDoDFromDispatch = VerifyDoD.parseDoDFromDispatch
let parseDoDFromAnnotation = VerifyDoD.parseDoDFromAnnotation
let inferDoD = VerifyDoD.inferDoD
let isCheckable = VerifyDoD.isCheckable
let getCheckCommand = VerifyDoD.getCheckCommand
let getCheckExpect = VerifyDoD.getCheckExpect
let getCheckPath = VerifyDoD.getCheckPath
let getCheckSchema = VerifyDoD.getCheckSchema
let getCheckKind = VerifyDoD.getCheckKind
let getDodDeliverable = VerifyDoD.getDodDeliverable
let getDodKind = VerifyDoD.getDodKind
let getDodChecks = VerifyDoD.getDodChecks
let getDodCriteria = VerifyDoD.getDodCriteria
let getDodSource = VerifyDoD.getDodSource

// Re-export dispatch core functions
let extractChangedFile = VerifyDispatchCore.extractChangedFile
let createChangedFileStore = VerifyDispatchCore.createChangedFileStore
let parseTaskResult = VerifyDispatchCore.parseTaskResult
let buildDelegationDoD = VerifyDispatchCore.buildDelegationDoD
let tierModel = VerifyDispatchCore.tierModel
let shouldVerifyTask = VerifyDispatchCore.shouldVerifyTask
let buildForcingNote = VerifyDispatchCore.buildForcingNote
let buildAcceptedSuffix = VerifyDispatchCore.buildAcceptedSuffix
