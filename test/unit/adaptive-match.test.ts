import { describe, expect, it } from "vitest";
import { type MatchMode, matchSignal, normalizeSignalText } from "../../src/reasoning/match";

// ---------------------------------------------------------------------------
// normalizeSignalText
// ---------------------------------------------------------------------------

describe("normalizeSignalText", () => {
  it("lowercases the input", () => {
    expect(normalizeSignalText("Investigate Root Cause")).toBe("investigate root cause");
  });

  it("collapses tabs to a single space", () => {
    expect(normalizeSignalText("investigate\troot cause")).toBe("investigate root cause");
  });

  it("collapses multiple spaces to one", () => {
    expect(normalizeSignalText("investigate    root cause")).toBe("investigate root cause");
  });

  it("collapses newlines to a single space", () => {
    expect(normalizeSignalText("investigate\nroot   cause")).toBe("investigate root cause");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSignalText("  investigate root cause  ")).toBe("investigate root cause");
  });
});

// ---------------------------------------------------------------------------
// matchSignal — stem (default) — inflection matching
// ---------------------------------------------------------------------------

describe("matchSignal — stem default", () => {
  it("matches 'debugging' against keyword 'debug'", () => {
    expect(matchSignal("debugging the race condition", "debug", "stem")).toBe(true);
  });

  it("matches 'refactoring' against keyword 'refactor'", () => {
    expect(matchSignal("please refactor this module", "refactor", "stem")).toBe(true);
  });

  it("matches 'migrations' against keyword 'migration'", () => {
    expect(matchSignal("running data migrations", "migration", "stem")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchSignal — stem — cross-word false positives are rejected
// ---------------------------------------------------------------------------

describe("matchSignal — stem rejects cross-word false positives", () => {
  it("does NOT match 'latest' against keyword 'test'", () => {
    expect(matchSignal("update the latest fixtures", "test", "stem")).toBe(false);
  });

  it("does NOT match 'prefix' against keyword 'fix'", () => {
    expect(matchSignal("rewrite the prefix handler", "fix", "stem")).toBe(false);
  });

  it("does NOT match 'dispatch' against keyword 'patch'", () => {
    expect(matchSignal("dispatch the worker", "patch", "stem")).toBe(false);
  });

  it("does NOT match 'contest' against keyword 'test'", () => {
    expect(matchSignal("enter the contest", "test", "stem")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchSignal — word strict
// ---------------------------------------------------------------------------

describe("matchSignal — word mode is strict", () => {
  it("does NOT match 'debugging' against keyword 'debug'", () => {
    expect(matchSignal("debugging the race condition", "debug", "word")).toBe(false);
  });

  it("does NOT match 'root causes' against keyword 'root cause'", () => {
    expect(matchSignal("investigate the root causes today", "root cause", "word")).toBe(false);
  });

  it("DOES match an exact word", () => {
    expect(matchSignal("please debug this", "debug", "word")).toBe(true);
  });

  it("DOES match an exact phrase with flexible whitespace", () => {
    expect(matchSignal("investigate\nroot   cause", "root cause", "word")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchSignal — substring (legacy opt-in)
// ---------------------------------------------------------------------------

describe("matchSignal — substring mode preserves legacy behavior", () => {
  it("matches 'latest' against keyword 'test' (documents the opt-in risk)", () => {
    expect(matchSignal("update the latest fixtures", "test", "substring")).toBe(true);
  });

  it("matches 'prefix' against keyword 'fix'", () => {
    expect(matchSignal("rewrite the prefix handler", "fix", "substring")).toBe(true);
  });

  it("matches 'dispatch' against keyword 'patch'", () => {
    expect(matchSignal("dispatch the worker", "patch", "substring")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchSignal — regex
// ---------------------------------------------------------------------------

describe("matchSignal — regex mode", () => {
  it("matches '^perf' against 'performance'", () => {
    expect(matchSignal("performance regression", "^perf", "regex")).toBe(true);
  });

  it("returns false for an invalid regex pattern (fail-soft, no throw)", () => {
    // Unbalanced group is rejected by RegExp constructor; the runtime path
    // must swallow the throw and report no match.
    expect(() => matchSignal("anything", "(unclosed", "regex")).not.toThrow();
    expect(matchSignal("anything", "(unclosed", "regex")).toBe(false);
  });

  it("matches arbitrary user patterns", () => {
    expect(matchSignal("foo bar baz", "b[a-z]+z", "regex")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchSignal — multi-word phrase with flexible whitespace
// ---------------------------------------------------------------------------

describe("matchSignal — multi-word phrases with flexible whitespace", () => {
  it("stem mode matches across tabs and newlines", () => {
    expect(matchSignal("investigate\nroot\tcause today", "root cause", "stem")).toBe(true);
  });

  it("word mode matches across tabs and newlines", () => {
    expect(matchSignal("investigate\nroot\tcause today", "root cause", "word")).toBe(true);
  });

  it("stem mode matches an exact phrase (last token allows inflection)", () => {
    expect(matchSignal("finding root causes", "root cause", "stem")).toBe(true);
  });

  it("word mode rejects inflection on the last token", () => {
    expect(matchSignal("finding root causes", "root cause", "word")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchSignal — memoization & defensive paths
// ---------------------------------------------------------------------------

describe("matchSignal — memoization and defensive paths", () => {
  it("does not throw on repeated calls for the same (mode, keyword)", () => {
    const call = () => matchSignal("debugging is fun", "debug", "stem");
    expect(call).not.toThrow();
    expect(call).not.toThrow();
    expect(call).not.toThrow();
    expect(matchSignal("debugging is fun", "debug", "stem")).toBe(true);
  });

  it("returns false for an empty keyword", () => {
    expect(matchSignal("anything", "", "stem")).toBe(false);
  });

  it("caches separately per match mode for the same keyword", () => {
    expect(matchSignal("debugging", "debug", "stem")).toBe(true);
    expect(matchSignal("debugging", "debug", "word")).toBe(false);
    expect(matchSignal("debugging", "debug", "substring")).toBe(true);
    expect(matchSignal("debugging", "debug", "regex" as MatchMode)).toBe(true);
  });
});
