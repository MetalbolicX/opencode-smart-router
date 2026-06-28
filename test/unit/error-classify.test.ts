// ---------------------------------------------------------------------------
// test/unit/error-classify.test.ts
//
// Dedicated classifier matrix for `classifyPromptError`. These cases
// pin the behaviour of the hardened patterns shipped in PR 1 of
// `fail-fast-hardening-v2`:
//
//   - Non-Error throws (string, plain object, null, undefined) are
//     handled defensively and fall through to the retryable bucket.
//   - `status` wins over `statusCode` when both are present (the SDK
//     convention).
//   - HTTP status codes take priority over message-based regex matches
//     (so a 401 with the message "model not found" classifies as auth,
//     not as model-not-found).
//   - HTTP 429 is explicitly retryable (rate limiting must not fail-closed).
//   - Each tightened pattern matches the legitimate provider-denial case
//     and rejects the incidental phrasing the old broad patterns matched.
//   - Abort detection is cross-runtime: DOMException, plain `{name: ...}`,
//     and `{code: ...}` shapes all classify as abort.
//   - Operator-supplied `additionalNonRetryablePatterns` extend the table
//     without changing built-in priority.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  classifyPromptError,
  isAbortLikeError,
  type NonRetryablePattern,
} from "../../src/utils/error-classify";

// ---------------------------------------------------------------------------
// Non-Error throws
// ---------------------------------------------------------------------------

describe("classifyPromptError — non-Error throws", () => {
  const nonErrors: Array<[string, unknown]> = [
    ["plain string", "something went wrong"],
    ["plain object", { message: "boom" }],
    ["null", null],
    ["undefined", undefined],
    ["number", 42],
    ["boolean", true],
    ["empty string", ""],
  ];

  it.each(nonErrors)("treats %s as retryable (no patterns match, no status)", (_label, err) => {
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });

  it("treats a plain string that contains 'insufficient' as retryable (no classification)", () => {
    // The tightening rule is regex-based — strings only classify when the
    // composite pattern matches, but a non-Error string still falls into
    // extractMessage() and is checked. This case verifies that bare strings
    // without matching structure go to retryable.
    expect(classifyPromptError("insufficient context")).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });
});

// ---------------------------------------------------------------------------
// status vs statusCode precedence
// ---------------------------------------------------------------------------

