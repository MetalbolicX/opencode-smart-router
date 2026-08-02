// ---------------------------------------------------------------------------
// ValidateEnforcement.res — ENFORCEMENT section validators ported from config-validate.ts.
//
// Ports the ENFORCEMENT section from src/router/config-validate.ts:
//   - validateEnforcement: top-level dispatcher
//   - validateEnforcementMode: enforcement.mode in {off,advisory,enforced}
//   - validateEnforcementVerify: enforcement.verify block validation
//   - validateEnforcementEscalate: enforcement.escalate block validation
//   - validateEnforcementPerTier: enforcement.perTier block validation
//   - validateEnforcementGuard: enforcement.guard block validation
//
// Input type is Js.Dict.t<Js.Json.t> which maps to TS Record<string, unknown>.
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants (mirrors TS ENFORCEMENT_MODES and VERIFY_REQUIRE_MODES)
// ---------------------------------------------------------------------------

let enforcementModes: array<string> = ["off", "advisory", "enforced"]
let verifyRequireModes: array<string> = ["never", "whenDoDPresent", "always"]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Guard: throws if val is not a plain object (for sub-object checks in enforcement)
let ensureIsObjectVal = (val: Js.Json.t, path: string): unit => {
  if %raw(`!(val && typeof val === 'object' && !Array.isArray(val))`) {
    raise(Js.Exn.raiseError(`tiers.json: ${path} must be an object`))
  }
}

// Check if a string is in an array (used for mode validation)
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

// ---------------------------------------------------------------------------
// validateEnforcement — top-level dispatcher
// ---------------------------------------------------------------------------

