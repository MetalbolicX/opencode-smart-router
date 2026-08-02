// ---------------------------------------------------------------------------
// ValidateReasoning.res — REASONING section validators ported from config-validate.ts.
//
// Ports the REASONING section from src/router/config-validate.ts:
//   - validateReasoningPolicy: top-level dispatcher
//   - validateReasoningPolicyMode: reasoningPolicy.mode in {static,manual,adaptive}
//   - validateAdaptivePolicy: reasoningPolicy.adaptive block validation
//   - validateKeywordRules: adaptive.keywordRules array validation
//   - validateKeywordRule: individual keyword rule validation (with regex fail-fast)
//   - validateAdaptiveTierDefaults: adaptive.tierDefaults object validation
//   - validateAdaptiveSurfaceDecision: adaptive.surfaceDecision boolean validation
//
// Input type is Js.Dict.t<Js.Json.t> which maps to TS Record<string, unknown>.
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants (mirrors TS REASONING_MODES, REASONING_LEVELS, MATCH_MODES)
// ---------------------------------------------------------------------------

let reasoningModes: array<string> = ["static", "manual", "adaptive"]
let reasoningLevels: array<string> = ["minimal", "normal", "elevated", "max"]
let matchModes: array<string> = ["word", "stem", "substring", "regex"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Check if a string is in an array
let stringInArray = (s: string, arr: array<string>): bool => {
  let rec go = (i: int): bool => {
    if i >= Array.length(arr) {
      false
    } else if Array.unsafe_get(arr, i) == s {
      true
    } else {
      go(i + 1)
    }
  }
  go(0)
}

// Check if a value is a valid reasoning level string
let isReasoningLevel = (v: Js.Json.t): bool => {
  switch Js.Json.decodeString(v) {
  | Some(s) => stringInArray(s, reasoningLevels)
  | None => false
  }
}

// Guard: throws if val is not a plain object (for sub-object checks)
let ensureIsObjectVal = (val: Js.Json.t, path: string): unit => {
  if %raw(`!(val && typeof val === 'object' && !Array.isArray(val))`) {
    raise(Js.Exn.raiseError(`tiers.json: ${path} must be an object`))
  }
}

// Test if a string is a valid regex via new RegExp()
let _testRegex = (s: string): bool => {
  %raw(`(function(s) { try { new RegExp(s); return true; } catch(e) { return false; } })(arguments[0])`)
}

// ---------------------------------------------------------------------------
// All exported validators — mutually recursive via `and`
// Order matters: functions must be defined before they are called.
// ---------------------------------------------------------------------------

// validateKeywordRule must come before validateKeywordRules (called by it)
let rec validateKeywordRule = (ruleJson: Js.Json.t, index: int): unit => {
  let prefix = `reasoningPolicy.adaptive.keywordRules[${Belt.Int.toString(index)}]`
  if %raw(`!(ruleJson && typeof ruleJson === 'object' && !Array.isArray(ruleJson))`) {
    raise(Js.Exn.raiseError(`tiers.json: ${prefix} must be an object`))
  }
  switch Js.Json.decodeObject(ruleJson) {
  | Some(rule) => {
      // keywords: REQUIRED, non-empty array of strings
      switch Js.Dict.get(rule, "keywords") {
      | Some(kwJson) =>
        switch Js.Json.decodeArray(kwJson) {
        | Some(kws) => {
            if Js.Array.length(kws) === 0 {
              raise(
                Js.Exn.raiseError(`tiers.json: ${prefix}.keywords must be a non-empty array of strings`),
              )
            }
            let rec goKw = (i: int): unit => {
              if i >= Js.Array.length(kws) {
                ()
              } else {
                let kw = Js.Array.unsafe_get(kws, i)
                switch Js.Json.decodeString(kw) {
                | Some(_) => goKw(i + 1)
                | None =>
                  raise(Js.Exn.raiseError(`tiers.json: ${prefix}.keywords must be an array of strings`))
                }
              }
            }
            goKw(0)
          }
        | None =>
          raise(Js.Exn.raiseError(`tiers.json: ${prefix}.keywords must be an array of strings`))
        }
      | None =>
        raise(Js.Exn.raiseError(`tiers.json: ${prefix}.keywords must be an array of strings`))
      }

      // level: REQUIRED, must be in the level set
      switch Js.Dict.get(rule, "level") {
      | Some(lvlJson) =>
        if !isReasoningLevel(lvlJson) {
          raise(
            Js.Exn.raiseError(
              `tiers.json: ${prefix}.level must be one of minimal|normal|elevated|max (got ${Js.Json.stringify(lvlJson)})`,
            ),
          )
        }
      | None =>
        raise(
          Js.Exn.raiseError(
            `tiers.json: ${prefix}.level must be one of minimal|normal|elevated|max`,
          ),
        )
      }

      // match: OPTIONAL; must be one of the four mode literals
      switch Js.Dict.get(rule, "match") {
      | Some(matchJson) =>
        switch Js.Json.decodeString(matchJson) {
        | Some(m) =>
          if !stringInArray(m, matchModes) {
            raise(
              Js.Exn.raiseError(
                `tiers.json: ${prefix}.match must be one of word|stem|substring|regex (got ${Js.Json.stringify(matchJson)})`,
              ),
            )
          }
        | None =>
          raise(
            Js.Exn.raiseError(
              `tiers.json: ${prefix}.match must be one of word|stem|substring|regex (got ${Js.Json.stringify(matchJson)})`,
            ),
          )
        }
      | None => ()
      }

      // excludeKeywords: OPTIONAL; array of strings (may be empty)
      switch Js.Dict.get(rule, "excludeKeywords") {
      | Some(exJson) =>
        switch Js.Json.decodeArray(exJson) {
        | Some(exs) => {
            let rec goEx = (i: int): unit => {
              if i >= Js.Array.length(exs) {
                ()
              } else {
                let ex = Js.Array.unsafe_get(exs, i)
                switch Js.Json.decodeString(ex) {
                | Some(_) => goEx(i + 1)
                | None =>
                  raise(
                    Js.Exn.raiseError(`tiers.json: ${prefix}.excludeKeywords must be an array of strings`),
                  )
                }
              }
            }
            goEx(0)
          }
        | None =>
          raise(
            Js.Exn.raiseError(`tiers.json: ${prefix}.excludeKeywords must be an array of strings`),
          )
        }
      | None => ()
      }

      // regex fail-fast: any keyword with match === "regex" must compile
      switch Js.Dict.get(rule, "match") {
      | Some(matchJson) =>
        switch Js.Json.decodeString(matchJson) {
        | Some("regex") => {
            switch Js.Dict.get(rule, "keywords") {
            | Some(kwJson) =>
              switch Js.Json.decodeArray(kwJson) {
              | Some(kws) => {
                  let rec goRegex = (i: int): unit => {
                    if i >= Js.Array.length(kws) {
                      ()
                    } else {
                      let kw = Js.Array.unsafe_get(kws, i)
                      switch Js.Json.decodeString(kw) {
                      | Some(kwStr) => {
                          // Validate regex by calling the helper with the captured kwStr
                          let valid = _testRegex(kwStr)
                          if !valid {
                            raise(
                              Js.Exn.raiseError(
                                `tiers.json: ${prefix} has invalid regex '${kwStr}'`,
                              ),
                            )
                          }
                          goRegex(i + 1)
                        }
                      | None => goRegex(i + 1)
                      }
                    }
                  }
                  goRegex(0)
                }
              | None => ()
              }
            | None => ()
            }
          }
        | _ => ()
        }
      | None => ()
      }
    }
  | None =>
    raise(Js.Exn.raiseError(`tiers.json: ${prefix} must be an object`))
  }
}

and validateKeywordRules = (adaptive: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(adaptive, "keywordRules") {
  | Some(json) =>
    switch Js.Json.decodeArray(json) {
    | Some(rules) => {
        let rec go = (i: int): unit => {
          if i >= Js.Array.length(rules) {
            ()
          } else {
            let ruleJson = Js.Array.unsafe_get(rules, i)
            validateKeywordRule(ruleJson, i)
            go(i + 1)
          }
        }
        go(0)
      }
    | None =>
      raise(Js.Exn.raiseError("tiers.json: reasoningPolicy.adaptive.keywordRules must be an array"))
    }
  | None => ()
  }
}

and validateAdaptiveTierDefaults = (adaptive: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(adaptive, "tierDefaults") {
  | Some(json) => {
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        raise(Js.Exn.raiseError("tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object"))
      }
      switch Js.Json.decodeObject(json) {
      | Some(td) => {
          let keys = Js.Dict.keys(td)
          let rec go = (i: int): unit => {
            if i >= Js.Array.length(keys) {
              ()
            } else {
              let k = Js.Array.unsafe_get(keys, i)
              switch Js.Dict.get(td, k) {
              | Some(lvlJson) =>
                if !isReasoningLevel(lvlJson) {
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: reasoningPolicy.adaptive.tierDefaults.${k} must be one of minimal|normal|elevated|max (got ${Js.Json.stringify(lvlJson)})`,
                    ),
                  )
                }
              | None => ()
              }
              go(i + 1)
            }
          }
          go(0)
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object"))
      }
    }
  | None => ()
  }
}

and validateAdaptiveSurfaceDecision = (adaptive: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(adaptive, "surfaceDecision") {
  | Some(sdJson) =>
    switch Js.Json.decodeBoolean(sdJson) {
    | Some(_) => ()
    | None =>
      raise(
        Js.Exn.raiseError(
          `tiers.json: reasoningPolicy.adaptive.surfaceDecision must be a boolean (got ${Js.Json.stringify(sdJson)})`,
        ),
      )
    }
  | None => ()
  }
}

and validateLevelOrNull = (obj: Js.Dict.t<Js.Json.t>, key: string, path: string): unit => {
  switch Js.Dict.get(obj, key) {
  | Some(json) =>
    if %raw(`json === null`) {
      () // null is allowed
    } else if !isReasoningLevel(json) {
      raise(
        Js.Exn.raiseError(
          `tiers.json: ${path} must be one of minimal|normal|elevated|max or null (got ${Js.Json.stringify(json)})`,
        ),
      )
    } else {
      ()
    }
  | None => ()
  }
}

and validateAdaptivePolicy = (policy: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(policy, "adaptive") {
  | Some(json) => {
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        raise(Js.Exn.raiseError("tiers.json: reasoningPolicy.adaptive must be an object"))
      }
      switch Js.Json.decodeObject(json) {
      | Some(adaptive) => {
          validateLevelOrNull(adaptive, "trivialLevel", "reasoningPolicy.adaptive.trivialLevel")
          validateLevelOrNull(adaptive, "defaultLevel", "reasoningPolicy.adaptive.defaultLevel")
          validateKeywordRules(adaptive)
          validateAdaptiveTierDefaults(adaptive)
          validateAdaptiveSurfaceDecision(adaptive)
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: reasoningPolicy.adaptive must be an object"))
      }
    }
  | None => ()
  }
}

and validateReasoningPolicyMode = (policy: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(policy, "mode") {
  | Some(modeJson) =>
    switch Js.Json.decodeString(modeJson) {
    | Some(mode) =>
      if !stringInArray(mode, reasoningModes) {
        raise(
          Js.Exn.raiseError(
            `tiers.json: reasoningPolicy.mode must be one of static|manual|adaptive (got ${Js.Json.stringify(modeJson)})`,
          ),
        )
      }
    | None =>
      raise(
        Js.Exn.raiseError(
          `tiers.json: reasoningPolicy.mode must be one of static|manual|adaptive (got ${Js.Json.stringify(modeJson)})`,
        ),
      )
    }
  | None => ()
  }
}

and validateReasoningPolicy = (obj: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(obj, "reasoningPolicy") {
  | Some(json) => {
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        raise(Js.Exn.raiseError("tiers.json: 'reasoningPolicy' must be an object"))
      }
      switch Js.Json.decodeObject(json) {
      | Some(policy) => {
          validateReasoningPolicyMode(policy)
          validateAdaptivePolicy(policy)
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: 'reasoningPolicy' must be an object"))
      }
    }
  | None => ()
  }
}
