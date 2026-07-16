/**
 * test/unit/tier-ladder.test.ts
 *
 * RED tests for resolveLadder — the canonical fallback tier-order resolver.
 *
 * Precedence contract (spec: ladder-resolution precedence):
 *   1. explicit enforcement.escalate.ladder wins (copied, not referenced)
 *   2. preset tiers sorted by costRatio ascending (stable insertion tie-break)
 *   3. default ['fast','light','medium','focused','heavy'] filtered to present names
 *
 * Additional contracts:
 *   - resolveLadder is pure: input cfg is never mutated
 *   - Returns a fresh array on every call (fresh-array immutability)
 *   - Custom three-tier preset resolves to exactly 3 rungs (backward-compat)
 */

import { describe, expect, it } from "vitest";
import { resolveLadder } from "../../src/router/tier-ladder";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal cfg builder with an active preset containing named tiers. */
const makeCfg = (
  tierDefs: Record<string, { model: string; description: string; whenToUse: string[]; costRatio?: number }>,
  overrides: Partial<RouterConfig> = {},
): RouterConfig => ({
  activePreset: "default",
  presets: { default: tierDefs },
  rules: [],
  defaultTier: "medium",
  ...overrides,
} as RouterConfig);

// ---------------------------------------------------------------------------
// RED — explicit precedence (scenario: explicit ladder wins)
// ---------------------------------------------------------------------------

describe("resolveLadder — explicit ladder precedence", () => {
  it("explicit enforcement.escalate.ladder is returned unchanged", () => {
    const cfg = makeCfg(
      { fast: { model: "a/f", description: "f", whenToUse: [] } },
      { enforcement: { escalate: { ladder: ["medium", "heavy"] } } },
    );
    const result = resolveLadder(cfg);
    expect(result).toEqual(["medium", "heavy"]);
  });

  it("explicit ladder is copied (not the same array reference)", () => {
    const explicitLadder = ["medium", "heavy"];
    const cfg = makeCfg(
      { fast: { model: "a/f", description: "f", whenToUse: [] } },
      { enforcement: { escalate: { ladder: explicitLadder } } },
    );
    const result = resolveLadder(cfg);
    expect(result).not.toBe(explicitLadder);
    expect(result).toEqual(explicitLadder);
  });

  it("explicit ladder wins over preset costRatio ordering", () => {
    const cfg = makeCfg(
      {
        fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
        medium: { model: "a/m", description: "m", whenToUse: [], costRatio: 5 },
        heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
      },
      { enforcement: { escalate: { ladder: ["heavy", "fast"] } } },
    );
    // Even though fast=1 is cheapest, explicit ladder dictates order
    expect(resolveLadder(cfg)).toEqual(["heavy", "fast"]);
  });
});

// ---------------------------------------------------------------------------
// RED — costRatio sort fallback (scenario: costRatio sort fallback)
// ---------------------------------------------------------------------------

describe("resolveLadder — costRatio sort fallback", () => {
  it("preset tiers sorted by costRatio ascending", () => {
    const cfg = makeCfg({
      fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
      light: { model: "a/l", description: "l", whenToUse: [], costRatio: 2 },
      medium: { model: "a/m", description: "m", whenToUse: [], costRatio: 5 },
      focused: { model: "a/fc", description: "fc", whenToUse: [], costRatio: 10 },
      heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
    });
    expect(resolveLadder(cfg)).toEqual(["fast", "light", "medium", "focused", "heavy"]);
  });

  it("missing costRatio sorts to end (stable insertion order tie-break)", () => {
    // All tiers without costRatio appear after those with, in preset insertion order
    const cfg = makeCfg({
      alpha: { model: "a/a", description: "a", whenToUse: [] },
      beta: { model: "a/b", description: "b", whenToUse: [], costRatio: 1 },
      gamma: { model: "a/g", description: "g", whenToUse: [] },
    });
    // beta has costRatio=1, so it comes first; alpha and gamma have no costRatio, insertion order preserved
    expect(resolveLadder(cfg)).toEqual(["beta", "alpha", "gamma"]);
  });

  it("equal costRatio preserves insertion order (stable sort)", () => {
    const cfg = makeCfg({
      first: { model: "a/f", description: "f", whenToUse: [], costRatio: 5 },
      second: { model: "a/s", description: "s", whenToUse: [], costRatio: 5 },
      third: { model: "a/t", description: "t", whenToUse: [], costRatio: 5 },
    });
    // Stable sort: insertion order preserved for equal costRatio
    expect(resolveLadder(cfg)).toEqual(["first", "second", "third"]);
  });
});

