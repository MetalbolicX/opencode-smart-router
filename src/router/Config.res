// Tier capability variants
type tierCapability =
  | TC_None
  | Binary({field: string, baseline: option<string>, elevated: string})
  | Discrete({field: string, levels: array<string>})
  | Budgeted({field: string, recommended: dict<float>})

// Nested block types for tier config
type thinkingBlock = {budgetTokens: option<int>}
and reasoningBlock = {effort: option<string>, summary: option<string>}

// Per-tier configuration
type tierConfig = {
  model: string,
  variant: option<string>,
  costRatio: option<float>,
  description: string,
  whenToUse: array<string>,
  thinking: option<thinkingBlock>,
  reasoning: option<reasoningBlock>,
  capability: option<tierCapability>,
}

// A preset maps tier names (e.g. "fast", "balanced") to tier configs
type preset = dict<tierConfig>

// Enforcement mode variant
type modeEnum = [#off | #advisory | #enforced]

// Enforcement sub-types
type enforcementVerify = {
  require: option<string>,
  requireExplicitDoD: option<bool>,
  preferDeterministic: option<bool>,
  graderPolicy: option<string>,
  graderTemperature: option<float>,
  minGraderTier: option<string>,
  skipFastTier: option<bool>,
  skipTiers: option<array<string>>,
  hookTimeoutMs: option<int>,
}

type rec enforcementEscalate = {
  floorTier: option<option<string>>,
  ladder: option<array<string>>,
  maxAttemptsPerTier: option<int>,
  maxTotalAttempts: option<int>,
  costCeiling: option<costCeilingBlock>,
}

and costCeilingBlock = {base: option<string>, multiple: option<float>}

type enforcementGuard = {
  readDraftCap: option<int>,
  sameOpRetryCap: option<int>,
  blockSelfScript: option<bool>,
  deliverableFirst: option<bool>,
  budget: option<int>,
  blockScriptWrites: option<bool>,
}

type enforcementConfig = {
  mode: option<[modeEnum]>,
  envGate: option<string>,
  perTier: option<dict<string>>,
  guard: option<enforcementGuard>,
  verify: option<enforcementVerify>,
  escalate: option<enforcementEscalate>,
  proportional: option<{trivialBypass: option<bool>, trivialClassifier: option<string>}>,
}

type keywordRule = {
  keywords: array<string>,
  level: string,
  match: option<string>,
  excludeKeywords: option<array<string>>,
}

type adaptivePolicy = {
  trivialLevel: option<string>,
  defaultLevel: option<string>,
  keywordRules: option<array<keywordRule>>,
  tierDefaults: option<dict<string>>,
  surfaceDecision: option<bool>,
}

type reasoningPolicyConfig = {
  mode: option<string>,
  defaultLevel: option<string>,
  surfaceLimits: option<bool>,
  adaptive: option<adaptivePolicy>,
}

type modeEntry = {
  defaultTier: string,
  description: string,
  overrideRules: option<array<string>>,
}

// Main config record
type t = {
  activePreset: string,
  activeMode: option<string>,
  tierCaps: option<dict<int>>,
  tierPrompts: option<dict<string>>,
  presets: dict<preset>,
  rules: array<string>,
  defaultTier: string,
  fallback: option<{global: option<dict<array<string>>>}>,
  taskPatterns: option<dict<array<string>>>,
  modes: option<dict<modeEntry>>,
  enforcement: option<enforcementConfig>,
  reasoningPolicy: option<reasoningPolicyConfig>,
}

// ---------------------------------------------------------------------------
// Reasoning level validation — mirrors src/router/config-validate.ts:49
// ---------------------------------------------------------------------------
let reasoningLevels: array<string> = ["minimal", "normal", "elevated", "max"]

let decodeLevel = (s: string): option<string> =>
  Js.Array.includes(s, reasoningLevels) ? Some(s) : None

// Try to compile a string as a RegExp. Returns true if valid, false otherwise.
let isValidRegex = (s: string): bool =>
  try {
    let _ = %raw(`new RegExp(s)`)
    true
  } catch {
  | _ => false
  }

// Validates all keywords compile as regex. Used only when match == "regex".
let validateRegexKeywords = (keywords: array<string>): bool => {
  let rec go = (arr: list<string>): bool =>
    switch arr {
    | list{} => true
    | list{head, ...rest} =>
      if isValidRegex(head) {
        go(rest)
      } else {
        false
      }
    }
  go(List.fromArray(keywords))
}

// Validates an optional level field: None (absent) -> Some(None),
// Some("valid-level") -> Some(Some("valid-level")), Some("invalid") -> None.
// Also returns None for null.
let optLevelField = (obj: dict<Js.Json.t>, key: string): option<option<string>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeString(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(s)) =>
      switch decodeLevel(s) {
      | Some(v) => Some(Some(v))
      | None => None
      }
    | (None, None) => None
    }
  }

