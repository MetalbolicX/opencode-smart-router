// ---------------------------------------------------------------------------
// ReasoningTranslate.resi — Public API contract for translateLevel.
//
// Pure function. Given a capability and a level, returns the provider-specific
// patch (variant string or options dict) or null for no-op.
//
// Surface detected by this module:
//   given a capability + a level, what patch would I emit if the policy
//   asked for one?
//
// Routing by cap.kind:
//   - "none"         → null (never mutated)
//   - "binary"       → { variant: cap.elevated }  for elevated/max
//                      { variant: cap.baseline }  for minimal/normal (if baseline exists)
//   - "discrete"     → { variant: picked }  or  { options: { reasoning_effort: picked } }
//   - "budgeted"     → { options: { budget_tokens: tokens } }
// ---------------------------------------------------------------------------

// Normalized reasoning level — same as ReasoningCapability.reasoningLevel
type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

// Capability type (mirrors ReasoningCapability.reasoningCapability)
// Using record with optional fields for JS object shape parity.
type reasoningCapability = {
  kind: string,
  field?: string,
  baseline?: string,
  elevated?: string,
  levels?: array<string>,
  recommended?: Js.Dict.t<float>,
}

// Provider-specific patch returned by translateLevel.
// null = no-op / capability can't satisfy this level.
type resolvedReasoning = {
  variant?: string,
  options?: Js.Dict.t<unknown>,
}

// translateLevel: pure function — no side effects, no IO.
let translateLevel: (reasoningCapability, reasoningLevel) => option<resolvedReasoning>
