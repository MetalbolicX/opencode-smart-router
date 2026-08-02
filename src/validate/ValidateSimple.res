// ---------------------------------------------------------------------------
// ValidateSimple.res — SIMPLE section validators ported from config-validate.ts.
//
// Ports the SIMPLE section from src/router/config-validate.ts:
//   - validateTierCaps: tierCaps values must be positive integers (>= 1)
//   - validateTierPrompts: tierPrompts values must be strings
//   - validateTaskPatterns: taskPatterns values must be arrays of strings
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

// Guard: throws if val is not a plain object (used for sub-object checks)
let ensureIsObject = (val: Js.Json.t, path: string): unit => {
  if %raw(`!(val && typeof val === 'object' && !Array.isArray(val))`) {
    raise(Js.Exn.raiseError(`tiers.json: ${path} must be an object`))
  }
}

// ---------------------------------------------------------------------------
// validateTierCaps
// Validates the tierCaps block: each value must be a finite positive integer (>= 1).
// tierCaps is optional — returns early if absent.
// ---------------------------------------------------------------------------

let validateTierCaps = (obj: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(obj, "tierCaps") {
  | Some(json) => {
      ensureIsObject(json, "'tierCaps'")
      switch Js.Json.decodeObject(json) {
      | Some(caps) => {
          let keys = Js.Dict.keys(caps)
          let rec go = (keys: list<string>): unit =>
            switch keys {
            | list{} => ()
            | list{k, ...rest} =>
              switch Js.Dict.get(caps, k) {
              | Some(capJson) =>
                switch Js.Json.decodeNumber(capJson) {
                | Some(cap) =>
                  // Must be finite and >= 1
                  if %raw(`!(Number.isFinite(cap) && cap >= 1)`) {
                    raise(
                      Js.Exn.raiseError(
                        `tiers.json: tierCaps.'${k}' must be a positive integer`,
                      ),
                    )
                  } else {
                    go(rest)
                  }
                | None =>
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: tierCaps.'${k}' must be a positive integer`,
                    ),
                  )
                }
              | None => go(rest)
              }
            }
          go(List.fromArray(keys))
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: 'tierCaps' must be a non-null object"))
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateTierPrompts
// Validates the tierPrompts block: each value must be a string.
// tierPrompts is optional — returns early if absent.
// ---------------------------------------------------------------------------

let validateTierPrompts = (obj: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(obj, "tierPrompts") {
  | Some(json) => {
      ensureIsObject(json, "'tierPrompts'")
      switch Js.Json.decodeObject(json) {
      | Some(prompts) => {
          let keys = Js.Dict.keys(prompts)
          let rec go = (keys: list<string>): unit =>
            switch keys {
            | list{} => ()
            | list{k, ...rest} =>
              switch Js.Dict.get(prompts, k) {
              | Some(promptJson) =>
                switch Js.Json.decodeString(promptJson) {
                | Some(_) => go(rest)
                | None =>
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: tierPrompts.'${k}' must be a string`,
                    ),
                  )
                }
              | None => go(rest)
              }
            }
          go(List.fromArray(keys))
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: 'tierPrompts' must be a non-null object"))
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateTaskPatterns
// Validates the taskPatterns block: each value must be an array of strings.
// taskPatterns is optional — returns early if absent.
// ---------------------------------------------------------------------------

let validateTaskPatterns = (obj: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(obj, "taskPatterns") {
  | Some(json) => {
      ensureIsObject(json, "'taskPatterns'")
      switch Js.Json.decodeObject(json) {
      | Some(patterns) => {
          let keys = Js.Dict.keys(patterns)
          let rec go = (keys: list<string>): unit =>
            switch keys {
            | list{} => ()
            | list{k, ...rest} =>
              switch Js.Dict.get(patterns, k) {
              | Some(patternsJson) =>
                switch Js.Json.decodeArray(patternsJson) {
                | Some(_) => go(rest)
                | None =>
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: taskPatterns.'${k}' must be an array of strings`,
                    ),
                  )
                }
              | None => go(rest)
              }
            }
          go(List.fromArray(keys))
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: 'taskPatterns' must be a non-null object"))
      }
    }
  | None => ()
  }
}
