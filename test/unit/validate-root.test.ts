// ---------------------------------------------------------------------------
// test/unit/validate-root.test.ts
//
// Vitest fixture for ValidateRoot validators — runs on IDENTICAL inputs
// as ValidateRoot_test.res to prove byte-parity.
//
// Note: These tests directly call the ReScript implementation via the
// TypeScript ABI bridge declared in src/types/rescript-modules.d.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  validateRootFields,
  validateRulesAndDefaultTier,
} from "../../src/validate/ValidateRoot.res.mjs";

// ---------------------------------------------------------------------------
// validateRootFields
// ---------------------------------------------------------------------------

describe("validateRootFields", () => {
  it("accepts a non-empty string activePreset", () => {
    expect(() => validateRootFields({ activePreset: "anthropic" })).not.toThrow();
  });

  it("accepts any non-empty string preset name", () => {
    expect(() => validateRootFields({ activePreset: "my-preset" })).not.toThrow();
  });

  it("rejects empty string activePreset", () => {
    expect(() => validateRootFields({ activePreset: "" })).toThrow(/activePreset/);
  });

  it("rejects missing activePreset", () => {
    expect(() => validateRootFields({})).toThrow(/activePreset/);
  });

  it("rejects non-string activePreset (number)", () => {
    expect(() => validateRootFields({ activePreset: 1 as any })).toThrow(/activePreset/);
  });
});

// ---------------------------------------------------------------------------
// validateRulesAndDefaultTier
// ---------------------------------------------------------------------------

describe("validateRulesAndDefaultTier", () => {
  it("accepts rules array + string defaultTier", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: ["rule1", "rule2"], defaultTier: "fast" }),
    ).not.toThrow();
  });

  it("accepts empty rules array", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: [], defaultTier: "medium" }),
    ).not.toThrow();
  });

  it("accepts single-rule array", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: ["only-rule"], defaultTier: "heavy" }),
    ).not.toThrow();
  });

  it("rejects non-array rules (string)", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: "x", defaultTier: "fast" } as any),
    ).toThrow(/rules/);
  });

  it("rejects non-array rules (number)", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: 42, defaultTier: "fast" } as any),
    ).toThrow(/rules/);
  });

  it("rejects missing rules", () => {
    expect(() =>
      validateRulesAndDefaultTier({ defaultTier: "fast" } as any),
    ).toThrow(/rules/);
  });

  it("rejects non-string defaultTier (number)", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: [], defaultTier: 3 } as any),
    ).toThrow(/defaultTier/);
  });

  it("rejects missing defaultTier", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: [] } as any),
    ).toThrow(/defaultTier/);
  });

  it("rejects empty string defaultTier", () => {
    expect(() =>
      validateRulesAndDefaultTier({ rules: [], defaultTier: "" }),
    ).toThrow(/defaultTier/);
  });
});
