// ---------------------------------------------------------------------------
// test/unit/validate-presets.test.ts
//
// Vitest fixture for ValidatePresets validators — runs on IDENTICAL inputs
// as ValidatePresets_test.res to prove byte-parity.
//
// Note: These tests directly call the ReScript implementation via the
// TypeScript ABI bridge declared in src/types/rescript-modules.d.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  validatePresets,
  validatePreset,
  validateTier,
} from "../../src/validate/ValidatePresets.res.mjs";

// ---------------------------------------------------------------------------
// validatePresets
// ---------------------------------------------------------------------------

describe("validatePresets", () => {
  it("accepts a valid presets object with one preset", () => {
    expect(() =>
      validatePresets({
        presets: {
          fast: {
            tier1: {
              model: "anthropic/claude-3-5-sonnet",
              description: "Fast tier",
              whenToUse: ["quick tasks"],
            },
          },
        },
      } as any),
    ).not.toThrow();
  });

  it("accepts multiple presets", () => {
    expect(() =>
      validatePresets({
        presets: {
          fast: {
            tier1: {
              model: "anthropic/claude-3-5-sonnet",
              description: "Fast",
              whenToUse: ["quick"],
            },
          },
          heavy: {
            tier1: {
              model: "anthropic/claude-3-5-opus",
              description: "Heavy",
              whenToUse: ["complex"],
            },
          },
        },
      } as any),
    ).not.toThrow();
  });

  it("rejects empty presets object", () => {
    expect(() =>
      validatePresets({ presets: {} } as any),
    ).toThrow(/presets.*at least one/);
  });

  it("rejects null presets", () => {
    expect(() =>
      validatePresets({ presets: null } as any),
    ).toThrow(/presets.*object/);
  });

  it("rejects array presets", () => {
    expect(() =>
      validatePresets({ presets: [] } as any),
    ).toThrow(/presets.*object/);
  });

  it("rejects missing presets", () => {
    expect(() =>
      validatePresets({} as any),
    ).toThrow(/presets.*object/);
  });
});

// ---------------------------------------------------------------------------
// validatePreset
// ---------------------------------------------------------------------------

describe("validatePreset", () => {
  it("accepts a preset with a single tier", () => {
    expect(() =>
      validatePreset("myPreset", {
        standard: {
          model: "openai/gpt-4o",
          description: "Standard tier",
          whenToUse: ["general"],
        },
      } as any),
    ).not.toThrow();
  });

  it("accepts a preset with multiple tiers", () => {
    expect(() =>
      validatePreset("myPreset", {
        tier1: {
          model: "openai/gpt-4o",
          description: "Standard",
          whenToUse: ["general"],
        },
        tier2: {
          model: "anthropic/claude-3-5-opus",
          description: "Premium",
          whenToUse: ["complex"],
        },
      } as any),
    ).not.toThrow();
  });

  it("rejects non-object preset", () => {
    expect(() =>
      validatePreset("myPreset", "not-an-object" as any),
    ).toThrow(/preset.*object/);
  });

  it("rejects null preset", () => {
    expect(() =>
      validatePreset("myPreset", null as any),
    ).toThrow(/preset.*object/);
  });
});

// ---------------------------------------------------------------------------
// validateTier
// ---------------------------------------------------------------------------

describe("validateTier", () => {
  it("accepts a fully-specified valid tier", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "anthropic/claude-3-5-sonnet-20241022",
        description: "Fast and capable",
        whenToUse: ["quick tasks", "simple queries"],
      } as any),
    ).not.toThrow();
  });

  it("accepts model with provider/model slash format", () => {
    expect(() =>
      validateTier("myPreset", "x", {
        model: "x/x",
        description: "Minimal",
        whenToUse: ["test"],
      } as any),
    ).not.toThrow();
  });

  it("accepts whenToUse array with single element", () => {
    expect(() =>
      validateTier("myPreset", "t1", {
        model: "anthropic/claude-3-5-sonnet",
        description: "Desc",
        whenToUse: ["only"],
      } as any),
    ).not.toThrow();
  });

  it("rejects missing model", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        description: "Desc",
        whenToUse: ["test"],
      } as any),
    ).toThrow(/model.*non-empty/);
  });

  it("rejects empty string model", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "",
        description: "Desc",
        whenToUse: ["test"],
      } as any),
    ).toThrow(/model.*non-empty/);
  });

  it("rejects model without slash", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "invalidmodel",
        description: "Desc",
        whenToUse: ["test"],
      } as any),
    ).toThrow(/provider\/model/);
  });

  it("rejects model with leading slash", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "/provider/model",
        description: "Desc",
        whenToUse: ["test"],
      } as any),
    ).toThrow(/provider\/model/);
  });

  it("rejects model with trailing slash", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "x/",
        description: "Desc",
        whenToUse: ["test"],
      } as any),
    ).toThrow(/provider\/model/);
  });

  it("rejects missing description", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "anthropic/claude-3-5-sonnet",
        whenToUse: ["test"],
      } as any),
    ).toThrow(/description.*string/);
  });

  it("rejects non-string description", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "anthropic/claude-3-5-sonnet",
        description: 42 as any,
        whenToUse: ["test"],
      } as any),
    ).toThrow(/description.*string/);
  });

  it("rejects missing whenToUse", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "anthropic/claude-3-5-sonnet",
        description: "Desc",
      } as any),
    ).toThrow(/whenToUse.*array/);
  });

  it("rejects non-array whenToUse", () => {
    expect(() =>
      validateTier("myPreset", "fast", {
        model: "anthropic/claude-3-5-sonnet",
        description: "Desc",
        whenToUse: "not-an-array" as any,
      } as any),
    ).toThrow(/whenToUse.*array/);
  });

  it("rejects non-object tier", () => {
    expect(() =>
      validateTier("myPreset", "fast", "not-an-object" as any),
    ).toThrow(/tier.*object/);
  });
});
