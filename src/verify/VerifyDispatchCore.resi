// src/verify/VerifyDispatchCore.resi
// Public interface for pure dispatch core

type changedFile = {
  path: string,
  status: string,
}

type changedFileStore

type parsedTaskResult = {
  finalReturnText: string,
  childSessionID: Js.Nullable.t<string>,
  parentSessionID: Js.Nullable.t<string>,
}

type tierModelResult = {
  providerID: string,
  modelID: string,
}

type escalationHint = {
  producerTier: Js.Nullable.t<string>,
  nextTier: Js.Nullable.t<string>,
}

type delegationArgs = {
  prompt: Js.Nullable.t<string>,
  description: Js.Nullable.t<string>,
  acceptance: Js.Nullable.t<string>,
}

type tierDefMinimal = {
  model: string,
}

type protocolTierConfig = {
  activePreset: string,
  activeMode: Js.Nullable.t<string>,
  presets: Js.Dict.t<Js.Dict.t<tierDefMinimal>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Js.Nullable.t<{ global: Js.Nullable.t<Js.Dict.t<array<string>>>, presets: Js.Nullable.t<Js.Dict.t<Js.Dict.t<array<string>>>> }>,
  taskPatterns: Js.Nullable.t<Js.Dict.t<array<string>>>,
  modes: Js.Nullable.t<Js.Dict.t<{ defaultTier: string, overrideRules: Js.Nullable.t<array<string>> }>>,
  enforcement: Js.Nullable.t<{ verify: Js.Nullable.t<{ requireExplicitDoD: Js.Nullable.t<bool> }> }>,
}

let extractChangedFile: (string, Js.Json.t) => Js.Nullable.t<changedFile>
let createChangedFileStore: (unit) => changedFileStore
let parseTaskResult: (Js.Json.t) => parsedTaskResult
let buildDelegationDoD: (delegationArgs, VerifyDoD.inferHints) => VerifyDoD.dod
let tierModel: (protocolTierConfig, string) => Js.Nullable.t<tierModelResult>
let shouldVerifyTask: (string, string, Js.Nullable.t<string>) => bool
let buildForcingNote: (array<string>, Js.Nullable.t<escalationHint>) => string
let buildAcceptedSuffix: (string) => string