// Validates every string value in a dict against reasoningLevels.
// Returns None if any value is not a valid level.
let validateTierDefaultsDict = (dictObj: dict<Js.Json.t>): option<dict<string>> => {
  let rec go = (keys: list<string>, acc: dict<string>): option<dict<string>> =>
    switch keys {
    | list{} => Some(acc)
    | list{k, ...ks} =>
      switch Js.Dict.get(dictObj, k) {
      | Some(v) =>
        switch Js.Json.decodeString(v) {
        | Some(s) =>
          switch decodeLevel(s) {
          | Some(valid) =>
            Js.Dict.set(acc, k, valid)
            go(ks, acc)
          | None => None
          }
        | None => None
        }
      | None => go(ks, acc)
      }
    }
  go(List.fromArray(Js.Dict.keys(dictObj)), Js.Dict.empty())
}

// ---------------------------------------------------------------------------
// JSON decoder helpers — ReScript 12.3 uses decode* functions, not classify
// ---------------------------------------------------------------------------

// Decode string array (all elements must be strings)
let decodeStringArray = (arr: array<Js.Json.t>): option<array<string>> => {
  let rec go = (arr: list<Js.Json.t>, acc: list<string>): option<list<string>> =>
    switch arr {
    | list{} => Some(acc)
    | list{head, ...rest} =>
      switch Js.Json.decodeString(head) {
      | Some(s) => go(rest, list{s, ...acc})
      | None => None
      }
    }
  switch go(List.fromArray(arr), list{}) {
  | Some(l) => Some(List.toArray(List.reverse(l)))
  | None => None
  }
}

// Decode optional field: absent/null -> Some(None), string -> Some(Some(s)), invalid -> None
let optStr = (obj: dict<Js.Json.t>, key: string): option<option<string>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeString(json)) {
    | (Some(_), _) => Some(None) // null
    | (None, Some(s)) => Some(Some(s))
    | (None, None) => None // wrong type
    }
  }

// Decode optional float field
let optNum = (obj: dict<Js.Json.t>, key: string): option<option<float>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeNumber(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(n)) => Some(Some(n))
    | (None, None) => None
    }
  }

// Decode optional bool field
let optBool = (obj: dict<Js.Json.t>, key: string): option<option<bool>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeBoolean(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(b)) => Some(Some(b))
    | (None, None) => None
    }
  }

// Decode optional int field (JSON number -> int)
let optInt = (obj: dict<Js.Json.t>, key: string): option<option<int>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeNumber(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(n)) => Some(Some(Float.toInt(n)))
    | (None, None) => None
    }
  }

// Decode required string field
let reqStr = (obj: dict<Js.Json.t>, key: string): option<string> =>
  switch Js.Dict.get(obj, key) {
  | Some(json) => Js.Json.decodeString(json)
  | None => None
  }

// Decode required array field
let reqArr = (obj: dict<Js.Json.t>, key: string): option<array<Js.Json.t>> =>
  switch Js.Dict.get(obj, key) {
  | Some(json) => Js.Json.decodeArray(json)
  | None => None
  }

// Decode optional array field
let optArr = (obj: dict<Js.Json.t>, key: string): option<option<array<Js.Json.t>>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeArray(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(a)) => Some(Some(a))
    | (None, None) => None
    }
  }

// Decode required object field
let reqObj = (obj: dict<Js.Json.t>, key: string): option<dict<Js.Json.t>> =>
  switch Js.Dict.get(obj, key) {
  | Some(json) => Js.Json.decodeObject(json)
  | None => None
  }

// Decode optional object field
let optObj = (obj: dict<Js.Json.t>, key: string): option<option<dict<Js.Json.t>>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(d)) => Some(Some(d))
    | (None, None) => None
    }
  }

