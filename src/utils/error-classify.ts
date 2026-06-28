// ---------------------------------------------------------------------------
// src/utils/error-classify.ts — Classify SDK prompt errors into retry buckets.
//
// The SDK (`client.session.prompt`) throws opaque Error instances with no
// structured error code or HTTP status property. This module inspects
// `err.message`, `err.name`, and any `status`/`statusCode` property to
// classify errors into three buckets:
//
//   abort        — user cancelled (AbortError). Caller should bail silently.
//   non_retryable — model/billing/auth/config errors that will never succeed
//                   on retry. Caller should fail-closed immediately.
//   retryable    — transport or transient API errors. Caller may retry or
//                   let the ladder decide.
//
// Patterns are deliberately scoped to concrete provider-denial evidence
// (HTTP status codes, billing/credits/quota terms, auth/forbidden language,
// invalid model/provider shapes). Incidental substrings like
// "insufficient context" or "academic credits" must NOT trip the
// non-retryable path — false positives waste attempts and pollute telemetry.
//
// Cross-runtime abort detection uses a duck-type helper so we don't depend
// on `instanceof DOMException` (Node, Bun, Deno, and browser runtimes all
// surface abort differently). See `isAbortLikeError` below.
//
// `additionalNonRetryablePatterns` is an operator extensibility seam: callers
// can register their own provider-specific terminologies (e.g. an upstream
// gateway code) without us having to ship a new classifier version.
// ---------------------------------------------------------------------------

export type PromptErrorKind = "abort" | "non_retryable" | "retryable";

export interface ClassifiedError {
  kind: PromptErrorKind;
  reason: string;
}

export type NonRetryablePattern = Readonly<{ pattern: RegExp; reason: string }>;

const NON_RETRYABLE_PATTERNS: ReadonlyArray<NonRetryablePattern> = [
  { pattern: /model.{0,5}not.{0,5}found/i, reason: "model not found" },
  { pattern: /unknown.{0,5}model/i, reason: "model not found" },
  // Tightened: require a billing/subscription/credits term to follow
  // "insufficient" so incidental phrases like "insufficient context"
  // don't trip the billing reason.
  {
    pattern: /insufficient.{0,20}(billing|subscription|quota|credits|funds|balance)/i,
    reason: "insufficient billing or subscription",
  },
  { pattern: /billing/i, reason: "insufficient billing or subscription" },
  { pattern: /subscription/i, reason: "insufficient billing or subscription" },
  { pattern: /payment.{0,5}required/i, reason: "insufficient billing or subscription" },
  { pattern: /quota/i, reason: "insufficient billing or subscription" },
  // Tightened: word-boundary match. The old `/unauthor/i` substring matched
  // any text containing "unauthor" as a prefix fragment (e.g. "unauthorised"
  // or "unauthorized access to the file system") — that's still intended,
  // but the explicit boundary prevents accidental matches against words
  // like "unauthoritative" being silently dropped in a future tightening.
  { pattern: /\bunauthor\w*\b/i, reason: "auth or permission denied" },
  { pattern: /forbidden/i, reason: "auth or permission denied" },
  { pattern: /permission.{0,5}denied/i, reason: "auth or permission denied" },
  { pattern: /invalid.{0,10}model/i, reason: "invalid model or provider configuration" },
  { pattern: /invalid.{0,10}provider/i, reason: "invalid model or provider configuration" },
];

const HTTP_STATUS_PATTERNS: ReadonlyArray<{
  codes: ReadonlyArray<number>;
  reason: string;
}> = [
  { codes: [402], reason: "insufficient billing or subscription" },
  { codes: [401], reason: "auth or permission denied" },
  { codes: [403], reason: "auth or permission denied" },
  { codes: [404], reason: "model not found" },
];

const extractStatus = (err: unknown): number | null => {
  if (typeof err !== "object" || err === null) return null;
  const rec = err as Record<string, unknown>;
  // `status` takes precedence over `statusCode`. Some SDKs / proxies set
  // both and the `status` field is the canonical HTTP status code while
  // `statusCode` is an alias (or vice versa on older clients). Picking
  // `status` first matches the docs and avoids accidental non-retryable
  // mis-classification when both are present.
  if (typeof rec.status === "number") return rec.status;
  if (typeof rec.statusCode === "number") return rec.statusCode;
  return null;
};

const extractMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
};

/**
 * Cross-runtime abort detection.
 *
 * Returns true when `err` looks like an abort signal from any of the
 * runtimes we support:
 *   - Browser/DOM: `DOMException` with `name === "AbortError"`
 *   - Node `fetch` / undici: plain object with `name === "AbortError"`
 *   - Node core `AbortController`: error with `code === "ABORT_ERR"`
 *   - Node legacy / undici: error with `code === "ERR_ABORTED"`
 *
 * We intentionally use a duck-type instead of `instanceof DOMException`
 * because:
 *   1. Not every runtime exposes `DOMException` (e.g. minimal Node builds).
 *   2. Some runtimes throw `Error("aborted")` with `code: "ERR_ABORTED"`
 *      rather than a DOMException.
 *
 * The contract is conservative: a positive match means the caller should
 * treat the operation as cancelled. False negatives fall through to the
 * retryable path (acceptable — see file header).
 */
export const isAbortLikeError = (err: unknown): boolean => {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.name === "AbortError") return true;
    if (e.code === "ERR_ABORTED" || e.code === "ABORT_ERR") return true;
  }
  return false;
};

export const classifyPromptError = (
  err: unknown,
  additionalNonRetryablePatterns?: readonly NonRetryablePattern[],
): ClassifiedError => {
  // Priority 1: Abort — always bail silently.
  if (isAbortLikeError(err)) {
    return { kind: "abort", reason: "aborted" };
  }

  // Priority 2: HTTP status codes (structured). 429 is explicitly retryable
  // (rate limiting is the canonical reason to back off and try again, not
  // to fail-closed) so we check it before the non-retryable HTTP table.
  const status = extractStatus(err);
  if (status !== null) {
    if (status === 429) {
      return { kind: "retryable", reason: "rate limited" };
    }
    for (const { codes, reason } of HTTP_STATUS_PATTERNS) {
      if (codes.includes(status)) {
        return { kind: "non_retryable", reason };
      }
    }
  }

  // Priority 3: message-based heuristics.
  const message = extractMessage(err);
  for (const { pattern, reason } of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) {
      return { kind: "non_retryable", reason };
    }
  }

  // Priority 4: operator-supplied additional non-retryable patterns. Same
  // priority level as the built-ins — first match wins. If a built-in
  // matched first, the additional list is never consulted (matches the
  // existing "first match wins" contract for the table).
  if (additionalNonRetryablePatterns) {
    for (const { pattern, reason } of additionalNonRetryablePatterns) {
      if (pattern.test(message)) {
        return { kind: "non_retryable", reason };
      }
    }
  }

  // Default: treat as retryable transport/transient error.
  return { kind: "retryable", reason: "transport or transient API error" };
};
