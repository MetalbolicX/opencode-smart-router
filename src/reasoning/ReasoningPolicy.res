// ---------------------------------------------------------------------------
// ReasoningPolicy.res — Resolve an effective reasoning override for a tier
// given the configured policy mode and a per-session override.
//
// Pure function. No IO, no mutation, no module-level state.
//
// Modes:
//   - "static"  → ALWAYS null. Primary regression guard. Even if a session
//                  override exists, static mode ignores it — agent def stays
//                  exactly as registerTierAgents produced it.
//   - "manual"  → sessionOverride ?? policy.defaultLevel, translate.
//                  If both absent → null.
//   - "adaptive"→ stubbed for Phase 2: consult selectAdaptiveLevel
//                  (adaptive.ts, not yet ported). Phase 2 will replace this stub.
//
// Unknown mode → null (fail-soft guard: typos cannot silently escalate).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types (defined locally — mirrors ReasoningPolicy.resi)
// ---------------------------------------------------------------------------

type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

type reasoningCapability = {
  kind: string,
  field?: string,
  baseline?: string,
  elevated?: string,
  levels?: array<string>,
  recommended?: Js.Dict.t<float>,
}

type tierConfig = {
  model: string,
  variant?: string,
  thinking?: { budgetTokens?: int },
  reasoning?: { effort?: string },
  description: string,
  whenToUse: array<string>,
  capability?: reasoningCapability,
}

type adaptiveSignals = {
  prompt: string,
  description: string,
  tierName: string,
  isTrivial: bool,
}

type resolvedReasoning = {
  variant?: string,
  options?: Js.Dict.t<unknown>,
}

// Mutually recursive types — reasoningPolicyConfig references adaptivePolicyConfig
// keywordRule and adaptivePolicyConfig need 'and' for the recursive array reference
type keywordRule = {
  keywords: array<string>,
  level: string,
  match: option<string>,
  excludeKeywords: option<array<string>>,
}

type adaptivePolicyConfig = {
  trivialLevel: option<string>,
  defaultLevel: option<string>,
  keywordRules: option<array<keywordRule>>,
  tierDefaults: option<Js.Dict.t<string>>,
  surfaceDecision: option<bool>,
}

type rec reasoningPolicyConfig = {
  mode: option<string>,
  defaultLevel: option<string>,
  surfaceLimits: option<bool>,
  adaptive: option<adaptivePolicyConfig>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Convert a string level to reasoningLevel variant, or None if unrecognized.
let _levelFromString = (s: string): option<reasoningLevel> => {
  switch s {
  | "minimal" => Some(#minimal)
  | "normal" => Some(#normal)
  | "elevated" => Some(#elevated)
  | "max" => Some(#max)
  | _ => None
  }
}

// Get the string mode from policy config
let _getMode = (policy: option<reasoningPolicyConfig>): option<string> => {
  switch policy {
  | Some(p) => p.mode
  | None => None
  }
}

// Get the defaultLevel string from policy config
let _getDefaultLevel = (policy: option<reasoningPolicyConfig>): option<string> => {
  switch policy {
  | Some(p) => p.defaultLevel
  | None => None
  }
}

// %raw helper: return explicit JS null instead of undefined (which is what None compiles to)
@setRuntimeSideEffects
let _nullResult = (): resolvedReasoning => {
  %raw("null")
}

// ---------------------------------------------------------------------------
// resolveReasoningOverride — main export
// ---------------------------------------------------------------------------

let resolveReasoningOverride = (
  tier: tierConfig,
  policy: option<reasoningPolicyConfig>,
  sessionOverride: option<reasoningLevel>,
  signals: adaptiveSignals,
): option<resolvedReasoning> => {
  let mode = _getMode(policy)

  // Primary regression guard: static mode hard no-op.
  // policy absent OR mode === "static" → null (not undefined)
  switch mode {
  | Some("static") => _nullResult()->Some
  | None => _nullResult()->Some
  | _ => {
      // Manual mode: sessionOverride ?? defaultLevel, then translate
      switch mode {
      | Some("manual") => {
          let level = switch sessionOverride {
          | Some(l) => Some(l)
          | None => {
              let dl = _getDefaultLevel(policy)
              switch dl {
              | Some(s) => _levelFromString(s)
              | None => None
              }
            }
          }
          switch level {
          | Some(l) => {
              let cap: ReasoningTranslate.reasoningCapability = switch tier.capability {
              | Some(c) => (c :> ReasoningTranslate.reasoningCapability)
              | None => (ReasoningCapability.inferCapability(tier :> ReasoningCapability.tierConfig) :> ReasoningTranslate.reasoningCapability)
              }
              switch ReasoningTranslate.translateLevel(cap, l) {
              | Some(r) => Some(r :> resolvedReasoning)
              | None => _nullResult()->Some
              }
            }
          | None => _nullResult()->Some
          }
        }

      // Adaptive mode: Phase 2 will replace with call to selectAdaptiveLevel.
      // For Phase 1, stub to null (adaptive.ts not yet ported).
      | Some("adaptive") => _nullResult()->Some

      // Unknown mode (not static, not manual, not adaptive): fail soft to null
      | _ => _nullResult()->Some
      }
    }
  }
}
