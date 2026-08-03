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
let validateRootFields = (obj: dict<JSON.t>): unit => {
  switch Dict.get(obj, "activePreset") {
  | Some(json) =>
    switch JSON.Decode.string(json) {
    | Some(s) if s !== "" => ()
    | _ => throw(JsError.throwWithMessage("tiers.json: 'activePreset' must be a non-empty string"))
    }
  | None => throw(JsError.throwWithMessage("tiers.json: 'activePreset' must be a non-empty string"))
  }
}

// ---------------------------------------------------------------------------
// validateRulesAndDefaultTier
// Validates that `rules` is an array of strings and `defaultTier` is a string.
// ---------------------------------------------------------------------------

// Check every element of a Js.Json.t array is a string
let rec checkStringArray = (arr: list<JSON.t>): unit =>
  switch arr {
  | list{} => ()
  | list{head, ...rest} =>
    switch JSON.Decode.string(head) {
    | Some(_) => checkStringArray(rest)
    | None => throw(JsError.throwWithMessage("tiers.json: 'rules' must be an array of strings"))
    }
  }

let validateRulesAndDefaultTier = (obj: dict<JSON.t>): unit => {
  // Validate rules: must be an array of strings
  switch Dict.get(obj, "rules") {
  | Some(json) =>
    switch JSON.Decode.array(json) {
    | Some(arr) => checkStringArray(List.fromArray(arr))
    | None => throw(JsError.throwWithMessage("tiers.json: 'rules' must be an array of strings"))
    }
  | None => throw(JsError.throwWithMessage("tiers.json: 'rules' must be an array of strings"))
  }

  // Validate defaultTier: must be a string
  switch Dict.get(obj, "defaultTier") {
  | Some(json) =>
    switch JSON.Decode.string(json) {
    | Some(s) if s !== "" => ()
    | _ => throw(JsError.throwWithMessage("tiers.json: 'defaultTier' must be a string"))
    }
  | None => throw(JsError.throwWithMessage("tiers.json: 'defaultTier' must be a string"))
  }
}
