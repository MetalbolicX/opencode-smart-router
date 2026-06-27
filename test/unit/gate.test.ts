import { describe, expect, it } from "vitest";
import type { CheckerDeps } from "../../src/verify/checker";
import { createMutexRegistry } from "../../src/verify/deterministic";
import { normalizeDoD } from "../../src/verify/dod";
import type { Artefact, Delegation, GateDeps } from "../../src/verify/gate";
import { accept } from "../../src/verify/gate";
import type { DeterministicDeps } from "../../src/verify/types";

// --- fakes -----------------------------------------------------------------

const fakeDeterministicDeps = (
  opts: { code?: number; stdout?: string; fileExists?: boolean; throws?: boolean } = {},
): DeterministicDeps => {
  return {
    exec: async () => {
      if (opts.throws) throw new Error("boom");
      return { code: opts.code ?? 0, stdout: opts.stdout ?? "", stderr: "" };
    },
    fs: {
      fileExists: async () => {
        if (opts.throws) throw new Error("boom");
        return opts.fileExists ?? true;
      },
      readFile: async () => "{}",
    },
    cwd: "/ws",
    mutex: createMutexRegistry(),
  };
};

const fakeCheckerDeps = (
  opts: { pass?: boolean; graderSessionID?: string; throws?: boolean } = {},
): CheckerDeps => {
  return {
    dispatchGrader: async () => {
      if (opts.throws) throw new Error("grader down");
      return {
        sessionID: opts.graderSessionID ?? "grader-sess",
        text: JSON.stringify({
          pass: opts.pass ?? true,
          reasons: opts.pass ? [] : ["criterion not met"],
        }),
      };
    },
    ladder: ["fast", "medium", "heavy"],
  };
};

const artefact = (overrides: Partial<Artefact> = {}): Artefact => {
  return {
    changedFiles: [],
    finalReturnText: "done",
    declaredOutputs: [],
    producerSessionID: "producer-sess",
    producerTier: "fast",
    ...overrides,
  };
};

const detDoD = () =>
  normalizeDoD({
    kind: "deterministic",
    checks: [{ kind: "fileExists", path: "out.txt" }],
    criteria: [],
    deliverable: "out.txt",
    source: "explicit",
  });

const checkerDoD = () =>
  normalizeDoD({
    kind: "checker",
    checks: [],
    criteria: ["the feature works as described"],
    deliverable: null,
    source: "inferred",
  });

const noneDoD = () =>
  normalizeDoD({
    kind: "none",
    checks: [],
    criteria: [],
    deliverable: null,
    source: "none",
  });

const deps = (over: Partial<GateDeps> = {}): GateDeps => {
  return {
    deterministic: fakeDeterministicDeps(),
    checker: fakeCheckerDeps(),
    ...over,
  };
};

// --- tests -----------------------------------------------------------------

describe("accept() — gate policy", () => {
  it("1. require:'never' disables the gate (accepts without verifying)", async () => {
    const del: Delegation = { dod: detDoD() };
    const r = await accept(del, artefact(), deps({ require: "never" }));
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/disabled/i);
  });

  it("2. no checkable DoD + trivial => skip + accept (GA-6)", async () => {
    const del: Delegation = { dod: noneDoD(), trivial: true };
    const r = await accept(del, artefact(), deps());
    expect(r.accepted).toBe(true);
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/trivial/i);
  });

  it("2b. trivial + auto-inferred checkable DoD => skip + accept, grader NOT called (GA-6)", async () => {
    const dod = normalizeDoD({
      kind: "checker",
      checks: [],
      criteria: ["the result is correct"],
      deliverable: null,
      source: "inferred",
    });
    let graderCalls = 0;
    const d = deps();
    d.checker = {
      ...d.checker,
      dispatchGrader: async () => {
        graderCalls++;
        return { sessionID: "grader_sess", text: '{"pass":true,"reasons":[]}' };
      },
    };
    const r = await accept({ dod, trivial: true }, artefact(), d);
    expect(r.accepted).toBe(true);
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/trivial/i);
    expect(graderCalls).toBe(0);
  });

  it("2c. trivial + EXPLICIT checkable DoD => still verified (explicit overrides trivial)", async () => {
    const dod = normalizeDoD({
      kind: "checker",
      checks: [],
      criteria: ["the result is correct"],
      deliverable: null,
      source: "explicit",
    });
    const d = deps();
    d.checker = {
      ...d.checker,
      dispatchGrader: async () => ({
        sessionID: "grader_sess",
        text: '{"pass":false,"reasons":["nope"]}',
      }),
    };
    const r = await accept({ dod, trivial: true }, artefact(), d);
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
    expect(r.verdict.method).toBe("checker");
  });

  it("3. no checkable DoD + non-trivial + Mode A => not accepted (forcing)", async () => {
    const del: Delegation = { dod: noneDoD(), mode: "modeA" };
    const r = await accept(del, artefact(), deps());
    expect(r.accepted).toBe(false);
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.reasons[0]).toMatch(/Mode A/);
  });

  it("4. no checkable DoD + non-trivial + Mode B => strict error", async () => {
    const del: Delegation = { dod: noneDoD(), mode: "modeB" };
    const r = await accept(del, artefact(), deps());
    expect(r.accepted).toBe(false);
    expect(r.verdict.reasons[0]).toMatch(/Mode B/);
  });
});

