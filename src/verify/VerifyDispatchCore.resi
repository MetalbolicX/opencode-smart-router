// src/verify/VerifyDispatchCore.resi
// Public interface for pure dispatch core

type changedFile = {
  path: string,
  status: string,
}

type changedFileStore

type parsedTaskResult = {
  finalReturnText: string,
  childSessionID: Nullable.t<string>,
  parentSessionID: Nullable.t<string>,
}

type tierModelResult = {
  providerID: string,
  modelID: string,
}

type escalationHint = {
  producerTier: Nullable.t<string>,
  nextTier: Nullable.t<string>,
}

type delegationArgs = {
  prompt: Nullable.t<string>,
  description: Nullable.t<string>,
  acceptance: Nullable.t<string>,
}

type tierDefMinimal = {
  model: string,
}

type protocolTierConfig = {
  activePreset: string,
  activeMode: Nullable.t<string>,
  presets: dict<dict<tierDefMinimal>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Nullable.t<{global: Nullable.t<dict<array<string>>>, fallback_presets: Nullable.t<dict<dict<array<string>>>>}>,
  taskPatterns: Nullable.t<dict<array<string>>>,
  modes: Nullable.t<dict<{modes_defaultTier: string, overrideRules: Nullable.t<array<string>>}>>,
  enforcement: Nullable.t<{verify: Nullable.t<{requireExplicitDoD: Nullable.t<bool>}>}>,
}

let extractChangedFile: (string, JSON.t) => Nullable.t<changedFile>
let createChangedFileStore: unit => changedFileStore
let parseTaskResult: JSON.t => parsedTaskResult
let buildDelegationDoD: (delegationArgs, VerifyDoD.inferHints) => VerifyDoD.dod
let tierModel: (protocolTierConfig, string) => Nullable.t<tierModelResult>
let shouldVerifyTask: (string, string, Nullable.t<string>) => bool
let buildForcingNote: (array<string>, Nullable.t<escalationHint>) => string
let buildAcceptedSuffix: string => string