let rec validateEnforcement = (obj: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(obj, "enforcement") {
  | Some(json) => {
      ensureIsObjectVal(json, "enforcement")
      switch Js.Json.decodeObject(json) {
      | Some(enf) => {
          validateEnforcementMode(enf)
          validateEnforcementVerify(enf)
          validateEnforcementEscalate(enf)
          validateEnforcementPerTier(enf)
          validateEnforcementGuard(enf)
        }
      | None =>
        raise(Js.Exn.raiseError("tiers.json: enforcement must be a non-null object"))
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementMode
// Validates enforcement.mode in {off, advisory, enforced}.
// Silently skips if absent (field is optional).
// Throws if mode is present but not a valid string value.
// ---------------------------------------------------------------------------

and validateEnforcementMode = (enf: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(enf, "mode") {
  | Some(modeJson) =>
    switch Js.Json.decodeString(modeJson) {
    | Some(mode) =>
      if !stringInArray(mode, enforcementModes) {
        raise(
          Js.Exn.raiseError(
            `tiers.json: enforcement.mode must be one of off|advisory|enforced`,
          ),
        )
      }
    | None =>
      raise(
        Js.Exn.raiseError(
          `tiers.json: enforcement.mode must be one of off|advisory|enforced`,
        ),
      )
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementVerify
// Validates enforcement.verify block (optional).
// Permissive: non-object verify values are silently ignored.
// Validates: require in {never,whenDoDPresent,always},
//   graderPolicy in {atLeastProducerTier}.
// ---------------------------------------------------------------------------

and validateEnforcementVerify = (enf: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(enf, "verify") {
  | Some(json) => {
      // Permissive skip: non-object verify is ignored so older configs survive.
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        ()
      } else {
        switch Js.Json.decodeObject(json) {
        | Some(verify) => {
            // Validate graderPolicy if present
            switch Js.Dict.get(verify, "graderPolicy") {
            | Some(gpJson) =>
              switch Js.Json.decodeString(gpJson) {
              | Some(gp) =>
                if gp != "atLeastProducerTier" {
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"`,
                    ),
                  )
                }
              | None =>
                raise(
                  Js.Exn.raiseError(
                    `tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"`,
                  ),
                )
              }
            | None => ()
            }
            // Validate require if present
            switch Js.Dict.get(verify, "require") {
            | Some(reqJson) =>
              switch Js.Json.decodeString(reqJson) {
              | Some(req) =>
                if !stringInArray(req, verifyRequireModes) {
                  raise(
                    Js.Exn.raiseError(
                      `tiers.json: enforcement.verify.require must be one of never|whenDoDPresent|always`,
                    ),
                  )
                }
              | None =>
                raise(
                  Js.Exn.raiseError(
                    `tiers.json: enforcement.verify.require must be one of never|whenDoDPresent|always (got ${Js.Json.stringify(reqJson)})`,
                  ),
                )
              }
            | None => ()
            }
          }
        | None => ()
        }
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementEscalate
// Validates enforcement.escalate block (optional).
// Permissive: non-object escalate values are silently ignored.
// Validates: ladder (array of strings), maxAttemptsPerTier (integer >= 0),
//   maxTotalAttempts (integer >= 1), floorTier (string | null).
// ---------------------------------------------------------------------------

and validateEnforcementEscalate = (enf: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(enf, "escalate") {
  | Some(json) => {
      // Permissive skip: non-object escalate is ignored so older configs survive.
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        ()
      } else {
        switch Js.Json.decodeObject(json) {
        | Some(escalate) => {
            validateEscalateCostCeiling(escalate)
            // Validate ladder
            switch Js.Dict.get(escalate, "ladder") {
            | Some(ladderJson) =>
              switch Js.Json.decodeArray(ladderJson) {
              | Some(ladder) => {
                  let rec goLadder = (i: int): unit => {
                    if i >= Js.Array.length(ladder) {
                      ()
                    } else {
                      let item = Js.Array.unsafe_get(ladder, i)
                      switch Js.Json.decodeString(item) {
                      | Some(_) => goLadder(i + 1)
                      | None =>
                        raise(
                          Js.Exn.raiseError(
                            "tiers.json: enforcement.escalate.ladder must be an array of strings",
                          ),
                        )
                      }
                    }
                  }
                  goLadder(0)
                }
              | None =>
                raise(
                  Js.Exn.raiseError(
                    "tiers.json: enforcement.escalate.ladder must be an array of strings",
                  ),
                )
              }
            | None => ()
            }
            // Validate maxAttemptsPerTier
            switch Js.Dict.get(escalate, "maxAttemptsPerTier") {
            | Some(matJson) =>
              switch Js.Json.decodeNumber(matJson) {
              | Some(mat) =>
                if %raw(`!(Number.isInteger(mat) && mat >= 0)`) {
                  raise(
                    Js.Exn.raiseError(
                      "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
                    ),
                  )
                }
              | None => ()
              }
            | None => ()
            }
            // Validate maxTotalAttempts
            switch Js.Dict.get(escalate, "maxTotalAttempts") {
            | Some(mtaJson) =>
              switch Js.Json.decodeNumber(mtaJson) {
              | Some(mta) =>
                if %raw(`!(Number.isInteger(mta) && mta >= 1)`) {
                  raise(
                    Js.Exn.raiseError(
                      "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
                    ),
                  )
                }
              | None => ()
              }
            | None => ()
            }
            // Validate floorTier (string | null)
            switch Js.Dict.get(escalate, "floorTier") {
            | Some(ftJson) =>
              // null is allowed; other non-strings are not
              if %raw(`ftJson === null`) {
                () // null is allowed
              } else {
                switch Js.Json.decodeString(ftJson) {
                | Some(_) => ()
                | None =>
                  raise(
                    Js.Exn.raiseError(
                      "tiers.json: enforcement.escalate.floorTier must be a string or null",
                    ),
                  )
                }
              }
            | None => ()
            }
          }
        | None => ()
        }
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementPerTier
// Validates enforcement.perTier block (optional).
// Permissive: non-object perTier values are silently ignored.
// Validates each tier value in {off, advisory, enforced}.
// ---------------------------------------------------------------------------

and validateEnforcementPerTier = (enf: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(enf, "perTier") {
  | Some(json) => {
      // Permissive skip: non-object perTier is ignored.
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        ()
      } else {
        switch Js.Json.decodeObject(json) {
        | Some(perTier) => {
            let keys = Js.Dict.keys(perTier)
            let rec go = (i: int): unit => {
              if i >= Js.Array.length(keys) {
                ()
              } else {
                let k = Js.Array.unsafe_get(keys, i)
                switch Js.Dict.get(perTier, k) {
                | Some(tierModeJson) =>
                  switch Js.Json.decodeString(tierModeJson) {
                  | Some(tierMode) =>
                    if !stringInArray(tierMode, enforcementModes) {
                      raise(
                        Js.Exn.raiseError(
                          `tiers.json: enforcement.perTier.${k} must be one of off|advisory|enforced`,
                        ),
                      )
                    }
                  | None =>
                    raise(
                      Js.Exn.raiseError(
                        `tiers.json: enforcement.perTier.${k} must be one of off|advisory|enforced`,
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
        | None => ()
        }
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementGuard
// Validates enforcement.guard block (optional).
// Permissive: non-object guard values are silently ignored.
// Validates: budget (number >= 1), blockScriptWrites (boolean).
// ---------------------------------------------------------------------------

and validateEnforcementGuard = (enf: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(enf, "guard") {
  | Some(json) => {
      // Permissive skip: non-object guard is ignored.
      if %raw(`!(json && typeof json === 'object' && !Array.isArray(json))`) {
        ()
      } else {
        switch Js.Json.decodeObject(json) {
        | Some(guard) => {
            // Validate budget
            switch Js.Dict.get(guard, "budget") {
            | Some(budgetJson) =>
              switch Js.Json.decodeNumber(budgetJson) {
              | Some(budget) =>
                if %raw(`!(Number.isFinite(budget) && budget >= 1)`) {
                  raise(
                    Js.Exn.raiseError("enforcement.guard.budget must be a number >= 1"),
                  )
                }
              | None =>
                raise(
                  Js.Exn.raiseError("enforcement.guard.budget must be a number >= 1"),
                )
              }
            | None => ()
            }
            // Validate blockScriptWrites
            switch Js.Dict.get(guard, "blockScriptWrites") {
            | Some(bswJson) =>
              switch Js.Json.decodeBoolean(bswJson) {
              | Some(_) => ()
              | None =>
                raise(
                  Js.Exn.raiseError("enforcement.guard.blockScriptWrites must be a boolean"),
                )
              }
            | None => ()
            }
          }
        | None => ()
        }
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEscalateCostCeiling — nested inside escalate validation
// ---------------------------------------------------------------------------

and validateEscalateCostCeiling = (escalate: Js.Dict.t<Js.Json.t>): unit => {
  switch Js.Dict.get(escalate, "costCeiling") {
  | Some(ccJson) => {
      // Permissive skip: non-object costCeiling is ignored.
      if %raw(`!(ccJson && typeof ccJson === 'object' && !Array.isArray(ccJson))`) {
        ()
      } else {
        switch Js.Json.decodeObject(ccJson) {
        | Some(cc) =>
          switch Js.Dict.get(cc, "multiple") {
          | Some(multJson) =>
            switch Js.Json.decodeNumber(multJson) {
            | Some(mult) =>
              if mult <= 0.0 {
                raise(
                  Js.Exn.raiseError(
                    "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
                  ),
                )
              }
            | None =>
              raise(
                Js.Exn.raiseError(
                  "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
                ),
              )
            }
          | None => ()
          }
        | None => ()
        }
      }
    }
  | None => ()
  }
}