// ---------------------------------------------------------------------------
// RED — default filtered to present tiers (scenario: default filtered to present)
// ---------------------------------------------------------------------------

describe("resolveLadder — default filtered to present tiers", () => {
  it("three-tier preset returns exactly three rungs", () => {
    const cfg = makeCfg({
      fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
      medium: { model: "a/m", description: "m", whenToUse: [], costRatio: 5 },
      heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
    });
    expect(resolveLadder(cfg)).toEqual(["fast", "medium", "heavy"]);
  });

  it("two-tier preset returns exactly two rungs", () => {
    const cfg = makeCfg({
      fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
      heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
    });
    expect(resolveLadder(cfg)).toEqual(["fast", "heavy"]);
  });

  it("single-tier preset returns exactly one rung", () => {
    const cfg = makeCfg({
      heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
    });
    expect(resolveLadder(cfg)).toEqual(["heavy"]);
  });

  it("preset with no costRatio still returns present tiers in insertion order", () => {
    const cfg = makeCfg({
      zebra: { model: "a/z", description: "z", whenToUse: [] },
      alpha: { model: "a/a", description: "a", whenToUse: [] },
    });
    expect(resolveLadder(cfg)).toEqual(["zebra", "alpha"]);
  });
});

// ---------------------------------------------------------------------------
// RED — immutability (scenario: input unchanged)
// ---------------------------------------------------------------------------

describe("resolveLadder — immutability", () => {
  it("does not mutate the input cfg", () => {
    const cfg = makeCfg(
      {
        fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
        medium: { model: "a/m", description: "m", whenToUse: [], costRatio: 5 },
      },
      { enforcement: { escalate: { ladder: ["medium"] } } },
    );
    const ladderBefore = cfg.enforcement?.escalate?.ladder;
    resolveLadder(cfg);
    expect(cfg.enforcement?.escalate?.ladder).toBe(ladderBefore);
  });

  it("does not mutate the explicit ladder array", () => {
    const explicitLadder = ["medium", "heavy"] as const;
    const cfg = makeCfg(
      { fast: { model: "a/f", description: "f", whenToUse: [] } },
      { enforcement: { escalate: { ladder: [...explicitLadder] } } },
    );
    const cfgLadderBefore = [...(cfg.enforcement?.escalate?.ladder ?? [])];
    resolveLadder(cfg);
    expect(cfg.enforcement?.escalate?.ladder).toEqual(cfgLadderBefore);
  });

  it("returns a fresh array on every call", () => {
    const cfg = makeCfg({
      fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
      medium: { model: "a/m", description: "m", whenToUse: [], costRatio: 5 },
    });
    const r1 = resolveLadder(cfg);
    const r2 = resolveLadder(cfg);
    expect(r1).not.toBe(r2);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// RED — backward-compatible three-tier (scenario: three-tier custom preset)
// ---------------------------------------------------------------------------

describe("resolveLadder — backward-compatible three-tier", () => {
  it("custom three-tier preset resolves to 3 rungs with no extra tiers", () => {
    const cfg = makeCfg({
      turbo: { model: "a/t", description: "t", whenToUse: [], costRatio: 15 },
      fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
      heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
    });
    // No explicit ladder → costRatio sort → fast(1), turbo(15), heavy(20)
    const result = resolveLadder(cfg);
    expect(result).toHaveLength(3);
    expect(result).toEqual(["fast", "turbo", "heavy"]);
  });

  it("enforcement absent returns preset tiers sorted by costRatio", () => {
    const cfg = makeCfg({
      fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 3 },
      heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 1 },
    });
    expect(resolveLadder(cfg)).toEqual(["heavy", "fast"]);
  });
});

// ---------------------------------------------------------------------------
// RED — skipTiers (new config field from design)
// ---------------------------------------------------------------------------

describe("resolveLadder — skipTiers compatibility", () => {
  it("returns all tiers when skipTiers is not set", () => {
    const cfg = makeCfg(
      {
        fast: { model: "a/f", description: "f", whenToUse: [], costRatio: 1 },
        medium: { model: "a/m", description: "m", whenToUse: [], costRatio: 5 },
        heavy: { model: "a/h", description: "h", whenToUse: [], costRatio: 20 },
      },
      { enforcement: { verify: {} } },
    );
    // skipTiers not set → all preset tiers returned
    expect(resolveLadder(cfg)).toEqual(["fast", "medium", "heavy"]);
  });
});