// Decode optional string array
let optStringArray = (obj: dict<Js.Json.t>, key: string): option<option<array<string>>> =>
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeArray(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(arr)) =>
      switch decodeStringArray(arr) {
      | Some(a) => Some(Some(a))
      | None => None
      }
    | (None, None) => None
    }
  }

// Decode optional string dict
let optStringDict = (obj: dict<Js.Json.t>, key: string): option<option<dict<string>>> => {
  let rec go = (keys: list<string>, dictObj: dict<Js.Json.t>, acc: dict<string>): option<dict<string>> =>
    switch keys {
    | list{} => Some(acc)
    | list{k, ...ks} =>
      switch Js.Dict.get(dictObj, k) {
      | Some(v) =>
        switch Js.Json.decodeString(v) {
        | Some(s) =>
          Js.Dict.set(acc, k, s)
          go(ks, dictObj, acc)
        | None => None
        }
      | None => go(ks, dictObj, acc)
      }
    }
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(dictObj)) =>
      switch go(List.fromArray(Js.Dict.keys(dictObj)), dictObj, Js.Dict.empty()) {
      | Some(d) => Some(Some(d))
      | None => None
      }
    | (None, None) => None
    }
  }
}

// Decode optional int dict
let optIntDict = (obj: dict<Js.Json.t>, key: string): option<option<dict<int>>> => {
  let rec go = (keys: list<string>, dictObj: dict<Js.Json.t>, acc: dict<int>): option<dict<int>> =>
    switch keys {
    | list{} => Some(acc)
    | list{k, ...ks} =>
      switch Js.Dict.get(dictObj, k) {
      | Some(v) =>
        switch Js.Json.decodeNumber(v) {
        | Some(n) =>
          Js.Dict.set(acc, k, Js.Math.floor(n))
          go(ks, dictObj, acc)
        | None => None
        }
      | None => go(ks, dictObj, acc)
      }
    }
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(dictObj)) =>
      switch go(List.fromArray(Js.Dict.keys(dictObj)), dictObj, Js.Dict.empty()) {
      | Some(d) => Some(Some(d))
      | None => None
      }
    | (None, None) => None
    }
  }
}

// Decode optional float dict
let optFloatDict = (obj: dict<Js.Json.t>, key: string): option<option<dict<float>>> => {
  let rec go = (keys: list<string>, dictObj: dict<Js.Json.t>, acc: dict<float>): option<dict<float>> =>
    switch keys {
    | list{} => Some(acc)
    | list{k, ...ks} =>
      switch Js.Dict.get(dictObj, k) {
      | Some(v) =>
        switch Js.Json.decodeNumber(v) {
        | Some(n) =>
          Js.Dict.set(acc, k, n)
          go(ks, dictObj, acc)
        | None => None
        }
      | None => go(ks, dictObj, acc)
      }
    }
  switch Js.Dict.get(obj, key) {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(dictObj)) =>
      switch go(List.fromArray(Js.Dict.keys(dictObj)), dictObj, Js.Dict.empty()) {
      | Some(d) => Some(Some(d))
      | None => None
      }
    | (None, None) => None
    }
  }
}

