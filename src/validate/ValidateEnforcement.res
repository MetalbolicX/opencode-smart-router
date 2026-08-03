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
let ensureIsObjectVal = (val: JSON.t, path: string): unit => {
  if JSON.Decode.object(val)->Option.isNone {
    throw(JsError.throwWithMessage(`tiers.json: ${path} must be an object`))
  }
}

// Check if a string is in an array (used for mode validation)
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

// ---------------------------------------------------------------------------
// validateEnforcement — top-level dispatcher
// ---------------------------------------------------------------------------

let rec validateEnforcement = (obj: dict<JSON.t>): unit => {
  switch Dict.get(obj, "enforcement") {
  | Some(json) => {
      ensureIsObjectVal(json, "enforcement")
      switch JSON.Decode.object(json) {
      | Some(enf) => {
          validateEnforcementMode(enf)
          validateEnforcementVerify(enf)
          validateEnforcementEscalate(enf)
          validateEnforcementPerTier(enf)
          validateEnforcementGuard(enf)
        }
      | None => throw(JsError.throwWithMessage("tiers.json: enforcement must be a non-null object"))
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

and validateEnforcementMode = (enf: dict<JSON.t>): unit => {
  switch Dict.get(enf, "mode") {
  | Some(modeJson) =>
    switch JSON.Decode.string(modeJson) {
    | Some(mode) =>
      if !stringInArray(mode, enforcementModes) {
        throw(
          JsError.throwWithMessage(`tiers.json: enforcement.mode must be one of off|advisory|enforced`),
        )
      }
    | None =>
      throw(
        JsError.throwWithMessage(`tiers.json: enforcement.mode must be one of off|advisory|enforced`),
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

and validateEnforcementVerify = (enf: dict<JSON.t>): unit => {
  switch Dict.get(enf, "verify") {
  | Some(json) => // Permissive skip: non-object verify is ignored so older configs survive.
    if JSON.Decode.object(json)->Option.isNone {
      ()
    } else {
      switch JSON.Decode.object(json) {
      | Some(verify) => {
          // Validate graderPolicy if present
          switch Dict.get(verify, "graderPolicy") {
          | Some(gpJson) =>
            switch JSON.Decode.string(gpJson) {
            | Some(gp) =>
              if gp != "atLeastProducerTier" {
                throw(
                  JsError.throwWithMessage(`tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"`),
                )
              }
            | None =>
              throw(
                JsError.throwWithMessage(`tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"`),
              )
            }
          | None => ()
          }
          // Validate require if present
          switch Dict.get(verify, "require") {
          | Some(reqJson) =>
            switch JSON.Decode.string(reqJson) {
            | Some(req) =>
              if !stringInArray(req, verifyRequireModes) {
                throw(
                  JsError.throwWithMessage(`tiers.json: enforcement.verify.require must be one of never|whenDoDPresent|always`),
                )
              }
            | None =>
              throw(
                JsError.throwWithMessage(
                  `tiers.json: enforcement.verify.require must be one of never|whenDoDPresent|always (got ${JSON.stringify(
                      reqJson,
                    )})`,
                ),
              )
            }
          | None => ()
          }
        }
      | None => ()
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

and validateEnforcementEscalate = (enf: dict<JSON.t>): unit => {
  switch Dict.get(enf, "escalate") {
  | Some(json) => // Permissive skip: non-object escalate is ignored so older configs survive.
    if JSON.Decode.object(json)->Option.isNone {
      ()
    } else {
      switch JSON.Decode.object(json) {
      | Some(escalate) => {
          validateEscalateCostCeiling(escalate)
          // Validate ladder
          switch Dict.get(escalate, "ladder") {
          | Some(ladderJson) =>
            switch JSON.Decode.array(ladderJson) {
            | Some(ladder) => {
                let rec goLadder = (i: int): unit => {
                  if i >= Array.length(ladder) {
                    ()
                  } else {
                    let item = Array.getUnsafe(ladder, i)
                    switch JSON.Decode.string(item) {
                    | Some(_) => goLadder(i + 1)
                    | None =>
                      throw(
                        JsError.throwWithMessage(
                          "tiers.json: enforcement.escalate.ladder must be an array of strings",
                        ),
                      )
                    }
                  }
                }
                goLadder(0)
              }
            | None =>
              throw(
                JsError.throwWithMessage(
                  "tiers.json: enforcement.escalate.ladder must be an array of strings",
                ),
              )
            }
          | None => ()
          }
          // Validate maxAttemptsPerTier
          switch Dict.get(escalate, "maxAttemptsPerTier") {
          | Some(matJson) =>
            switch JSON.Decode.float(matJson) {
            | Some(mat) =>
              if !(Float.isFinite(mat) && Float.toInt(mat)->Float.fromInt === mat && mat >= 0.0) {
                throw(
                  JsError.throwWithMessage(
                    "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
                  ),
                )
              }
            | None => ()
            }
          | None => ()
          }
          // Validate maxTotalAttempts
          switch Dict.get(escalate, "maxTotalAttempts") {
          | Some(mtaJson) =>
            switch JSON.Decode.float(mtaJson) {
            | Some(mta) =>
              if !(Float.isFinite(mta) && Float.toInt(mta)->Float.fromInt === mta && mta >= 1.0) {
                throw(
                  JsError.throwWithMessage(
                    "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
                  ),
                )
              }
            | None => ()
            }
          | None => ()
          }
          // Validate floorTier (string | null)
          switch Dict.get(escalate, "floorTier") {
          | Some(ftJson) =>
            switch JSON.Decode.null(ftJson) {
            | Some(_) => () // null is allowed
            | None =>
              switch JSON.Decode.string(ftJson) {
              | Some(_) => ()
              | None =>
                throw(
                  JsError.throwWithMessage(
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
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementPerTier
// Validates enforcement.perTier block (optional).
// Permissive: non-object perTier values are silently ignored.
// Validates each tier value in {off, advisory, enforced}.
// ---------------------------------------------------------------------------

and validateEnforcementPerTier = (enf: dict<JSON.t>): unit => {
  switch Dict.get(enf, "perTier") {
  | Some(json) => // Permissive skip: non-object perTier is ignored.
    if JSON.Decode.object(json)->Option.isNone {
      ()
    } else {
      switch JSON.Decode.object(json) {
      | Some(perTier) => {
          let keys = Dict.keysToArray(perTier)
          let rec go = (i: int): unit => {
            if i >= Array.length(keys) {
              ()
            } else {
              let k = Array.getUnsafe(keys, i)
              switch Dict.get(perTier, k) {
              | Some(tierModeJson) =>
                switch JSON.Decode.string(tierModeJson) {
                | Some(tierMode) =>
                  if !stringInArray(tierMode, enforcementModes) {
                    throw(
                      JsError.throwWithMessage(
                        `tiers.json: enforcement.perTier.${k} must be one of off|advisory|enforced`,
                      ),
                    )
                  }
                | None =>
                  throw(
                    JsError.throwWithMessage(
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
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEnforcementGuard
// Validates enforcement.guard block (optional).
// Permissive: non-object guard values are silently ignored.
// Validates: budget (number >= 1), blockScriptWrites (boolean).
// ---------------------------------------------------------------------------

and validateEnforcementGuard = (enf: dict<JSON.t>): unit => {
  switch Dict.get(enf, "guard") {
  | Some(json) => // Permissive skip: non-object guard is ignored.
    if JSON.Decode.object(json)->Option.isNone {
      ()
    } else {
      switch JSON.Decode.object(json) {
      | Some(guard) => {
          // Validate budget
          switch Dict.get(guard, "budget") {
          | Some(budgetJson) =>
            switch JSON.Decode.float(budgetJson) {
            | Some(budget) =>
              if !Float.isFinite(budget) || budget < 1.0 {
                throw(JsError.throwWithMessage("enforcement.guard.budget must be a number >= 1"))
              }
            | None =>
              throw(JsError.throwWithMessage("enforcement.guard.budget must be a number >= 1"))
            }
          | None => ()
          }
          // Validate blockScriptWrites
          switch Dict.get(guard, "blockScriptWrites") {
          | Some(bswJson) =>
            switch JSON.Decode.bool(bswJson) {
            | Some(_) => ()
            | None =>
              throw(
                JsError.throwWithMessage("enforcement.guard.blockScriptWrites must be a boolean"),
              )
            }
          | None => ()
          }
        }
      | None => ()
      }
    }
  | None => ()
  }
}

// ---------------------------------------------------------------------------
// validateEscalateCostCeiling — nested inside escalate validation
// ---------------------------------------------------------------------------

and validateEscalateCostCeiling = (escalate: dict<JSON.t>): unit => {
  switch Dict.get(escalate, "costCeiling") {
  | Some(ccJson) => // Permissive skip: non-object costCeiling is ignored.
    if JSON.Decode.object(ccJson)->Option.isNone {
      ()
    } else {
      switch JSON.Decode.object(ccJson) {
      | Some(cc) =>
        switch Dict.get(cc, "multiple") {
        | Some(multJson) =>
          switch JSON.Decode.float(multJson) {
          | Some(mult) =>
            if mult <= 0.0 {
              throw(
                JsError.throwWithMessage(
                  "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
                ),
              )
            }
          | None =>
            throw(
              JsError.throwWithMessage(
                "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
              ),
            )
          }
        | None => ()
        }
      | None => ()
      }
    }
  | None => ()
  }
}
