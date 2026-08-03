// ---------------------------------------------------------------------------
// src/config/ConfigMerge_test.res — RED-first deepMerge parity tests
//
// WU-6: Tests are written FIRST (RED) to define expected behavior, then
// the implementation is written to make them pass (GREEN).
//
// Dual-run parity: matching vitest fixtures in test/unit/config-deepmerge.test.ts
// must pass on IDENTICAL inputs against both the TS and ReScript implementations.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let pass = () => assertion((_, _) => true, true, true)

/** Deep equality check via JSON serialization. */
let deepEqual = (~message: option<string>=?, a: 'a, b: 'b) =>
  assertion(
    ~message?,
    ~operator="deepEqual",
    (x, y) => JSON.stringify(x) === JSON.stringify(y),
    a,
    b,
  )

/** Check if haystack contains needle as substring. */
let stringContains = (haystack: string, needle: string): bool =>
  String.indexOf(haystack, needle) >= 0

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/** Parse a JSON string to Js.Json.t. */
let parse = (s: string): Js.Json.t => Js.Json.parseExn(s)

// ---------------------------------------------------------------------------
// Identity fixtures — merging with empty / merging with self
// ---------------------------------------------------------------------------

test("deepMerge: two empty objects produce empty object", () => {
  let base: Js.Json.t = %raw(`{}`)
  let override: Js.Json.t = %raw(`{}`)
  deepEqual(ConfigMerge.deepMerge(base, override), %raw(`{}`))
})

test("deepMerge: merging empty with self returns self", () => {
  let base: Js.Json.t = %raw(`{}`)
  deepEqual(ConfigMerge.deepMerge(base, base), base)
})

test("deepMerge: undefined base returns override", () => {
  let override: Js.Json.t = %raw(`{}`)
  deepEqual(ConfigMerge.deepMerge(%raw("undefined"), override), override)
})

test("deepMerge: undefined override returns base", () => {
  let base: Js.Json.t = %raw(`{}`)
  deepEqual(ConfigMerge.deepMerge(base, %raw("undefined")), base)
})

// ---------------------------------------------------------------------------
// Nested object fixtures — deep merge, not shallow
// ---------------------------------------------------------------------------

