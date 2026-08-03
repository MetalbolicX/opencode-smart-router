// ---------------------------------------------------------------------------
// ReasoningCapability.res — Provider-agnostic reasoning capability model.
//
// Pure inference helper. NO side effects, NO file IO, NO router wiring.
// Mirrors src/reasoning/capability.ts exactly.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types — mirrors the TS interfaces using records (for JS object output parity)
// ---------------------------------------------------------------------------

// Normalized reasoning level — provider-agnostic rank.
type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

// Output channel discriminator — string literals matching TS.
type reasoningField = string

// Capability discriminated union as a record.
// kind: string discriminator matching TS variants.
// Using records (not variant payloads) so compiled JS has exact TS shape.
type reasoningCapability = {
  kind: string,
  field?: reasoningField,
  baseline?: string,
  elevated?: string,
  levels?: array<string>,
  recommended?: dict<float>,
}

// Minimal TierConfig shape mirroring src/router/config.types.ts.
// Only the fields actually read by inferCapability are included.
type tierConfig = {
  model: string,
  variant?: string,
  thinking?: {budgetTokens?: int},
  reasoning?: {effort?: string},
  description: string,
  whenToUse: array<string>,
  capability?: reasoningCapability,
}

// ---------------------------------------------------------------------------
// Positional and named variant sets (from TS source)
// ---------------------------------------------------------------------------

// Plain objects used as Sets — Js.Dict.get returns the value (truthy) if key exists.
let _positionalVariants: dict<bool> = {
  let d = Dict.make()
  Dict.set(d, "low", true)
  Dict.set(d, "medium", true)
  Dict.set(d, "high", true)
  Dict.set(d, "xhigh", true)
  d
}

let _namedVariants: dict<bool> = {
  let d = Dict.make()
  Dict.set(d, "thinking", true)
  Dict.set(d, "max", true)
  d
}

// ---------------------------------------------------------------------------
// Default budget ladder (hardcoded from TS source)
// ---------------------------------------------------------------------------

let _makeBudgetLadder = (): dict<float> => {
  let d: dict<float> = Dict.make()
  Dict.set(d, "minimal", 1024.0)
  Dict.set(d, "normal", 4096.0)
  Dict.set(d, "elevated", 8192.0)
  Dict.set(d, "max", 16000.0)
  d
}

// ---------------------------------------------------------------------------
// inferCapability — backward-compat inference from tier fields
//
// Inference precedence (first match wins):
//   1. tier.reasoning?.effort  → discrete / "reasoning.effort"
//   2. tier.thinking?.budgetTokens → budgeted / "thinking.budgetTokens"
//   3. tier.variant in {low,medium,high} → discrete / "variant"
//   4. tier.variant in {thinking,max}  → binary / "variant"
//   5. otherwise → { kind: "none" }
// ---------------------------------------------------------------------------

let rec inferCapability = (tier: tierConfig): reasoningCapability => {
  // Step 1: reasoning.effort → discrete / reasoning.effort
  switch tier.reasoning {
  | Some(r) =>
    switch r.effort {
    | Some(_) => {
        kind: "discrete",
        field: "reasoning.effort",
        levels: ["low", "medium", "high"],
      }
    | None => _step2(tier)
    }
  | None => _step2(tier)
  }
}
// Step 2: thinking.budgetTokens → budgeted; else fall through to variant check
and _step2 = (tier: tierConfig): reasoningCapability =>
  switch tier.thinking {
  | Some(t) =>
    switch t.budgetTokens {
    | Some(_) => {
        kind: "budgeted",
        field: "thinking.budgetTokens",
        recommended: _makeBudgetLadder(),
      }
    | None => _step3(tier)
    }
  | None => _step3(tier)
  }
// Step 3: variant-only inference (steps 3 & 4)
and _step3 = (tier: tierConfig): reasoningCapability =>
  switch tier.variant {
  | Some(v) =>
    switch Dict.get(_positionalVariants, v) {
    | Some(_) => {
        let levels: array<string> =
          v === "xhigh" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"]
        {kind: "discrete", field: "variant", levels}
      }
    | None =>
      switch Dict.get(_namedVariants, v) {
      | Some(_) => {kind: "binary", field: "variant", elevated: v}
      | None => {kind: "none"}
      }
    }
  | None => {kind: "none"}
  }
