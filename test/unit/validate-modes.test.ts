// ---------------------------------------------------------------------------
// test/unit/validate-modes.test.ts
//
// Vitest fixture for ValidateModes validators — runs on IDENTICAL inputs
// as ValidateModes_test.res to prove byte-parity.
//
// Note: These tests directly call the ReScript implementation via the
// TypeScript ABI bridge declared in src/types/rescript-modules.d.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  validateModes,
  validateMode,
} from "../../src/validate/ValidateModes.res.mjs";

// ---------------------------------------------------------------------------
// validateModes
// ---------------------------------------------------------------------------

describe("validateModes", () => {
  it("accepts a modes object with one valid mode", () => {
    expect(() =>
      validateModes({
        modes: {
          auto: {
            defaultTier: "fast",
            description: "Auto mode",
          },
        },
      } as any),
    ).not.toThrow();
  });

  it("accepts a modes object with multiple valid modes", () => {
    expect(() =>
      validateModes({
        modes: {
          auto: {
            defaultTier: "fast",
            description: "Auto",
          },
          careful: {
            defaultTier: "heavy",
            description: "Careful",
          },
        },
      } as any),
    ).not.toThrow();
  });

  it("accepts empty modes object", () => {
    expect(() =>
      validateModes({
        modes: {},
      } as any),
    ).not.toThrow();
  });

  it("passes silently when modes is absent", () => {
    expect(() =>
      validateModes({
        activePreset: "default",
        rules: ["*"],
        defaultTier: "fast",
        presets: {},
      } as any),
    ).not.toThrow();
  });

  it("throws when modes is not an object (array)", () => {
    expect(() =>
      validateModes({
        modes: [],
      } as any),
    ).toThrow("tiers.json: 'modes' must be an object");
  });

  it("throws when modes is null", () => {
    expect(() =>
      validateModes({
        modes: null,
      } as any),
    ).toThrow("tiers.json: 'modes' must be an object");
  });
});

// ---------------------------------------------------------------------------
// validateMode
// ---------------------------------------------------------------------------

describe("validateMode", () => {
  it("accepts a fully-specified valid mode", () => {
    expect(() =>
      validateMode(
        "myMode",
        {
          defaultTier: "fast",
          description: "Fast auto mode",
        } as any,
      ),
    ).not.toThrow();
  });

  it("accepts mode with minimal required fields", () => {
    expect(() =>
      validateMode(
        "modeA",
        {
          defaultTier: "tier1",
          description: "Minimal mode",
        } as any,
      ),
    ).not.toThrow();
  });

  it("throws when mode is not an object", () => {
    expect(() =>
      validateMode("badMode", "not an object" as any),
    ).toThrow("tiers.json: mode 'badMode' must be an object");
  });

  it("throws when mode is an array", () => {
    expect(() =>
      validateMode("badMode", [] as any),
    ).toThrow("tiers.json: mode 'badMode' must be an object");
  });

  it("throws when mode is null", () => {
    expect(() =>
      validateMode("badMode", null as any),
    ).toThrow("tiers.json: mode 'badMode' must be an object");
  });

  it("throws when defaultTier is missing", () => {
    expect(() =>
      validateMode(
        "incomplete",
        {
          description: "Missing defaultTier",
        } as any,
      ),
    ).toThrow("tiers.json: mode 'incomplete.defaultTier' must be a string");
  });

  it("throws when defaultTier is not a string (number)", () => {
    expect(() =>
      validateMode(
        "badTier",
        {
          defaultTier: 123,
          description: "Valid description",
        } as any,
      ),
    ).toThrow("tiers.json: mode 'badTier.defaultTier' must be a string");
  });

  it("throws when description is missing", () => {
    expect(() =>
      validateMode(
        "noDesc",
        {
          defaultTier: "fast",
        } as any,
      ),
    ).toThrow("tiers.json: mode 'noDesc.description' must be a string");
  });

  it("throws when description is not a string", () => {
    expect(() =>
      validateMode(
        "badDesc",
        {
          defaultTier: "fast",
          description: 999,
        } as any,
      ),
    ).toThrow("tiers.json: mode 'badDesc.description' must be a string");
  });

  it("throws when mode is not a non-null object", () => {
    expect(() =>
      validateMode("nullMode", null as any),
    ).toThrow("tiers.json: mode 'nullMode' must be an object");
  });
});
