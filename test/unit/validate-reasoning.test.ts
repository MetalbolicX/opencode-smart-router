// ---------------------------------------------------------------------------
// test/unit/validate-reasoning.test.ts
//
// Vitest fixture for ValidateReasoning validators — runs on IDENTICAL inputs
// as ValidateReasoning_test.res to prove byte-parity.
//
// Note: These tests directly call the ReScript implementation via the
// TypeScript ABI bridge declared in src/types/rescript-modules.d.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ValidateReasoning: any = require("../../src/validate/ValidateReasoning.res.mjs");

// ---------------------------------------------------------------------------
// validateReasoningPolicy — top-level dispatcher
// ---------------------------------------------------------------------------

describe("validateReasoningPolicy", () => {
  it("accepts a valid reasoningPolicy object", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicy({
        reasoningPolicy: { mode: "static" },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when reasoningPolicy is absent", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicy({
        activePreset: "default",
      } as any),
    ).not.toThrow();
  });

  it("throws when reasoningPolicy is not an object", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicy({
        reasoningPolicy: "not-an-object",
      } as any),
    ).toThrow("tiers.json: 'reasoningPolicy' must be an object");
  });

  it("throws when reasoningPolicy is an array", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicy({
        reasoningPolicy: [],
      } as any),
    ).toThrow("tiers.json: 'reasoningPolicy' must be an object");
  });

  it("throws when adaptive is not an object", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicy({
        reasoningPolicy: { adaptive: "not-an-object" },
      } as any),
    ).toThrow("tiers.json: reasoningPolicy.adaptive must be an object");
  });
});

// ---------------------------------------------------------------------------
// validateReasoningPolicyMode
// ---------------------------------------------------------------------------

describe("validateReasoningPolicyMode", () => {
  it("accepts mode 'static'", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicyMode({
        mode: "static",
      } as any),
    ).not.toThrow();
  });

  it("accepts mode 'manual'", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicyMode({
        mode: "manual",
      } as any),
    ).not.toThrow();
  });

  it("accepts mode 'adaptive'", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicyMode({
        mode: "adaptive",
      } as any),
    ).not.toThrow();
  });

  it("passes silently when mode is absent", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicyMode({
        otherField: "value",
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid mode string", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicyMode({
        mode: "invalid",
      } as any),
    ).toThrow("tiers.json: reasoningPolicy.mode must be one of static|manual|adaptive");
  });

  it("throws on non-string mode", () => {
    expect(() =>
      ValidateReasoning.validateReasoningPolicyMode({
        mode: 123,
      } as any),
    ).toThrow("tiers.json: reasoningPolicy.mode must be one of static|manual|adaptive");
  });
});

// ---------------------------------------------------------------------------
// validateAdaptivePolicy
// ---------------------------------------------------------------------------

describe("validateAdaptivePolicy", () => {
  it("accepts a valid adaptive object", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { defaultLevel: "normal" },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when adaptive is absent", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        mode: "static",
      } as any),
    ).not.toThrow();
  });

  it("throws when adaptive is not an object", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: "not-an-object",
      } as any),
    ).toThrow("tiers.json: reasoningPolicy.adaptive must be an object");
  });

  it("accepts trivialLevel as null", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { trivialLevel: null },
      } as any),
    ).not.toThrow();
  });

  it("accepts defaultLevel as null", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { defaultLevel: null },
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid trivialLevel", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { trivialLevel: "not-a-level" },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.trivialLevel must be one of minimal|normal|elevated|max or null",
    );
  });

  it("throws on invalid defaultLevel", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { defaultLevel: "not-a-level" },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.defaultLevel must be one of minimal|normal|elevated|max or null",
    );
  });

  it("accepts valid keywordRules", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { keywordRules: [{ keywords: ["bug"], level: "minimal" }] },
      } as any),
    ).not.toThrow();
  });

  it("accepts valid tierDefaults", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { tierDefaults: { fast: "minimal", heavy: "max" } },
      } as any),
    ).not.toThrow();
  });

  it("accepts surfaceDecision as true", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { surfaceDecision: true },
      } as any),
    ).not.toThrow();
  });

  it("accepts surfaceDecision as false", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { surfaceDecision: false },
      } as any),
    ).not.toThrow();
  });

  it("throws on non-boolean surfaceDecision", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { surfaceDecision: "yes" },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.surfaceDecision must be a boolean",
    );
  });

  it("throws on non-array keywordRules", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { keywordRules: "not-an-array" },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules must be an array",
    );
  });

  it("throws on invalid tierDefaults", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { tierDefaults: { fast: "not-a-level" } },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.tierDefaults.fast must be one of minimal|normal|elevated|max",
    );
  });

  it("throws when adaptive.tierDefaults is not an object", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { tierDefaults: "not-an-object" },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object",
    );
  });
});

// ---------------------------------------------------------------------------
// validateKeywordRule
// ---------------------------------------------------------------------------

