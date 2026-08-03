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
let getStringField = (dict: dict<JSON.t>, key: string): string => {
  switch Dict.get(dict, key) {
  | None => ""
  | Some(json) =>
    switch JSON.Decode.string(json) {
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
let ensureIsObject = (_tier: dict<JSON.t>, presetName: string, tierName: string): unit => {
  if %raw(`!(tier && typeof tier === 'object' && !Array.isArray(tier))`) {
    throw(
      JsError.throwWithMessage(`tiers.json: tier '${presetName}.${tierName}' must be an object`),
    )
  }
}

let validateTier = (presetName: string, tierName: string, tier: dict<JSON.t>): unit => {
  // Guard: tier must be a non-null object (not a primitive like string/number/null)
  ensureIsObject(tier, presetName, tierName)

  // model: required, non-empty string
  let modelVal = getStringField(tier, "model")
  if modelVal === "" {
    throw(
      JsError.throwWithMessage(
        `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
      ),
    )
  }

  // provider/model slash predicate: slash must be present and not at boundaries
  // slash <= 0 covers missing-or-leading slash; slash >= length-1 covers missing-or-trailing
  let slashIdx = modelVal->String.indexOf("/")
  if slashIdx <= 0 || slashIdx >= modelVal->String.length - 1 {
    throw(
      JsError.throwWithMessage(
        `tiers.json: '${presetName}.${tierName}.model' must be provider/model (got ${modelVal})`,
      ),
    )
  }

  // description: required, must be a string
  let descVal = getStringField(tier, "description")
  if descVal === "" {
    throw(
      JsError.throwWithMessage(
        `tiers.json: '${presetName}.${tierName}.description' must be a string`,
      ),
    )
  }

  // whenToUse: required, must be an array
  switch Dict.get(tier, "whenToUse") {
  | Some(json) =>
    switch JSON.Decode.array(json) {
    | Some(_) => ()
    | None =>
      throw(
        JsError.throwWithMessage(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        ),
      )
    }
  | None =>
    throw(
      JsError.throwWithMessage(
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
let ensurePresetIsObject = (_preset: dict<JSON.t>, presetName: string): unit => {
  if %raw(`!(preset && typeof preset === 'object' && !Array.isArray(preset))`) {
    throw(JsError.throwWithMessage(`tiers.json: preset '${presetName}' must be an object`))
  }
}

let validatePreset = (presetName: string, preset: dict<JSON.t>): unit => {
  // Guard: preset must be a non-null object (not number, string, null, etc.)
  ensurePresetIsObject(preset, presetName)
  let keys = List.fromArray(Dict.keysToArray(preset))
  let rec go = (keys: list<string>): unit =>
    switch keys {
    | list{} => ()
    | list{k, ...rest} =>
      switch Dict.get(preset, k) {
      | Some(tierJson) =>
        switch JSON.Decode.object(tierJson) {
        | Some(tier) => {
            validateTier(presetName, k, tier)
            go(rest)
          }
        | None =>
          throw(JsError.throwWithMessage(`tiers.json: tier '${presetName}.${k}' must be an object`))
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
let ensureIsConfigObject = (_obj: dict<JSON.t>): unit => {
  if %raw(`!(obj && typeof obj === 'object' && !Array.isArray(obj))`) {
    throw(JsError.throwWithMessage("tiers.json: expected a JSON object at root"))
  }
}

let validatePresets = (obj: dict<JSON.t>): unit => {
  // Guard: obj must be a non-null object
  ensureIsConfigObject(obj)
  switch Dict.get(obj, "presets") {
  | Some(json) =>
    switch JSON.Decode.object(json) {
    | Some(presets) => {
        let keys = Dict.keysToArray(presets)
        switch Array.length(keys) {
        | 0 =>
          throw(JsError.throwWithMessage("tiers.json: 'presets' must have at least one preset"))
        | _ => {
            let rec go = (keys: list<string>): unit =>
              switch keys {
              | list{} => ()
              | list{k, ...rest} =>
                switch Dict.get(presets, k) {
                | Some(presetJson) =>
                  switch JSON.Decode.object(presetJson) {
                  | Some(preset) => {
                      validatePreset(k, preset)
                      go(rest)
                    }
                  | None =>
                    throw(JsError.throwWithMessage(`tiers.json: preset '${k}' must be an object`))
                  }
                | None => go(rest)
                }
              }
            go(List.fromArray(keys))
          }
        }
      }
    | None => throw(JsError.throwWithMessage("tiers.json: 'presets' must be a non-null object"))
    }
  | None => throw(JsError.throwWithMessage("tiers.json: 'presets' must be a non-null object"))
  }
}
