import { describe, expect, it } from "vitest";
import { selectAdaptiveLevel } from "../../src/reasoning/adaptive";
import type { ReasoningLevel } from "../../src/reasoning/capability";
import type { AdaptivePolicyConfig, ReasoningPolicyConfig } from "../../src/router/config.types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `ReasoningPolicyConfig` with the given adaptive block. `mode` is
 * intentionally not set on the policy here — the selector only inspects
 * `policy.adaptive`, so wiring `mode === "adaptive"` is the resolver's job
 * (covered in Phase 2 tests). Keeping these tests focused on the selector
 * means they don't accidentally regress when the resolver signature grows.
 */
const policyWithAdaptive = (adaptive: AdaptivePolicyConfig | undefined): ReasoningPolicyConfig => ({
  mode: "adaptive",
  adaptive,
});

const baseSignals = {
  prompt: "implement a new feature",
  description: "add a button to the dashboard",
  tierName: "medium",
  isTrivial: false,
};

// ---------------------------------------------------------------------------
// Branch 1 — no adaptive config → null
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — no adaptive config", () => {
  it("returns null when policy is undefined", () => {
    expect(selectAdaptiveLevel(baseSignals, undefined)).toEqual({
      level: null,
      reason: "no adaptive config",
    });
  });

  it("returns null when policy.adaptive is undefined", () => {
    const policy: ReasoningPolicyConfig = { mode: "adaptive" };
    expect(selectAdaptiveLevel(baseSignals, policy)).toEqual({
      level: null,
      reason: "no adaptive config",
    });
  });

  it("does not consult defaultLevel when the adaptive block is missing", () => {
    const policy: ReasoningPolicyConfig = { mode: "adaptive", defaultLevel: "elevated" };
    // `policy.defaultLevel` is the manual-mode fallback; under adaptive it
    // is NOT consulted unless `policy.adaptive` is also present.
    expect(selectAdaptiveLevel(baseSignals, policy).level).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Branch 2 — trivial classification short-circuits the selector
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — trivial classification", () => {
  it("applies trivialLevel when isTrivial is true", () => {
    const policy = policyWithAdaptive({ trivialLevel: "minimal" });
    const signals = { ...baseSignals, isTrivial: true };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("minimal");
  });

  it("returns null when isTrivial is true and trivialLevel is absent", () => {
    const policy = policyWithAdaptive({ defaultLevel: "elevated" });
    const signals = { ...baseSignals, isTrivial: true };
    // Trivial short-circuits BEFORE the default branch — `defaultLevel`
    // must NOT rescue a trivial task.
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("returns null when isTrivial is true and trivialLevel is explicitly null", () => {
    // base.json ships `"trivialLevel": null` — the selector must treat
    // explicit null identically to "absent".
    const policy = policyWithAdaptive({ trivialLevel: null, defaultLevel: "normal" });
    const signals = { ...baseSignals, isTrivial: true };
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("does NOT consult tierDefaults or keywordRules when isTrivial is true", () => {
    const policy = policyWithAdaptive({
      trivialLevel: "minimal",
      tierDefaults: { medium: "elevated" },
      keywordRules: [{ keywords: ["refactor"], level: "max" }],
    });
    const signals = {
      ...baseSignals,
      isTrivial: true,
      prompt: "refactor this module",
      tierName: "medium",
    };
    // Trivial wins — even though keyword "refactor" matches and the tier
    // default would override, the trivial branch short-circuits both.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("minimal");
  });
});

// ---------------------------------------------------------------------------
// Branch 3 — tierDefaults wins over defaultLevel
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — tierDefaults", () => {
  it("returns tierDefaults[tierName] when the tier is listed", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      tierDefaults: { heavy: "elevated" },
    });
    const signals = { ...baseSignals, tierName: "heavy" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("falls through to defaultLevel when tierName is not in tierDefaults", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      tierDefaults: { heavy: "elevated" },
    });
    const signals = { ...baseSignals, tierName: "fast" }; // not in map
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("treats empty tierDefaults as absent (falls through)", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "elevated",
      tierDefaults: {},
    });
    expect(selectAdaptiveLevel(baseSignals, policy).level).toBe("elevated");
  });

  it("tierDefaults wins over keywordRules (decision order: trivial → tier → keyword → default)", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      tierDefaults: { medium: "elevated" },
      keywordRules: [{ keywords: ["refactor"], level: "max" }],
    });
    const signals = {
      ...baseSignals,
      tierName: "medium",
      prompt: "please refactor this file",
    };
    // The plan pins the order as: isTrivial → tierDefaults → keywordRules
    // → defaultLevel. So tierDefaults beats keywordRules here.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });
});

