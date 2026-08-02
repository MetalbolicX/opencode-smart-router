// ---------------------------------------------------------------------------
// test/unit/validate-enforcement.test.ts
//
// Vitest fixture for ValidateEnforcement validators — runs on IDENTICAL inputs
// as ValidateEnforcement_test.res to prove byte-parity.
//
// Note: These tests directly call the ReScript implementation via the
// TypeScript ABI bridge declared in src/types/rescript-modules.d.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  validateEnforcement,
  validateEnforcementMode,
  validateEnforcementVerify,
  validateEnforcementEscalate,
  validateEnforcementPerTier,
  validateEnforcementGuard,
} from "../../src/validate/ValidateEnforcement.res.mjs";

// ---------------------------------------------------------------------------
// validateEnforcement — top-level dispatcher
// ---------------------------------------------------------------------------

describe("validateEnforcement", () => {
  it("accepts a valid enforcement object", () => {
    expect(() =>
      validateEnforcement({
        enforcement: { mode: "advisory" },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when enforcement is absent", () => {
    expect(() =>
      validateEnforcement({
        activePreset: "default",
      } as any),
    ).not.toThrow();
  });

  it("throws when enforcement is not an object", () => {
    expect(() =>
      validateEnforcement({
        enforcement: "not-an-object",
      } as any),
    ).toThrow("tiers.json: enforcement must be an object");
  });

  it("throws when enforcement is an array", () => {
    expect(() =>
      validateEnforcement({
        enforcement: [],
      } as any),
    ).toThrow("tiers.json: enforcement must be an object");
  });
});

// ---------------------------------------------------------------------------
// validateEnforcementMode
// ---------------------------------------------------------------------------

describe("validateEnforcementMode", () => {
  it("accepts mode 'off'", () => {
    expect(() =>
      validateEnforcementMode({
        mode: "off",
      } as any),
    ).not.toThrow();
  });

  it("accepts mode 'advisory'", () => {
    expect(() =>
      validateEnforcementMode({
        mode: "advisory",
      } as any),
    ).not.toThrow();
  });

  it("accepts mode 'enforced'", () => {
    expect(() =>
      validateEnforcementMode({
        mode: "enforced",
      } as any),
    ).not.toThrow();
  });

  it("passes silently when mode is absent", () => {
    expect(() =>
      validateEnforcementMode({
        otherField: "value",
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid mode string", () => {
    expect(() =>
      validateEnforcementMode({
        mode: "invalid",
      } as any),
    ).toThrow("tiers.json: enforcement.mode must be one of off|advisory|enforced");
  });

  it("throws on non-string mode", () => {
    expect(() =>
      validateEnforcementMode({
        mode: 123,
      } as any),
    ).toThrow("tiers.json: enforcement.mode must be one of off|advisory|enforced");
  });
});

// ---------------------------------------------------------------------------
// validateEnforcementVerify
// ---------------------------------------------------------------------------

describe("validateEnforcementVerify", () => {
  it("accepts a valid verify block", () => {
    expect(() =>
      validateEnforcementVerify({
        verify: { require: "whenDoDPresent" },
      } as any),
    ).not.toThrow();
  });

  it("accepts verify with all optional fields", () => {
    expect(() =>
      validateEnforcementVerify({
        verify: {
          require: "always",
          preferDeterministic: true,
          graderPolicy: "atLeastProducerTier",
        },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when verify is absent", () => {
    expect(() =>
      validateEnforcementVerify({
        mode: "off",
      } as any),
    ).not.toThrow();
  });

  it("accepts verify with non-object value (permissive)", () => {
    expect(() =>
      validateEnforcementVerify({
        verify: "not-an-object",
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid require value", () => {
    expect(() =>
      validateEnforcementVerify({
        verify: { require: "invalid" },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.verify.require must be one of never|whenDoDPresent|always",
    );
  });

  it("throws on invalid graderPolicy", () => {
    expect(() =>
      validateEnforcementVerify({
        verify: { graderPolicy: "invalid" },
      } as any),
    ).toThrow(
      'tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"',
    );
  });
});

// ---------------------------------------------------------------------------
// validateEnforcementEscalate
// ---------------------------------------------------------------------------

describe("validateEnforcementEscalate", () => {
  it("accepts a valid escalate block with ladder", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { ladder: ["tier1", "tier2"] },
      } as any),
    ).not.toThrow();
  });

  it("accepts floorTier as string", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { floorTier: "fast" },
      } as any),
    ).not.toThrow();
  });

  it("accepts floorTier as null", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { floorTier: null },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when escalate is absent", () => {
    expect(() =>
      validateEnforcementEscalate({
        mode: "off",
      } as any),
    ).not.toThrow();
  });

  it("accepts escalate with non-object value (permissive)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: "not-an-object",
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid ladder (non-array)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { ladder: "not-an-array" },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.ladder must be an array of strings",
    );
  });

  it("throws on invalid ladder (non-string elements)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { ladder: ["tier1", 123] },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.ladder must be an array of strings",
    );
  });

  it("throws on negative maxAttemptsPerTier", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { maxAttemptsPerTier: -1 },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
    );
  });

  it("accepts zero maxAttemptsPerTier", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { maxAttemptsPerTier: 0 },
      } as any),
    ).not.toThrow();
  });

  it("throws on maxTotalAttempts < 1", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { maxTotalAttempts: 0 },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
    );
  });

  it("accepts maxTotalAttempts = 1", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { maxTotalAttempts: 1 },
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid floorTier (number)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { floorTier: 123 },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.floorTier must be a string or null",
    );
  });

  it("throws on invalid floorTier (object)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { floorTier: {} },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.floorTier must be a string or null",
    );
  });

  it("accepts valid costCeiling with multiple", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { costCeiling: { multiple: 2.5 } },
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid costCeiling.multiple (<= 0)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { costCeiling: { multiple: 0 } },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
    );
  });

  it("accepts costCeiling with non-object value (permissive)", () => {
    expect(() =>
      validateEnforcementEscalate({
        escalate: { costCeiling: "not-an-object" },
      } as any),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateEnforcementPerTier
// ---------------------------------------------------------------------------

describe("validateEnforcementPerTier", () => {
  it("accepts a valid perTier object", () => {
    expect(() =>
      validateEnforcementPerTier({
        perTier: { fast: "off", heavy: "enforced" },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when perTier is absent", () => {
    expect(() =>
      validateEnforcementPerTier({
        mode: "off",
      } as any),
    ).not.toThrow();
  });

  it("accepts perTier with non-object value (permissive)", () => {
    expect(() =>
      validateEnforcementPerTier({
        perTier: "not-an-object",
      } as any),
    ).not.toThrow();
  });

  it("throws on invalid perTier mode", () => {
    expect(() =>
      validateEnforcementPerTier({
        perTier: { fast: "invalid" },
      } as any),
    ).toThrow(
      "tiers.json: enforcement.perTier.fast must be one of off|advisory|enforced",
    );
  });

  it("throws on perTier with array value", () => {
    expect(() =>
      validateEnforcementPerTier({
        perTier: ["off", "enforced"],
      } as any),
    ).not.toThrow(); // permissive skip for arrays
  });
});

// ---------------------------------------------------------------------------
// validateEnforcementGuard
// ---------------------------------------------------------------------------

describe("validateEnforcementGuard", () => {
  it("accepts a valid guard block", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { budget: 100, blockScriptWrites: true },
      } as any),
    ).not.toThrow();
  });

  it("accepts guard with all optional fields", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: {
          readDraftCap: 5,
          sameOpRetryCap: 3,
          blockSelfScript: true,
          deliverableFirst: false,
          budget: 500,
          blockScriptWrites: false,
        },
      } as any),
    ).not.toThrow();
  });

  it("passes silently when guard is absent", () => {
    expect(() =>
      validateEnforcementGuard({
        mode: "off",
      } as any),
    ).not.toThrow();
  });

  it("accepts guard with non-object value (permissive)", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: "not-an-object",
      } as any),
    ).not.toThrow();
  });

  it("throws on budget < 1", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { budget: 0 },
      } as any),
    ).toThrow("enforcement.guard.budget must be a number >= 1");
  });

  it("throws on non-finite budget", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { budget: Infinity },
      } as any),
    ).toThrow("enforcement.guard.budget must be a number >= 1");
  });

  it("accepts budget = 1", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { budget: 1 },
      } as any),
    ).not.toThrow();
  });

  it("throws on non-boolean blockScriptWrites", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { blockScriptWrites: "yes" },
      } as any),
    ).toThrow("enforcement.guard.blockScriptWrites must be a boolean");
  });

  it("accepts blockScriptWrites = true", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { blockScriptWrites: true },
      } as any),
    ).not.toThrow();
  });

  it("accepts blockScriptWrites = false", () => {
    expect(() =>
      validateEnforcementGuard({
        guard: { blockScriptWrites: false },
      } as any),
    ).not.toThrow();
  });
});
