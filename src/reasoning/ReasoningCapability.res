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
  recommended?: Js.Dict.t<float>,
}

// Minimal TierConfig shape mirroring src/router/config.types.ts.
// Only the fields actually read by inferCapability are included.
type tierConfig = {
  model: string,
  variant?: string,
  thinking?: { budgetTokens?: int },
  reasoning?: { effort?: string },
  description: string,
  whenToUse: array<string>,
  capability?: reasoningCapability,
}

// ---------------------------------------------------------------------------
// Positional and named variant sets (from TS source)
// ---------------------------------------------------------------------------

// Plain objects used as Sets — Js.Dict.get returns the value (truthy) if key exists.
let _positionalVariants: Js.Dict.t<bool> = {
  let d = Js.Dict.empty()
  Js.Dict.set(d, "low", true)
  Js.Dict.set(d, "medium", true)
  Js.Dict.set(d, "high", true)
  Js.Dict.set(d, "xhigh", true)
  d
}

let _namedVariants: Js.Dict.t<bool> = {
  let d = Js.Dict.empty()
  Js.Dict.set(d, "thinking", true)
  Js.Dict.set(d, "max", true)
  d
}

// ---------------------------------------------------------------------------
// Default budget ladder (hardcoded from TS source)
// ---------------------------------------------------------------------------

let _makeBudgetLadder = (): Js.Dict.t<float> => {
  let d: Js.Dict.t<float> = Js.Dict.empty()
  Js.Dict.set(d, "minimal", 1024.0)
  Js.Dict.set(d, "normal", 4096.0)
  Js.Dict.set(d, "elevated", 8192.0)
  Js.Dict.set(d, "max", 16000.0)
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
    | Some(_) =>
      {
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
    | Some(_) =>
      {
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
    switch Js.Dict.get(_positionalVariants, v) {
    | Some(_) => {
        let levels: array<string> = v === "xhigh"
          ? ["low", "medium", "high", "xhigh"]
          : ["low", "medium", "high"]
        { kind: "discrete", field: "variant", levels }
      }
    | None =>
      switch Js.Dict.get(_namedVariants, v) {
      | Some(_) => { kind: "binary", field: "variant", elevated: v }
      | None => { kind: "none" }
      }
    }
  | None => { kind: "none" }
  }