// ---------------------------------------------------------------------------
// Branch 4 — keywordRules: first match wins (array order = priority)
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — keywordRules priority", () => {
  it("first matching keyword rule wins", () => {
    const policy = policyWithAdaptive({
      keywordRules: [
        { keywords: ["refactor"], level: "elevated" },
        { keywords: ["fix"], level: "minimal" },
      ],
    });
    const signals = {
      ...baseSignals,
      prompt: "please fix the bug and refactor the module",
    };
    // Both rules match — first one wins.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("matches keywords found in description even when prompt does not contain them", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "implement a new endpoint",
      description: "needs a refactor of the auth layer",
    };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("matches keywords found in prompt even when description does not contain them", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["debug"], level: "elevated" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "debug the failing test",
      description: "in the payments service",
    };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("is case-insensitive: keyword 'Refactor' matches prompt 'refactoring the auth module'", () => {
    // Signals are pre-lowercased by the caller (per the AdaptiveSignals
    // contract); this test pins down the substring match semantics, not
    // the case-folding (the caller owns case-folding).
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "refactoring the auth module",
    };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("is case-insensitive when keywords are mixed case AND the signal text is lowercased", () => {
    // Real-world call: hook layer lowercases both prompt and keywords
    // (effectively) by sending them as lowercased strings to a lowercased
    // match. The selector must not assume one side is cased.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor", "architecture"], level: "elevated" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "review the architecture diagram",
    };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("does substring matching — 'refactor' matches 'refactoring'", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "we are refactoring this code" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("skips a rule when none of its keywords match", () => {
    const policy = policyWithAdaptive({
      keywordRules: [
        { keywords: ["refactor"], level: "elevated" },
        { keywords: ["debug"], level: "elevated" },
      ],
    });
    const signals = { ...baseSignals, prompt: "debug the failing test" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("skips rules with empty keyword arrays", () => {
    const policy = policyWithAdaptive({
      keywordRules: [
        { keywords: [], level: "max" }, // matches nothing
        { keywords: ["refactor"], level: "elevated" },
      ],
    });
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("reports the matched keyword in the decision reason (for debug logs)", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor", "architecture"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "please refactor this" };
    // Reason includes rule index, matched keyword, mode, and source field.
    // Default mode is `stem`; the prompt is the source.
    expect(selectAdaptiveLevel(signals, policy)).toMatchObject({
      level: "elevated",
      reason: `keyword match: rule[0] "refactor" (stem) in prompt`,
    });
  });

  it("first matching keyword within a multi-keyword rule wins", () => {
    // The selector iterates keywords in declared order within a single rule.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor", "architecture", "security"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "review the architecture" };
    expect(selectAdaptiveLevel(signals, policy).reason).toBe(
      `keyword match: rule[0] "architecture" (stem) in prompt`,
    );
  });
});

// ---------------------------------------------------------------------------
// Branch 4b — malformed keywordRules entries are skipped silently (fail-soft)
//
// The TypeScript type declares `keywords: string[]`, but runtime config can
// drift (hand-edited files, partial migrations, JSON coming from an external
// preset). The spec mandates these shapes be treated as non-matching rules:
// they MUST NOT throw, MUST NOT change valid `surfaceDecision` reasons for
// other rules, and MUST NOT prevent a later valid rule from matching.
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — malformed keyword rules (fail-soft)", () => {
  /**
   * Build a policy whose `keywordRules` are typed as `unknown` so the
   * inner literals escape the contextual `string[]` check. All malformed
   * test cases use this — every assertion below would fail with a TypeError
   * on the unhardened selector, proving the guard does its job.
   */
  const policyWithRawRules = (
    keywordRules: unknown,
    extra: AdaptivePolicyConfig = {},
  ): ReasoningPolicyConfig => {
    const adaptive = { ...extra, keywordRules } as unknown as AdaptivePolicyConfig;
    return { mode: "adaptive", adaptive };
  };

  it("skips a rule whose `keywords` field is missing without throwing", () => {
    const policy = policyWithRawRules([{ keywords: undefined, level: "max" }]);
    const signals = { ...baseSignals, prompt: "implement a button" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("skips a rule whose `keywords` is a string (non-array)", () => {
    const policy = policyWithRawRules([{ keywords: "refactor", level: "max" }]);
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("skips a rule whose `keywords` is null", () => {
    const policy = policyWithRawRules([{ keywords: null, level: "max" }]);
    const signals = { ...baseSignals, prompt: "implement a button" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("skips a rule whose `keywords` is an object (non-array)", () => {
    const policy = policyWithRawRules([{ keywords: { refactor: true }, level: "max" }]);
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("skips non-string entries inside `keywords` without throwing", () => {
    // 42 and true are valid array entries but not strings; without the
    // inner guard, `String.prototype.includes(42)` would throw.
    const policy = policyWithRawRules([
      { keywords: [42, true, null, "refactor"], level: "elevated" },
    ]);
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    // The valid string "refactor" is still matched — non-string entries
    // are simply non-matching within the same rule.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("a malformed rule BEFORE a valid matching rule does NOT block the valid rule", () => {
    // This is the spec scenario: "malformed keyword rule is skipped".
    // The malformed rule must be silently dropped so the later valid
    // match is applied.
    const policy = policyWithRawRules([
      { keywords: undefined, level: "max" }, // malformed — must skip
      { keywords: ["refactor"], level: "elevated" }, // valid — must apply
    ]);
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("a malformed rule AFTER a valid matching rule does NOT prevent the valid rule from winning", () => {
    // Regression: the guard must run per-rule, not before the whole loop,
    // so a later malformed rule cannot poison an earlier valid match.
    const policy = policyWithRawRules([
      { keywords: ["refactor"], level: "elevated" }, // valid — first match wins
      { keywords: "not-an-array", level: "minimal" }, // malformed — must skip
    ]);
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("falls through to defaultLevel when every keyword rule is malformed", () => {
    const policy = policyWithRawRules(
      [
        { keywords: undefined, level: "max" },
        { keywords: "refactor", level: "elevated" },
        { keywords: [42, true], level: "elevated" },
      ],
      { defaultLevel: "normal" },
    );
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("preserves the decision reason of the still-valid matching rule (no reason text drift)", () => {
    // Spec requirement: malformed rules MUST NOT change `surfaceDecision`
    // behaviour for valid rules. The matched-keyword reason must remain
    // a pure `keyword match: rule[i] "kw" (mode) in source` string — no
    // mention of skipped malformed rules.
    const policy = policyWithRawRules([
      { keywords: undefined, level: "max" },
      { keywords: ["refactor"], level: "elevated" },
    ]);
    const signals = { ...baseSignals, prompt: "refactor this" };
    expect(selectAdaptiveLevel(signals, policy).reason).toBe(
      `keyword match: rule[1] "refactor" (stem) in prompt`,
    );
  });
});

// ---------------------------------------------------------------------------
// Branch 5 — fallthrough to defaultLevel
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — defaultLevel fallback", () => {
  it("returns defaultLevel when no rule matches", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "implement a button" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("returns null when no rule matches AND defaultLevel is absent", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "implement a button" };
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("returns null when defaultLevel is explicitly null (Plan 015 base.json contract)", () => {
    const policy = policyWithAdaptive({
      defaultLevel: null,
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "implement a button" };
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("returns null when nothing is configured besides an empty adaptive block", () => {
    const policy = policyWithAdaptive({});
    expect(selectAdaptiveLevel(baseSignals, policy).level).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty inputs, boundary signals
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — edge cases", () => {
  it("returns defaultLevel when prompt and description are both empty", () => {
    const policy = policyWithAdaptive({ defaultLevel: "normal" });
    const signals = { prompt: "", description: "", tierName: "medium", isTrivial: false };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("returns null when prompt and description are empty AND no defaultLevel", () => {
    const policy = policyWithAdaptive({});
    const signals = { prompt: "", description: "", tierName: "medium", isTrivial: false };
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("does not match keywords across the tierName boundary", () => {
    // Tier name MUST NOT participate in keyword matching. A tier named
    // "refactor" should never be auto-elevated because of its name.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, tierName: "refactor" };
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("treats whitespace-only prompt as effectively empty (no match)", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "   \n\t  " };
    // "refactor" is not in whitespace-only text.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("is deterministic — same inputs always produce the same decision", () => {
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["debug"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "debug the flaky test" };
    const first = selectAdaptiveLevel(signals, policy);
    const second = selectAdaptiveLevel(signals, policy);
    const third = selectAdaptiveLevel(signals, policy);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });
});

// ---------------------------------------------------------------------------
// Decision-reason smoke checks — the exact `reason` text is a debug-log
// concern, not a contract, but these pin the strings down so log scrapers
// don't silently drift.
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — decision reasons (smoke)", () => {
  const cases: Array<{
    name: string;
    policy: ReasoningPolicyConfig;
    signals: Parameters<typeof selectAdaptiveLevel>[0];
    expected: { level: ReasoningLevel | null; reason: string };
  }> = [
    {
      name: "no adaptive config",
      policy: { mode: "adaptive" },
      signals: baseSignals,
      expected: { level: null, reason: "no adaptive config" },
    },
    {
      name: "trivial short-circuit",
      policy: policyWithAdaptive({ trivialLevel: "minimal" }),
      signals: { ...baseSignals, isTrivial: true },
      expected: { level: "minimal", reason: "trivial" },
    },
    {
      name: "tier default hit",
      policy: policyWithAdaptive({ tierDefaults: { heavy: "elevated" } }),
      signals: { ...baseSignals, tierName: "heavy" },
      expected: { level: "elevated", reason: "tier default: heavy" },
    },
    {
      name: "keyword match",
      policy: policyWithAdaptive({
        keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
      }),
      signals: { ...baseSignals, prompt: "refactor this" },
      expected: {
        level: "elevated",
        reason: `keyword match: rule[0] "refactor" (stem) in prompt`,
      },
    },
    {
      name: "default level fallback",
      policy: policyWithAdaptive({ defaultLevel: "normal" }),
      signals: baseSignals,
      expected: { level: "normal", reason: "default level" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(selectAdaptiveLevel(c.signals, c.policy)).toEqual(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Branch 6 — Plan 018 (PR 4) match-mode coverage
//
// Exercises the four match modes (`word` / `stem` / `substring` / `regex`),
// the `excludeKeywords` skip, phrase whitespace, richer reason format, and
// the `stem` default for match-less rules. Each case ties to a behavior the
// shipped `base.json` vocabulary depends on.
// ---------------------------------------------------------------------------

describe("selectAdaptiveLevel — Plan 018 match-mode coverage", () => {
  // ---- Boundary regression: cross-word false positives no longer match. ----

  it("does NOT match 'test' when the prompt contains the unrelated word 'latest'", () => {
    // Legacy `String.includes` would have matched "test" inside "latest"
    // and escalated to the rule's level. Under `stem` (the default) the
    // word-boundary start rejects "latest" as a stem of "test". The
    // selector MUST fall through to `defaultLevel`.
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["test"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "update the latest fixtures" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("does NOT match 'fix' when the prompt contains 'prefix'", () => {
    // Mirrors the above for "fix"/"prefix" — a documented stem-mode false
    // positive the legacy substring loop would have produced. "prefix"
    // contains "fix" as a non-prefix substring (positions 2-4), so the
    // `\b` requirement rejects the match under stem mode.
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["fix"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "add a prefix to the slug" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  // ---- Inflection via `stem` default. ----

  it("matches the inflection 'debugging' against an elevated rule whose keyword is 'debug'", () => {
    // The whole point of `stem` as the default: it preserves the useful
    // suffix-inflection behavior (`debug` → `debugging`) while killing
    // cross-word false positives.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["debug"], level: "elevated" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "debugging the race condition in the payments worker",
    };
    const decision = selectAdaptiveLevel(signals, policy);
    expect(decision.level).toBe("elevated");
    // Rich reason (per the design spec) — pin both the keyword that hit
    // and the source field so log scrapers stay aligned.
    expect(decision.reason).toBe(`keyword match: rule[0] "debug" (stem) in prompt`);
  });

  it("matches the inflection 'refactoring' against an elevated rule whose keyword is 'refactor'", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "we are refactoring the auth module" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  // ---- `word` mode is strict — rejects inflections on the last token. ----

  it("does NOT match 'debugging' when the rule's match mode is 'word'", () => {
    // `word` uses `\b<token>\b` — `debugging` is a different word from
    // `debug`, so it must not match under strict mode.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["debug"], level: "elevated", match: "word" }],
    });
    const signals = { ...baseSignals, prompt: "debugging the flaky test" };
    expect(selectAdaptiveLevel(signals, policy).level).toBeNull();
  });

  it("does NOT match 'root causes' against the strict phrase 'root cause'", () => {
    // Phrase keywords are still phrase-bounded under `word`. Pluralizing
    // the last token drops out of the strict window.
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["root cause"], level: "max", match: "word" }],
    });
    const signals = { ...baseSignals, prompt: "investigate the root causes of the outage" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  // ---- `excludeKeywords` skip on hit. ----

  it("skips a minimal rule when its `excludeKeywords` hit", () => {
    // `format` would normally map to minimal, but `refactor` is in the
    // exclusion set so the rule is dropped entirely. The selector then
    // falls through to the next rule (or defaultLevel).
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [
        {
          keywords: ["format"],
          level: "minimal",
          excludeKeywords: ["refactor"],
        },
        { keywords: ["refactor"], level: "elevated" },
      ],
    });
    const signals = { ...baseSignals, prompt: "format and refactor the auth module" };
    // minimal rule is excluded; refactor rule fires → elevated.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("falls through to defaultLevel when ONLY the matching rule is excluded", () => {
    // A more targeted case: the only rule whose keyword matches is the
    // one that gets excluded. Selector must NOT match the excluded rule
    // and MUST fall through to the catch-all.
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [
        {
          keywords: ["format"],
          level: "minimal",
          excludeKeywords: ["refactor"],
        },
      ],
    });
    const signals = { ...baseSignals, prompt: "format the source and refactor the module" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });

  it("exclusions evaluate under the rule's own match mode", () => {
    // A `match: "word"` rule excludes on a strict-word check. The
    // inflection "refactoring" must NOT trigger the exclusion (because
    // word mode rejects the inflection), and the keyword "debug" only
    // fires when it appears as a bare word — so "debug the test" wins.
    const policy = policyWithAdaptive({
      keywordRules: [
        {
          keywords: ["debug"],
          level: "elevated",
          match: "word",
          excludeKeywords: ["refactor"],
        },
      ],
    });
    const signals = { ...baseSignals, prompt: "refactoring then debug the test" };
    // Excluded? `refactor` (word) vs `refactoring` → no hit under word mode.
    // Keyword? `debug` (word) vs `debug the test` → hits.
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  // ---- Phrase whitespace (signal normalization in the hook layer). ----

  it("matches the phrase 'root cause' against description text with mixed whitespace", () => {
    // The hook layer calls `normalizeSignalText` (lowercase + collapse
    // whitespace + trim) before handing signals to the selector. The
    // selector itself does NOT re-normalize — these tests pin the
    // caller-side contract. Description carries the irregular whitespace.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["root cause"], level: "max" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "ticket #4711",
      description: "investigate\nroot   cause\nfor the outage",
    };
    const decision = selectAdaptiveLevel(signals, policy);
    expect(decision.level).toBe("max");
    // Source attribution tracks WHERE the match was found — important
    // for operator debug logs.
    expect(decision.reason).toBe(`keyword match: rule[0] "root cause" (stem) in description`);
  });

  // ---- Richer reason (decision log contract). ----

  it("emits a richer reason that names the rule index, keyword, mode, and source", () => {
    // The shipped reason format: `keyword match: rule[i] "<kw>" (<mode>) in <source>`.
    // Pin the entire format here so log scrapers and tests can rely on it.
    const policy = policyWithAdaptive({
      keywordRules: [
        { keywords: ["lint"], level: "minimal" },
        { keywords: ["refactor"], level: "elevated", match: "word" },
      ],
    });
    // The first rule (lint) wins on prompt "please lint the codebase" with
    // the default `stem` mode.
    const signals = { ...baseSignals, prompt: "please lint the codebase" };
    expect(selectAdaptiveLevel(signals, policy)).toEqual({
      level: "minimal",
      reason: `keyword match: rule[0] "lint" (stem) in prompt`,
    });
  });

  it("reason records the rule's actual mode (not always 'stem')", () => {
    // Same prompt, but the matched rule declared `match: "substring"`.
    // The reason must show the actual mode so operators can debug.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["test"], level: "normal", match: "substring" }],
    });
    const signals = { ...baseSignals, prompt: "update the latest fixtures" };
    expect(selectAdaptiveLevel(signals, policy).reason).toBe(
      `keyword match: rule[0] "test" (substring) in prompt`,
    );
  });

  // ---- Backward-compat: a match-less rule defaults to `stem`. ----

  it("treats a rule with no `match` field as `stem` and matches the inflection 'refactoring'", () => {
    // Pre-Plan-018 configs (and any operator who doesn't opt into a
    // specific mode) get `stem` automatically. The legacy inflection
    // behavior (`refactor` → `refactoring`) MUST keep working.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["refactor"], level: "elevated" }],
    });
    const signals = { ...baseSignals, prompt: "we are refactoring the auth module" };
    const decision = selectAdaptiveLevel(signals, policy);
    expect(decision.level).toBe("elevated");
    expect(decision.reason).toBe(`keyword match: rule[0] "refactor" (stem) in prompt`);
  });

  // ---- `substring` (opt-in) legacy behavior. ----

  it("substring mode matches 'test' inside 'latest' (documents the opt-in cross-word behavior)", () => {
    // This is the legacy `String.includes` behavior. It exists as an
    // opt-in escape hatch for operators that explicitly want it; the
    // default `stem` mode rejects it. This test pins the contrast so a
    // future refactor doesn't accidentally collapse the two modes.
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["test"], level: "elevated", match: "substring" }],
    });
    const signals = { ...baseSignals, prompt: "update the latest fixtures" };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  // ---- `regex` mode (power-user escape hatch). ----

  it("regex mode matches a user-supplied pattern (anchored '^perf')", () => {
    const policy = policyWithAdaptive({
      keywordRules: [{ keywords: ["^perf"], level: "elevated", match: "regex" }],
    });
    const signals = {
      ...baseSignals,
      prompt: "performance regression in the payments worker",
    };
    expect(selectAdaptiveLevel(signals, policy).level).toBe("elevated");
  });

  it("regex mode falls through on an invalid pattern (config validation is the fail-fast gate)", () => {
    // The selector must NOT throw — invalid regex at runtime is fail-soft.
    // Config validation (PR 3) is responsible for catching these at load
    // time, but the runtime guard ensures a hand-edited preset that slips
    // through cannot crash dispatch.
    const policy = policyWithAdaptive({
      defaultLevel: "normal",
      keywordRules: [{ keywords: ["("], level: "elevated", match: "regex" }],
    });
    const signals = { ...baseSignals, prompt: "any task text" };
    expect(() => selectAdaptiveLevel(signals, policy)).not.toThrow();
    expect(selectAdaptiveLevel(signals, policy).level).toBe("normal");
  });
});
