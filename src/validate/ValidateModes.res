// ---------------------------------------------------------------------------
// ValidateModes.res — MODES section validators ported from config-validate.ts.
//
// Ports the MODES section from src/router/config-validate.ts:
//   - validateModes: modes must be an object if present
//   - validateMode: mode must be an object; defaultTier/description must be strings
//
// Input type is Js.Dict.t<Js.Json.t> which maps to TS Record<string, unknown>.
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Guard: throws if obj is not a plain object (not null, string, number, etc.)
// Js.Dict.get uses the 'in' operator internally which throws for non-objects,
// so we must check upfront.
let _ensureIsConfigObject = (_obj: dict<JSON.t>): unit => {
  if %raw(`!(obj && typeof obj === 'object' && !Array.isArray(obj))`) {
    throw(JsError.throwWithMessage("tiers.json: expected a JSON object at root"))
  }
}

// Guard: throws if val is not a plain object
let ensureIsObject = (_val: JSON.t, path: string): unit => {
  if %raw(`!(val && typeof val === 'object' && !Array.isArray(val))`) {
    throw(JsError.throwWithMessage(`tiers.json: ${path} must be an object`))
  }
}

// ---------------------------------------------------------------------------
// validateMode
// Validates a single mode: must be an object; defaultTier/description must be strings.
// ---------------------------------------------------------------------------

let validateMode = (modeName: string, mode: dict<JSON.t>): unit => {
  // Guard: mode must be a non-null object (not null, number, string, etc.)
  // Js.Dict.get uses the 'in' operator internally which throws for non-objects,
  // so we must check upfront.
  if %raw(`!(mode && typeof mode === 'object' && !Array.isArray(mode))`) {
    throw(JsError.throwWithMessage(`tiers.json: mode '${modeName}' must be an object`))
  }

  // defaultTier: required, must be a string
  switch Dict.get(mode, "defaultTier") {
  | Some(json) =>
    switch JSON.Decode.string(json) {
    | Some(_) => ()
    | None =>
      throw(JsError.throwWithMessage(`tiers.json: mode '${modeName}.defaultTier' must be a string`))
    }
  | None =>
    throw(JsError.throwWithMessage(`tiers.json: mode '${modeName}.defaultTier' must be a string`))
  }

  // description: required, must be a string
  switch Dict.get(mode, "description") {
  | Some(json) =>
    switch JSON.Decode.string(json) {
    | Some(_) => ()
    | None =>
      throw(JsError.throwWithMessage(`tiers.json: mode '${modeName}.description' must be a string`))
    }
  | None =>
    throw(JsError.throwWithMessage(`tiers.json: mode '${modeName}.description' must be a string`))
  }
}

// ---------------------------------------------------------------------------
// validateModes
// Validates the top-level modes block: must be an object if present.
// Iterates over each mode entry and calls validateMode.
// ---------------------------------------------------------------------------

let validateModes = (obj: dict<JSON.t>): unit => {
  // modes is optional — return early if absent
  switch Dict.get(obj, "modes") {
  | Some(json) => {
      // modes must be an object (not null, array, etc.)
      ensureIsObject(json, "'modes'")
      switch JSON.Decode.object(json) {
      | Some(modes) => {
          let keys = Dict.keysToArray(modes)
          let rec go = (keys: list<string>): unit =>
            switch keys {
            | list{} => ()
            | list{k, ...rest} =>
              switch Dict.get(modes, k) {
              | Some(modeJson) =>
                switch JSON.Decode.object(modeJson) {
                | Some(mode) => {
                    validateMode(k, mode)
                    go(rest)
                  }
                | None =>
                  throw(JsError.throwWithMessage(`tiers.json: mode '${k}' must be an object`))
                }
              | None => go(rest)
              }
            }
          go(List.fromArray(keys))
        }
      | None => throw(JsError.throwWithMessage("tiers.json: 'modes' must be a non-null object"))
      }
    }
  | None => ()
  }
}
