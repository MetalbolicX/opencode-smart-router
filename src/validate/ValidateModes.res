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
let ensureIsConfigObject = (obj: Js.Dict.t<Js.Json.t>): unit => {
  if %raw(`!(obj && typeof obj === 'object' && !Array.isArray(obj))`) {
    raise(
      Js.Exn.raiseError("tiers.json: expected a JSON object at root"),
    )
  }
}

// Guard: throws if val is not a plain object
let ensureIsObject = (val: Js.Json.t, path: string): unit => {
  if %raw(`!(val && typeof val === 'object' && !Array.isArray(val))`) {
    raise(Js.Exn.raiseError(`tiers.json: ${path} must be an object`))
  }
}

// ---------------------------------------------------------------------------
// validateMode
// Validates a single mode: must be an object; defaultTier/description must be strings.
// ---------------------------------------------------------------------------

let validateMode = (modeName: string, mode: Js.Dict.t<Js.Json.t>): unit => {
  // Guard: mode must be a non-null object (not null, number, string, etc.)
  // Js.Dict.get uses the 'in' operator internally which throws for non-objects,
  // so we must check upfront.
  if %raw(`!(mode && typeof mode === 'object' && !Array.isArray(mode))`) {
    raise(Js.Exn.raiseError(`tiers.json: mode '${modeName}' must be an object`))
  }

  // defaultTier: required, must be a string
  switch Js.Dict.get(mode, "defaultTier") {
  | Some(json) =>
    switch Js.Json.decodeString(json) {
    | Some(_) => ()
    | None =>
      raise(
        Js.Exn.raiseError(
          `tiers.json: mode '${modeName}.defaultTier' must be a string`,
        ),
      )
    }
  | None =>
    raise(
      Js.Exn.raiseError(
        `tiers.json: mode '${modeName}.defaultTier' must be a string`,
      ),
    )
  }

  // description: required, must be a string
  switch Js.Dict.get(mode, "description") {
  | Some(json) =>
    switch Js.Json.decodeString(json) {
    | Some(_) => ()
    | None =>
      raise(
        Js.Exn.raiseError(
          `tiers.json: mode '${modeName}.description' must be a string`,
        ),
      )
    }
  | None =>
    raise(
      Js.Exn.raiseError(
        `tiers.json: mode '${modeName}.description' must be a string`,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// validateModes
// Validates the top-level modes block: must be an object if present.
// Iterates over each mode entry and calls validateMode.
// ---------------------------------------------------------------------------

let validateModes = (obj: Js.Dict.t<Js.Json.t>): unit => {
  // modes is optional — return early if absent
  switch Js.Dict.get(obj, "modes") {
  | Some(json) => {
      // modes must be an object (not null, array, etc.)
      ensureIsObject(json, "'modes'")
      switch Js.Json.decodeObject(json) {
      | Some(modes) => {
          let keys = Js.Dict.keys(modes)
          let rec go = (keys: list<string>): unit =>
            switch keys {
            | list{} => ()
            | list{k, ...rest} =>
              switch Js.Dict.get(modes, k) {
              | Some(modeJson) =>
                switch Js.Json.decodeObject(modeJson) {
                | Some(mode) => {
                    validateMode(k, mode)
                    go(rest)
                  }
                | None =>
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: mode '${k}' must be an object`,
                    ),
                  )
                }
              | None => go(rest)
              }
            }
          go(List.fromArray(keys))
        }
      | None =>
        raise(
          Js.Exn.raiseError("tiers.json: 'modes' must be a non-null object"),
        )
      }
    }
  | None => ()
  }
}
