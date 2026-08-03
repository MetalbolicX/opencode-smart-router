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
    } else if Array.getUnsafe(arr, i) == s {
      true
    } else {
      go(i + 1)
    }
  }
  go(0)
}

// Check if a value is a valid reasoning level string
let isReasoningLevel = (v: JSON.t): bool => {
  switch JSON.Decode.string(v) {
  | Some(s) => stringInArray(s, reasoningLevels)
  | None => false
  }
}

// Guard: throws if val is not a plain object (for sub-object checks)
let _ensureIsObjectVal = (val: JSON.t, path: string): unit => {
  if JSON.Decode.object(val)->Option.isNone {
    throw(JsError.throwWithMessage(`tiers.json: ${path} must be an object`))
  }
}

// Test if a string is a valid regex via RegExp.fromString
let _testRegex = (s: string): bool => {
  try {
    let _ = RegExp.fromString(s)
    true
  } catch {
  | _ => false
  }
}

// ---------------------------------------------------------------------------
// All exported validators — mutually recursive via `and`
// Order matters: functions must be defined before they are called.
// ---------------------------------------------------------------------------

// validateKeywordRule must come before validateKeywordRules (called by it)
let rec validateKeywordRule = (ruleJson: JSON.t, index: int): unit => {
  let prefix = `reasoningPolicy.adaptive.keywordRules[${Belt.Int.toString(index)}]`
  if JSON.Decode.object(ruleJson)->Option.isNone {
    throw(JsError.throwWithMessage(`tiers.json: ${prefix} must be an object`))
  }
  switch JSON.Decode.object(ruleJson) {
  | Some(rule) => {
      // keywords: REQUIRED, non-empty array of strings
      switch Dict.get(rule, "keywords") {
      | Some(kwJson) =>
        switch JSON.Decode.array(kwJson) {
        | Some(kws) => {
            if Array.length(kws) === 0 {
              throw(
                JsError.throwWithMessage(
                  `tiers.json: ${prefix}.keywords must be a non-empty array of strings`,
                ),
              )
            }
            let rec goKw = (i: int): unit => {
              if i >= Array.length(kws) {
                ()
              } else {
                let kw = Array.getUnsafe(kws, i)
                switch JSON.Decode.string(kw) {
                | Some(_) => goKw(i + 1)
                | None =>
                  throw(
                    JsError.throwWithMessage(
                      `tiers.json: ${prefix}.keywords must be an array of strings`,
                    ),
                  )
                }
              }
            }
            goKw(0)
          }
        | None =>
          throw(
            JsError.throwWithMessage(`tiers.json: ${prefix}.keywords must be an array of strings`),
          )
        }
      | None =>
        throw(
          JsError.throwWithMessage(`tiers.json: ${prefix}.keywords must be an array of strings`),
        )
      }

      // level: REQUIRED, must be in the level set
      switch Dict.get(rule, "level") {
      | Some(lvlJson) =>
        if !isReasoningLevel(lvlJson) {
          throw(
            JsError.throwWithMessage(
              `tiers.json: ${prefix}.level must be one of minimal|normal|elevated|max (got ${JSON.stringify(
                  lvlJson,
                )})`,
            ),
          )
        }
      | None =>
        throw(
          JsError.throwWithMessage(
            `tiers.json: ${prefix}.level must be one of minimal|normal|elevated|max`,
          ),
        )
      }

      // match: OPTIONAL; must be one of the four mode literals
      switch Dict.get(rule, "match") {
      | Some(matchJson) =>
        switch JSON.Decode.string(matchJson) {
        | Some(m) =>
          if !stringInArray(m, matchModes) {
            throw(
              JsError.throwWithMessage(
                `tiers.json: ${prefix}.match must be one of word|stem|substring|regex (got ${JSON.stringify(
                    matchJson,
                  )})`,
              ),
            )
          }
        | None =>
          throw(
            JsError.throwWithMessage(
              `tiers.json: ${prefix}.match must be one of word|stem|substring|regex (got ${JSON.stringify(
                  matchJson,
                )})`,
            ),
          )
        }
      | None => ()
      }

      // excludeKeywords: OPTIONAL; array of strings (may be empty)
      switch Dict.get(rule, "excludeKeywords") {
      | Some(exJson) =>
        switch JSON.Decode.array(exJson) {
        | Some(exs) => {
            let rec goEx = (i: int): unit => {
              if i >= Array.length(exs) {
                ()
              } else {
                let ex = Array.getUnsafe(exs, i)
                switch JSON.Decode.string(ex) {
                | Some(_) => goEx(i + 1)
                | None =>
                  throw(
                    JsError.throwWithMessage(
                      `tiers.json: ${prefix}.excludeKeywords must be an array of strings`,
                    ),
                  )
                }
              }
            }
            goEx(0)
          }
        | None =>
          throw(
            JsError.throwWithMessage(
              `tiers.json: ${prefix}.excludeKeywords must be an array of strings`,
            ),
          )
        }
      | None => ()
      }

      // regex fail-fast: any keyword with match === "regex" must compile
      switch Dict.get(rule, "match") {
      | Some(matchJson) =>
        switch JSON.Decode.string(matchJson) {
        | Some("regex") => switch Dict.get(rule, "keywords") {
          | Some(kwJson) =>
            switch JSON.Decode.array(kwJson) {
            | Some(kws) => {
                let rec goRegex = (i: int): unit => {
                  if i >= Array.length(kws) {
                    ()
                  } else {
                    let kw = Array.getUnsafe(kws, i)
                    switch JSON.Decode.string(kw) {
                    | Some(kwStr) => {
                        // Validate regex by calling the helper with the captured kwStr
                        let valid = _testRegex(kwStr)
                        if !valid {
                          throw(
                            JsError.throwWithMessage(
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
        | _ => ()
        }
      | None => ()
      }
    }
  | None => throw(JsError.throwWithMessage(`tiers.json: ${prefix} must be an object`))
  }
}

and validateKeywordRules = (adaptive: dict<JSON.t>): unit => {
  switch Dict.get(adaptive, "keywordRules") {
  | Some(json) =>
    switch JSON.Decode.array(json) {
    | Some(rules) => {
        let rec go = (i: int): unit => {
          if i >= Array.length(rules) {
            ()
          } else {
            let ruleJson = Array.getUnsafe(rules, i)
            validateKeywordRule(ruleJson, i)
            go(i + 1)
          }
        }
        go(0)
      }
    | None =>
      throw(
        JsError.throwWithMessage(
          "tiers.json: reasoningPolicy.adaptive.keywordRules must be an array",
        ),
      )
    }
  | None => ()
  }
}

and validateAdaptiveTierDefaults = (adaptive: dict<JSON.t>): unit => {
  switch Dict.get(adaptive, "tierDefaults") {
  | Some(json) => {
      if JSON.Decode.object(json)->Option.isNone {
        throw(
          JsError.throwWithMessage(
            "tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object",
          ),
        )
      }
      switch JSON.Decode.object(json) {
      | Some(td) => {
          let keys = Dict.keysToArray(td)
          let rec go = (i: int): unit => {
            if i >= Array.length(keys) {
              ()
            } else {
              let k = Array.getUnsafe(keys, i)
              switch Dict.get(td, k) {
              | Some(lvlJson) =>
                if !isReasoningLevel(lvlJson) {
                  throw(
                    JsError.throwWithMessage(
                      `tiers.json: reasoningPolicy.adaptive.tierDefaults.${k} must be one of minimal|normal|elevated|max (got ${JSON.stringify(
                          lvlJson,
                        )})`,
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
        throw(
          JsError.throwWithMessage(
            "tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object",
          ),
        )
      }
    }
  | None => ()
  }
}

and validateAdaptiveSurfaceDecision = (adaptive: dict<JSON.t>): unit => {
  switch Dict.get(adaptive, "surfaceDecision") {
  | Some(sdJson) =>
    switch JSON.Decode.bool(sdJson) {
    | Some(_) => ()
    | None =>
      throw(
        JsError.throwWithMessage(
          `tiers.json: reasoningPolicy.adaptive.surfaceDecision must be a boolean (got ${JSON.stringify(
              sdJson,
            )})`,
        ),
      )
    }
  | None => ()
  }
}

and validateLevelOrNull = (obj: dict<JSON.t>, key: string, path: string): unit => {
  switch Dict.get(obj, key) {
  | Some(json) =>
    switch JSON.Decode.null(json) {
    | Some(_) => () // null is allowed
    | None =>
      if !isReasoningLevel(json) {
        throw(
          JsError.throwWithMessage(
            `tiers.json: ${path} must be one of minimal|normal|elevated|max or null (got ${JSON.stringify(
                json,
              )})`,
          ),
        )
      }
    }
  | None => ()
  }
}

and validateAdaptivePolicy = (policy: dict<JSON.t>): unit => {
  switch Dict.get(policy, "adaptive") {
  | Some(json) => {
      if JSON.Decode.object(json)->Option.isNone {
        throw(JsError.throwWithMessage("tiers.json: reasoningPolicy.adaptive must be an object"))
      }
      switch JSON.Decode.object(json) {
      | Some(adaptive) => {
          validateLevelOrNull(adaptive, "trivialLevel", "reasoningPolicy.adaptive.trivialLevel")
          validateLevelOrNull(adaptive, "defaultLevel", "reasoningPolicy.adaptive.defaultLevel")
          validateKeywordRules(adaptive)
          validateAdaptiveTierDefaults(adaptive)
          validateAdaptiveSurfaceDecision(adaptive)
        }
      | None =>
        throw(JsError.throwWithMessage("tiers.json: reasoningPolicy.adaptive must be an object"))
      }
    }
  | None => ()
  }
}

and validateReasoningPolicyMode = (policy: dict<JSON.t>): unit => {
  switch Dict.get(policy, "mode") {
  | Some(modeJson) =>
    switch JSON.Decode.string(modeJson) {
    | Some(mode) =>
      if !stringInArray(mode, reasoningModes) {
        throw(
          JsError.throwWithMessage(
            `tiers.json: reasoningPolicy.mode must be one of static|manual|adaptive (got ${JSON.stringify(
                modeJson,
              )})`,
          ),
        )
      }
    | None =>
      throw(
        JsError.throwWithMessage(
          `tiers.json: reasoningPolicy.mode must be one of static|manual|adaptive (got ${JSON.stringify(
              modeJson,
            )})`,
        ),
      )
    }
  | None => ()
  }
}

and validateReasoningPolicy = (obj: dict<JSON.t>): unit => {
  switch Dict.get(obj, "reasoningPolicy") {
  | Some(json) => {
      if JSON.Decode.object(json)->Option.isNone {
        throw(JsError.throwWithMessage("tiers.json: 'reasoningPolicy' must be an object"))
      }
      switch JSON.Decode.object(json) {
      | Some(policy) => {
          validateReasoningPolicyMode(policy)
          validateAdaptivePolicy(policy)
        }
      | None => throw(JsError.throwWithMessage("tiers.json: 'reasoningPolicy' must be an object"))
      }
    }
  | None => ()
  }
}