describe("validateKeywordRule", () => {
  it("accepts valid rule with level", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug", "error"], level: "minimal" } as any,
        0,
      ),
    ).not.toThrow();
  });

  it("accepts rule with match field", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["crash"], level: "minimal", match: "word" } as any,
        0,
      ),
    ).not.toThrow();
  });

  it("accepts rule with excludeKeywords", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["slow"], level: "normal", excludeKeywords: ["fast"] } as any,
        0,
      ),
    ).not.toThrow();
  });

  it("accepts rule with match=stem", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["analyzing"], level: "elevated", match: "stem" } as any,
        0,
      ),
    ).not.toThrow();
  });

  it("accepts rule with match=substring", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["analyze"], level: "elevated", match: "substring" } as any,
        0,
      ),
    ).not.toThrow();
  });

  it("accepts rule with match=regex (valid pattern)", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug[0-9]+"], level: "minimal", match: "regex" } as any,
        0,
      ),
    ).not.toThrow();
  });

  it("throws when rule is not an object", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule("not-an-object" as any, 0),
    ).toThrow("tiers.json: reasoningPolicy.adaptive.keywordRules[0] must be an object");
  });

  it("throws when keywords is not an array", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: "not-an-array", level: "minimal" } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].keywords must be an array of strings",
    );
  });

  it("throws when keywords is empty", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: [], level: "minimal" } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].keywords must be a non-empty array of strings",
    );
  });

  it("throws when keywords contains non-string", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug", 123], level: "minimal" } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].keywords must be an array of strings",
    );
  });

  it("throws when level is missing", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule({ keywords: ["bug"] } as any, 0),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].level must be one of minimal|normal|elevated|max",
    );
  });

  it("throws when level is invalid", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug"], level: "not-a-level" } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].level must be one of minimal|normal|elevated|max",
    );
  });

  it("throws on invalid match value", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug"], level: "minimal", match: "invalid" } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].match must be one of word|stem|substring|regex",
    );
  });

  it("throws on non-string match", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug"], level: "minimal", match: 123 } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].match must be one of word|stem|substring|regex",
    );
  });

  it("throws on non-array excludeKeywords", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["bug"], level: "minimal", excludeKeywords: "not-an-array" } as any,
        0,
      ),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.keywordRules[0].excludeKeywords must be an array of strings",
    );
  });

  it("throws on invalid regex pattern", () => {
    expect(() =>
      ValidateReasoning.validateKeywordRule(
        { keywords: ["[invalid"], level: "minimal", match: "regex" } as any,
        0,
      ),
    ).toThrow("tiers.json: reasoningPolicy.adaptive.keywordRules[0] has invalid regex");
  });
});

// ---------------------------------------------------------------------------
// validateAdaptiveTierDefaults
// ---------------------------------------------------------------------------

describe("validateAdaptiveTierDefaults", () => {
  it("accepts empty tierDefaults", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        tierDefaults: {},
      } as any),
    ).not.toThrow();
  });

  it("accepts single tierDefault", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        tierDefaults: { fast: "minimal" },
      } as any),
    ).not.toThrow();
  });

  it("accepts multiple tierDefaults", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        tierDefaults: { fast: "minimal", heavy: "max", medium: "normal" },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when tierDefaults is absent", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        otherField: "value",
      } as any),
    ).not.toThrow();
  });

  it("throws when tierDefaults is not an object", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        tierDefaults: "not-an-object",
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.tierDefaults must be an object",
    );
  });

  it("throws on invalid level value", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        tierDefaults: { fast: "not-a-level" },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.tierDefaults.fast must be one of minimal|normal|elevated|max",
    );
  });

  it("throws on null level value", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveTierDefaults({
        tierDefaults: { fast: null },
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.tierDefaults.fast must be one of minimal|normal|elevated|max",
    );
  });
});

// ---------------------------------------------------------------------------
// validateAdaptiveSurfaceDecision
// ---------------------------------------------------------------------------

describe("validateAdaptiveSurfaceDecision", () => {
  it("accepts surfaceDecision as true", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveSurfaceDecision({
        surfaceDecision: true,
      } as any),
    ).not.toThrow();
  });

  it("accepts surfaceDecision as false", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveSurfaceDecision({
        surfaceDecision: false,
      } as any),
    ).not.toThrow();
  });

  it("passes silently when surfaceDecision is absent", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveSurfaceDecision({
        otherField: "value",
      } as any),
    ).not.toThrow();
  });

  it("throws on non-boolean surfaceDecision (string)", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveSurfaceDecision({
        surfaceDecision: "yes",
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.surfaceDecision must be a boolean",
    );
  });

  it("throws on non-boolean surfaceDecision (number)", () => {
    expect(() =>
      ValidateReasoning.validateAdaptiveSurfaceDecision({
        surfaceDecision: 1,
      } as any),
    ).toThrow(
      "tiers.json: reasoningPolicy.adaptive.surfaceDecision must be a boolean",
    );
  });
});

// ---------------------------------------------------------------------------
// absent / null / malformed distinction tests
// ---------------------------------------------------------------------------

describe("absent vs null vs malformed distinction", () => {
  it("level absent: no error", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: {},
      } as any),
    ).not.toThrow();
  });

  it("level null: no error", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { trivialLevel: null, defaultLevel: null },
      } as any),
    ).not.toThrow();
  });

  it("level malformed (wrong type): throws", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { trivialLevel: "not-a-level" },
      } as any),
    ).toThrow();
  });

  it("keywordRules absent: no error", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: {},
      } as any),
    ).not.toThrow();
  });

  it("keywordRules null: throws (must be array)", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { keywordRules: null },
      } as any),
    ).toThrow();
  });

  it("keywordRules malformed (string): throws", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { keywordRules: "not-an-array" },
      } as any),
    ).toThrow();
  });

  it("tierDefaults absent: no error", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: {},
      } as any),
    ).not.toThrow();
  });

  it("tierDefaults null: throws (must be object)", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { tierDefaults: null },
      } as any),
    ).toThrow();
  });

  it("surfaceDecision absent: no error", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: {},
      } as any),
    ).not.toThrow();
  });

  it("surfaceDecision null: throws (must be boolean)", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { surfaceDecision: null },
      } as any),
    ).toThrow();
  });

  it("surfaceDecision malformed (string): throws", () => {
    expect(() =>
      ValidateReasoning.validateAdaptivePolicy({
        adaptive: { surfaceDecision: "yes" },
      } as any),
    ).toThrow();
  });
});