// ---------------------------------------------------------------------------
// Decode mode string to modeEnum variant
// ---------------------------------------------------------------------------
let decodeMode = (obj: dict<Js.Json.t>): option<option<[modeEnum]>> =>
  switch Js.Dict.get(obj, "mode") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeString(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some("off")) => Some(Some(#off))
    | (None, Some("advisory")) => Some(Some(#advisory))
    | (None, Some("enforced")) => Some(Some(#enforced))
    | (None, Some(_)) => None
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode capability
// ---------------------------------------------------------------------------
let decodeCapability = (obj: dict<Js.Json.t>): option<option<tierCapability>> =>
  switch Js.Dict.get(obj, "capability") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(capObj)) =>
      switch reqStr(capObj, "kind") {
      | Some("none") => Some(Some(TC_None))
      | Some("binary") =>
        switch (reqStr(capObj, "field"), optStr(capObj, "baseline"), reqStr(capObj, "elevated")) {
        | (Some(f), Some(b), Some(e)) => Some(Some(Binary({field: f, baseline: b, elevated: e})))
        | _ => None
        }
      | Some("discrete") =>
        switch (reqStr(capObj, "field"), reqArr(capObj, "levels")) {
        | (Some(f), Some(levels)) =>
          switch decodeStringArray(levels) {
          | Some(levelsList) => Some(Some(Discrete({field: f, levels: levelsList})))
          | None => None
          }
        | _ => None
        }
      | Some("budgeted") =>
        switch (reqStr(capObj, "field"), optFloatDict(capObj, "recommended")) {
        | (Some(f), Some(Some(recF))) => Some(Some(Budgeted({field: f, recommended: recF})))
        | _ => None
        }
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode thinking block
// ---------------------------------------------------------------------------
let decodeThinking = (obj: dict<Js.Json.t>): option<option<thinkingBlock>> =>
  switch Js.Dict.get(obj, "thinking") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(thObj)) =>
      switch Js.Dict.get(thObj, "budgetTokens") {
      | None => Some(Some({budgetTokens: None}))
      | Some(tokJson) =>
        switch (Js.Json.decodeNull(tokJson), Js.Json.decodeString(tokJson), Js.Json.decodeNumber(tokJson)) {
        | (Some(_), _, _) => Some(Some({budgetTokens: None}))
        | (None, Some(s), _) =>
          switch Float.fromString(s) {
          | Some(n) => Some(Some({budgetTokens: Some(Float.toInt(n))}))
          | None => Some(Some({budgetTokens: None}))
          }
        | (None, None, Some(n)) => Some(Some({budgetTokens: Some(Float.toInt(n))}))
        | (None, None, None) => None
        }
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode reasoning block
// ---------------------------------------------------------------------------
let decodeReasoning = (obj: dict<Js.Json.t>): option<option<reasoningBlock>> =>
  switch Js.Dict.get(obj, "reasoning") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(reasObj)) =>
      switch (optStr(reasObj, "effort"), optStr(reasObj, "summary")) {
      | (Some(effort), Some(summary)) => Some(Some({effort, summary}))
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode a single tier
// ---------------------------------------------------------------------------
let decodeTier = (obj: dict<Js.Json.t>): option<tierConfig> => {
  switch reqStr(obj, "model") {
  | None => None
  | Some(model) =>
    if Js.String.indexOf("/", model) < 0 {
      None
    } else {
      switch (reqStr(obj, "description"), reqArr(obj, "whenToUse")) {
      | (Some(description), Some(whenToUseArr)) =>
        switch decodeStringArray(whenToUseArr) {
        | Some(whenToUse) =>
          let variant = optStr(obj, "variant")
          let costRatio = optNum(obj, "costRatio")
          let thinking = decodeThinking(obj)
          let reasoning = decodeReasoning(obj)
          let capability = decodeCapability(obj)
          switch (variant, costRatio, thinking, reasoning, capability) {
          | (Some(variant), Some(costRatio), Some(thinking), Some(reasoning), Some(capability)) =>
            Some({model, variant, costRatio, description, whenToUse, thinking, reasoning, capability})
          | _ => None
          }
        | None => None
        }
      | _ => None
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Decode keywordRules array
// ---------------------------------------------------------------------------
let decodeKeywordRules = (obj: dict<Js.Json.t>): option<option<array<keywordRule>>> => {
  let rec go = (arr: list<Js.Json.t>, acc: list<keywordRule>): option<list<keywordRule>> =>
    switch arr {
    | list{} => Some(acc)
    | list{head, ...rest} =>
      switch Js.Json.decodeObject(head) {
      | Some(ruleObj) =>
        switch (optStringArray(ruleObj, "keywords"), reqStr(ruleObj, "level")) {
        | (Some(Some(keywords)), Some(level)) =>
          switch decodeLevel(level) {
          | None => None
          | Some(validLevel) =>
            if keywords->Js.Array.length == 0 {
              None
            } else {
              switch (optStr(ruleObj, "match"), optStringArray(ruleObj, "excludeKeywords")) {
              | (Some(match_), Some(excludeKeywords)) =>
                // match_ is option<string>: None = absent, Some(s) = present
                switch match_ {
                | None =>
                  let kr: keywordRule = {keywords, level: validLevel, match: None, excludeKeywords}
                  go(rest, list{kr, ...acc})
                | Some(m) =>
                  if m === "regex" && !validateRegexKeywords(keywords) {
                    None
                  } else {
                    let kr: keywordRule = {keywords, level: validLevel, match: Some(m), excludeKeywords}
                    go(rest, list{kr, ...acc})
                  }
                }
              | _ => None
              }
            }
          }
        }
      }
  }
  switch Js.Dict.get(obj, "keywordRules") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeArray(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(arr)) =>
      switch go(List.fromArray(arr), list{}) {
      | Some(l) => Some(Some(List.toArray(List.reverse(l))))
      | None => None
      }
    | (None, None) => None
    }
  }
}

// ---------------------------------------------------------------------------
// Decode adaptive policy
// ---------------------------------------------------------------------------
let decodeAdaptive = (obj: dict<Js.Json.t>): option<option<adaptivePolicy>> =>
  switch Js.Dict.get(obj, "adaptive") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(adaptObj)) =>
      switch (optLevelField(adaptObj, "trivialLevel"), optLevelField(adaptObj, "defaultLevel"), decodeKeywordRules(adaptObj)) {
      | (Some(trivialLevel), Some(defaultLevel), Some(keywordRules)) =>
        switch (optBool(adaptObj, "surfaceDecision")) {
        | Some(sd) =>
          // Validate tierDefaults: each value must be a valid reasoning level
          switch Js.Dict.get(adaptObj, "tierDefaults") {
          | None =>
            let tierDefaults: option<dict<string>> = Some(Js.Dict.empty())
            Some(Some({trivialLevel, defaultLevel, keywordRules, tierDefaults, surfaceDecision: sd}))
          | Some(json) =>
            switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
            | (Some(_), _) => Some(None)
            | (None, Some(dictObj)) =>
              switch validateTierDefaultsDict(dictObj) {
              | Some(tierDefaults) => Some(Some({trivialLevel, defaultLevel, keywordRules, tierDefaults: Some(tierDefaults), surfaceDecision: sd}))
              | None => None
              }
            | (None, None) => None
            }
          | _ => None
          }
        | _ => None
        }
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode reasoningPolicy
// ---------------------------------------------------------------------------
let decodeReasoningPolicy = (obj: dict<Js.Json.t>): option<option<reasoningPolicyConfig>> =>
  switch Js.Dict.get(obj, "reasoningPolicy") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(policyObj)) =>
      switch (optStr(policyObj, "mode"), optLevelField(policyObj, "defaultLevel"), optBool(policyObj, "surfaceLimits"), decodeAdaptive(policyObj)) {
      | (Some(mode), Some(defaultLevel), Some(surfaceLimits), Some(adaptive)) =>
        Some(Some({mode, defaultLevel, surfaceLimits, adaptive}))
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode modes dict
// ---------------------------------------------------------------------------
let decodeModes = (obj: dict<Js.Json.t>): option<option<dict<modeEntry>>> => {
  let rec go = (keys: list<string>, dictObj: dict<Js.Json.t>, acc: dict<modeEntry>): option<dict<modeEntry>> =>
    switch keys {
    | list{} => Some(acc)
    | list{k, ...ks} =>
      switch Js.Dict.get(dictObj, k) {
      | Some(v) =>
        switch Js.Json.decodeObject(v) {
        | Some(entryObj) =>
          switch (reqStr(entryObj, "defaultTier"), reqStr(entryObj, "description")) {
          | (Some(defaultTier), Some(description)) =>
            switch optStringArray(entryObj, "overrideRules") {
            | Some(overrideRules) =>
              let entry: modeEntry = {defaultTier, description, overrideRules}
              Js.Dict.set(acc, k, entry)
              go(ks, dictObj, acc)
            | None => None
            }
          | _ => go(ks, dictObj, acc)
          }
        | None => go(ks, dictObj, acc)
        }
      | None => go(ks, dictObj, acc)
      }
    }
  switch Js.Dict.get(obj, "modes") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(dictObj)) =>
      switch go(List.fromArray(Js.Dict.keys(dictObj)), dictObj, Js.Dict.empty()) {
      | Some(d) => Some(Some(d))
      | None => None
      }
    | (None, None) => None
    }
  }
}

// ---------------------------------------------------------------------------
// Decode optional perTier dict
// ---------------------------------------------------------------------------
let optPerTier = (obj: dict<Js.Json.t>): option<option<dict<string>>> => {
  let rec go = (keys: list<string>, dictObj: dict<Js.Json.t>, acc: dict<string>): option<dict<string>> =>
    switch keys {
    | list{} => Some(acc)
    | list{k, ...ks} =>
      switch Js.Dict.get(dictObj, k) {
      | Some(v) =>
        switch Js.Json.decodeString(v) {
        | Some(s) =>
          Js.Dict.set(acc, k, s)
          go(ks, dictObj, acc)
        | None => None
        }
      | None => go(ks, dictObj, acc)
      }
    }
  switch Js.Dict.get(obj, "perTier") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(dictObj)) =>
      switch go(List.fromArray(Js.Dict.keys(dictObj)), dictObj, Js.Dict.empty()) {
      | Some(d) => Some(Some(d))
      | None => None
      }
    | (None, None) => None
    }
  }
}

// ---------------------------------------------------------------------------
// Decode costCeiling block
// ---------------------------------------------------------------------------
let decodeCostCeiling = (obj: dict<Js.Json.t>): option<option<costCeilingBlock>> =>
  switch Js.Dict.get(obj, "costCeiling") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(ccObj)) =>
      switch (optStr(ccObj, "base"), optNum(ccObj, "multiple")) {
      | (Some(base), Some(multiple)) => Some(Some({base, multiple}))
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode guard block
// ---------------------------------------------------------------------------
let decodeGuard = (obj: dict<Js.Json.t>): option<option<enforcementGuard>> =>
  switch Js.Dict.get(obj, "guard") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(guardObj)) =>
      switch (optBool(guardObj, "blockSelfScript"), optInt(guardObj, "budget")) {
      | (Some(blockSelfScript), Some(budget)) =>
        Some(Some({
          readDraftCap: None,
          sameOpRetryCap: None,
          blockSelfScript,
          deliverableFirst: None,
          budget,
          blockScriptWrites: None,
        }))
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode verify block
// ---------------------------------------------------------------------------
let decodeVerify = (obj: dict<Js.Json.t>): option<option<enforcementVerify>> =>
  switch Js.Dict.get(obj, "verify") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(verifyObj)) =>
      switch (optStr(verifyObj, "require"), optStr(verifyObj, "graderPolicy"), optBool(verifyObj, "skipFastTier")) {
      | (Some(require), Some(graderPolicy), Some(skipFastTier)) =>
        Some(Some({
          require,
          requireExplicitDoD: None,
          preferDeterministic: None,
          graderPolicy,
          graderTemperature: None,
          minGraderTier: None,
          skipTiers: None,
          skipFastTier,
          hookTimeoutMs: None,
        }))
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode escalate block
// ---------------------------------------------------------------------------
let decodeEscalate = (obj: dict<Js.Json.t>): option<option<enforcementEscalate>> =>
  switch Js.Dict.get(obj, "escalate") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(escObj)) =>
      switch Js.Dict.get(escObj, "floorTier") {
      | None =>
        switch decodeCostCeiling(escObj) {
        | Some(costCeiling) =>
          Some(Some({
            floorTier: None,
            ladder: None,
            maxAttemptsPerTier: None,
            maxTotalAttempts: None,
            costCeiling,
          }))
        | None => None
        }
      | Some(floorTierJson) =>
        switch (Js.Json.decodeNull(floorTierJson), Js.Json.decodeString(floorTierJson)) {
        | (Some(_), _) =>
          switch decodeCostCeiling(escObj) {
          | Some(costCeiling) =>
            Some(Some({
              floorTier: None,
              ladder: None,
              maxAttemptsPerTier: None,
              maxTotalAttempts: None,
              costCeiling,
            }))
          | None => None
          }
        | (None, Some(floorTier)) =>
          switch decodeCostCeiling(escObj) {
          | Some(costCeiling) =>
            Some(Some({
              floorTier: Some(Some(floorTier)),
              ladder: None,
              maxAttemptsPerTier: None,
              maxTotalAttempts: None,
              costCeiling,
            }))
          | None => None
          }
        | (None, None) => None
        }
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Decode enforcement block
// ---------------------------------------------------------------------------
let decodeEnforcement = (obj: dict<Js.Json.t>): option<option<enforcementConfig>> =>
  switch Js.Dict.get(obj, "enforcement") {
  | None => Some(None)
  | Some(json) =>
    switch (Js.Json.decodeNull(json), Js.Json.decodeObject(json)) {
    | (Some(_), _) => Some(None)
    | (None, Some(enfObj)) =>
      switch (decodeMode(enfObj), decodeGuard(enfObj), decodeVerify(enfObj), decodeEscalate(enfObj)) {
      | (Some(mode), Some(guard), Some(verify), Some(escalate)) =>
        switch optPerTier(enfObj) {
        | Some(perTier) =>
          Some(Some({
            mode,
            envGate: None,
            perTier,
            guard,
            verify,
            escalate,
            proportional: None,
          }))
        | None => None
        }
      | _ => None
      }
    | (None, None) => None
    }
  }

// ---------------------------------------------------------------------------
// Build all tiers for one preset
// ---------------------------------------------------------------------------
let rec buildAllTiers = (presetObj: dict<Js.Json.t>): option<dict<tierConfig>> => {
  let tierKeys = List.fromArray(Js.Dict.keys(presetObj))
  let rec go = (keys: list<string>, acc: dict<tierConfig>): option<dict<tierConfig>> =>
    switch keys {
    | list{} => Some(acc)
    | list{tk, ...ks} =>
      switch Js.Dict.get(presetObj, tk) {
      | Some(tierJson) =>
        switch Js.Json.decodeObject(tierJson) {
        | Some(tierObj) =>
          switch decodeTier(tierObj) {
          | Some(tc) =>
            Js.Dict.set(acc, tk, tc)
            go(ks, acc)
          | None => None
          }
        | None => go(ks, acc)
        }
      | None => go(ks, acc)
      }
    }
  go(tierKeys, Js.Dict.empty())
}

// ---------------------------------------------------------------------------
// Build all presets from the presets object
// ---------------------------------------------------------------------------
and buildAllPresets = (presetsObj: dict<Js.Json.t>): option<dict<preset>> => {
  let presetKeys = List.fromArray(Js.Dict.keys(presetsObj))
  // Empty presets object is invalid (must have at least one preset)
  if presetKeys->List.length == 0 {
    None
  } else {
    let rec go = (keys: list<string>, acc: dict<preset>): option<dict<preset>> =>
    switch keys {
    | list{} => Some(acc)
    | list{pk, ...ks} =>
      switch Js.Dict.get(presetsObj, pk) {
      | Some(presetJson) =>
        switch Js.Json.decodeObject(presetJson) {
        | Some(presetObj) =>
          switch buildAllTiers(presetObj) {
          | Some(td) =>
            Js.Dict.set(acc, pk, td)
            go(ks, acc)
          | None => None
          }
        | None => None
        }
      | None => go(ks, acc)
      }
    }
  go(presetKeys, Js.Dict.empty())
  }
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

let parse = (json: Js.Json.t): option<t> => {
  switch Js.Json.decodeObject(json) {
  | None => None
  | Some(root) =>
    switch (reqStr(root, "activePreset"), reqStr(root, "defaultTier"), reqArr(root, "rules"), reqObj(root, "presets")) {
    | (Some(activePreset), Some(defaultTier), Some(rulesArr), Some(presetsObj)) =>
      switch decodeStringArray(rulesArr) {
      | Some(rules) =>
        switch buildAllPresets(presetsObj) {
        | Some(presets) =>
          let activeMode = optStr(root, "activeMode")
          let tierCaps = optIntDict(root, "tierCaps")
          let tierPrompts = optStringDict(root, "tierPrompts")
          let modes = decodeModes(root)
          let enforcement = decodeEnforcement(root)
          let reasoningPolicy = decodeReasoningPolicy(root)
          switch (activeMode, tierCaps, tierPrompts, modes, enforcement, reasoningPolicy) {
          | (Some(activeMode), Some(tierCaps), Some(tierPrompts), Some(modes), Some(enforcement), Some(reasoningPolicy)) =>
            Some({
              activePreset,
              activeMode,
              tierCaps,
              tierPrompts,
              presets,
              rules,
              defaultTier,
              fallback: None,
              taskPatterns: None,
              modes,
              enforcement,
              reasoningPolicy,
            })
          | _ => None
          }
        | None => None
        }
      | None => None
      }
    | _ => None
    }
  }
}
