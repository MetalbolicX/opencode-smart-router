import { describe, expect, it } from "vitest";
import {
  advance,
  buildEscalatePolicy,
  buildLadderForcingMessage,
  bumpExhausted,
  canBumpReasoning,
  type EscalatePolicy,
  formatLadderScorecard,
  type LadderState,
  type LadderVerdict,
  newLadderState,
  nextAction,
  nextTierAfter,
  recordAttempt,
  resolveStartTier,
  tierRank,
} from "../../src/escalate/ladder";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mulberry32 = (seed: number) => {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const makePolicy = (overrides: Partial<EscalatePolicy> = {}): EscalatePolicy => {
  return {
    ladder: ["fast", "medium", "heavy"],
    floorTier: null,
    maxAttemptsPerTier: 1,
    maxTotalAttempts: 4,
    costMultiple: null,
    ...overrides,
  };
};

const exhaustionMatrix = Array.from({ length: 5 }, (_, lengthOffset) => {
  const levelsLength = lengthOffset + 1;
  return Array.from({ length: levelsLength }, (_, maxBumps) =>
    Array.from({ length: maxBumps + 1 }, (_, bumpsThisTier) =>
      Array.from({ length: levelsLength }, (_, levelIndex) =>
        (["verification_fail", "retryable_error"] as const).map((cause) => ({
          levelsLength,
          maxBumps,
          bumpsThisTier,
          levelIndex,
          cause,
        })),
      ),
    ),
  );
}).flat(4);

describe("D-3 exhaustive bump exhaustion matrix", () => {
  it.each(exhaustionMatrix)(
    "levels=$levelsLength maxBumps=$maxBumps bumps=$bumpsThisTier index=$levelIndex cause=$cause",
    ({ levelsLength, maxBumps, bumpsThisTier, levelIndex, cause }) => {
      const state = makeState({
        reasoningLadderLen: levelsLength,
        tierMaxBumps: maxBumps,
        bumpsThisTier,
        levelIndex,
      });
      const verdict: LadderVerdict = { pass: false, cause };
      const action = nextAction(state, verdict, makePolicy());

      if (cause === "retryable_error") {
        expect(action.action).toBe("retry");
        expect(bumpExhausted(state, verdict)).toBe(false);
        return;
      }

      const hasRoom = maxBumps > 0 && bumpsThisTier < maxBumps && levelIndex < levelsLength - 1;
      expect(action.action).toBe(hasRoom ? "bump" : maxBumps > 0 ? "escalate" : "retry");
      expect(bumpExhausted(state, verdict)).toBe(maxBumps > 0 && !hasRoom);
    },
  );

  it.each([1, 2, 3, 4, 5])("uses effective bump room for %s levels", (levelsLength) => {
    for (let maxBumps = 0; maxBumps < levelsLength; maxBumps++) {
      for (let startIndex = 0; startIndex < levelsLength; startIndex++) {
        let room = 0;
        let index = startIndex;
        let bumps = 0;
        while (bumps < maxBumps && index < levelsLength - 1) {
          room++;
          bumps++;
          index++;
        }
        expect(room).toBe(Math.min(maxBumps, levelsLength - 1 - startIndex));
      }
    }
  });
});

const makeState = (overrides: Partial<LadderState> = {}): LadderState => {
  const base: LadderState = {
    currentTier: "fast",
    attemptsThisTier: 0,
    totalAttempts: 0,
    escalations: 0,
    firstAttemptCost: null,
    cumulativeCost: 0,
    levelIndex: 0,
    bumpsThisTier: 0,
    reasoningLadderLen: 0,
    tierMaxBumps: 0,
  };
  return { ...base, ...overrides };
};

// ---------------------------------------------------------------------------
// tierRank
// ---------------------------------------------------------------------------

describe("tierRank", () => {
  const ladder = ["fast", "medium", "heavy"];

  it("returns correct index for known tier", () => {
    expect(tierRank("fast", ladder)).toBe(0);
    expect(tierRank("medium", ladder)).toBe(1);
    expect(tierRank("heavy", ladder)).toBe(2);
  });

  it("returns -1 for unknown tier", () => {
    expect(tierRank("ultra", ladder)).toBe(-1);
    expect(tierRank("", ladder)).toBe(-1);
  });

  it("returns -1 for empty ladder", () => {
    expect(tierRank("fast", [])).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// resolveStartTier
// ---------------------------------------------------------------------------

describe("resolveStartTier", () => {
  it("producer in ladder, no floor => returns producerTier", () => {
    const p = makePolicy({ ladder: ["fast", "medium", "heavy"] });
    expect(resolveStartTier("fast", p)).toBe("fast");
    expect(resolveStartTier("medium", p)).toBe("medium");
    expect(resolveStartTier("heavy", p)).toBe("heavy");
  });

  it("producer below floorTier => returns floorTier", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "medium",
    });
    expect(resolveStartTier("fast", p)).toBe("medium");
  });

  it("producer at floorTier => returns producerTier (same)", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "medium",
    });
    expect(resolveStartTier("medium", p)).toBe("medium");
  });

  it("producer above floorTier => returns producerTier", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "fast",
    });
    expect(resolveStartTier("heavy", p)).toBe("heavy");
  });

  it("floorTier:heavy with producerTier:fast => starts at heavy", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "heavy",
    });
    expect(resolveStartTier("fast", p)).toBe("heavy");
  });

  it("unknown producerTier not in ladder => uses ladder[0] unless floor raises it", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: null,
    });
    expect(resolveStartTier("unknown", p)).toBe("fast");
  });

  it("unknown producerTier + floor medium => starts at medium", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "medium",
    });
    expect(resolveStartTier("unknown", p)).toBe("medium");
  });

  it("empty ladder, no floor => returns producerTier as fallback", () => {
    const p = makePolicy({ ladder: [], floorTier: null });
    expect(resolveStartTier("medium", p)).toBe("medium");
  });

  it("floorTier not in ladder (unknown) => acts as -1, no-op for floor", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "nonexistent",
    });
    // fi=-1, pi=0 => startIdx=max(0,0)=0 => "fast"
    expect(resolveStartTier("fast", p)).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// newLadderState
// ---------------------------------------------------------------------------

describe("newLadderState", () => {
  it("initialises all counters to zero/null", () => {
    const p = makePolicy();
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("fast");
    expect(s.attemptsThisTier).toBe(0);
    expect(s.totalAttempts).toBe(0);
    expect(s.escalations).toBe(0);
    expect(s.firstAttemptCost).toBeNull();
    expect(s.cumulativeCost).toBe(0);
  });

  it("applies floorTier to currentTier", () => {
    const p = makePolicy({ floorTier: "medium" });
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("medium");
  });

  it("does not mutate input policy", () => {
    const p = makePolicy();
    const pCopy = JSON.parse(JSON.stringify(p)) as EscalatePolicy;
    newLadderState("fast", p);
    expect(p).toEqual(pCopy);
  });
});

