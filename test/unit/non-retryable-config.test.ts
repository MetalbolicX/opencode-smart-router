import { describe, expect, it } from "vitest";
import { validateNonRetryableErrorPatterns } from "../../src/router/config-validate";
import { classifyPromptError } from "../../src/utils/error-classify";

// Real denial strings captured from welfare gateways (New API relays).
const TABITOKEN_PREDEDUCT = "预扣费额度失败, 用户剩余额度: ＄0.623214, 需要预扣费额度: ＄0.800000";
const KKTOKEN_OVERDRAWN = "用户额度不足, 剩余额度: ＄-0.144680";
const RATE_LIMITED = "Concurrency limit exceeded for user, please retry later";
const NO_CHANNEL =
  "No available channel for model claude-opus-4-8 under group default (distributor)";

const OPERATOR_PATTERNS = [
  {
    pattern: /(预扣费|剩余额度|额度不足|余额不足|欠费|请充值|잔액|残高不足)/i,
    reason: "insufficient billing or subscription",
  },
];

describe("operator-supplied nonRetryableErrorPatterns", () => {
  it("localized billing denials are non_retryable when supplied", () => {
    for (const msg of [TABITOKEN_PREDEDUCT, KKTOKEN_OVERDRAWN]) {
      const res = classifyPromptError(new Error(msg), OPERATOR_PATTERNS);
      expect(res.kind).toBe("non_retryable");
      expect(res.reason).toBe("insufficient billing or subscription");
    }
  });

  it("without the patterns the same denials stay retryable (upstream default)", () => {
    for (const msg of [TABITOKEN_PREDEDUCT, KKTOKEN_OVERDRAWN]) {
      expect(classifyPromptError(new Error(msg)).kind).toBe("retryable");
    }
  });

  it("transient failures stay retryable even with the patterns", () => {
    for (const msg of [RATE_LIMITED, NO_CHANNEL]) {
      expect(classifyPromptError(new Error(msg), OPERATOR_PATTERNS).kind).toBe("retryable");
    }
  });
});

describe("validateNonRetryableErrorPatterns", () => {
  it("accepts absent field and a well-formed list", () => {
    expect(() => validateNonRetryableErrorPatterns({})).not.toThrow();
    expect(() =>
      validateNonRetryableErrorPatterns({
        nonRetryableErrorPatterns: [{ pattern: "余额不足", reason: "billing" }],
      }),
    ).not.toThrow();
  });

  it("rejects a non-array, missing fields, and an invalid regex", () => {
    expect(() => validateNonRetryableErrorPatterns({ nonRetryableErrorPatterns: {} })).toThrow(
      /must be an array/,
    );
    expect(() =>
      validateNonRetryableErrorPatterns({ nonRetryableErrorPatterns: [{ reason: "x" }] }),
    ).toThrow(/\.pattern' must be a non-empty string/);
    expect(() =>
      validateNonRetryableErrorPatterns({
        nonRetryableErrorPatterns: [{ pattern: "([", reason: "x" }],
      }),
    ).toThrow(/not a valid regex/);
  });
});
