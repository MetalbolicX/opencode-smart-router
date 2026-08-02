// ---------------------------------------------------------------------------
// ValidatePresets.res — PRESETS section validators ported from config-validate.ts.
//
// Ports the PRESETS section from src/router/config-validate.ts:
//   - validatePresets: presets must be a non-null object with at least one key
//   - validatePreset: each preset must be an object, iterates over tiers
//   - validateTier: tier.model (non-empty + provider/model slash),
//     description (string), whenToUse (array)
//
// Input type is Js.Dict.t<Js.Json.t> which maps to TS Record<string, unknown>.
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Helper: extract a string field from a dict, returning "" if absent or non-string.
let getStringField = (dict: Js.Dict.t<Js.Json.t>, key: string): string => {
  switch Js.Dict.get(dict, key) {
  | None => ""
  | Some(json) =>
    switch Js.Json.decodeString(json) {
    | Some(s) => s
    | None => ""
    }
  }
}

// ---------------------------------------------------------------------------
// validateTier
// Validates a tier object: model (non-empty string + slash format),
// description (string), whenToUse (array).
// ---------------------------------------------------------------------------

// Guard: throws if tier is not a plain object (not null, string, number, etc.)
// Js.Dict.get uses the 'in' operator internally which throws for non-objects,
// so we must check upfront.
let ensureIsObject = (tier: Js.Dict.t<Js.Json.t>, presetName: string, tierName: string): unit => {
  if %raw(`!(tier && typeof tier === 'object' && !Array.isArray(tier))`) {
    raise(
      Js.Exn.raiseError(
        `tiers.json: tier '${presetName}.${tierName}' must be an object`,
      ),
    )
  }
}

let validateTier = (presetName: string, tierName: string, tier: Js.Dict.t<Js.Json.t>): unit => {
  // Guard: tier must be a non-null object (not a primitive like string/number/null)
  ensureIsObject(tier, presetName, tierName)

  // model: required, non-empty string
  let modelVal = getStringField(tier, "model")
  if modelVal === "" {
    raise(
      Js.Exn.raiseError(
        `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
      ),
    )
  }

  // provider/model slash predicate: slash must be present and not at boundaries
  // slash <= 0 covers missing-or-leading slash; slash >= length-1 covers missing-or-trailing
  let slashIdx = modelVal->String.indexOf("/")
  if slashIdx <= 0 || slashIdx >= modelVal->String.length - 1 {
    raise(
      Js.Exn.raiseError(
        `tiers.json: '${presetName}.${tierName}.model' must be provider/model (got ${modelVal})`,
      ),
    )
  }

  // description: required, must be a string
  let descVal = getStringField(tier, "description")
  if descVal === "" {
    raise(
      Js.Exn.raiseError(
        `tiers.json: '${presetName}.${tierName}.description' must be a string`,
      ),
    )
  }

  // whenToUse: required, must be an array
  switch Js.Dict.get(tier, "whenToUse") {
  | Some(json) =>
    switch Js.Json.decodeArray(json) {
    | Some(_) => ()
    | None =>
      raise(
        Js.Exn.raiseError(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        ),
      )
    }
  | None =>
    raise(
      Js.Exn.raiseError(
        `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// validatePreset
// Validates that a preset is a non-null object and checks each tier.
// ---------------------------------------------------------------------------

// Guard: throws if preset is not a plain object
let ensurePresetIsObject = (preset: Js.Dict.t<Js.Json.t>, presetName: string): unit => {
  if %raw(`!(preset && typeof preset === 'object' && !Array.isArray(preset))`) {
    raise(
      Js.Exn.raiseError(`tiers.json: preset '${presetName}' must be an object`),
    )
  }
}

let validatePreset = (presetName: string, preset: Js.Dict.t<Js.Json.t>): unit => {
  // Guard: preset must be a non-null object (not number, string, null, etc.)
  ensurePresetIsObject(preset, presetName)
  let keys = List.fromArray(Js.Dict.keys(preset))
  let rec go = (keys: list<string>): unit =>
    switch keys {
    | list{} => ()
    | list{k, ...rest} =>
      switch Js.Dict.get(preset, k) {
      | Some(tierJson) =>
        switch Js.Json.decodeObject(tierJson) {
        | Some(tier) => {
            validateTier(presetName, k, tier)
            go(rest)
          }
        | None =>
          raise(
            Js.Exn.raiseError(
              `tiers.json: tier '${presetName}.${k}' must be an object`,
            ),
          )
        }
      | None => go(rest)
      }
    }
  go(keys)
}

// ---------------------------------------------------------------------------
// validatePresets
// Validates that `presets` is a non-null object with at least one preset key,
// then validates each preset.
// ---------------------------------------------------------------------------

// Guard: throws if obj is not a plain object
let ensureIsConfigObject = (obj: Js.Dict.t<Js.Json.t>): unit => {
  if %raw(`!(obj && typeof obj === 'object' && !Array.isArray(obj))`) {
    raise(
      Js.Exn.raiseError("tiers.json: expected a JSON object at root"),
    )
  }
}

let validatePresets = (obj: Js.Dict.t<Js.Json.t>): unit => {
  // Guard: obj must be a non-null object
  ensureIsConfigObject(obj)
  switch Js.Dict.get(obj, "presets") {
  | Some(json) =>
    switch Js.Json.decodeObject(json) {
    | Some(presets) => {
        let keys = Js.Dict.keys(presets)
        switch Array.length(keys) {
        | 0 =>
          raise(
            Js.Exn.raiseError("tiers.json: 'presets' must have at least one preset"),
          )
        | _ => {
            let rec go = (keys: list<string>): unit =>
              switch keys {
              | list{} => ()
              | list{k, ...rest} =>
                switch Js.Dict.get(presets, k) {
                | Some(presetJson) =>
                  switch Js.Json.decodeObject(presetJson) {
                  | Some(preset) => {
                      validatePreset(k, preset)
                      go(rest)
                    }
                  | None =>
                    raise(
                      Js.Exn.raiseError(
                        `tiers.json: preset '${k}' must be an object`,
                      ),
                    )
                  }
                | None => go(rest)
                }
              }
            go(List.fromArray(keys))
          }
        }
      }
    | None =>
      raise(Js.Exn.raiseError("tiers.json: 'presets' must be a non-null object"))
    }
  | None =>
    raise(Js.Exn.raiseError("tiers.json: 'presets' must be a non-null object"))
  }
}