// ---------------------------------------------------------------------------
// recordAttempt
// ---------------------------------------------------------------------------

describe("recordAttempt", () => {
  it("increments totalAttempts and cumulativeCost", () => {
    const s = makeState();
    const s2 = recordAttempt(s, 5);
    expect(s2.totalAttempts).toBe(1);
    expect(s2.cumulativeCost).toBe(5);
    expect(s2.firstAttemptCost).toBe(5);
  });

  it("firstAttemptCost is set only once (second call does not overwrite)", () => {
    const s = makeState();
    const s1 = recordAttempt(s, 3);
    const s2 = recordAttempt(s1, 10);
    expect(s2.firstAttemptCost).toBe(3);
    expect(s2.cumulativeCost).toBe(13);
    expect(s2.totalAttempts).toBe(2);
  });

  it("default cost is 0", () => {
    const s = makeState();
    const s2 = recordAttempt(s);
    expect(s2.cumulativeCost).toBe(0);
    expect(s2.firstAttemptCost).toBe(0);
  });

  it("does NOT mutate the input state", () => {
    const s = makeState({ totalAttempts: 0, cumulativeCost: 0 });
    recordAttempt(s, 7);
    expect(s.totalAttempts).toBe(0);
    expect(s.cumulativeCost).toBe(0);
  });

  it("accumulates cost across many calls", () => {
    let s = makeState();
    for (let i = 1; i <= 4; i++) {
      s = recordAttempt(s, i);
    }
    expect(s.cumulativeCost).toBe(10); // 1+2+3+4
    expect(s.firstAttemptCost).toBe(1);
    expect(s.totalAttempts).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// nextTierAfter
// ---------------------------------------------------------------------------

describe("nextTierAfter", () => {
  const p = makePolicy({ ladder: ["fast", "medium", "heavy"] });

  it("fast => medium", () => {
    expect(nextTierAfter("fast", p)).toBe("medium");
  });

  it("medium => heavy", () => {
    expect(nextTierAfter("medium", p)).toBe("heavy");
  });

  it("heavy (top) => null", () => {
    expect(nextTierAfter("heavy", p)).toBeNull();
  });

  it("unknown tier => null", () => {
    expect(nextTierAfter("unknown", p)).toBeNull();
  });

  it("single-tier ladder => null", () => {
    const single = makePolicy({ ladder: ["medium"] });
    expect(nextTierAfter("medium", single)).toBeNull();
  });

  it("returns null when next index exists but value is undefined (sparse ladder)", () => {
    // Sparse array with a hole at index 1: ["fast", undefined, "heavy"]
    // This exercises the ?? null branch when ladder[ci+1] is undefined.
    const sparseLadder: (string | undefined)[] = ["fast", undefined, "heavy"];
    const p = makePolicy({ ladder: sparseLadder as unknown as string[] });
    expect(nextTierAfter("fast", p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildLadderForcingMessage
// ---------------------------------------------------------------------------

describe("buildLadderForcingMessage", () => {
  it("includes header line", () => {
    const msg = buildLadderForcingMessage(["reason A"]);
    expect(msg).toContain("[router escalation] previous attempt did not pass verification:");
  });

  it("includes NEXT line", () => {
    const msg = buildLadderForcingMessage(["x"]);
    expect(msg).toContain("NEXT: retry with these failures addressed.");
  });

  it("formats each reason as a bullet", () => {
    const msg = buildLadderForcingMessage(["foo", "bar"]);
    expect(msg).toContain("- foo");
    expect(msg).toContain("- bar");
  });

  it("empty reasons => uses fallback bullet", () => {
    const msg = buildLadderForcingMessage([]);
    expect(msg).toContain("- (no reasons provided)");
    expect(msg).not.toContain("- foo");
  });

  it("multiple reasons all present in output", () => {
    const reasons = ["err1", "err2", "err3"];
    const msg = buildLadderForcingMessage(reasons);
    for (const r of reasons) {
      expect(msg).toContain(`- ${r}`);
    }
  });

  it("pure — does not include scrubbing (caller responsibility)", () => {
    const msg = buildLadderForcingMessage(["secret=abc123"]);
    // The raw text should pass through as-is
    expect(msg).toContain("secret=abc123");
  });
});

// ---------------------------------------------------------------------------
// nextAction — core decision logic
// ---------------------------------------------------------------------------

describe("nextAction", () => {
  it("verdict.pass=true => accept (immediate)", () => {
    const p = makePolicy();
    const s = makeState({ totalAttempts: 1 });
    const a = nextAction(s, { pass: true }, p);
    expect(a.action).toBe("accept");
  });

  it("verdict null => treated as FAIL (not accept)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 4 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, null, p);
    expect(a.action).not.toBe("accept");
  });

  it("verdict undefined => treated as FAIL (not accept)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 4 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, undefined, p);
    expect(a.action).not.toBe("accept");
  });

  it("maxTotalAttempts reached => give_up with message", () => {
    const p = makePolicy({ maxTotalAttempts: 3 });
    const s = makeState({ totalAttempts: 3, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toContain("max total attempts (3)");
  });

  it("maxTotalAttempts check precedes retry", () => {
    const p = makePolicy({ maxTotalAttempts: 2, maxAttemptsPerTier: 5 });
    // attemptsThisTier < maxAttemptsPerTier, but totalAttempts >= max
    const s = makeState({ totalAttempts: 2, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
  });

  it("cost ceiling exceeded => give_up", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10 });
    // first cost 5, cumulative 11 => 11 > 5*2=10
    const s = makeState({
      totalAttempts: 2,
      firstAttemptCost: 5,
      cumulativeCost: 11,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("cost ceiling exceeded");
  });

  it("cost ceiling: cumulativeCost exactly at threshold (=) is NOT exceeded", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10 });
    // 5 * 2 = 10; cumulative = 10 => NOT exceeded (> not >=)
    const s = makeState({
      totalAttempts: 2,
      firstAttemptCost: 5,
      cumulativeCost: 10,
      attemptsThisTier: 0,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("retry");
  });

  it("cost check precedes retry/escalate", () => {
    const p = makePolicy({
      costMultiple: 2,
      maxTotalAttempts: 10,
      maxAttemptsPerTier: 5,
    });
    const s = makeState({
      totalAttempts: 2,
      attemptsThisTier: 0,
      firstAttemptCost: 5,
      cumulativeCost: 11,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
  });

  it("retry when attemptsThisTier < maxAttemptsPerTier", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("retry");
    expect(a.tier).toBe("fast");
    expect(a.forcingMessage).toBeDefined();
  });

  it("retry includes forcingMessage from verdict reasons", () => {
    const p = makePolicy({ maxAttemptsPerTier: 3, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const verdict: LadderVerdict = { pass: false, reasons: ["bad output"] };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("retry");
    expect(a.forcingMessage).toContain("bad output");
  });

  it("escalate when attemptsThisTier >= maxAttemptsPerTier and next tier exists", () => {
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "fast",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
    expect(a.forcingMessage).toBeDefined();
  });

  it("give_up: no higher tier (already at top)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "heavy",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("maxAttemptsPerTier:0 => escalate immediately (no retry)", () => {
    const p = makePolicy({
      maxAttemptsPerTier: 0,
      maxTotalAttempts: 10,
      ladder: ["fast", "medium", "heavy"],
    });
    const s = makeState({
      currentTier: "fast",
      totalAttempts: 1,
      attemptsThisTier: 0,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });

  it("single-tier ladder: retries up to cap then give_up (no escalate)", () => {
    const p = makePolicy({
      ladder: ["medium"],
      maxAttemptsPerTier: 2,
      maxTotalAttempts: 10,
    });
    const s = makeState({
      currentTier: "medium",
      totalAttempts: 3,
      attemptsThisTier: 2,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("no forcingMessage on give_up", () => {
    const p = makePolicy({ maxTotalAttempts: 1 });
    const s = makeState({ totalAttempts: 1 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.forcingMessage).toBeUndefined();
  });

  it("costMultiple null => cost check never triggers", () => {
    const p = makePolicy({ costMultiple: null, maxTotalAttempts: 10, maxAttemptsPerTier: 1 });
    const s = makeState({
      totalAttempts: 2,
      attemptsThisTier: 0,
      firstAttemptCost: 1,
      cumulativeCost: 99999,
    });
    const a = nextAction(s, { pass: false }, p);
    // Should NOT give_up due to cost (costMultiple is null)
    expect(a.action).not.toBe("give_up");
  });

  it("firstAttemptCost null => cost check never triggers even with costMultiple set", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10, maxAttemptsPerTier: 3 });
    const s = makeState({
      totalAttempts: 1,
      attemptsThisTier: 0,
      firstAttemptCost: null,
      cumulativeCost: 100,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).not.toBe("give_up");
  });

  it("accept takes priority over cost/attempt checks", () => {
    const p = makePolicy({ costMultiple: 1, maxTotalAttempts: 1 });
    const s = makeState({
      totalAttempts: 5,
      firstAttemptCost: 1,
      cumulativeCost: 100,
    });
    const a = nextAction(s, { pass: true }, p);
    expect(a.action).toBe("accept");
  });
});

// ---------------------------------------------------------------------------
// advance — state transitions
// ---------------------------------------------------------------------------

describe("advance", () => {
  it("retry => increments attemptsThisTier only", () => {
    const s = makeState({ attemptsThisTier: 0, currentTier: "fast" });
    const s2 = advance(s, { action: "retry", tier: "fast" });
    expect(s2.attemptsThisTier).toBe(1);
    expect(s2.currentTier).toBe("fast");
    expect(s2.escalations).toBe(0);
    expect(s2.totalAttempts).toBe(0); // unchanged
  });

  it("escalate => updates currentTier, resets attemptsThisTier, increments escalations", () => {
    const s = makeState({
      currentTier: "fast",
      attemptsThisTier: 1,
      escalations: 0,
    });
    const s2 = advance(s, { action: "escalate", tier: "medium" });
    expect(s2.currentTier).toBe("medium");
    expect(s2.attemptsThisTier).toBe(0);
    expect(s2.escalations).toBe(1);
  });

  it("accept => state unchanged (terminal)", () => {
    const s = makeState({ currentTier: "medium", totalAttempts: 3 });
    const s2 = advance(s, { action: "accept" });
    expect(s2).toEqual(s);
  });

  it("give_up => state unchanged (terminal)", () => {
    const s = makeState({ totalAttempts: 4, currentTier: "heavy" });
    const s2 = advance(s, { action: "give_up", reason: "done" });
    expect(s2).toEqual(s);
  });

  it("escalate without tier => returns state unchanged (defensive no-op)", () => {
    const s = makeState({
      currentTier: "fast",
      attemptsThisTier: 1,
      escalations: 0,
      levelIndex: 2,
      bumpsThisTier: 1,
      reasoningLadderLen: 3,
    });
    const s2 = advance(s, { action: "escalate" } as any);
    expect(s2).toEqual(s);
  });

  it("does NOT mutate input state on retry", () => {
    const s = makeState({ attemptsThisTier: 2 });
    const orig = { ...s };
    advance(s, { action: "retry", tier: "fast" });
    expect(s.attemptsThisTier).toBe(orig.attemptsThisTier);
  });

  it("does NOT mutate input state on escalate", () => {
    const s = makeState({ currentTier: "fast", escalations: 0 });
    const orig = { ...s };
    advance(s, { action: "escalate", tier: "medium" });
    expect(s.currentTier).toBe(orig.currentTier);
    expect(s.escalations).toBe(orig.escalations);
  });

  // WU-4: bump — increments levelIndex and bumpsThisTier, NOT attemptsThisTier
  it("bump => increments levelIndex and bumpsThisTier (NOT attemptsThisTier)", () => {
    const s = makeState({
      currentTier: "medium",
      levelIndex: 1,
      bumpsThisTier: 0,
      attemptsThisTier: 0,
      reasoningLadderLen: 5,
    });
    const s2 = advance(s, { action: "bump", tier: "medium" });
    expect(s2.levelIndex).toBe(2);
    expect(s2.bumpsThisTier).toBe(1);
    expect(s2.attemptsThisTier).toBe(0); // unchanged
    expect(s2.currentTier).toBe("medium"); // unchanged
  });

  it("bump does NOT mutate input state", () => {
    const s = makeState({ levelIndex: 1, bumpsThisTier: 0 });
    const orig = { ...s };
    advance(s, { action: "bump", tier: "medium" });
    expect(s.levelIndex).toBe(orig.levelIndex);
    expect(s.bumpsThisTier).toBe(orig.bumpsThisTier);
  });

  // WU-4: escalate — also resets ladder state fields
  it("escalate => resets levelIndex, bumpsThisTier, reasoningLadderLen", () => {
    const s = makeState({
      currentTier: "fast",
      levelIndex: 2,
      bumpsThisTier: 1,
      reasoningLadderLen: 5,
      attemptsThisTier: 1,
      escalations: 0,
    });
    const s2 = advance(s, { action: "escalate", tier: "medium" });
    expect(s2.currentTier).toBe("medium");
    expect(s2.attemptsThisTier).toBe(0);
    expect(s2.escalations).toBe(1);
    expect(s2.levelIndex).toBe(0); // reset
    expect(s2.bumpsThisTier).toBe(0); // reset
    expect(s2.reasoningLadderLen).toBe(0); // reset
  });
});

// ---------------------------------------------------------------------------
// buildEscalatePolicy
// ---------------------------------------------------------------------------

describe("buildEscalatePolicy", () => {
  function makeCfg(partial: Partial<RouterConfig> = {}): RouterConfig {
    return {
      activePreset: "default",
      presets: {},
      rules: [],
      defaultTier: "fast",
      ...partial,
    } as RouterConfig;
  }

  it("all defaults when enforcement is absent", () => {
    const p = buildEscalatePolicy(makeCfg());
    // No usable active preset means resolveLadder applies the documented canonical five-tier default.
    expect(p.ladder).toEqual(["fast", "light", "medium", "focused", "heavy"]);
    expect(p.floorTier).toBeNull();
    expect(p.maxAttemptsPerTier).toBe(1);
    expect(p.maxTotalAttempts).toBe(4);
    expect(p.costMultiple).toBe(4);
  });

  it("honours cfg.enforcement.escalate overrides", () => {
    const cfg = makeCfg({
      enforcement: {
        escalate: {
          ladder: ["a", "b"],
          floorTier: "b",
          maxAttemptsPerTier: 3,
          maxTotalAttempts: 8,
          costCeiling: { multiple: 5 },
        },
      },
    });
    const p = buildEscalatePolicy(cfg);
    expect(p.ladder).toEqual(["a", "b"]);
    expect(p.floorTier).toBe("b");
    expect(p.maxAttemptsPerTier).toBe(3);
    expect(p.maxTotalAttempts).toBe(8);
    expect(p.costMultiple).toBe(5);
  });

  it("enforcement present but escalate absent => defaults", () => {
    const cfg = makeCfg({ enforcement: { mode: "enforced" } });
    const p = buildEscalatePolicy(cfg);
    // Missing escalate config still delegates to resolveLadder's canonical five-tier default.
    expect(p.ladder).toEqual(["fast", "light", "medium", "focused", "heavy"]);
    expect(p.maxTotalAttempts).toBe(4);
  });

  it("partial escalate config => merges defaults for missing fields", () => {
    const cfg = makeCfg({
      enforcement: { escalate: { maxTotalAttempts: 6 } },
    });
    const p = buildEscalatePolicy(cfg);
    expect(p.maxTotalAttempts).toBe(6);
    // Partial escalate config leaves the ladder unset, so the documented five-tier default applies.
    expect(p.ladder).toEqual(["fast", "light", "medium", "focused", "heavy"]);
    expect(p.maxAttemptsPerTier).toBe(1);
    expect(p.costMultiple).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Edge-case integration scenarios
// ---------------------------------------------------------------------------

describe("edge cases: explicit scenario coverage", () => {
  it("FAIL at heavy with no retries left => give_up 'no higher tier'", () => {
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "heavy",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("maxTotalAttempts reached mid-ladder => give_up 'max total attempts'", () => {
    const p = makePolicy({ maxTotalAttempts: 2, maxAttemptsPerTier: 5 });
    const s = makeState({ currentTier: "medium", totalAttempts: 2, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toContain("max total attempts (2)");
  });

  it("cost ceiling exceeded mid-ladder => give_up 'cost ceiling exceeded'", () => {
    const p = makePolicy({ costMultiple: 3, maxTotalAttempts: 10 });
    const s = makeState({
      totalAttempts: 2,
      firstAttemptCost: 4,
      cumulativeCost: 13, // 13 > 4*3=12
      attemptsThisTier: 0,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("cost ceiling exceeded");
  });

  it("retry then PASS => accept on second call", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    let s = newLadderState("fast", p);
    s = recordAttempt(s, 1);
    const a1 = nextAction(s, { pass: false }, p);
    expect(a1.action).toBe("retry");
    s = advance(s, a1);
    s = recordAttempt(s, 1);
    const a2 = nextAction(s, { pass: true }, p);
    expect(a2.action).toBe("accept");
  });

  it("maxAttemptsPerTier:0 => escalate immediately on first FAIL", () => {
    const p = makePolicy({ maxAttemptsPerTier: 0, maxTotalAttempts: 10 });
    let s = newLadderState("fast", p);
    s = recordAttempt(s, 0);
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });

  it("single-tier ladder ['medium'] => retries up to cap then give_up (no escalate target)", () => {
    const p = makePolicy({
      ladder: ["medium"],
      maxAttemptsPerTier: 2,
      maxTotalAttempts: 10,
    });
    let s = newLadderState("medium", p);
    // First attempt
    s = recordAttempt(s, 1);
    const a1 = nextAction(s, { pass: false }, p);
    expect(a1.action).toBe("retry"); // attemptsThisTier(0) < 2
    s = advance(s, a1);
    // Second attempt
    s = recordAttempt(s, 1);
    const a2 = nextAction(s, { pass: false }, p);
    expect(a2.action).toBe("retry"); // attemptsThisTier(1) < 2
    s = advance(s, a2);
    // Third attempt — exhausted tier
    s = recordAttempt(s, 1);
    const a3 = nextAction(s, { pass: false }, p);
    expect(a3.action).toBe("give_up");
    expect(a3.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("floorTier:'heavy' with producerTier 'fast' => starts at heavy (no cheap rungs)", () => {
    const p = makePolicy({ floorTier: "heavy" });
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("heavy");
  });

  it("producerTier below floorTier => starts at floorTier", () => {
    const p = makePolicy({ floorTier: "medium" });
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("medium");
  });

  it("unknown producerTier not in ladder => starts at ladder[0]", () => {
    const p = makePolicy({ floorTier: null });
    const s = newLadderState("turbo", p);
    expect(s.currentTier).toBe("fast");
  });

  it("verdict null/undefined => treated as FAIL (not accept)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    expect(nextAction(s, null, p).action).not.toBe("accept");
    expect(nextAction(s, undefined, p).action).not.toBe("accept");
  });

  it("recordAttempt: sets firstAttemptCost once and accumulates cumulativeCost", () => {
    let s = makeState();
    s = recordAttempt(s, 7);
    expect(s.firstAttemptCost).toBe(7);
    s = recordAttempt(s, 3);
    expect(s.firstAttemptCost).toBe(7); // unchanged
    expect(s.cumulativeCost).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// formatLadderScorecard
// ---------------------------------------------------------------------------

describe("formatLadderScorecard", () => {
  it("accepted=true => verdict=PASS with all fields present", () => {
    const p = makePolicy({ ladder: ["fast", "medium", "heavy"] });
    let s = newLadderState("fast", p);
    s = recordAttempt(s, 3);
    s = advance(s, { action: "escalate", tier: "medium" });
    s = recordAttempt(s, 5);
    const result = formatLadderScorecard(s, true, "grader");
    expect(result).toContain("verdict=PASS");
    expect(result).toContain(`final_tier=${s.currentTier}`);
    expect(result).toContain(`attempts=${s.totalAttempts}`);
    expect(result).toContain(`escalations=${s.escalations}`);
    expect(result).toContain(`cost=${s.cumulativeCost}`);
    expect(result).toContain("method=grader");
  });

  it("accepted=false => verdict=UNMET", () => {
    const p = makePolicy();
    const s = newLadderState("fast", p);
    const result = formatLadderScorecard(s, false, "heuristic");
    expect(result).toContain("verdict=UNMET");
    expect(result).not.toContain("verdict=PASS");
  });
});

// ---------------------------------------------------------------------------
// Property-based: termination guarantee
// ---------------------------------------------------------------------------

describe("property-based: termination", () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed=${seed}: loop always terminates and invariants hold`, () => {
      const rng = mulberry32(seed);

      // Random but valid policy
      const ladderLen = 1 + Math.floor(rng() * 3); // 1..3
      const allTiers = ["fast", "medium", "heavy", "ultra"];
      const ladder = allTiers.slice(0, ladderLen);
      const maxAttemptsPerTier = Math.floor(rng() * 4); // 0..3
      const maxTotalAttempts = 1 + Math.floor(rng() * 6); // 1..6
      const useCostMultiple = rng() < 0.5;
      const costMultiple: number | null = useCostMultiple
        ? 1 + Math.floor(rng() * 5) // 1..5
        : null;

      const p: EscalatePolicy = {
        ladder,
        floorTier: null,
        maxAttemptsPerTier,
        maxTotalAttempts,
        costMultiple,
      };

      const producerTier = ladder[0]!;
      let state = newLadderState(producerTier, p);
      let cycles = 0;
      let done = false;
      let prevTotalAttempts = 0;
      let prevEscalations = 0;

      while (!done) {
        // Simulate random per-attempt cost 0..10
        const cost = Math.floor(rng() * 11);
        state = recordAttempt(state, cost);
        cycles++;

        // Monotonic: totalAttempts strictly increases each cycle
        expect(state.totalAttempts).toBeGreaterThan(prevTotalAttempts);
        prevTotalAttempts = state.totalAttempts;

        // Random verdict (including all-FAIL case)
        const pass = rng() < 0.3; // 30% chance pass
        const verdict: LadderVerdict = {
          pass,
          reasons: pass ? [] : ["failure reason"],
        };

        const action = nextAction(state, verdict, p);

        // nextAction NEVER returns retry/escalate when totalAttempts >= maxTotalAttempts
        if (state.totalAttempts >= maxTotalAttempts) {
          expect(action.action).not.toBe("retry");
          expect(action.action).not.toBe("escalate");
        }

        // accept IFF pass===true
        if (action.action === "accept") {
          expect(verdict.pass).toBe(true);
        }
        if (verdict.pass === true) {
          expect(action.action).toBe("accept");
        }

        if (action.action === "accept" || action.action === "give_up") {
          done = true;
        } else {
          state = advance(state, action);

          // escalations counter only increases on escalate action
          if (action.action === "escalate") {
            expect(state.escalations).toBeGreaterThan(prevEscalations);
          } else {
            expect(state.escalations).toBe(prevEscalations);
          }
          prevEscalations = state.escalations;
        }
      }

      // Loop terminates within maxTotalAttempts produce cycles
      expect(cycles).toBeLessThanOrEqual(maxTotalAttempts);
    });
  }
});

// ---------------------------------------------------------------------------
// Property-based: bump invariants with feature ON + ladder tiers (WU-4)
//
// Distinct seed range (1001-1060) — separate from the 60-seed feature-off loop.
// Invariants verified per seed:
//   - levelIndex is monotonic non-decreasing within a tier (resets on tier change)
//   - bumpsThisTier <= maxLevelBumpsPerTier
//   - never returns "retry" when bumps ARE available on verification_fail ladder tier
//   - loop terminates within safetyMax cycles
// ---------------------------------------------------------------------------

describe("property-based: bump invariants with feature ON (WU-4)", () => {
  for (let seed = 1001; seed <= 1060; seed++) {
    it(`seed=${seed}: levelIndex monotonic, bumpsThisTier <= cap, no retry when bumps available`, () => {
      const rng = mulberry32(seed);

      // Random but valid policy with feature ON
      const tierCount = 1 + Math.floor(rng() * 3); // 1..3 tiers
      const allTiers = ["fast", "medium", "heavy", "ultra"];
      const ladder = allTiers.slice(0, tierCount);
      const maxAttemptsPerTier = Math.floor(rng() * 4); // 0..3
      const maxTotalAttempts = 1 + Math.floor(rng() * 6); // 1..6
      const maxLevelBumpsPerTier = 1 + Math.floor(rng() * 4); // 1..4 bumps per tier
      const reasoningLadderLen = 2 + Math.floor(rng() * 4); // 2..5 rungs

      const p: EscalatePolicy = {
        ladder,
        floorTier: null,
        maxAttemptsPerTier,
        maxTotalAttempts,
        costMultiple: null,
      };

      const producerTier = ladder[0]!;
      let state = newLadderState(producerTier, p);
      // Simulate enterTier: set reasoningLadderLen and tierMaxBumps for the starting tier
      state = { ...state, reasoningLadderLen, tierMaxBumps: maxLevelBumpsPerTier };

      let cycles = 0;
      let done = false;
      let prevTier = state.currentTier;
      let prevLevelIndex = state.levelIndex; // reset on tier change
      let prevBumpsThisTier = state.bumpsThisTier;
      const safetyMax = maxTotalAttempts * 3; // generous bound for bump cycles

      while (!done && cycles < safetyMax) {
        cycles++;

        // Tier change resets monotonic counters
        if (state.currentTier !== prevTier) {
          prevTier = state.currentTier;
          prevLevelIndex = 0; // reset on new tier
        }

        // Monotonic: levelIndex within a tier never decreases
        expect(state.levelIndex).toBeGreaterThanOrEqual(prevLevelIndex);
        prevLevelIndex = state.levelIndex;

        // Bumps never exceed cap
        expect(state.bumpsThisTier).toBeLessThanOrEqual(maxLevelBumpsPerTier);
        prevBumpsThisTier = state.bumpsThisTier;

        // Random cost (not relevant for bump logic but part of the loop)
        const cost = Math.floor(rng() * 11);
        state = recordAttempt(state, cost);

        // Random verdict: 30% pass, 40% verification_fail, 30% retryable_error
        const roll = rng();
        const pass = roll < 0.3;
        const cause: LadderVerdict["cause"] =
          roll < 0.3 ? undefined : roll < 0.7 ? "verification_fail" : "retryable_error";
        const verdict: LadderVerdict = {
          pass,
          cause: cause ?? undefined,
          reasons: pass ? [] : ["failure reason"],
        };

        const action = nextAction(state, verdict, p);

        // Critical invariant: when bumps ARE available on verification_fail ladder tier
        // (canBumpReasoning returns true), nextAction must bump OR escalate, NEVER retry.
        // When bumps are exhausted, escalate is correct — retry would be wrong.
        const bumpsLeft = maxLevelBumpsPerTier - state.bumpsThisTier;
        const rungsRemain = state.levelIndex + 1 < state.reasoningLadderLen;
        const bumpsAvailable =
          bumpsLeft > 0 && rungsRemain && verdict.cause === "verification_fail";
        if (bumpsAvailable && state.tierMaxBumps > 0) {
          expect(action.action).not.toBe("retry");
        }

        if (action.action === "accept" || action.action === "give_up") {
          done = true;
        } else {
          state = advance(state, action);
        }
      }

      expect(cycles).toBeLessThan(safetyMax); // loop must terminate
    });
  }
});

// ---------------------------------------------------------------------------
// AbortSignal — post-abort the ladder must give_up, NEVER retry/escalate.
//
// Contract (PR 1 of fix-delegate-cancellation): once the caller's
// AbortSignal is fired, every subsequent nextAction() call must short-
// circuit to {action:"give_up", reason:"aborted"} regardless of:
//   - the verdict (FAIL, null, undefined, even pass via special path
//     is a no-op because accept returns first; we test FAIL + null only)
//   - the policy (escalate-target exists or not, retries left or not)
//   - the cost ceiling (would normally give_up but for a different reason)
//
// The signal must NOT regress any existing nextAction() behaviour when
// it is absent or not yet aborted (covered by every test above).
// ---------------------------------------------------------------------------

describe("nextAction — AbortSignal guard", () => {
  it("aborted signal + FAIL verdict => give_up with reason 'aborted'", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: false, reasons: ["boom"] }, p, ac.signal);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("aborted");
  });

  it("aborted signal + FAIL verdict => never retry", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: false }, p, ac.signal);
    expect(a.action).not.toBe("retry");
  });

  it("aborted signal + FAIL verdict + tier-exhausted => never escalate", () => {
    // Without abort, this would return escalate (medium).
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "fast",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: false }, p, ac.signal);
    expect(a.action).toBe("give_up");
    expect(a.action).not.toBe("escalate");
  });

  it("aborted signal + null verdict => give_up (treated as FAIL + aborted)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, null, p, ac.signal);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("aborted");
  });

  it("aborted signal + undefined verdict => give_up", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, undefined, p, ac.signal);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("aborted");
  });

  it("aborted signal + cost ceiling already exceeded => reason is 'aborted' (not 'cost ceiling exceeded')", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10 });
    const s = makeState({
      totalAttempts: 2,
      attemptsThisTier: 0,
      firstAttemptCost: 5,
      cumulativeCost: 100, // way over 10
    });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: false }, p, ac.signal);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("aborted");
  });

  it("aborted signal + max total attempts reached => reason is 'aborted' (not 'max total attempts')", () => {
    const p = makePolicy({ maxTotalAttempts: 1, maxAttemptsPerTier: 1 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 1 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: false }, p, ac.signal);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("aborted");
  });

  it("aborted signal + no forcingMessage (terminal action)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: false }, p, ac.signal);
    expect(a.forcingMessage).toBeUndefined();
  });

  it("un-aborted signal => behaves exactly like no signal (no regression)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();
    // Do NOT call ac.abort().
    const a = nextAction(s, { pass: false }, p, ac.signal);
    expect(a.action).toBe("retry");
    expect(a.tier).toBe("fast");
  });

  it("aborting between calls: first call retry, second call (after abort) give_up", () => {
    // Models the real loop: caller aborts AFTER a verdict comes back.
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const ac = new AbortController();

    // First decision: ladder says retry.
    const a1 = nextAction(s, { pass: false }, p, ac.signal);
    expect(a1.action).toBe("retry");

    // Now the caller aborts (e.g. user pressed Ctrl-C between attempts).
    ac.abort();

    // Second decision: abort guard fires immediately.
    const a2 = nextAction(s, { pass: false }, p, ac.signal);
    expect(a2.action).toBe("give_up");
    expect(a2.reason).toBe("aborted");
  });

  it("aborted signal still allows accept when verdict.pass===true (accept preempts abort)", () => {
    // The accept branch fires before the abort guard by design — if the
    // last attempt succeeded, we want to return its result, not abort.
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 1 });
    const s = makeState({ totalAttempts: 1 });
    const ac = new AbortController();
    ac.abort();
    const a = nextAction(s, { pass: true }, p, ac.signal);
    expect(a.action).toBe("accept");
  });

  it("omitted signal (no 4th arg) => unchanged behaviour (back-compat)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("retry");
  });

  it("explicit undefined signal => unchanged behaviour", () => {
    const p = makePolicy({ maxAttemptsPerTier: 5, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p, undefined);
    expect(a.action).toBe("retry");
  });

  it("property-style: aborted signal + random policy + random state never returns retry/escalate", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rng = mulberry32(seed);
      const ladderLen = 1 + Math.floor(rng() * 3);
      const allTiers = ["fast", "medium", "heavy", "ultra"];
      const ladder = allTiers.slice(0, ladderLen);
      const p: EscalatePolicy = {
        ladder,
        floorTier: null,
        maxAttemptsPerTier: Math.floor(rng() * 4),
        maxTotalAttempts: 1 + Math.floor(rng() * 6),
        costMultiple: rng() < 0.5 ? null : 1 + Math.floor(rng() * 5),
      };
      const s = makeState({
        currentTier: ladder[0]!,
        totalAttempts: Math.floor(rng() * 5),
        attemptsThisTier: Math.floor(rng() * 3),
        firstAttemptCost: rng() < 0.5 ? null : Math.floor(rng() * 10),
        cumulativeCost: Math.floor(rng() * 50),
      });
      const ac = new AbortController();
      ac.abort();
      const a = nextAction(s, { pass: false }, p, ac.signal);
      expect(a.action, `seed=${seed}`).toBe("give_up");
      expect(a.reason, `seed=${seed}`).toBe("aborted");
    }
  });
});

// ---------------------------------------------------------------------------
// canBumpReasoning — pure gating function for the bump branch
// D-2: policy param dropped; bumping eligibility is entirely state-local via tierMaxBumps.
//
// Truth table (new signature: canBumpReasoning(state, verdict)):
//   T-1: tierMaxBumps>0 + tierHasLadder + bumpsLeft + notTop + verification_fail  → true
//   T-2: tierMaxBumps>0 + tierHasLadder + bumpsLeft + notTop + retryable_error   → false
//   T-3: tierMaxBumps>0 + tierHasLadder + bumpsLeft + notTop + no cause          → false
//   T-4: tierMaxBumps>0 + tierHasLadder + bumpsLeft + notTop + cause=undefined    → false
//   T-5: tierMaxBumps>0 + tierHasLadder + bumpsLeft=0 + verification_fail         → false (no bumps left)
//   T-6: tierMaxBumps>0 + tierHasLadder=0 + verification_fail                   → false (no ladder)
//   T-7: tierMaxBumps=0 + verification_fail                                       → false (bumping disabled)
//   T-8: tierMaxBumps>0 + tierHasLadder + bumpsLeft + TOP rung + verification_fail → false (at top)
// ---------------------------------------------------------------------------

describe("canBumpReasoning", () => {
  // T-1: true
  it("T-1: returns true when tierMaxBumps>0, ladder, bumpsLeft, notTop, cause=verification_fail", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    expect(canBumpReasoning(s, verdict)).toBe(true);
  });

  // T-2: false (retryable_error)
  it("T-2: returns false when cause=retryable_error (even with bumps left)", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false, cause: "retryable_error" };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });

  // T-3: false (no cause field)
  it("T-3: returns false when cause is absent (verdict has no cause field)", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });

  // T-4: false (cause=undefined)
  it("T-4: returns false when cause=undefined", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false, cause: undefined };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });

  // T-5: false (no bumps left)
  it("T-5: returns false when bumpsThisTier >= tierMaxBumps (no bumps left)", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 1,
      bumpsThisTier: 2,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });

  // T-6: false (no ladder)
  it("T-6: returns false when reasoningLadderLen=0 (tier has no ladder)", () => {
    const s = makeState({
      reasoningLadderLen: 0,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });

  // T-7: false (bumping disabled)
  it("T-7: returns false when tierMaxBumps=0 (bumping disabled)", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 0,
    });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });

  // T-8: false (at top rung)
  it("T-8: returns false when at top rung (levelIndex >= reasoningLadderLen - 1)", () => {
    const s = makeState({
      reasoningLadderLen: 3,
      levelIndex: 2,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
    });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    expect(canBumpReasoning(s, verdict)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextAction — bump branch (WU-4)
//
// T-1: feature ON + ladder + bumpsLeft + verification_fail => bump
// T-2: feature ON + ladder + bumpsLeft + retryable_error    => retry (else-wrap)
// T-3: feature ON + ladder + top rung (no rungsRemain)      => escalate
// T-4: feature ON + ladder + bumps exhausted                 => escalate
// T-5: feature OFF (enabled=false)                           => existing path
// T-6: cause omitted (no cause field)                       => no bump
// ---------------------------------------------------------------------------

describe("nextAction — bump branch (WU-4)", () => {
  const ladder = ["fast", "medium", "heavy"];
  const bumpPolicy = (overrides: Partial<EscalatePolicy> = {}) =>
    makePolicy({
      ladder,
      ...overrides,
    });
  const ladderState = (overrides: Partial<LadderState> = {}) =>
    makeState({
      reasoningLadderLen: 3,
      levelIndex: 0,
      bumpsThisTier: 0,
      tierMaxBumps: 2,
      ...overrides,
    });

  // T-1: bump
  it("T-1: returns bump when feature ON + tierHasLadder + bumpsLeft + verification_fail", () => {
    const p = bumpPolicy();
    const s = ladderState({ levelIndex: 0, bumpsThisTier: 0, attemptsThisTier: 0 });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("bump");
    expect(a.tier).toBe("fast");
  });

  // T-3: top-rung escalate (no bump — no rungs remain)
  it("T-3: escalates when at top rung (levelIndex+1 >= reasoningLadderLen)", () => {
    const p = bumpPolicy();
    // levelIndex 2 with ladderLen 3 = top rung (index 2 is last of 3 levels: 0,1,2)
    const s = ladderState({ levelIndex: 2, bumpsThisTier: 0, attemptsThisTier: 1 });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });

  // T-4: cap-hit escalate (no bump — bumps exhausted)
  it("T-4: escalates when bumpsThisTier >= maxLevelBumpsPerTier", () => {
    const p = bumpPolicy();
    const s = ladderState({ levelIndex: 0, bumpsThisTier: 2, attemptsThisTier: 1 });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("escalate");
  });

  // T-4 variant: bumps exhausted at non-top-rung with next tier available
  it("T-4 variant: escalates to next tier when explicit bump cap exhausted but rungs remain and higher tier exists", () => {
    const p = bumpPolicy();
    // levelIndex 0 with reasoningLadderLen 3 => rungs remain (0+1 < 3)
    // bumpsThisTier 1 === maxLevelBumpsPerTier 1 => bumps exhausted
    const s = ladderState({
      levelIndex: 0,
      bumpsThisTier: 1,
      attemptsThisTier: 1,
      tierMaxBumps: 1,
    });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });

  // T-2: retryable error — enters else-wrap branch 6 (retry)
  it("T-2: returns retry (not bump) when cause=retryable_error", () => {
    const p = bumpPolicy({ maxAttemptsPerTier: 2 });
    const s = ladderState({ levelIndex: 0, bumpsThisTier: 0, attemptsThisTier: 0 });
    const verdict: LadderVerdict = { pass: false, cause: "retryable_error" };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("retry"); // else-wrap to branch 6
    expect(a.tier).toBe("fast");
  });

  // T-5: feature off — existing path (retry)
  it("T-5: returns retry when feature is OFF (enabled=false)", () => {
    const p = makePolicy({
      ladder,
      maxAttemptsPerTier: 2,
    });
    const s = ladderState({ attemptsThisTier: 0, tierMaxBumps: 0 });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("retry"); // existing path, no bump
  });

  // T-6: omitted cause — no bump (enters else-wrap → retry or escalate)
  it("T-6: omitted cause => no bump (cause absent, not verification_fail)", () => {
    const p = bumpPolicy({ maxAttemptsPerTier: 2 });
    const s = ladderState({ levelIndex: 0, bumpsThisTier: 0, attemptsThisTier: 0 });
    const verdict: LadderVerdict = { pass: false }; // no cause field
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("retry"); // else-wrap → branch 6
  });

  // R-1 else-wrap invariant: verification_fail ladder tier MUST NOT enter branch 6
  it("R-1: verification_fail ladder tier skips branch 6 (retry) and escalates", () => {
    const p = bumpPolicy({ maxAttemptsPerTier: 3 }); // retry available but...
    const s = ladderState({ levelIndex: 0, bumpsThisTier: 0, attemptsThisTier: 1 });
    const verdict: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, verdict, p);
    // bump available (rungsRemain + bumpsLeft) → returns bump, not retry
    expect(a.action).toBe("bump");
  });
});

// ---------------------------------------------------------------------------
// attempt accounting with bumps (039 characterization)
//
// Pins the bumps-first-then-retries arithmetic documented in Plan 039:
//   produce attempts per tier = 1 (initial) + maxLevelBumpsPerTier + maxAttemptsPerTier.
// Worst case with the SHIPPED base.json (maxAttemptsPerTier=2,
// maxLevelBumpsPerTier=2): 5 produce attempts per tier.
// ---------------------------------------------------------------------------

describe("attempt accounting with bumps (039 characterization)", () => {
  // 3-rung reasoning ladder, 2 bumps cap, 2 retries cap, 2 tiers total.
  const p: EscalatePolicy = {
    ladder: ["fast", "medium"],
    floorTier: null,
    maxAttemptsPerTier: 2,
    maxTotalAttempts: 10,
    costMultiple: null,
  };

  it("bumps do not consume the retry budget: attemptsThisTier stays 0 across two bumps", () => {
    const fail: LadderVerdict = { pass: false, cause: "verification_fail" };

    let state: LadderState = {
      currentTier: "fast",
      attemptsThisTier: 0,
      totalAttempts: 0,
      escalations: 0,
      firstAttemptCost: null,
      cumulativeCost: 0,
      levelIndex: 0,
      bumpsThisTier: 0,
      reasoningLadderLen: 3,
      tierMaxBumps: 2,
    };

    // First FAIL: bumps + rungs both available → bump.
    let a = nextAction(state, fail, p);
    expect(a.action).toBe("bump");
    expect(state.attemptsThisTier).toBe(0); // unchanged by nextAction (no recordAttempt yet)
    state = advance(state, a);
    expect(state.levelIndex).toBe(1);
    expect(state.bumpsThisTier).toBe(1);
    expect(state.attemptsThisTier).toBe(0); // bumps must not touch the retry budget

    // Second FAIL: still rungs + bumps available → bump.
    a = nextAction(state, fail, p);
    expect(a.action).toBe("bump");
    state = advance(state, a);
    expect(state.levelIndex).toBe(2);
    expect(state.bumpsThisTier).toBe(2);
    expect(state.attemptsThisTier).toBe(0); // still zero — the retry budget is intact

    // Third FAIL: bumpsThisTier=2 === tierMaxBumps=2 → bump exhausted (D-3 spec).
    // bumpExhausted returns true → escalate directly, no same-level retry.
    a = nextAction(state, fail, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
    state = advance(state, a);
    // On escalate, attemptsThisTier resets to 0.
    expect(state.attemptsThisTier).toBe(0);
    expect(state.levelIndex).toBe(0); // reset on tier change
    expect(state.bumpsThisTier).toBe(0); // reset on tier change
  });

  it("worst-case per-tier arithmetic: 1 initial + 2 bumps + escalate (D-3: bump exhaustion bypasses retry)", () => {
    const fail: LadderVerdict = { pass: false, cause: "verification_fail" };

    let state: LadderState = {
      currentTier: "fast",
      attemptsThisTier: 0,
      totalAttempts: 0,
      escalations: 0,
      firstAttemptCost: null,
      cumulativeCost: 0,
      levelIndex: 0,
      bumpsThisTier: 0,
      reasoningLadderLen: 3,
      tierMaxBumps: 2,
    };

    // Drive the bump-phase to its end (2 bumps for a 3-rung ladder).
    for (let i = 0; i < 2; i++) {
      const a = nextAction(state, fail, p);
      expect(a.action).toBe("bump");
      state = advance(state, a);
    }
    expect(state.bumpsThisTier).toBe(2);
    expect(state.levelIndex).toBe(2);
    expect(state.attemptsThisTier).toBe(0); // bump phase never touched retries

    // Third verification_fail: bump exhausted (tierMaxBumps reached + top rung) → escalate directly (D-3 spec).
    // No retry phase — bumpExhausted bypasses branch 6.
    const escalateAction = nextAction(state, fail, p);
    expect(escalateAction.action).toBe("escalate");
    expect(escalateAction.tier).toBe("medium");
    state = advance(state, escalateAction);
    // On escalate: attemptsThisTier=0, levelIndex=0, bumpsThisTier=0, tierMaxBumps=0 (all reset).
    expect(state.attemptsThisTier).toBe(0);
    expect(state.levelIndex).toBe(0);
    expect(state.bumpsThisTier).toBe(0);
    expect(state.tierMaxBumps).toBe(0);
  });

  it("top-of-rung with bumps still remaining escalates (pins the collapsed `!rungsRemain` path)", () => {
    // levelIndex 2 is the top of a 3-rung ladder (idx 0,1,2).
    // bumpsThisTier=1 < tierMaxBumps=2 → bumps remain mathematically,
    // but no rung above → bump is impossible; must escalate.
    const s: LadderState = {
      currentTier: "fast",
      attemptsThisTier: 0,
      totalAttempts: 0,
      escalations: 0,
      firstAttemptCost: null,
      cumulativeCost: 0,
      levelIndex: 2,
      bumpsThisTier: 1,
      reasoningLadderLen: 3,
      tierMaxBumps: 2,
    };
    const fail: LadderVerdict = { pass: false, cause: "verification_fail" };
    const a = nextAction(s, fail, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });
});
