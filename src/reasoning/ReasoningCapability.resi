// ---------------------------------------------------------------------------
// ReasoningCapability.resi — Public API contract for capability inference.
//
// Pure types and inference helper. NO side effects, NO file IO, NO router wiring.
// Mirrors src/reasoning/capability.ts.
//
// The JS output uses plain records with a "kind" string discriminator to match
// the TS discriminated union shape exactly.
// ---------------------------------------------------------------------------

// Normalized reasoning level — provider-agnostic rank.
type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

// Output channel a capability writes through.
// String literal union matching TS ReasoningField.
type reasoningField = string

// Capability discriminated union as plain record.
// kind discriminator matches TS variants: "none" | "binary" | "discrete" | "budgeted".
type reasoningCapability = {
  kind: string,
  field?: reasoningField,
  baseline?: string,
  elevated?: string,
  levels?: array<string>,
  recommended?: Js.Dict.t<float>,
}

// Minimal TierConfig shape mirroring src/router/config.types.ts.
// Only the fields read by inferCapability are included.
type tierConfig = {
  model: string,
  variant?: string,
  thinking?: { budgetTokens?: int },
  reasoning?: { effort?: string },
  description: string,
  whenToUse: array<string>,
  capability?: reasoningCapability,
}

// Infer a capability from a TierConfig when no explicit capability is declared.
// Inference precedence (first match wins):
//   1. tier.reasoning?.effort  → discrete / "reasoning.effort"
//   2. tier.thinking?.budgetTokens → budgeted / "thinking.budgetTokens"
//   3. tier.variant in {low,medium,high} → discrete / "variant"
//   4. tier.variant in {thinking,max}  → binary / "variant"
//   5. otherwise → { kind: "none" }
let inferCapability: tierConfig => reasoningCapability
