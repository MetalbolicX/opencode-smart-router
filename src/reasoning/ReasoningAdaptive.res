// ---------------------------------------------------------------------------
// ReasoningAdaptive.res — Deterministic, config-driven adaptive level selector.
//
// Pure function. No IO, no module state. Decision order (first match wins):
//   1. policy.adaptive absent               → { level: null, reason: "no adaptive config" }
//   2. signals.isTrivial                   → { level: adaptive.trivialLevel ?? null, reason: "trivial" }
//   3. adaptive.tierDefaults[tierName]      → { level: that, reason: "tier default: <name>" }
//   4. adaptive.keywordRules (array order)  → first rule whose keywords match (via
//                                            matchSignal) AND whose excludeKeywords
//                                            do NOT match; default mode = "stem"
//   5. catch-all                           → { level: adaptive.defaultLevel ?? null,
//                                            reason: "default level" }
//
// Keyword matching delegates to ReasoningMatch.matchSignal (word/stem/substring/regex).
// Malformed rules (missing/non-array keywords) are silently skipped.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types (mirrors TS AdaptiveSignals, AdaptiveDecision, ReasoningPolicyConfig)
// ---------------------------------------------------------------------------

// Normalized reasoning level — same as ReasoningCapability.reasoningLevel
type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

// Match mode — same as ReasoningMatch.matchMode
type matchMode = [
  | #word
  | #stem
  | #substring
  | #regex
]

// AdaptiveSignals: signals available at dispatch time
type adaptiveSignals = {
  prompt: string,
  description: string,
  tierName: string,
  isTrivial: bool,
}

// Keyword rule from AdaptivePolicyConfig.keywordRules
type keywordRule = {
  keywords: array<string>,
  level: string,
  match: option<string>,
  excludeKeywords: option<array<string>>,
}

// AdaptivePolicyConfig from ReasoningPolicyConfig.adaptive
type adaptivePolicyConfig = {
  trivialLevel: option<string>,
  defaultLevel: option<string>,
  keywordRules: option<array<keywordRule>>,
  tierDefaults: option<Js.Dict.t<string>>,
  surfaceDecision: option<bool>,
}

// ReasoningPolicyConfig minimal shape (fields read by selectAdaptiveLevel)
type reasoningPolicyConfig = {
  mode: option<string>,
  defaultLevel: option<string>,
  surfaceLimits: option<bool>,
  adaptive: option<adaptivePolicyConfig>,
}