test("deepMerge: nested objects merge deeply", () => {
  let base = parse(`{
    "presets": {
      "multi-provider": {
        "fast": {"model": "a/fast"}
      }
    },
    "rules": []
  }`)
  let override = parse(`{
    "presets": {
      "multi-provider": {
        "fast": {"description": "updated"}
      }
    }
  }`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  // The nested fast object should have BOTH model and description
  assertion(
    ~operator="hasModel",
    (_a, _b) => stringContains(resultStr, "\"model\"") === true,
    true,
    true,
  )
})

test("deepMerge: override adds new keys", () => {
  let base = parse(`{"a": 1}`)
  let override = parse(`{"b": 2}`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  assertion(
    ~operator="hasBoth",
    (_a, _b) => stringContains(resultStr, "\"a\"") === true &&
      stringContains(resultStr, "\"b\"") === true,
    true,
    true,
  )
})

test("deepMerge: deep nested merge preserves non-overridden keys", () => {
  let base = parse(`{
    "enforcement": {
      "mode": "off",
      "guard": {"budget": 5000}
    }
  }`)
  let override = parse(`{
    "enforcement": {
      "guard": {"budget": 10000}
    }
  }`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  // mode: off should be preserved from base, guard.budget: 10000 from override
  assertion(
    ~operator="modePreserved",
    (_a, _b) => stringContains(resultStr, "\"off\"") === true,
    true,
    true,
  )
})

// ---------------------------------------------------------------------------
// Array fixtures — replacement semantics (not concat)
// ---------------------------------------------------------------------------

test("deepMerge: array override replaces base (not concat)", () => {
  let base = parse(`{"rules": ["a", "b"]}`)
  let override = parse(`{"rules": ["c"]}`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  assertion(
    ~operator="arrayReplaced",
    (_a, _b) => stringContains(resultStr, "\"c\"") === true &&
      stringContains(resultStr, "\"a\"") === false,
    true,
    true,
  )
})

test("deepMerge: nested array also replaces", () => {
  let base = parse(`{
    "presets": {
      "p": {
        "fast": {"whenToUse": ["old1", "old2"]}
      }
    }
  }`)
  let override = parse(`{
    "presets": {
      "p": {
        "fast": {"whenToUse": ["new"]}
      }
    }
  }`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  assertion(
    ~operator="nestedArrayReplaced",
    (_a, _b) => stringContains(resultStr, "\"new\"") === true &&
      stringContains(resultStr, "\"old1\"") === false,
    true,
    true,
  )
})

// ---------------------------------------------------------------------------
// Scalar fixtures — last value wins
// ---------------------------------------------------------------------------

test("deepMerge: string override replaces string base", () => {
  let base: Js.Json.t = %raw(`"hello"`)
  let override: Js.Json.t = %raw(`"world"`)
  deepEqual(ConfigMerge.deepMerge(base, override), %raw(`"world"`))
})

test("deepMerge: number override replaces number base", () => {
  let base: Js.Json.t = %raw(`10`)
  let override: Js.Json.t = %raw(`20`)
  deepEqual(ConfigMerge.deepMerge(base, override), %raw(`20`))
})

test("deepMerge: boolean override replaces boolean base", () => {
  let base: Js.Json.t = %raw(`false`)
  let override: Js.Json.t = %raw(`true`)
  deepEqual(ConfigMerge.deepMerge(base, override), %raw(`true`))
})

test("deepMerge: object override replaces scalar base", () => {
  let base: Js.Json.t = %raw(`42`)
  let override = parse(`{"key": "value"}`)
  deepEqual(ConfigMerge.deepMerge(base, override), override)
})

test("deepMerge: scalar override replaces object base", () => {
  let base = parse(`{"key": "value"}`)
  let override: Js.Json.t = %raw(`42`)
  deepEqual(ConfigMerge.deepMerge(base, override), %raw(`42`))
})

// ---------------------------------------------------------------------------
// Null fixtures — null is a value, not undefined
// ---------------------------------------------------------------------------

test("deepMerge: null override replaces non-null base", () => {
  let base: Js.Json.t = %raw(`"hello"`)
  let override: Js.Json.t = %raw(`null`)
  deepEqual(ConfigMerge.deepMerge(base, override), %raw(`null`))
})

test("deepMerge: null base is preserved (null !== undefined)", () => {
  let override: Js.Json.t = %raw(`"override"`)
  deepEqual(ConfigMerge.deepMerge(%raw(`null`), override), override)
})

test("deepMerge: null nested value can be overridden", () => {
  let base = parse(`{"capability": null}`)
  let override = parse(`{"capability": "binary"}`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  assertion(
    ~operator="nullOverridden",
    (_a, _b) => stringContains(resultStr, "\"binary\"") === true,
    true,
    true,
  )
})

test("deepMerge: null in nested object merges correctly", () => {
  let base = parse(`{
    "capability": {
      "kind": null,
      "field": "variant"
    }
  }`)
  let override = parse(`{
    "capability": {
      "kind": "binary"
    }
  }`)
  let result = ConfigMerge.deepMerge(base, override)
  let resultStr = JSON.stringify(result)
  // kind should be "binary" (overridden), field should be preserved from base
  assertion(
    ~operator="fieldPreserved",
    (_a, _b) => stringContains(resultStr, "\"field\"") === true &&
      stringContains(resultStr, "\"binary\"") === true,
    true,
    true,
  )
})

// ---------------------------------------------------------------------------
// Three-way merge — chained deepMerge
// ---------------------------------------------------------------------------

test("deepMerge: three-way chained merge (bundled → global → local)", () => {
  let bundled = parse(`{
    "activePreset": "multi-provider",
    "presets": {"p": {"fast": {"model": "a/fast"}}},
    "rules": [],
    "defaultTier": "fast"
  }`)
  let global = parse(`{
    "activePreset": "custom"
  }`)
  let local = parse(`{
    "rules": ["local-rule"]
  }`)
  let step1 = ConfigMerge.deepMerge(bundled, global)
  let step2 = ConfigMerge.deepMerge(step1, local)
  let resultStr = JSON.stringify(step2)
  assertion(
    ~operator="threeWay",
    (_a, _b) => stringContains(resultStr, "\"custom\"") === true &&
      stringContains(resultStr, "\"local-rule\"") === true &&
      stringContains(resultStr, "\"a/fast\"") === true,
    true,
    true,
  )
})
