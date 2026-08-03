// ---------------------------------------------------------------------------
// test/unit/config-deepmerge.test.ts — Parity tests for Config.deepMerge
//
// WU-6: Matching vitest fixtures on IDENTICAL inputs as ConfigMerge_test.res.
// Both TS and ReScript implementations must pass on these inputs before the
// TS helper in config-loader.ts is removed.
//
// Run alongside: pnpm retest --match "config/ConfigMerge_test"
// Or: pnpm test -- test/unit/config-deepmerge.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { deepMergeConfig } from "../../src/router/config-loader";

// ---------------------------------------------------------------------------
// Identity fixtures
// ---------------------------------------------------------------------------

describe("deepMergeConfig identity fixtures", () => {
  it("two empty objects produce empty object", () => {
    const result = deepMergeConfig({}, {});
    expect(result).toEqual({});
  });

  it("merging empty with self returns self", () => {
    const empty = {};
    const result = deepMergeConfig(empty, empty);
    expect(result).toEqual(empty);
  });

  it("undefined base returns override", () => {
    const override = {};
    const result = deepMergeConfig(undefined, override);
    expect(result).toBe(override);
  });

  it("undefined override returns base", () => {
    const base = {};
    const result = deepMergeConfig(base, undefined);
    expect(result).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Nested object fixtures — deep merge
// ---------------------------------------------------------------------------

describe("deepMergeConfig nested object fixtures", () => {
  it("nested objects merge deeply", () => {
    const base = {
      presets: { "multi-provider": { fast: { model: "a/fast" } } },
      rules: [],
    };
    const override = {
      presets: { "multi-provider": { fast: { description: "updated" } } },
    };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    // The nested fast object should have BOTH model and description
    const fast = (result.presets as any)["multi-provider"]?.fast;
    expect(fast).toHaveProperty("model", "a/fast");
    expect(fast).toHaveProperty("description", "updated");
  });

  it("override adds new keys", () => {
    const base = { a: 1 };
    const override = { b: 2 };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    expect(result).toHaveProperty("a", 1);
    expect(result).toHaveProperty("b", 2);
  });

  it("deep nested merge preserves non-overridden keys", () => {
    const base = {
      enforcement: { mode: "off", guard: { budget: 5000 } },
    };
    const override = { enforcement: { guard: { budget: 10000 } } };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    const enf = result.enforcement as any;
    expect(enf).toHaveProperty("mode", "off"); // preserved from base
    expect(enf.guard).toHaveProperty("budget", 10000); // overridden
  });
});

// ---------------------------------------------------------------------------
// Array fixtures — replacement (not concat)
// ---------------------------------------------------------------------------

describe("deepMergeConfig array fixtures", () => {
  it("array override replaces base (not concat)", () => {
    const base = { rules: ["a", "b"] };
    const override = { rules: ["c"] };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    expect(result.rules).toEqual(["c"]);
    expect((result.rules as string[]).includes("a")).toBe(false);
  });

  it("nested array also replaces", () => {
    const base = {
      presets: { p: { fast: { whenToUse: ["old1", "old2"] } } },
    };
    const override = {
      presets: { p: { fast: { whenToUse: ["new"] } } },
    };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    const whenToUse = (result.presets as any).p.fast.whenToUse;
    expect(whenToUse).toEqual(["new"]);
    expect(whenToUse.includes("old1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scalar fixtures — last value wins
// ---------------------------------------------------------------------------

describe("deepMergeConfig scalar fixtures", () => {
  it("string override replaces string base", () => {
    expect(deepMergeConfig("hello", "world")).toBe("world");
  });

  it("number override replaces number base", () => {
    expect(deepMergeConfig(10, 20)).toBe(20);
  });

  it("boolean override replaces boolean base", () => {
    expect(deepMergeConfig(false, true)).toBe(true);
  });

  it("object override replaces scalar base", () => {
    const override = { key: "value" };
    expect(deepMergeConfig(42, override)).toEqual(override);
  });

  it("scalar override replaces object base", () => {
    const base = { key: "value" };
    expect(deepMergeConfig(base, 42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Null fixtures — null is a value, not undefined
// ---------------------------------------------------------------------------

describe("deepMergeConfig null fixtures", () => {
  it("null override replaces non-null base", () => {
    expect(deepMergeConfig("hello", null)).toBe(null);
  });

  it("null base is preserved (null !== undefined)", () => {
    const override = "override";
    expect(deepMergeConfig(null, override)).toBe(override);
  });

  it("null nested value can be overridden", () => {
    const base = { capability: null };
    const override = { capability: "binary" };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    expect(result.capability).toBe("binary");
  });

  it("null in nested object merges correctly", () => {
    const base = { capability: { kind: null, field: "variant" } };
    const override = { capability: { kind: "binary" } };
    const result = deepMergeConfig(base, override) as Record<string, unknown>;
    const cap = result.capability as any;
    expect(cap).toHaveProperty("kind", "binary"); // overridden
    expect(cap).toHaveProperty("field", "variant"); // preserved from base
  });
});

// ---------------------------------------------------------------------------
// Three-way merge — chained deepMergeConfig
// ---------------------------------------------------------------------------

describe("deepMergeConfig three-way merge", () => {
  it("chained merge (bundled → global → local)", () => {
    const bundled = {
      activePreset: "multi-provider",
      presets: { p: { fast: { model: "a/fast" } } },
      rules: [],
      defaultTier: "fast",
    };
    const global = { activePreset: "custom" };
    const local = { rules: ["local-rule"] };
    const step1 = deepMergeConfig(bundled, global);
    const result = deepMergeConfig(step1, local) as Record<string, unknown>;
    expect(result.activePreset).toBe("custom");
    expect((result.rules as string[]).includes("local-rule")).toBe(true);
    expect((result.presets as any).p.fast).toHaveProperty("model", "a/fast");
  });
});