describe("accept() — deterministic path", () => {
  it("5. all checks pass => accepted", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ fileExists: true }) }),
    );
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("deterministic");
    expect(r.verdict.pass).toBe(true);
  });

  it("6. a failing check => not accepted", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ fileExists: false }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.pass).toBe(false);
  });

  it("11. fail-closed: a throwing seam yields not-accepted (never throws out)", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ throws: true }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.pass).toBe(false);
  });
});

describe("accept() — checker path", () => {
  it("7. grader PASS => accepted", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ pass: true }) }),
    );
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("checker");
  });

  it("8. grader FAIL => not accepted", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ pass: false }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.method).toBe("checker");
  });

  it("9. GA-3: a lying 'DONE' is rejected by the independent grader", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact({ finalReturnText: "DONE: fully implemented and tested" }),
      deps({ checker: fakeCheckerDeps({ pass: false }) }),
    );
    expect(r.accepted).toBe(false);
  });

  it("10. independence enforced: grader sharing the producer session FAILs", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact({ producerSessionID: "producer-sess" }),
      deps({ checker: fakeCheckerDeps({ graderSessionID: "producer-sess" }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.reasons.join(" ")).toMatch(/independent/i);
  });

  it("12. fail-closed: a throwing grader dispatch => not accepted", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ throws: true }) }),
    );
    expect(r.accepted).toBe(false);
  });
});

describe("accept() — bookkeeping", () => {
  it("13. dodSource is mirrored from the DoD", async () => {
    const det = await accept({ dod: detDoD() }, artefact(), deps());
    expect(det.dodSource).toBe("explicit");
    const chk = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ pass: true }) }),
    );
    expect(chk.dodSource).toBe("inferred");
  });

  it("14. omitted require behaves like 'whenDoDPresent'", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ fileExists: true }) }),
    );
    expect(r.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 matrix — `verify.require` values.
//
// Supported values keep their existing semantics. Unknown / empty / null /
// non-string values fail closed: coerced to "always" so a typo can never
// silently downgrade the gate from "verify always" to "verify sometimes".
// ---------------------------------------------------------------------------

describe("accept() — Phase 5: verify.require matrix", () => {
  async function runRequire(req: unknown, detDeps?: DeterministicDeps) {
    return accept(
      { dod: detDoD() },
      artefact(),
      deps({
        require: req as never,
        ...(detDeps ? { deterministic: detDeps } : {}),
      }),
    );
  }

  it("require:'never' => accepted, method:none, skipped:true (gate disabled)", async () => {
    const r = await runRequire("never");
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/disabled/i);
  });

  it("require:'whenDoDPresent' + checkable DoD => verifies (default)", async () => {
    const r = await runRequire("whenDoDPresent", fakeDeterministicDeps({ fileExists: true }));
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("deterministic");
    expect(r.verdict.skipped).toBeFalsy();
  });

  it("require:'always' + checkable DoD => verifies, no skip", async () => {
    const r = await runRequire("always", fakeDeterministicDeps({ fileExists: true }));
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("deterministic");
    expect(r.verdict.skipped).toBeFalsy();
  });

  it("require: undefined => defaults to 'whenDoDPresent'", async () => {
    const r = await runRequire(undefined, fakeDeterministicDeps({ fileExists: true }));
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("deterministic");
  });

  // Phase 5: fail-closed coercion
  it("require: 'sometimes' (unknown) => coerced to 'always' (fail closed)", async () => {
    // 'always' means verify — so a DoD that fails the check must produce
    // accepted:false, not the 'never'-style accept-with-skip.
    const r = await runRequire("sometimes", fakeDeterministicDeps({ fileExists: false }));
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
    expect(r.verdict.method).toBe("deterministic");
  });

  it("require: '' (empty) => coerced to 'always' (fail closed)", async () => {
    const r = await runRequire("", fakeDeterministicDeps({ fileExists: false }));
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
  });

  it("require: null => coerced to 'always' (fail closed)", async () => {
    const r = await runRequire(null, fakeDeterministicDeps({ fileExists: false }));
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
  });

  it("require: 42 (non-string) => coerced to 'always' (fail closed)", async () => {
    const r = await runRequire(42, fakeDeterministicDeps({ fileExists: false }));
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
  });

  it("require: 'NEVER' (case-sensitive) => coerced to 'always' (fail closed)", async () => {
    // Phase 5: the coercion is type-strict, not case-insensitive. An
    // uppercased "NEVER" is unknown, so it fails closed to "always".
    const r = await runRequire("NEVER", fakeDeterministicDeps({ fileExists: false }));
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
  });

  it("require: 'never' (the only escape hatch) still skips", async () => {
    // Even on a failing check, 'never' must still skip — the value is in
    // the allowed set, so the gate's disable branch runs as before.
    const r = await runRequire("never", fakeDeterministicDeps({ fileExists: false }));
    expect(r.accepted).toBe(true);
    expect(r.verdict.skipped).toBe(true);
  });
});
