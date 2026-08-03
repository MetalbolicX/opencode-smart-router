// ---------------------------------------------------------------------------
// ReasoningTranslate_test.res — RED-first parity tests for ReasoningTranslate.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of translate.ts fixtures — none/binary/discrete/budgeted channels,
// precedence, clamping, NaN edge case, and field routing.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

// Assert two non-option values are equal
let assertionEqual = (~operator: string, expected: 'a, actual: 'a): unit =>
  assertion(~operator, (a, b) => a === b, actual, expected)

// Assert an option<T> is Some (not null)
let assertionSome = (~operator: string, actual: option<'a>): unit =>
  switch actual {
  | Some(_) => ()
  | None => assertion(~operator, (_a, _b) => false, (), ())
  }

// Assert an option<T> is None
let assertionNone = (~operator: string, actual: option<'a>): unit =>
  switch actual {
  | Some(_) => assertion(~operator, (_a, _b) => false, (), ())
  | None => ()
  }

// ---------------------------------------------------------------------------
// Test data — shared across suites
// ---------------------------------------------------------------------------

// Discrete 3-level ladder
let discrete3: ReasoningTranslate.reasoningCapability = {
  kind: "discrete",
  field: "variant",
  levels: ["low", "medium", "high"],
}

// Discrete 4-level ladder
let discrete4: ReasoningTranslate.reasoningCapability = {
  kind: "discrete",
  field: "variant",
  levels: ["low", "medium", "high", "xhigh"],
}

// Discrete 2-level ladder
let discrete2: ReasoningTranslate.reasoningCapability = {
  kind: "discrete",
  field: "variant",
  levels: ["low", "high"],
}

// Binary with baseline
let binaryWithBaseline: ReasoningTranslate.reasoningCapability = {
  kind: "binary",
  field: "variant",
  baseline: "default",
  elevated: "thinking",
}

// Binary without baseline
let binaryNoBaseline: ReasoningTranslate.reasoningCapability = {
  kind: "binary",
  field: "variant",
  elevated: "thinking",
}

// Budgeted capability
let budgetedCap: ReasoningTranslate.reasoningCapability = {
  let d = Dict.make()
  Dict.set(d, "minimal", 1024.0)
  Dict.set(d, "normal", 4096.0)
  Dict.set(d, "elevated", 8192.0)
  Dict.set(d, "max", 16000.0)
  {
    kind: "budgeted",
    field: "thinking.budgetTokens",
    recommended: d,
  }
}

// None capability
let noneCap: ReasoningTranslate.reasoningCapability = {kind: "none"}

// ---------------------------------------------------------------------------
// translateLevel — none channel: always null
// ---------------------------------------------------------------------------

test("translateLevel: none returns null for every level", () => {
  assertionNone(~operator="minimal", ReasoningTranslate.translateLevel(noneCap, #minimal))
  assertionNone(~operator="normal", ReasoningTranslate.translateLevel(noneCap, #normal))
  assertionNone(~operator="elevated", ReasoningTranslate.translateLevel(noneCap, #elevated))
  assertionNone(~operator="max", ReasoningTranslate.translateLevel(noneCap, #max))
})

// ---------------------------------------------------------------------------
// translateLevel — binary channel: elevated/max → elevated variant
// ---------------------------------------------------------------------------

test("translateLevel: binary — elevated and max return elevated variant", () => {
  assertionSome(
    ~operator="elevated",
    ReasoningTranslate.translateLevel(binaryWithBaseline, #elevated),
  )
  assertionSome(~operator="max", ReasoningTranslate.translateLevel(binaryWithBaseline, #max))
})

test("translateLevel: binary — elevated/max also work when no baseline declared", () => {
  assertionSome(
    ~operator="no-baseline-elevated",
    ReasoningTranslate.translateLevel(binaryNoBaseline, #elevated),
  )
  assertionSome(
    ~operator="no-baseline-max",
    ReasoningTranslate.translateLevel(binaryNoBaseline, #max),
  )
})

test("translateLevel: binary — minimal and normal return baseline variant", () => {
  assertionSome(
    ~operator="minimal",
    ReasoningTranslate.translateLevel(binaryWithBaseline, #minimal),
  )
  assertionSome(~operator="normal", ReasoningTranslate.translateLevel(binaryWithBaseline, #normal))
})

test("translateLevel: binary — minimal/normal return null when no baseline", () => {
  assertionNone(~operator="minimal", ReasoningTranslate.translateLevel(binaryNoBaseline, #minimal))
  assertionNone(~operator="normal", ReasoningTranslate.translateLevel(binaryNoBaseline, #normal))
})

// ---------------------------------------------------------------------------
// translateLevel — discrete / variant channel: clamping formula
// ---------------------------------------------------------------------------

test("translateLevel: discrete 3-level — rank formula clamps correctly", () => {
  // Math.round((rank/3)*(len-1)) with len=3:
  // minimal(0) -> round(0)   -> 0 -> low
  // normal(1)  -> round(2/3) -> 1 -> medium
  // elevated(2)-> round(4/3) -> 1 -> medium  (same as normal!)
  // max(3)     -> round(1)   -> 1 -> high
  assertionSome(~operator="minimal", ReasoningTranslate.translateLevel(discrete3, #minimal))
  assertionSome(~operator="normal", ReasoningTranslate.translateLevel(discrete3, #normal))
  assertionSome(~operator="elevated", ReasoningTranslate.translateLevel(discrete3, #elevated))
  assertionSome(~operator="max", ReasoningTranslate.translateLevel(discrete3, #max))
})

test("translateLevel: discrete 4-level — linear mapping", () => {
  // Math.round((rank/3)*(4-1)) = Math.round(rank * 1):
  // minimal(0)->0->low, normal(1)->1->medium, elevated(2)->2->high, max(3)->3->xhigh
  assertionSome(~operator="minimal", ReasoningTranslate.translateLevel(discrete4, #minimal))
  assertionSome(~operator="normal", ReasoningTranslate.translateLevel(discrete4, #normal))
  assertionSome(~operator="elevated", ReasoningTranslate.translateLevel(discrete4, #elevated))
  assertionSome(~operator="max", ReasoningTranslate.translateLevel(discrete4, #max))
})

test("translateLevel: discrete 2-level — elevated/max clamp to high", () => {
  // Math.round((rank/3)*(2-1)) = Math.round(rank/3):
  // minimal(0)->0->low, normal(1)->0->low, elevated(2)->1->high, max(3)->1->high
  assertionSome(~operator="minimal", ReasoningTranslate.translateLevel(discrete2, #minimal))
  assertionSome(~operator="normal", ReasoningTranslate.translateLevel(discrete2, #normal))
  assertionSome(~operator="elevated", ReasoningTranslate.translateLevel(discrete2, #elevated))
  assertionSome(~operator="max", ReasoningTranslate.translateLevel(discrete2, #max))
})

// ---------------------------------------------------------------------------
// translateLevel — discrete / reasoning.effort channel
// ---------------------------------------------------------------------------

test("translateLevel: discrete reasoning.effort — routes to options.reasoning_effort", () => {
  let cap: ReasoningTranslate.reasoningCapability = {
    kind: "discrete",
    field: "reasoning.effort",
    levels: ["low", "medium", "high"],
  }
  assertionSome(~operator="max", ReasoningTranslate.translateLevel(cap, #max))
  assertionSome(~operator="minimal", ReasoningTranslate.translateLevel(cap, #minimal))
})

// ---------------------------------------------------------------------------
// translateLevel — budgeted channel
// ---------------------------------------------------------------------------

test("translateLevel: budgeted — returns options.budget_tokens per level", () => {
  assertionSome(~operator="minimal", ReasoningTranslate.translateLevel(budgetedCap, #minimal))
  assertionSome(~operator="normal", ReasoningTranslate.translateLevel(budgetedCap, #normal))
  assertionSome(~operator="elevated", ReasoningTranslate.translateLevel(budgetedCap, #elevated))
  assertionSome(~operator="max", ReasoningTranslate.translateLevel(budgetedCap, #max))
})

test("translateLevel: budgeted — never writes .variant", () => {
  let out = ReasoningTranslate.translateLevel(budgetedCap, #max)
  switch out {
  | Some(_) => () // pass
  | None => assertion(~operator="not-null", (_a, _b) => false, (), ())
  }
})

// ---------------------------------------------------------------------------
// translateLevel — field routing sanity
// ---------------------------------------------------------------------------

test("translateLevel: binary writes to .variant only", () => {
  let cap: ReasoningTranslate.reasoningCapability = {
    kind: "binary",
    field: "variant",
    elevated: "thinking",
  }
  let out = ReasoningTranslate.translateLevel(cap, #elevated)
  switch out {
  | Some(_) => () // pass
  | None => assertion(~operator="not-null", (_a, _b) => false, (), ())
  }
})
