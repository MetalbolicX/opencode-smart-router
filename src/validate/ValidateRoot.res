// ---------------------------------------------------------------------------
// ValidateRoot.res — ROOT section validators ported from config-validate.ts.
//
// Ports the ROOT section from src/router/config-validate.ts:
//   - validateRootFields: activePreset must be a non-empty string
//   - validateRulesAndDefaultTier: rules must be array of strings,
//     defaultTier must be a string
//
// Input type is Js.Dict.t<Js.Json.t> which maps to TS Record<string, unknown>.
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validateRootFields
// Validates that `activePreset` is a non-empty string.
// ---------------------------------------------------------------------------
let validateRootFields = (obj: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(obj, "activePreset") {
  | Some(json) =>
    switch Js.Json.decodeString(json) {
    | Some(s) if s !== "" => ()
    | _ =>
      raise(Js.Exn.raiseError("tiers.json: 'activePreset' must be a non-empty string"))
    }
  | None =>
    raise(Js.Exn.raiseError("tiers.json: 'activePreset' must be a non-empty string"))
  }
}

// ---------------------------------------------------------------------------
// validateRulesAndDefaultTier
// Validates that `rules` is an array of strings and `defaultTier` is a string.
// ---------------------------------------------------------------------------

// Check every element of a Js.Json.t array is a string
let rec checkStringArray = (arr: list<Js.Json.t>): unit =>
  switch arr {
  | list{} => ()
  | list{head, ...rest} =>
    switch Js.Json.decodeString(head) {
    | Some(_) => checkStringArray(rest)
    | None =>
      raise(Js.Exn.raiseError("tiers.json: 'rules' must be an array of strings"))
    }
  }

let validateRulesAndDefaultTier = (obj: Js.Dict.t<Js.Json.t>): unit => {
  // Validate rules: must be an array of strings
  switch Js.Dict.get(obj, "rules") {
  | Some(json) =>
    switch Js.Json.decodeArray(json) {
    | Some(arr) =>
      checkStringArray(List.fromArray(arr))
    | None =>
      raise(Js.Exn.raiseError("tiers.json: 'rules' must be an array of strings"))
    }
  | None =>
    raise(Js.Exn.raiseError("tiers.json: 'rules' must be an array of strings"))
  }

  // Validate defaultTier: must be a string
  switch Js.Dict.get(obj, "defaultTier") {
  | Some(json) =>
    switch Js.Json.decodeString(json) {
    | Some(s) if s !== "" => ()
    | _ =>
      raise(Js.Exn.raiseError("tiers.json: 'defaultTier' must be a string"))
    }
  | None =>
    raise(Js.Exn.raiseError("tiers.json: 'defaultTier' must be a string"))
  }
}
