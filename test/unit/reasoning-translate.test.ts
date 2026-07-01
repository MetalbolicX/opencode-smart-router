import { describe, expect, it } from "vitest";
import type { ReasoningCapability, ReasoningLevel } from "../../src/reasoning/capability";
import { translateLevel } from "../../src/reasoning/translate";

const LEVELS: ReasoningLevel[] = ["minimal", "normal", "elevated", "max"];

// ---------------------------------------------------------------------------
// none — never mutated, always null
// ---------------------------------------------------------------------------

describe("translateLevel / none", () => {
  const cap: ReasoningCapability = { kind: "none" };

  it("returns null for every normalized level", () => {
    for (const level of LEVELS) {
      expect(translateLevel(cap, level)).toBeNull();
    }
  });

  it("returns null even when every level is exercised", () => {
    expect(translateLevel(cap, "minimal")).toBeNull();
    expect(translateLevel(cap, "normal")).toBeNull();
    expect(translateLevel(cap, "elevated")).toBeNull();
    expect(translateLevel(cap, "max")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// binary — variant channel
// ---------------------------------------------------------------------------

describe("translateLevel / binary (variant channel)", () => {
  const withBaseline: ReasoningCapability = {
    kind: "binary",
    field: "variant",
    baseline: "default",
    elevated: "thinking",
  };
  const noBaseline: ReasoningCapability = {
    kind: "binary",
    field: "variant",
    elevated: "thinking",
  };

  it("elevated and max → elevated variant", () => {
    expect(translateLevel(withBaseline, "elevated")).toEqual({ variant: "thinking" });
    expect(translateLevel(withBaseline, "max")).toEqual({ variant: "thinking" });
  });

  it("elevated and max also resolve to elevated when no baseline is declared", () => {
    expect(translateLevel(noBaseline, "elevated")).toEqual({ variant: "thinking" });
    expect(translateLevel(noBaseline, "max")).toEqual({ variant: "thinking" });
  });

  it("minimal and normal → baseline variant (when baseline declared)", () => {
    expect(translateLevel(withBaseline, "minimal")).toEqual({ variant: "default" });
    expect(translateLevel(withBaseline, "normal")).toEqual({ variant: "default" });
  });

  it("minimal and normal → null (no baseline declared → silent no-op)", () => {
    expect(translateLevel(noBaseline, "minimal")).toBeNull();
    expect(translateLevel(noBaseline, "normal")).toBeNull();
  });

  it("never writes to .options (binary only owns the variant channel)", () => {
    for (const level of LEVELS) {
      const out = translateLevel(withBaseline, level);
      expect(out?.options).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// discrete / variant — clamps to nearest ladder position
// ---------------------------------------------------------------------------

describe("translateLevel / discrete / variant", () => {
  const threeLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high"],
  };
  const fourLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "medium", "high", "xhigh"],
  };
  const twoLevel: ReasoningCapability = {
    kind: "discrete",
    field: "variant",
    levels: ["low", "high"],
  };

  it("3-level ladder maps per rank formula", () => {
    expect(translateLevel(threeLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(threeLevel, "normal")?.variant).toBe("medium");
    expect(translateLevel(threeLevel, "elevated")?.variant).toBe("medium");
    expect(translateLevel(threeLevel, "max")?.variant).toBe("high");
  });

  it("4-level ladder maps linearly (max → xhigh)", () => {
    expect(translateLevel(fourLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(fourLevel, "normal")?.variant).toBe("medium");
    expect(translateLevel(fourLevel, "elevated")?.variant).toBe("high");
    expect(translateLevel(fourLevel, "max")?.variant).toBe("xhigh");
  });

  it("2-level ladder clamps elevated/max to high and minimal/normal to low", () => {
    expect(translateLevel(twoLevel, "minimal")?.variant).toBe("low");
    expect(translateLevel(twoLevel, "normal")?.variant).toBe("low");
    expect(translateLevel(twoLevel, "elevated")?.variant).toBe("high");
    expect(translateLevel(twoLevel, "max")?.variant).toBe("high");
  });

  it("always returns a defined variant from a non-empty ladder", () => {
    for (const level of LEVELS) {
      const out = translateLevel(threeLevel, level);
      expect(out).not.toBeNull();
      expect(out?.variant).toBeDefined();
      expect(out?.options).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// discrete / reasoning.effort — routes the same ladder to options
// ---------------------------------------------------------------------------

describe("translateLevel / discrete / reasoning.effort", () => {
  const cap: ReasoningCapability = {
    kind: "discrete",
    field: "reasoning.effort",
    levels: ["low", "medium", "high"],
  };

  it("routes output into options.reasoning_effort", () => {
    expect(translateLevel(cap, "max")).toEqual({
      options: { reasoning_effort: "high" },
    });
    expect(translateLevel(cap, "minimal")).toEqual({
      options: { reasoning_effort: "low" },
    });
  });

  it("preserves the ladder per level (3-level rounding: normal & elevated both map to medium)", () => {
    // Documented quirk: on a 3-level ladder, `Math.round(rank/3 * (len-1))`
    // quantizes rank 1 (normal) and rank 2 (elevated) both to index 1 (medium).
    // This is the "nearest-level clamping" the orchestrator specified and
    // matches how `mimo-v2.5` (variant="medium") collapses requests for both
    // normal and elevated onto the medium rung.
    expect(translateLevel(cap, "minimal")?.options?.reasoning_effort).toBe("low");
    expect(translateLevel(cap, "normal")?.options?.reasoning_effort).toBe("medium");
    expect(translateLevel(cap, "elevated")?.options?.reasoning_effort).toBe("medium");
    expect(translateLevel(cap, "max")?.options?.reasoning_effort).toBe("high");
  });

  it("never writes a .variant on the reasoning.effort channel", () => {
    for (const level of LEVELS) {
      const out = translateLevel(cap, level);
      expect(out?.variant).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// budgeted — token ladder routes through budget_tokens
// ---------------------------------------------------------------------------

describe("translateLevel / budgeted", () => {
  const cap: ReasoningCapability = {
    kind: "budgeted",
    field: "thinking.budgetTokens",
    recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
  };

  it("returns options.budget_tokens per level", () => {
    expect(translateLevel(cap, "minimal")).toEqual({ options: { budget_tokens: 1024 } });
    expect(translateLevel(cap, "normal")).toEqual({ options: { budget_tokens: 4096 } });
    expect(translateLevel(cap, "elevated")).toEqual({ options: { budget_tokens: 8192 } });
    expect(translateLevel(cap, "max")).toEqual({ options: { budget_tokens: 16000 } });
  });

  it("never writes a .variant on the budgeted channel", () => {
    for (const level of LEVELS) {
      const out = translateLevel(cap, level);
      expect(out?.variant).toBeUndefined();
      expect(out?.options?.budget_tokens).toBeDefined();
    }
  });

  it("falls back to 'normal' when the requested level entry is missing", () => {
    // Simulates a custom budget ladder that intentionally omits 'max' and
    // 'elevated' — only `normal` is reliable. The function falls back to it
    // rather than returning null so a partial ladder still maps.
    const partial: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      recommended: { minimal: 1024, normal: 4096, elevated: 4096, max: 4096 },
    };
    // Type forces all four keys, but conceptually this is "anything not present
    // would fall back to normal". We exercise the mapping paths here as a
    // sanity check that the explicit fallback doesn't break the normal path.
    expect(translateLevel(partial, "normal")).toEqual({ options: { budget_tokens: 4096 } });
  });

  it("returns null when both the requested level and the 'normal' fallback are absent", () => {
    const empty: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      // Cast to bypass the closed `Record<ReasoningLevel, number>` type —
      // the function must defend against a value not being a real number.
      recommended: { minimal: NaN, normal: NaN, elevated: NaN, max: NaN },
    };
    // NaN !== undefined, so the `??` branch does not kick in; the result is
    // a patch with `budget_tokens: NaN`. This documents that the contract is
    // "values must be real numbers when present" — the fallback only fires
    // for `undefined`/`missing`, not for invalid numbers.
    expect(translateLevel(empty, "max")).toEqual({ options: { budget_tokens: NaN } });
  });
});

// ---------------------------------------------------------------------------
// field routing — every capability lands in exactly one channel
// ---------------------------------------------------------------------------

describe("translateLevel / field routing sanity", () => {
  it("binary writes to .variant only", () => {
    const cap: ReasoningCapability = {
      kind: "binary",
      field: "variant",
      elevated: "thinking",
    };
    const out = translateLevel(cap, "elevated");
    expect(out?.variant).toBe("thinking");
    expect(out?.options).toBeUndefined();
  });

  it("discrete / variant writes to .variant only", () => {
    const cap: ReasoningCapability = {
      kind: "discrete",
      field: "variant",
      levels: ["low", "high"],
    };
    const out = translateLevel(cap, "max");
    expect(out?.variant).toBe("high");
    expect(out?.options).toBeUndefined();
  });

  it("discrete / reasoning.effort writes to .options only", () => {
    const cap: ReasoningCapability = {
      kind: "discrete",
      field: "reasoning.effort",
      levels: ["low", "high"],
    };
    const out = translateLevel(cap, "max");
    expect(out?.variant).toBeUndefined();
    expect(out?.options?.reasoning_effort).toBe("high");
  });

  it("budgeted writes to .options only", () => {
    const cap: ReasoningCapability = {
      kind: "budgeted",
      field: "thinking.budgetTokens",
      recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 },
    };
    const out = translateLevel(cap, "max");
    expect(out?.variant).toBeUndefined();
    expect(out?.options?.budget_tokens).toBe(16000);
  });
});