describe("classifyPromptError — status vs statusCode precedence", () => {
  it("reads `status` when only `status` is present", () => {
    const err = Object.assign(new Error("oops"), { status: 404 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "model not found",
    });
  });

  it("reads `statusCode` when only `statusCode` is present", () => {
    const err = Object.assign(new Error("oops"), { statusCode: 401 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });

  it("`status` wins over `statusCode` when both are present (status=401, statusCode=404 → auth)", () => {
    const err = Object.assign(new Error("oops"), { status: 401, statusCode: 404 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });

  it("`status` wins over `statusCode` (status=404, statusCode=401 → model not found)", () => {
    // Inverse direction — prove the winner is `status`, not just the first
    // one encountered.
    const err = Object.assign(new Error("oops"), { status: 404, statusCode: 401 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "model not found",
    });
  });

  it("ignores non-numeric `status` and falls back to `statusCode`", () => {
    const err = Object.assign(new Error("oops"), { status: "401", statusCode: 403 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP priority over regex
// ---------------------------------------------------------------------------

describe("classifyPromptError — HTTP priority over regex", () => {
  it("HTTP 401 with message 'model not found' → auth (status wins)", () => {
    const err = Object.assign(new Error("model not found"), { status: 401 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });

  it("HTTP 402 with message 'unauthorized' → billing (status wins)", () => {
    const err = Object.assign(new Error("unauthorized: payment required"), { status: 402 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "insufficient billing or subscription",
    });
  });

  it("HTTP 403 with message 'model not found' → auth (status wins)", () => {
    const err = Object.assign(new Error("model not found: gpt-9000"), { status: 403 });
    expect(classifyPromptError(err)).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });

  it("HTTP 429 (rate limited) → retryable even with alarming message text", () => {
    const err = Object.assign(new Error("model not found: gpt-9000"), { status: 429 });
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "rate limited",
    });
  });

  it("HTTP 500 with no matching message → retryable", () => {
    const err = Object.assign(new Error("internal error"), { status: 500 });
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP 429 retryable (Phase 1, Task 1.3)
// ---------------------------------------------------------------------------

describe("classifyPromptError — HTTP 429 is retryable", () => {
  it("classifies a bare HTTP 429 as retryable 'rate limited'", () => {
    const err = Object.assign(new Error(""), { status: 429 });
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "rate limited",
    });
  });

  it("classifies an HTTP 429 + statusCode=200 as retryable (status wins)", () => {
    const err = Object.assign(new Error(""), { status: 429, statusCode: 200 });
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "rate limited",
    });
  });
});

// ---------------------------------------------------------------------------
// Built-in non-retryable patterns — match and non-match matrix
// ---------------------------------------------------------------------------

describe("classifyPromptError — built-in non-retryable patterns (positive matches)", () => {
  // Each row is [label, message, expectedReason]. These are the
  // provider-denial phrases the patterns are supposed to catch.
  const patternMatches: Array<[string, string, string]> = [
    // --- model not found ---
    ["model not found", "model not found: anthropic/gpt-9000", "model not found"],
    ["unknown model", "unknown model id provided", "model not found"],

    // --- insufficient billing composite ---
    [
      "insufficient billing",
      "insufficient billing on account",
      "insufficient billing or subscription",
    ],
    ["insufficient credits", "insufficient credits", "insufficient billing or subscription"],
    [
      "insufficient quota",
      "insufficient quota for this tier",
      "insufficient billing or subscription",
    ],
    ["insufficient funds", "insufficient funds", "insufficient billing or subscription"],
    [
      "insufficient balance",
      "insufficient balance to complete",
      "insufficient billing or subscription",
    ],
    [
      "insufficient subscription",
      "insufficient subscription tier",
      "insufficient billing or subscription",
    ],

    // --- billing ---
    ["billing", "billing address rejected", "insufficient billing or subscription"],

    // --- subscription ---
    ["subscription", "subscription expired", "insufficient billing or subscription"],

    // --- payment required ---
    ["payment required", "payment required to continue", "insufficient billing or subscription"],

    // --- quota (standalone) ---
    ["quota", "quota exceeded", "insufficient billing or subscription"],

    // --- auth/permission denied ---
    ["unauthorized", "unauthorized: invalid API key", "auth or permission denied"],
    [
      "unauthorized (suffix variants)",
      "unauthorized access denied by gateway",
      "auth or permission denied",
    ],
    ["unauthorised (British spelling)", "unauthorised access token", "auth or permission denied"],
    ["forbidden", "forbidden: token rejected", "auth or permission denied"],
    ["permission denied", "permission denied for model", "auth or permission denied"],

    // --- invalid model/provider ---
    ["invalid model", "invalid model id 'foo'", "invalid model or provider configuration"],
    ["invalid provider", "invalid provider 'bar'", "invalid model or provider configuration"],
  ];

  it.each(patternMatches)("'%s' (%s) → %s", (_label, message, expectedReason) => {
    const result = classifyPromptError(new Error(message));
    expect(result.kind).toBe("non_retryable");
    expect(result.reason).toBe(expectedReason);
  });
});

describe("classifyPromptError — tightened patterns reject incidental phrasing", () => {
  // These messages USED to match the broad patterns (`/insufficient/i`
  // and `/credits/i`). After tightening, none of them must classify as
  // non-retryable — they all fall through to retryable.
  const incidental: Array<[string, string]> = [
    ["insufficient context", "insufficient context was provided to the model"],
    ["insufficient memory", "insufficient memory available to continue"],
    ["insufficient information", "insufficient information to answer"],
    ["academic credits", "the student earned academic credits for the course"],
    ["out of credits", "you are out of credits for this account"],
  ];

  it.each(incidental)("'%s' message does NOT classify as non-retryable", (_label, message) => {
    expect(classifyPromptError(new Error(message))).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });
});

// ---------------------------------------------------------------------------
// Incidental text non-matches — authorized-behavior pin for the
// `unauthorized` family.
//
// The word-boundary tightening on `/unauthor/i` is INTENTIONAL but
// conservative: any word containing 'unauthor' as a prefix (e.g.
// "unauthorized", "unauthorised", "unauthorized access to the file
// system") still classifies as auth. This test pins that contract so
// a future over-tightening that drops these phrases is caught.
// ---------------------------------------------------------------------------

describe("classifyPromptError — 'unauthorized' family still matches (intentional)", () => {
  it("matches 'unauthorized access to the file system' as auth", () => {
    expect(classifyPromptError(new Error("unauthorized access to the file system"))).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });

  it("matches 'unauthorised' (British spelling) as auth", () => {
    expect(classifyPromptError(new Error("unauthorised access token"))).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });
});

// ---------------------------------------------------------------------------
// Default fallthrough (unknown error shapes)
// ---------------------------------------------------------------------------

describe("classifyPromptError — default retryable fallthrough", () => {
  it("returns 'transport or transient API error' for unknown error shapes", () => {
    expect(classifyPromptError({ weird: "shape", code: 99999 })).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });

  it("returns 'transport or transient API error' for unknown status codes", () => {
    const err = Object.assign(new Error("boom"), { status: 418 });
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });

  it("returns 'transport or transient API error' for an Error with no message", () => {
    const err = new Error();
    expect(classifyPromptError(err)).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });
});

// ---------------------------------------------------------------------------
// Abort canonical check + cross-runtime duck-type (Task 1.4)
// ---------------------------------------------------------------------------

describe("isAbortLikeError — cross-runtime abort detection", () => {
  it("matches a DOMException with name 'AbortError'", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(isAbortLikeError(err)).toBe(true);
  });

  it("matches a plain object with name 'AbortError'", () => {
    expect(isAbortLikeError({ name: "AbortError", message: "x" })).toBe(true);
  });

  it("matches a plain object with code 'ERR_ABORTED'", () => {
    expect(isAbortLikeError({ code: "ERR_ABORTED", message: "x" })).toBe(true);
  });

  it("matches a plain object with code 'ABORT_ERR'", () => {
    expect(isAbortLikeError({ code: "ABORT_ERR", message: "x" })).toBe(true);
  });

  it("does NOT match a regular Error", () => {
    expect(isAbortLikeError(new Error("aborted"))).toBe(false);
  });

  it("matches an Error whose name has been redefined to 'AbortError'", () => {
    // The duck-type helper intentionally treats any object with
    // `name === "AbortError"` as abort — including a plain Error whose
    // `name` has been reassigned. This is the documented contract: a
    // runtime that throws `new Error("aborted")` with `name="AbortError"`
    // is unambiguously an abort, regardless of constructor. Pinning here
    // so the helper's "be liberal in what you accept" contract isn't
    // silently narrowed in a future refactor.
    const err = new Error("aborted");
    Object.defineProperty(err, "name", { value: "AbortError" });
    expect(isAbortLikeError(err)).toBe(true);
  });

  it("does NOT match null", () => {
    expect(isAbortLikeError(null)).toBe(false);
  });

  it("does NOT match undefined", () => {
    expect(isAbortLikeError(undefined)).toBe(false);
  });

  it("does NOT match a string", () => {
    expect(isAbortLikeError("aborted")).toBe(false);
  });

  it("does NOT match a number", () => {
    expect(isAbortLikeError(0)).toBe(false);
  });
});

describe("classifyPromptError — abort short-circuits all other checks", () => {
  it("returns 'abort' for a DOMException with name 'AbortError' regardless of status", () => {
    const err = Object.assign(new DOMException("aborted", "AbortError"), {
      status: 401,
    });
    expect(classifyPromptError(err)).toEqual({ kind: "abort", reason: "aborted" });
  });

  it("returns 'abort' for a duck-typed {name: 'AbortError'} object", () => {
    expect(classifyPromptError({ name: "AbortError", message: "x" })).toEqual({
      kind: "abort",
      reason: "aborted",
    });
  });

  it("returns 'abort' for a duck-typed {code: 'ERR_ABORTED'} object", () => {
    expect(classifyPromptError({ code: "ERR_ABORTED", message: "x" })).toEqual({
      kind: "abort",
      reason: "aborted",
    });
  });

  it("returns 'abort' for a duck-typed {code: 'ABORT_ERR'} object", () => {
    expect(classifyPromptError({ code: "ABORT_ERR", message: "x" })).toEqual({
      kind: "abort",
      reason: "aborted",
    });
  });

  it("abort classification beats a matching non-retryable message", () => {
    // The message is "unauthorized" (would match the non-retryable auth
    // pattern), but the abort short-circuit runs first.
    const err = new DOMException("unauthorized", "AbortError");
    expect(classifyPromptError(err)).toEqual({ kind: "abort", reason: "aborted" });
  });
});

// ---------------------------------------------------------------------------
// Operator extensibility seam (Task 1.5)
// ---------------------------------------------------------------------------

describe("classifyPromptError — additionalNonRetryablePatterns", () => {
  const customPatterns: readonly NonRetryablePattern[] = [
    { pattern: /gateway code 42/i, reason: "upstream gateway code 42" },
    { pattern: /\bcircuit_open\b/i, reason: "circuit breaker open" },
  ];

  it("matches a custom pattern when no built-in matches first", () => {
    const err = new Error("Gateway Code 42 from upstream");
    expect(classifyPromptError(err, customPatterns)).toEqual({
      kind: "non_retryable",
      reason: "upstream gateway code 42",
    });
  });

  it("built-in patterns win over additional patterns on overlap", () => {
    // The built-in `/unauthor/i` matches "unauthorized" before the
    // additional pattern gets a chance — "first match wins" preserves
    // the existing priority contract.
    const err = new Error("unauthorized: gateway code 42 from upstream");
    expect(classifyPromptError(err, customPatterns)).toEqual({
      kind: "non_retryable",
      reason: "auth or permission denied",
    });
  });

  it("returns retryable when neither built-ins nor additional patterns match", () => {
    const err = new Error("nothing matches here");
    expect(classifyPromptError(err, customPatterns)).toEqual({
      kind: "retryable",
      reason: "transport or transient API error",
    });
  });

  it("accepts an empty additional pattern list", () => {
    const err = new Error("insufficient credits");
    expect(classifyPromptError(err, [])).toEqual({
      kind: "non_retryable",
      reason: "insufficient billing or subscription",
    });
  });

  it("additional patterns do NOT override the abort short-circuit", () => {
    const err = new DOMException("aborted", "AbortError");
    expect(classifyPromptError(err, customPatterns)).toEqual({
      kind: "abort",
      reason: "aborted",
    });
  });

  it("additional patterns do NOT override HTTP status code priority", () => {
    // HTTP 429 → retryable even if the message would match a custom
    // non-retryable pattern.
    const err = Object.assign(new Error("gateway code 42"), { status: 429 });
    expect(classifyPromptError(err, customPatterns)).toEqual({
      kind: "retryable",
      reason: "rate limited",
    });
  });

  it("exports the NonRetryablePattern type shape (structural check)", () => {
    // Compile-time evidence: the type is exported and usable from outside
    // the module. If the shape drifts, this fails to compile.
    const sample: NonRetryablePattern = { pattern: /x/, reason: "x" };
    expect(sample.pattern.test("x")).toBe(true);
    expect(sample.reason).toBe("x");
  });
});