// Return type: level is nullable at the TS boundary (Js.Nullable.t<reasoningLevel>)
type adaptiveDecision = {
  level: Js.Nullable.t<reasoningLevel>,
  reason: string,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// %raw helper: return explicit JS null for nullable level fields
@setRuntimeSideEffects
let _nullLevel = (): Js.Nullable.t<reasoningLevel> => {
  %raw("null")
}

// Convert string level to reasoningLevel variant, or return null
let _levelFromString = (s: string): Js.Nullable.t<reasoningLevel> => {
  switch s {
  | "minimal" => Js.Nullable.return(#minimal)
  | "normal" => Js.Nullable.return(#normal)
  | "elevated" => Js.Nullable.return(#elevated)
  | "max" => Js.Nullable.return(#max)
  | _ => _nullLevel()
  }
}

// Determine matchMode from optional string (default = stem)
let _getMatchMode = (m: option<string>): matchMode => {
  switch m {
  | Some("word") => #word
  | Some("substring") => #substring
  | Some("regex") => #regex
  | _ => #stem
  }
}

// Get nullable excludeKeywords array (empty if absent)
let _getExclusions = (ex: option<array<string>>): array<string> => {
  switch ex {
  | Some(arr) => arr
  | None => []
  }
}

// Check if any exclusion keyword matches (fail-soft: non-string/empty = non-matching)
let _isExcluded = (exclusions: array<string>, prompt: string, description: string, mode: matchMode): bool => {
  let excluded = exclusions->Array.some((k) => {
    if k === "" {
      false
    } else {
      ReasoningMatch.matchSignal(prompt, k, mode) ||
        ReasoningMatch.matchSignal(description, k, mode)
    }
  })
  excluded
}

// Check a single rule and return Some(decision) if it matches, None otherwise
// Uses `and` for mutual recursion with _scanRules
let rec _checkRule = (
  rule: keywordRule,
  idx: int,
  prompt: string,
  description: string,
): option<adaptiveDecision> => {
  // Fail-soft: skip rules with empty keywords array
  if rule.keywords->Array.length === 0 {
    None
  } else {
    let mode = _getMatchMode(rule.match)
    let modeStr = switch mode {
    | #word => "word"
    | #substring => "substring"
    | #regex => "regex"
    | #stem => "stem"
    }
    let exclusions = _getExclusions(rule.excludeKeywords)

    // Check exclusions first (fail-soft: non-string entries are non-matching)
    if _isExcluded(exclusions, prompt, description, mode) {
      None
    } else {
      // Find first matching keyword within this rule's keywords
      let matched = rule.keywords->Array.find((kw) => {
        if kw === "" {
          false
        } else if ReasoningMatch.matchSignal(prompt, kw, mode) {
          true
        } else if ReasoningMatch.matchSignal(description, kw, mode) {
          true
        } else {
          false
        }
      })
      switch matched {
      | Some(kw) => {
          let source = ReasoningMatch.matchSignal(prompt, kw, mode) ? "prompt" : "description"
          let lvl = _levelFromString(rule.level)
          Some({
            level: lvl,
            reason: `keyword match: rule[${Int.toString(idx)}] "${kw}" (${modeStr}) in ${source}`,
          })
        }
      | None => None
      }
    }
  }
}
// Mutually recursive: _scanRules calls _checkRule
and _scanRules = (
  rules: array<keywordRule>,
  idx: int,
  prompt: string,
  description: string,
): option<adaptiveDecision> => {
  let rulesLen = rules->Array.length
  if idx >= rulesLen {
    None
  } else {
    switch rules->Array.get(idx) {
    | None => _scanRules(rules, idx + 1, prompt, description)
    | Some(rule) => {
        switch _checkRule(rule, idx, prompt, description) {
        | Some(d) => Some(d)
        | None => _scanRules(rules, idx + 1, prompt, description)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// selectAdaptiveLevel — main export
// ---------------------------------------------------------------------------

let selectAdaptiveLevel = (
  signals: adaptiveSignals,
  policy: option<reasoningPolicyConfig>,
): adaptiveDecision => {
  // Step 1: adaptive config absent
  let adaptive: option<adaptivePolicyConfig> = switch policy {
  | Some(p) => p.adaptive
  | None => None
  }
  switch adaptive {
  | None => { level: _nullLevel(), reason: "no adaptive config" }

  | Some(ac) => {
      // Step 2: trivial short-circuit
      if signals.isTrivial {
        let lvl = switch ac.trivialLevel {
        | Some(s) => _levelFromString(s)
        | None => _nullLevel()
        }
        { level: lvl, reason: "trivial" }
      } else {
        // Step 3: tierDefaults check
        let tierDefaults = switch ac.tierDefaults {
        | Some(td) => td
        | None => Js.Dict.empty()
        }
        switch Js.Dict.get(tierDefaults, signals.tierName) {
        | Some(tierLevel) => {
            let lvl = _levelFromString(tierLevel)
            { level: lvl, reason: `tier default: ${signals.tierName}` }
          }
        | None => {
            // Step 4: keywordRules
            let keywordRules = switch ac.keywordRules {
            | Some(rules) => rules
            | None => []
            }
            switch _scanRules(keywordRules, 0, signals.prompt, signals.description) {
            | Some(d) => d
            | None => {
                // Step 5: catch-all defaultLevel
                let lvl = switch ac.defaultLevel {
                | Some(s) => _levelFromString(s)
                | None => _nullLevel()
                }
                { level: lvl, reason: "default level" }
              }
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Accessor helpers for test assertions
// ---------------------------------------------------------------------------

// Get the level as Js.Nullable.t<reasoningLevel> (for parity assertions)
let getLevelNull = (d: adaptiveDecision): Js.Nullable.t<reasoningLevel> => {
  d.level
}

// Get the level as option<reasoningLevel> (for test comparisons)
let getLevelOption = (d: adaptiveDecision): option<reasoningLevel> => {
  Js.Nullable.toOption(d.level)
}

// Get the reason string
let getReason = (d: adaptiveDecision): string => {
  d.reason
}

// ---------------------------------------------------------------------------
// Test helper: build a ReasoningPolicyConfig with adaptive block
// ---------------------------------------------------------------------------

let makePolicyWithAdaptive = (adaptive: option<adaptivePolicyConfig>): reasoningPolicyConfig => {
  {
    mode: Some("adaptive"),
    defaultLevel: None,
    surfaceLimits: None,
    adaptive: adaptive,
  }
}
