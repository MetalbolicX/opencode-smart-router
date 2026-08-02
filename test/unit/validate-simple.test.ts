// ---------------------------------------------------------------------------
// test/unit/validate-simple.test.ts
//
// Vitest fixture for ValidateSimple validators — runs on IDENTICAL inputs
// as ValidateSimple_test.res to prove byte-parity.
//
// Note: These tests directly call the ReScript implementation via the
// TypeScript ABI bridge declared in src/types/rescript-modules.d.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  validateTierCaps,
  validateTierPrompts,
  validateTaskPatterns,
} from "../../src/validate/ValidateSimple.res.mjs";

// ---------------------------------------------------------------------------
// validateTierCaps
// ---------------------------------------------------------------------------

describe("validateTierCaps", () => {
  it("accepts a valid tierCaps object with one cap", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { fast: 100, heavy: 50 },
      } as any),
    ).not.toThrow();
  });

  it("accepts tierCaps with various positive integers", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { tier1: 1, tier2: 10, tier3: 1000 },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when tierCaps is absent", () => {
    expect(() =>
      validateTierCaps({
        activePreset: "default",
      } as any),
    ).not.toThrow();
  });

  it("accepts tierCaps with large positive integers", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { big: 999999999 },
      } as any),
    ).not.toThrow();
  });

  it("throws when tierCaps is not an object (array)", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: [],
      } as any),
    ).toThrow("tiers.json: 'tierCaps' must be an object");
  });

  it("throws when tierCaps is null", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: null,
      } as any),
    ).toThrow("tiers.json: 'tierCaps' must be an object");
  });

  it("throws when a cap is not a number", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { fast: "not-a-number" },
      } as any),
    ).toThrow("tiers.json: tierCaps.'fast' must be a positive integer");
  });

  it("throws when a cap is negative", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { fast: -1 },
      } as any),
    ).toThrow("tiers.json: tierCaps.'fast' must be a positive integer");
  });

  it("throws when a cap is zero", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { fast: 0 },
      } as any),
    ).toThrow("tiers.json: tierCaps.'fast' must be a positive integer");
  });

  it("throws when a cap is Infinity", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { fast: Infinity },
      } as any),
    ).toThrow("tiers.json: tierCaps.'fast' must be a positive integer");
  });

  it("throws when a cap is NaN", () => {
    expect(() =>
      validateTierCaps({
        tierCaps: { fast: NaN },
      } as any),
    ).toThrow("tiers.json: tierCaps.'fast' must be a positive integer");
  });
});

// ---------------------------------------------------------------------------
// validateTierPrompts
// ---------------------------------------------------------------------------

describe("validateTierPrompts", () => {
  it("accepts a valid tierPrompts object with one prompt", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: { fast: "Use fast model", heavy: "Use heavy model" },
      } as any),
    ).not.toThrow();
  });

  it("accepts tierPrompts with various string values", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: { tier1: "", tier2: "Hello", tier3: "Multi-word prompt" },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when tierPrompts is absent", () => {
    expect(() =>
      validateTierPrompts({
        activePreset: "default",
      } as any),
    ).not.toThrow();
  });

  it("accepts tierPrompts with empty string values", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: { empty: "" },
      } as any),
    ).not.toThrow();
  });

  it("throws when tierPrompts is not an object (array)", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: [],
      } as any),
    ).toThrow("tiers.json: 'tierPrompts' must be an object");
  });

  it("throws when tierPrompts is null", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: null,
      } as any),
    ).toThrow("tiers.json: 'tierPrompts' must be an object");
  });

  it("throws when a prompt is not a string (number)", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: { fast: 123 },
      } as any),
    ).toThrow("tiers.json: tierPrompts.'fast' must be a string");
  });

  it("throws when a prompt is not a string (object)", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: { fast: { text: "not a string" } },
      } as any),
    ).toThrow("tiers.json: tierPrompts.'fast' must be a string");
  });

  it("throws when a prompt is not a string (array)", () => {
    expect(() =>
      validateTierPrompts({
        tierPrompts: { fast: ["array", "not", "string"] },
      } as any),
    ).toThrow("tiers.json: tierPrompts.'fast' must be a string");
  });
});

// ---------------------------------------------------------------------------
// validateTaskPatterns
// ---------------------------------------------------------------------------

describe("validateTaskPatterns", () => {
  it("accepts a valid taskPatterns object with one pattern array", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: { read: ["*.md", "*.txt"], write: ["*.ts"] },
      } as any),
    ).not.toThrow();
  });

  it("accepts taskPatterns with empty arrays", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: { empty: [] },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when taskPatterns is absent", () => {
    expect(() =>
      validateTaskPatterns({
        activePreset: "default",
      } as any),
    ).not.toThrow();
  });

  it("accepts taskPatterns with multiple patterns", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: { docs: ["*.md", "*.rst", "*.adoc"] },
      } as any),
    ).not.toThrow();
  });

  it("throws when taskPatterns is not an object (array)", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: [],
      } as any),
    ).toThrow("tiers.json: 'taskPatterns' must be an object");
  });

  it("throws when taskPatterns is null", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: null,
      } as any),
    ).toThrow("tiers.json: 'taskPatterns' must be an object");
  });

  it("throws when a pattern entry is not an array (string)", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: { read: "*.md" },
      } as any),
    ).toThrow("tiers.json: taskPatterns.'read' must be an array of strings");
  });

  it("throws when a pattern entry is not an array (number)", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: { read: 42 },
      } as any),
    ).toThrow("tiers.json: taskPatterns.'read' must be an array of strings");
  });

  it("throws when a pattern entry is not an array (object)", () => {
    expect(() =>
      validateTaskPatterns({
        taskPatterns: { read: { patterns: ["*.md"] } },
      } as any),
    ).toThrow("tiers.json: taskPatterns.'read' must be an array of strings");
  });
});
