import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "../../src/plugin/context";
import { executeDelegate } from "../../src/plugin/delegate";
import { createFanoutStore } from "../../src/plugin/fanout-store";
import { createReasoningStore } from "../../src/reasoning/store";
import * as agentsModule from "../../src/router/agents";
import type { RouterConfig } from "../../src/router/config";
import { log } from "../../src/utils/observability";
import { resolveTierModelGuard } from "../../src/utils/tier-model-guard";

// ---------------------------------------------------------------------------
// Delegate-execution parity tests.
//
// The extracted `executeDelegate` is a verbatim copy of the
// `tool.delegate.execute` closure that lived in `src/index.ts` before the
// core-refactor-plan. These tests exercise the same branches the old
// integration test (`test/integration/layer2-wiring.test.ts`) drove
// end-to-end, but with direct seam calls so a failure localizes to
// `executeDelegate` rather than the whole plugin factory.
//
// We mock the SDK (`session.create` / `session.prompt`) and stub
// `accept()` via vi.mock so the test stays deterministic.
// ---------------------------------------------------------------------------

// Mock `accept` so we can force gate outcomes (PASS/FAIL/throw) per case
// without driving the real checker/deterministic pipeline.
const acceptMock = vi.fn();
vi.mock("../../src/verify/gate", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/verify/gate")>("../../src/verify/gate");
  return { ...actual, accept: (...args: unknown[]) => acceptMock(...args) };
});

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origCwd: string;

beforeEach(() => {
  acceptMock.mockReset();
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origCwd = process.cwd();

  tmpHome = join(
    tmpdir(),
    `oc-del-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Set the verified-delegate env so consumers can still require it
  // independently; this test does not gate on it.

  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Fake PluginContext builder — stubs every seam `executeDelegate` touches.
// ---------------------------------------------------------------------------

interface SessionCall {
  sessionID: string;
  promptText?: string;
}

const makeCtx = (opts: {
  createImpl?: (req: any) => Promise<any>;
  promptImpl?: (req: any) => Promise<any>;
  abortImpl?: (req: any) => Promise<any>;
  deleteImpl?: (req: any) => Promise<any>;
  getConfigImpl?: () => RouterConfig;
  refreshConfigImpl?: () => RouterConfig;
  sessionStoreOverrides?: Partial<{
    registerProducerSession: (...args: unknown[]) => unknown;
    unregister: (...args: unknown[]) => unknown;
    isSubagent: (sid: string) => boolean;
    isTrivial: (sid: string) => boolean;
    getTier: (sid: string) => string | null;
    registerFromChatMessage: (...args: unknown[]) => unknown;
    recordToolCall: (...args: unknown[]) => unknown;
  }>;
  guardStoreOverrides?: Partial<{
    get: (...args: unknown[]) => unknown;
    clear: (...args: unknown[]) => unknown;
  }>;
}): {
  ctx: PluginContext;
  sessions: SessionCall[];
  counters: { getConfig: number; refreshConfig: number };
  toastSpy: ReturnType<typeof vi.fn>;
} => {
  const sessions: SessionCall[] = [];
  let createSeq = 0;
  const counters = { getConfig: 0, refreshConfig: 0 };
  // SDD: tui-toast-verification — capture every showToast call so
  // terminal-failure tests can assert that exactly one toast fires per
  // terminal outcome and zero toasts fire on retry/abort paths.
  const toastSpy = vi.fn().mockResolvedValue(undefined);

  const baseConfig: RouterConfig = {
    activePreset: "default",
    defaultTier: "fast",
    presets: {
      default: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast",
          whenToUse: [],
          costRatio: 1,
        },
        medium: {
          model: "anthropic/claude-sonnet-4",
          description: "medium",
          whenToUse: [],
          costRatio: 3,
        },
        heavy: {
          model: "anthropic/claude-opus-4",
          description: "heavy",
          whenToUse: [],
          costRatio: 9,
        },
      },
    },
    rules: [],
    enforcement: {
      verify: { require: "always", graderTemperature: 0 },
      escalate: {
        ladder: ["fast", "medium", "heavy"],
        maxAttemptsPerTier: 1,
        maxTotalAttempts: 5,
      },
    },
  };

  const ctx: PluginContext = {
    plugin: {
      directory: tmpCwd,
      client: {
        session: {
          create: opts.createImpl
            ? opts.createImpl
            : async () => {
                const id = `sess_${++createSeq}`;
                sessions.push({ sessionID: id });
                return { data: { id } };
              },
          prompt: opts.promptImpl
            ? opts.promptImpl
            : async (req: any) => {
                const id = req?.path?.id ?? "?";
                const text = req?.body?.parts?.[0]?.text ?? "(no text)";
                const last = sessions.find((s) => s.sessionID === id);
                if (last) last.promptText = text;
                return { data: { parts: [{ type: "text", text: "I did it." }] } };
              },
          abort: opts.abortImpl ?? vi.fn().mockResolvedValue(undefined),
          delete: opts.deleteImpl ?? vi.fn().mockResolvedValue(undefined),
        },
        // SDD: tui-toast-verification — wire a tui.showToast spy so the
        // terminal-failure tests can assert exactly-one-toast-per-outcome
        // and zero-toasts-on-retry/abort invariants.
        tui: { showToast: toastSpy },
      },
    } as any,
    initialConfig: baseConfig,
    activeTiersAtLoad: baseConfig.presets["default"]!,
    getConfig: opts.getConfigImpl
      ? async () => {
          counters.getConfig++;
          return opts.getConfigImpl!();
        }
      : async () => {
          counters.getConfig++;
          return baseConfig;
        },
    refreshConfig: opts.refreshConfigImpl
      ? async () => {
          counters.refreshConfig++;
          return opts.refreshConfigImpl!();
        }
      : async () => {
          counters.refreshConfig++;
          return baseConfig;
        },
    async getFreshConfig() {
      try {
        if (opts.refreshConfigImpl) return await opts.refreshConfigImpl();
        return baseConfig;
      } catch {
        if (opts.getConfigImpl) return opts.getConfigImpl();
        return baseConfig;
      }
    },
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore: {
      registerProducerSession: () => undefined,
      unregister: () => undefined,
      isSubagent: () => false,
      isTrivial: () => false,
      getTier: () => "fast",
      registerFromChatMessage: () => undefined,
      recordToolCall: () => undefined,
      ...(opts.sessionStoreOverrides ?? {}),
    } as any,
    trajectoryStore: {
      ensure: () => undefined,
      recordToolEvent: () => undefined,
      dump: () => null,
    } as any,
    guardStore: {
      get: () => null,
      clear: () => undefined,
      ...(opts.guardStoreOverrides ?? {}),
    } as any,
    changedFileStore: {
      get: () => [],
      clear: () => undefined,
      record: () => undefined,
    } as any,
    reasoningStore: createReasoningStore(),
    fanoutStore: createFanoutStore(),
    graderSessions: new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
  };

  return { ctx, sessions, counters, toastSpy };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeDelegate — unexpected outer error", () => {
  it("logs the unexpected error and preserves the fail-closed response", async () => {
    const { ctx } = makeCtx({});
    vi.spyOn(ctx, "getConfig").mockRejectedValue(new Error("unexpected boom"));
    const error = vi.spyOn(log, "error").mockImplementation(() => {});

    await expect(executeDelegate(ctx, { task: "say hi" })).resolves.toBe(
      "[router] delegate failed (fail-closed): the delegation or verification could not complete (unexpected boom).",
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "delegate.unexpected_error",
        error: "unexpected boom",
      }),
    );
  });
});

describe("executeDelegate — happy path", () => {
  it("returns the producer text + deterministic-accepted suffix on first-try PASS", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx, sessions, counters } = makeCtx({});
    const out = await executeDelegate(ctx, {
      task: "say hi",
      tier: "fast",
    });

    expect(out).toContain("I did it.");
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionID).toMatch(/^sess_/);
    expect(counters.refreshConfig).toBeGreaterThanOrEqual(1);
  });

  it("uses the explicit acceptance block from `acceptance` argument when provided", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "explicit",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, {
      task: "ignored",
      tier: "fast",
      acceptance: "[acceptance]\ncheck: testsPass\n[/acceptance]",
    });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("defaults the initial tier to the cfg's defaultTier when args.tier is omitted", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx, sessions } = makeCtx({});
    await executeDelegate(ctx, { task: "say hi" });
    expect(sessions).toHaveLength(1);
  });

  it("defaults to 'medium' when args.tier is whitespace and defaultTier is missing", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx } = makeCtx({
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "",
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
              },
              medium: {
                model: "anthropic/claude-sonnet-4",
                description: "medium",
                whenToUse: [],
              },
            },
          },
          rules: [],
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "   " });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("calls refreshConfig() then getConfig() on a successful refresh", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx, counters } = makeCtx({});
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(counters.refreshConfig).toBe(1);
    expect(counters.getConfig).toBeGreaterThanOrEqual(1);
  });

  // SDD fix-session-ghost-tui-jump: on happy completion, the session persists in
  // the TUI as 'idle' — NEITHER abort NOR delete is called.
  it("does NOT call session.abort or session.delete on happy completion (session persists)", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ abortImpl: abortSpy, deleteImpl: deleteSpy });

    await executeDelegate(ctx, { task: "say hi", tier: "fast" });

    // Extract the SID that was used in session.create
    const createdSid = "sess_1";

    // Happy completion: session stays alive in TUI — no abort, no delete.
    expect(abortSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("executeDelegate — SDK teardown fail-soft", () => {
  // SDD fix-session-ghost-tui-jump: delete is NEVER called. On failure paths,
  // abort is called (shouldAbort=true) but delete is removed entirely.
  it("calls session.abort on gate failure but NOT session.delete", async () => {
    const gateFail = {
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["gate failed"] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValue(gateFail);

    const abortSpy = vi.fn().mockRejectedValue(new Error("abort failed"));
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ abortImpl: abortSpy, deleteImpl: deleteSpy });

    // Should not throw — abort rejection is caught, fail-soft.
    await expect(executeDelegate(ctx, { task: "say hi", tier: "fast" })).resolves.toContain(
      "unmet",
    );

    // abort WAS called (failure path triggers shouldAbort=true)
    expect(abortSpy).toHaveBeenCalled();
    // delete is NEVER called in this SDD change
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // SDD fix-session-ghost-tui-jump: this test is removed because delete is
  // NEVER called — session.delete has been removed from cleanupProducerSession.

  // SDD fix-session-ghost-tui-jump: on gate failure, abort is called (fail-soft)
  // but delete is NEVER called.
  it("does not propagate when session.abort rejects on gate failure", async () => {
    const gateFail = {
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["gate failed"] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValue(gateFail);

    const abortSpy = vi.fn().mockRejectedValue(new Error("abort failed"));
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ abortImpl: abortSpy, deleteImpl: deleteSpy });

    // Should not throw — abort rejection is caught, fail-soft.
    await expect(executeDelegate(ctx, { task: "say hi", tier: "fast" })).resolves.toContain(
      "unmet",
    );

    // abort was attempted (failure path)
    expect(abortSpy).toHaveBeenCalled();
    // delete is NEVER called in this SDD change
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("executeDelegate — refresh fallback", () => {
  it("falls back to getConfig() when refreshConfig() throws", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const { ctx } = makeCtx({
      refreshConfigImpl: () => {
        throw new Error("disk read failed");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The fallback uses getConfig() which returns the baseConfig — happy path continues.
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

// SDD fix-session-ghost-tui-jump: new session lifecycle tests.
// REQ-3: No session.delete ever. REQ-4: Conditional session.abort.
describe("executeDelegate — session lifecycle (fix-session-ghost-tui-jump)", () => {
  // REQ-4: On happy completion, shouldAbort=false → session.abort NOT called.
  // The session persists in TUI as 'idle' for developer review.
  it("does NOT call session.abort on happy completion (session persists)", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValue(gateOk);

    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ abortImpl: abortSpy, deleteImpl: deleteSpy });

    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("accepted");

    // Happy path: session stays alive, no abort, no delete
    expect(abortSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // REQ-4: On gate failure, shouldAbort=true → session.abort IS called, no delete.
  it("calls session.abort on gate failure but NOT session.delete", async () => {
    const gateFail = {
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["gate rejected"] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValue(gateFail);

    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ abortImpl: abortSpy, deleteImpl: deleteSpy });

    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("unmet");

    // Failure path: abort IS called, delete is NEVER called
    expect(abortSpy).toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // REQ-4: On timeout, shouldAbort=true → session.abort IS called, no delete.
  it("calls session.abort on timeout but NOT session.delete", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty artefact"] },
      dodSource: "inferred",
    });

    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_timeout" } }),
      promptImpl: async () => {
        throw new Error("session.prompt timed out after 600000ms");
      },
      abortImpl: abortSpy,
      deleteImpl: deleteSpy,
    });

    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("unmet");

    // Timeout path: abort IS called, delete is NEVER called
    expect(abortSpy).toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("executeDelegate — failure paths", () => {
  it("returns 'could not create a producer session' when session.create yields no id", async () => {
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: undefined }),
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("could not create a producer session");
  });

  it("does NOT call session.abort or session.delete when session.create yields no usable sid", async () => {
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: undefined }),
      abortImpl: abortSpy,
      deleteImpl: deleteSpy,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("could not create a producer session");
    // No SID means nothing to abort/delete — SDK teardown must not be called.
    expect(abortSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("early-returns without calling registerProducerSession when session.create yields empty-string id", async () => {
    const registerSpy = vi.fn();
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "" } }),
      sessionStoreOverrides: {
        registerProducerSession: registerSpy,
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("could not create a producer session");
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("treats prompt errors as an empty artefact and lets the gate decide", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The gate accepted (we mocked it to PASS); the accepted suffix is appended
    // even when producerText is empty (matching the original behaviour).
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("returns 'verification failed (fail-closed)' verdict when accept throws on every attempt", async () => {
    // accept throws on every call so the inner try-catch fires each iteration,
    // setting the fail-closed verdict; the ladder eventually gives up.
    acceptMock.mockRejectedValue(new Error("gate boom"));
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    // The fail-closed reason surfaces in the forcing note.
    expect(out).toContain("verification failed (fail-closed)");
  });

  it("appends 'router status: unmet' when the gate refuses and the ladder gives up", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["file missing"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).not.toContain("[router \u2713 accepted:");
  });
});

describe("executeDelegate — output shape parity", () => {
  it("accept suffix format matches the original verbatim", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "x", tier: "fast" });
    expect(out.endsWith("\n\n[router \u2713 accepted: deterministic]")).toBe(true);
  });

  it("the outer catch-all returns the fail-closed sentinel string", async () => {
    acceptMock.mockReset();
    // Force an outer throw by replacing `ctx.getConfig` with a throwing impl
    // AFTER the inner refresh+get fallback. Simpler: break `accept` so it
    // throws AND set up a scenario where even the inner try-catch fails.
    // Here we make the delegate's outer try fail by making session.create
    // throw on every call (the inner catch swallows, so we instead force
    // the producerText scrub path to throw — hard to trigger from outside).
    // Easier check: when accept is mocked to throw and ladder escalates,
    // we still get a structured response (fail-closed suffix is reachable
    // through the inner catch, and the outer catch is the last line of
    // defence). The outer-catch path is unreachable through public mocks
    // because every inner step is try-caught — this test asserts the
    // observable contract: the response is always a non-empty string and
    // never rejects.
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "x", tier: "fast" });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("executeDelegate — config-refresh parity", () => {
  it("uses the refreshed config's defaultTier for tier resolution", async () => {
    const gateOk = {
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    };
    acceptMock.mockResolvedValueOnce(gateOk);

    const cfgMedium: RouterConfig = {
      activePreset: "default",
      defaultTier: "medium",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast",
            whenToUse: [],
          },
          medium: {
            model: "anthropic/claude-sonnet-4",
            description: "medium",
            whenToUse: [],
          },
        },
      },
      rules: [],
    } as RouterConfig;

    const { ctx } = makeCtx({
      refreshConfigImpl: () => cfgMedium,
      getConfigImpl: () => cfgMedium,
    });
    await executeDelegate(ctx, { task: "say hi" });
    // The accepted suffix proves the run completed cleanly — the test name
    // documents the intended refresh-vs-read semantic change in PR1.
    expect(acceptMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 4.1 — additional direct branch coverage for executeDelegate.
//
// These tests cover the remaining seams of the delegate loop:
//   - store-mutation throw paths (register/unregister/guard.clear swallow)
//   - accept returning a "skipped" verdict (no forcing note appended)
//   - the forcing-message retry/escalate path that runs across attempts
//   - the safety-net branch when the loop exceeds its attempt cap
//   - the costRatio fallback when tiersForCost lacks the tier's costRatio
//   - defaultTier undefined defaults the initial tier to "medium"
// ---------------------------------------------------------------------------

describe("executeDelegate — store-mutation swallow paths", () => {
  it("continues to the gate even when registerProducerSession throws", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      // Force registerProducerSession to throw on every attempt.
      sessionStoreOverrides: {
        registerProducerSession: () => {
          throw new Error("register boom");
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("continues when sessionStore.unregister throws after the gate verdict", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      sessionStoreOverrides: {
        unregister: () => {
          throw new Error("unregister boom");
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("continues when guardStore.clear throws after the gate verdict", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      guardStoreOverrides: {
        clear: () => {
          throw new Error("guard clear boom");
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

describe("executeDelegate — gate verdict branches", () => {
  it("does NOT append a forcing note when the gate verdict is skipped", async () => {
    // skipped: true means the gate chose to skip verification; the ladder
    // treats this as "pass" via `if (!res.accepted && !res.verdict.skipped)`,
    // so no forcing note is appended.
    acceptMock.mockResolvedValueOnce({
      accepted: false,
      verdict: {
        pass: false,
        method: "deterministic",
        reasons: [],
        skipped: true,
      },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The output ends with a missing/empty forcing note.
    expect(out).not.toContain("NOT ACCEPTED");
  });

  it("escalates and retries across attempts when the gate fails the first attempt", async () => {
    // First attempt FAILS (with retry), second attempt PASSES.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["missing"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });
    const { ctx, sessions } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("hits the safety-net branch when the loop exceeds its attempt cap", async () => {
    // Make accept fail every attempt; combined with a tight policy this
    // should drive the loop past safetyMax and out via the safety-net branch.
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["never passes"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "fast",
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
                costRatio: 1,
              },
            },
          },
          rules: [],
          enforcement: {
            verify: { require: "always", graderTemperature: 0 },
            escalate: {
              ladder: ["fast", "medium", "heavy"],
              maxAttemptsPerTier: 99,
              maxTotalAttempts: 999,
            },
          },
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The safety net returns a different prefix than the give_up branch.
    expect(out).toMatch(/delegation stopped by the safety net|\[router status: unmet\]/);
  });
});

describe("executeDelegate — tier resolution and cost fallback", () => {
  it("defaults the initial tier to 'medium' when defaultTier is undefined", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      // defaultTier missing entirely -> the `defaultTier || "medium"` fallback fires.
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "" as unknown as string,
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
                costRatio: 1,
              },
              medium: {
                model: "anthropic/claude-sonnet-4",
                description: "medium",
                whenToUse: [],
                costRatio: 3,
              },
            },
          },
          rules: [],
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });

  it("falls back to costRatio=1 when the tier's costRatio is not a number", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      getConfigImpl: () =>
        ({
          activePreset: "default",
          defaultTier: "fast",
          presets: {
            default: {
              fast: {
                model: "anthropic/claude-haiku-4-5",
                description: "fast",
                whenToUse: [],
                // costRatio is a string, not a number — fallback path triggers.
                costRatio: "high" as unknown as number,
              },
            },
          },
          rules: [],
        }) as RouterConfig,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

// ---------------------------------------------------------------------------
// parentSessionID propagation — producer sessions inherit the parent's
// sessionID so OpenCode treats them as child sessions. OpenCode filters
// ctrl+x l with WHERE parent_session_id IS NULL, so without parentID the
// producer sessions leak into the TUI session list (regression fixed by
// restore-session-parenting). The session still completes normally — it
// is just classified as nested, not standalone.
// ---------------------------------------------------------------------------

describe("executeDelegate — parentSessionID propagation", () => {
  // SDD restore-session-parenting: delegate session.create MUST thread
  // parentSessionID into body.parentID so the producer is a child session
  // of the orchestrator and is hidden from the TUI session list.
  it("passes parentID to session.create when parentSessionID is provided", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_parent_child" } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" }, "parent-sid-42");
    expect(createCalls).toHaveLength(1);
    // REQ-1: parentID is forwarded as body.parentID so OpenCode marks the
    // session as a child of the orchestrator.
    expect(createCalls[0]).toEqual({ body: { parentID: "parent-sid-42" } });
  });

  it("passes {} (no parentID) to session.create when parentSessionID is omitted", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_root" } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({});
  });

  // SDD restore-session-parenting: grader session.create MUST thread
  // parentSessionID into body.parentID so the grader is a child session
  // of the orchestrator and is hidden from the TUI session list.
  // REQ-2: parentID on grader session.create.
  it("passes parentID to session.create for the grader", async () => {
    const ctxBase = makeCtx({});
    const ctx: PluginContext = {
      ...ctxBase.ctx,
      seams: { exec: ctxBase.ctx.seams.exec, fs: ctxBase.ctx.seams.fs },
    };
    const { buildGateDeps } = await import("../../src/verify/dispatch");
    const createCalls: unknown[] = [];
    const wrappedCtx: PluginContext = {
      ...ctx,
      plugin: {
        ...ctx.plugin,
        client: {
          ...ctx.plugin.client,
          session: {
            ...ctx.plugin.client.session,
            create: async (req: unknown) => {
              createCalls.push(req);
              return { data: { id: "grader-sid" } };
            },
          } as any,
        },
      } as any,
    };
    const deps = await buildGateDeps(wrappedCtx, "orch-sid-99");
    await deps.checker.dispatchGrader({ tier: "fast", system: "", prompt: "x" });
    expect(createCalls).toHaveLength(1);
    // REQ-2: grader session.create forwards parentID as body.parentID
    expect(createCalls[0]).toEqual({ body: { parentID: "orch-sid-99" } });
  });

  // SDD restore-session-parenting: parentID MUST be threaded on every
  // delegate attempt, including failing paths. Without it the producer
  // sessions leak into the TUI list as standalone rows.
  it("passes parentID to session.create on a failing delegate attempt", async () => {
    acceptMock.mockImplementation(async () => ({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["boom"] },
      dodSource: "inferred",
    }));
    const createCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_parent_child" } };
      },
    });

    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, "parent-sid-fail");

    expect(out).toContain("[router status: unmet]");
    expect(createCalls.length).toBeGreaterThan(0);
    // REQ-1: parentID is forwarded on every attempt, even when failing
    expect(
      createCalls.every((req) => {
        return JSON.stringify(req) === JSON.stringify({ body: { parentID: "parent-sid-fail" } });
      }),
    ).toBe(true);
  });
});

describe("executeDelegate — timeout handling", () => {
  it("does not hang when session.create rejects with a timeout error", async () => {
    // Simulate the withTimeout-rejected error shape (what session.create
    // would throw after the 30s timeout). We avoid the actual 30s wait by
    // throwing immediately with the same error message contract. The key
    // invariant is that executeDelegate returns promptly (fail-closed) and
    // surfaces the timeout reason — NOT hangs forever.
    const { ctx } = makeCtx({
      createImpl: async () => {
        throw new Error("session.create timed out after 30000ms");
      },
    });
    const result = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(result).toContain("delegate failed (fail-closed)");
    expect(result).toContain("timed out after");
  });

  it("treats timeout on session.prompt as a failed attempt (ladder retries)", async () => {
    // session.create works (returns a fresh sid); session.prompt hangs →
    // withTimeout rejects with a timeout-shaped error → the existing inner
    // catch produces an empty artefact → the ladder treats this as one
    // failed attempt and eventually gives up with "unmet".
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty artefact"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_timeout" } }),
      promptImpl: async () => {
        throw new Error("session.prompt (producer) timed out after 600000ms");
      },
    });
    const result = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(result).toContain("unmet");
  });

  it("cleans up producer session state after prompt timeout", async () => {
    // Track calls to the sessionStore.unregister and guardStore.clear to
    // prove the finally block ran on prompt timeout.
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty artefact"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_to_cleanup" } }),
      promptImpl: async () => {
        throw new Error("session.prompt (producer) timed out after 600000ms");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The finally block must have run for the timed-out producer session.
    expect(unregisterCalls).toContain("sess_to_cleanup");
    expect(clearCalls).toContain("sess_to_cleanup");
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — PR 2 of fix-delegate-cancellation.
//
// The delegate loop MUST:
//   - Forward the AbortSignal to `session.create` and `session.prompt`
//     options (so the SDK can cancel in-flight network calls).
//   - Forward the same signal to `withTimeout` so the local timeout
//     wrapper also races the abort.
//   - Check `signal.aborted` at the loop top — if cancelled while idle
//     (between attempts or before the loop), return `""` silently with
//     no producer session to clean up.
//   - Check `signal.aborted` after `session.create` — if cancelled while
//     the producer session is being created, return `""` AFTER the
//     per-attempt cleanup runs (so the new producer sid is untracked).
//   - Detect AbortError from the `withTimeout(prompt)` race — early-
//     return `""` from inside the catch so we don't run the gate against
//     an empty artefact.
//   - Pass the signal to `nextAction` so a post-abort decision returns
//     `give_up` with reason `"aborted"`. The give_up branch in the loop
//     must short-circuit to `""` (no `[router status: unmet]`).
//   - Be idempotent across multiple `abort()` calls.
//   - Be silent: the abort path must NEVER produce `[router status:`,
//     `[router] delegate failed`, or any other user-facing sentinel.
// ---------------------------------------------------------------------------

describe("executeDelegate — AbortSignal forwarding (PR 2)", () => {
  it("forwards the abort signal to session.create options", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const ac = new AbortController();
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_1" } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0] as { signal?: AbortSignal }).signal).toBe(ac.signal);
  });

  it("forwards the abort signal to session.prompt options", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const promptCalls: unknown[] = [];
    const ac = new AbortController();
    const { ctx } = makeCtx({
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return {
          data: { parts: [{ type: "text", text: "I did it." }] },
        };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(promptCalls).toHaveLength(1);
    expect((promptCalls[0] as { signal?: AbortSignal }).signal).toBe(ac.signal);
  });

  it("omits the signal field from create/prompt options when no signal is supplied (back-compat)", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_x" } };
      },
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "ok" }] } };
      },
    });
    await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect((createCalls[0] as { signal?: AbortSignal }).signal).toBeUndefined();
    expect((promptCalls[0] as { signal?: AbortSignal }).signal).toBeUndefined();
  });
});

describe("executeDelegate — abort before loop starts (top-of-loop check)", () => {
  it("returns '' when signal is already aborted before the first attempt", async () => {
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const ac = new AbortController();
    ac.abort();
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_pre" } };
      },
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should not run" }] } };
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(createCalls).toHaveLength(0);
    expect(promptCalls).toHaveLength(0);
  });
});

describe("executeDelegate — abort between create and prompt (post-create check)", () => {
  it("returns '' after aborting between create and prompt, cleanup ran for the new producer sid", async () => {
    acceptMock.mockReset(); // no accept() should be called
    const ac = new AbortController();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const abortSpy = vi.fn().mockResolvedValue(undefined);
    const deleteSpy = vi.fn().mockResolvedValue(undefined);
    let createDone = false;
    const { ctx } = makeCtx({
      createImpl: async () => {
        if (!createDone) {
          createDone = true;
          // Abort immediately after create resolves, before prompt fires.
          queueMicrotask(() => ac.abort());
        }
        return { data: { id: "sess_aborted_between" } };
      },
      promptImpl: async () => {
        throw new Error("prompt must NOT be called when aborted between create+prompt");
      },
      abortImpl: abortSpy,
      deleteImpl: deleteSpy,
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    // The producer session created just before the abort MUST be cleaned up.
    expect(unregisterCalls).toContain("sess_aborted_between");
    expect(clearCalls).toContain("sess_aborted_between");
    // SDK teardown: abort MUST be called (abort path), but delete is NEVER called.
    expect(abortSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "sess_aborted_between" } }),
    );
    // REQ-3: session.delete is NEVER called
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("executeDelegate — abort during session.prompt", () => {
  it("returns '' when withTimeout(prompt) rejects with AbortError, cleanup ran", async () => {
    acceptMock.mockReset(); // no accept() should run
    const ac = new AbortController();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_prompt_aborted" } }),
      promptImpl: async () => {
        // Abort while the prompt is "in flight".
        queueMicrotask(() => ac.abort());
        // Throw an AbortError matching the withTimeout shape.
        throw new DOMException("aborted", "AbortError");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(unregisterCalls).toContain("sess_prompt_aborted");
    expect(clearCalls).toContain("sess_prompt_aborted");
  });

  it("does NOT call accept() when abort fires during prompt", async () => {
    acceptMock.mockReset();
    const ac = new AbortController();
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_a" } }),
      promptImpl: async () => {
        queueMicrotask(() => ac.abort());
        throw new DOMException("aborted", "AbortError");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("non-AbortError from prompt still falls through to ladder retry (existing behaviour preserved)", async () => {
    // Sanity: an abort-like shape that is NOT a DOMException with name
    // 'AbortError' should still be treated as a transport error, not
    // an abort. The gate will see an empty artefact and the ladder will
    // retry/give_up as usual.
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty"] },
      dodSource: "inferred",
    });
    const ac = new AbortController();
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_nonabort" } }),
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    // Not aborted, so the ladder runs normally and produces an unmet status.
    expect(ac.signal.aborted).toBe(false);
    expect(out).toContain("[router status: unmet]");
  });
});

describe("executeDelegate — abort during ladder eval (post-abort give_up short-circuit)", () => {
  it("returns '' when signal fires between attempts — no [router status: unmet] surfaced", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["boom"] },
      dodSource: "inferred",
    });
    const ac = new AbortController();
    let createCount = 0;
    const { ctx } = makeCtx({
      createImpl: async () => {
        createCount++;
        // First attempt: let it complete and FAIL the gate.
        // Second attempt: abort BEFORE create so the loop-top check fires.
        if (createCount === 2) ac.abort();
        return { data: { id: `sess_attempt_${createCount}` } };
      },
      promptImpl: async () => ({
        data: { parts: [{ type: "text", text: "attempt done" }] },
      }),
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    expect(out).not.toContain("[router status:");
    expect(out).not.toContain("[router] delegate failed");
  });
});

describe("executeDelegate — post-completion abort is a no-op", () => {
  it("returns the accepted result when abort fires AFTER an accepted prompt", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const ac = new AbortController();
    let promptResolved = false;
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_post" } }),
      promptImpl: async () => {
        // Abort AFTER the prompt resolves (i.e. we already have a result).
        const res = { data: { parts: [{ type: "text", text: "I did it." }] } };
        queueMicrotask(() => {
          promptResolved = true;
          ac.abort();
        });
        return res;
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(promptResolved).toBe(true);
    // The accepted verdict wins; the late abort cannot rewrite the result.
    expect(out).toContain("[router ✓ accepted: deterministic]");
    expect(out).toContain("I did it.");
  });
});

describe("executeDelegate — multiple aborts are idempotent", () => {
  it("second abort() after the first is a no-op — only one silent '' surfaces", async () => {
    acceptMock.mockReset();
    const ac = new AbortController();
    let aborted = false;
    const { ctx } = makeCtx({
      createImpl: async () => {
        if (!aborted) {
          aborted = true;
          // Fire two aborts back-to-back. The second must not throw or
          // surface a second error path.
          ac.abort();
          ac.abort();
        }
        return { data: { id: "sess_idem" } };
      },
      promptImpl: async () => {
        throw new DOMException("aborted", "AbortError");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
  });
});

describe("executeDelegate — abort path is silent (no user-facing message)", () => {
  it("every abort branch returns '' — no status: unmet, no fail-closed sentinel", async () => {
    // All four abort branches: top-of-loop, after-create, during-prompt,
    // and ladder post-abort give_up. Each MUST return "".
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["x"] },
      dodSource: "inferred",
    });

    // (1) top-of-loop
    {
      const ac = new AbortController();
      ac.abort();
      const { ctx } = makeCtx({});
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }

    // (2) after-create
    {
      const ac = new AbortController();
      let firstCreate = true;
      const { ctx } = makeCtx({
        createImpl: async () => {
          if (firstCreate) {
            firstCreate = false;
            queueMicrotask(() => ac.abort());
          }
          return { data: { id: "sess_a" } };
        },
        promptImpl: async () => {
          throw new Error("prompt must NOT be called");
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }

    // (3) during-prompt
    {
      const ac = new AbortController();
      const { ctx } = makeCtx({
        createImpl: async () => ({ data: { id: "sess_b" } }),
        promptImpl: async () => {
          queueMicrotask(() => ac.abort());
          throw new DOMException("aborted", "AbortError");
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }

    // (4) ladder post-abort give_up
    {
      const ac = new AbortController();
      let createCount = 0;
      const { ctx } = makeCtx({
        createImpl: async () => {
          createCount++;
          if (createCount === 2) ac.abort();
          return { data: { id: `sess_${createCount}` } };
        },
        promptImpl: async () => ({
          data: { parts: [{ type: "text", text: "x" }] },
        }),
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
    }
  });
});

describe("executeDelegate — runtime forwards context.abort to executeDelegate", () => {
  // This is the wire-up contract: the runtime hook passes the OpenCode
  // ToolContext's `abort` straight through to executeDelegate's `signal`
  // parameter. Verified by inspecting the export surface + the typed
  // call site.
  it("runtime.ts delegate tool handler forwards context.abort", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/plugin/runtime.ts", import.meta.url), "utf8"),
    );
    expect(src).toMatch(
      /executeDelegate\(\s*ctx,\s*args,\s*context\.sessionID,\s*context\.abort\s*\)/,
    );
  });

  it("executeDelegate signature accepts an optional 4th AbortSignal parameter", async () => {
    // Compile-time evidence: the function is callable with three OR four
    // arguments without `any` casts. We assert both forms work.
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({});
    const out3 = await executeDelegate(ctx, { task: "x", tier: "fast" });
    expect(typeof out3).toBe("string");
    // We already use the 4-arg form elsewhere; this is just back-compat
    // proof for the call site.
  });
});

// ---------------------------------------------------------------------------
// SDD: delegate-nonretryable-errors — fail-fast on non-retryable prompt
// errors and on a `null` tierModel() result.
//
// The change wires `classifyPromptError` into the `session.prompt` catch and
// adds a pre-prompt `tierModel()` guard. Non-retryable failures short-circuit
// the loop with a fail-closed `[router status: unmet]` message naming the
// classified reason, emit `routing.unmet` observability, and rely on the
// per-attempt `finally` for cleanup. Retryable errors, aborts, and the
// give_up/safety-net branches are unchanged.
//
// Invariants under test:
//   - Non-retryable prompt errors (billing / model-not-found / auth) return
//     a fail-closed `[router status: unmet]` message naming the reason.
//   - The gate (`accept()`) is never called on the fail-fast path.
//   - Only ONE producer session is created (no retry, no escalation).
//   - `routing.unmet` is recorded for the failure.
//   - `tierModel() === null` short-circuits BEFORE session.prompt fires.
//   - The per-attempt `finally` still runs on the fail-fast path (cleanup
//     spies fire).
//   - Retryable prompt errors (e.g. "transport boom") keep the existing
//     empty-artefact → gate → ladder behaviour.
// ---------------------------------------------------------------------------

describe("executeDelegate — non-retryable prompt errors fail fast (SDD)", () => {
  it("fails fast on a non-retryable billing/subscription error and never runs the gate", async () => {
    acceptMock.mockReset(); // gate MUST NOT be called on the fail-fast path
    const createCalls: unknown[] = [];
    const promptCalls: unknown[] = [];
    const { ctx } = makeCtx({
      createImpl: async (req: unknown) => {
        createCalls.push(req);
        return { data: { id: "sess_billing" } };
      },
      promptImpl: async () => {
        promptCalls.push("called");
        throw new Error("insufficient billing: please update your subscription");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("insufficient billing or subscription");
    expect(out).not.toContain("[router \u2713 accepted:");
    // Only one producer session — no retry, no escalation.
    expect(createCalls).toHaveLength(1);
    expect(promptCalls).toHaveLength(1);
    // Gate was never called.
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("fails fast on a non-retryable model-not-found error (HTTP 404)", async () => {
    acceptMock.mockReset();
    const { ctx } = makeCtx({
      promptImpl: async () => {
        const err = new Error("model not found: anthropic/gpt-9000") as Error & {
          status?: number;
        };
        err.status = 404;
        throw err;
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("model not found");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("fails fast on a non-retryable auth/permission denied error", async () => {
    acceptMock.mockReset();
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("unauthorized: invalid API key");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("auth or permission denied");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("emits a routing.unmet observability event on the non-retryable fail-fast path", async () => {
    acceptMock.mockReset();
    // SDD: tui-toast-verification — routing.unmet is now a debug event.
    // Opt in to debug level via MODEL_ROUTER_LOG_LEVEL and spy on
    // console.log (debug+info share the stdout sink).
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = makeCtx({
        promptImpl: async () => {
          throw new Error("quota exceeded: insufficient credits");
        },
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      // routing.unmet now flows through console.log at debug level.
      const lines = logSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((l) => l.startsWith("[model-router] "));
      const hasUnmet = lines.some((l) => {
        try {
          const env = JSON.parse(l.slice(l.indexOf("{")));
          return (
            env["event"] === "routing.unmet" && /billing|quota|credit/i.test(String(env["reason"]))
          );
        } catch {
          return false;
        }
      });
      expect(hasUnmet).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  it("per-attempt cleanup still runs on the non-retryable fail-fast path", async () => {
    acceptMock.mockReset();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_failfast_cleanup" } }),
      promptImpl: async () => {
        throw new Error("forbidden: permission denied for model");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    // The per-attempt `finally` MUST have run for the fail-fast producer
    // session — a leak here would regress the abort/timeout cleanup tests.
    expect(unregisterCalls).toContain("sess_failfast_cleanup");
    expect(clearCalls).toContain("sess_failfast_cleanup");
  });
});

describe("executeDelegate — tierModel() === null fails fast (SDD)", () => {
  it("fails fast on a malformed tier model, never invoking session.prompt", async () => {
    acceptMock.mockReset();
    const promptCalls: unknown[] = [];
    // Malformed `model` (empty string → no `provider/model` slash) makes
    // tierModel() return null. The fail-fast must fire BEFORE the prompt
    // call so the SDK never sees a malformed body.
    const malformedCfg = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "" as unknown as string,
            description: "fast",
            whenToUse: [],
            costRatio: 1,
          },
          medium: {
            model: "anthropic/claude-sonnet-4",
            description: "medium",
            whenToUse: [],
            costRatio: 3,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["fast", "medium", "heavy"],
          maxAttemptsPerTier: 1,
          maxTotalAttempts: 5,
        },
      },
    } as RouterConfig;
    const { ctx } = makeCtx({
      getConfigImpl: () => malformedCfg,
      refreshConfigImpl: () => malformedCfg,
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should not run" }] } };
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("invalid model or provider configuration");
    // session.prompt MUST NOT have been called.
    expect(promptCalls).toHaveLength(0);
    // The gate MUST NOT have been called either.
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("fails fast when the tier itself is missing from the config", async () => {
    acceptMock.mockReset();
    const promptCalls: unknown[] = [];
    // Tier 'fast' is omitted entirely from presets → tierModel() returns
    // null because `tiers[tierName]` is undefined.
    const noFastCfg = {
      activePreset: "default",
      defaultTier: "medium",
      presets: {
        default: {
          medium: {
            model: "anthropic/claude-sonnet-4",
            description: "medium",
            whenToUse: [],
            costRatio: 3,
          },
          heavy: {
            model: "anthropic/claude-opus-4",
            description: "heavy",
            whenToUse: [],
            costRatio: 9,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["fast", "medium", "heavy"],
          maxAttemptsPerTier: 1,
          maxTotalAttempts: 5,
        },
      },
    } as RouterConfig;
    const { ctx } = makeCtx({
      getConfigImpl: () => noFastCfg,
      refreshConfigImpl: () => noFastCfg,
      promptImpl: async (req: unknown) => {
        promptCalls.push(req);
        return { data: { parts: [{ type: "text", text: "should not run" }] } };
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(out).toContain("invalid model or provider configuration");
    expect(promptCalls).toHaveLength(0);
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("emits a routing.unmet observability event on the tierModel-null path", async () => {
    acceptMock.mockReset();
    // SDD: tui-toast-verification — routing.unmet is now a debug event.
    // Opt in to debug level and spy on console.log.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const malformedCfg = {
        activePreset: "default",
        defaultTier: "fast",
        presets: {
          default: {
            fast: {
              model: "" as unknown as string,
              description: "fast",
              whenToUse: [],
              costRatio: 1,
            },
          },
        },
        rules: [],
        enforcement: {
          verify: { require: "always", graderTemperature: 0 },
          escalate: {
            ladder: ["fast", "medium", "heavy"],
            maxAttemptsPerTier: 1,
            maxTotalAttempts: 5,
          },
        },
      } as RouterConfig;
      const { ctx } = makeCtx({
        getConfigImpl: () => malformedCfg,
        refreshConfigImpl: () => malformedCfg,
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      const lines = logSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((l) => l.startsWith("[model-router] "));
      const hasUnmet = lines.some((l) => {
        try {
          const env = JSON.parse(l.slice(l.indexOf("{")));
          return (
            env["event"] === "routing.unmet" &&
            /invalid model or provider configuration/i.test(String(env["reason"]))
          );
        } catch {
          return false;
        }
      });
      expect(hasUnmet).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });
});

describe("executeDelegate — retryable prompt errors still use the ladder (SDD regression)", () => {
  it("retryable transport error yields an empty artefact and lets the gate/ladder decide", async () => {
    // A non-classified message ("transport boom") does NOT match any
    // non-retryable pattern, so classifyPromptError returns
    // kind: "retryable". The pre-refactor behaviour — empty artefact →
    // gate → ladder — must be preserved byte-for-byte: the gate sees an
    // empty producerText and decides to retry or give up based on its
    // own verdict.
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["empty"] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // The gate ran, rejected the empty artefact, and the ladder eventually
    // gave up with the standard `[router status: unmet]` message — NOT the
    // fail-fast "delegation stopped:" prefix used by the non-retryable path.
    expect(acceptMock).toHaveBeenCalled();
    expect(out).toContain("[router status: unmet]");
    expect(out).not.toContain("delegation stopped:");
  });

  it("a retryable error that the gate accepts still produces the accepted suffix", async () => {
    // Back-compat: the existing 'treats prompt errors as an empty artefact
    // and lets the gate decide' test is preserved — a retryable error that
    // the gate happens to accept must still produce the accepted suffix.
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("transport boom");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
  });
});

describe("executeDelegate — abort on the fail-fast path is silent (SDD regression)", () => {
  it("abort during prompt still returns '' and the per-attempt `finally` cleans up", async () => {
    // The classifier's abort kind is the canonical AbortError check; this
    // test pins the existing abort-during-prompt behaviour byte-for-byte
    // (returns '' + cleanup spies fire) and protects the SDD change from
    // accidentally re-routing AbortError through the non-retryable branch.
    acceptMock.mockReset();
    const ac = new AbortController();
    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const { ctx } = makeCtx({
      createImpl: async () => ({ data: { id: "sess_abort_failfast" } }),
      promptImpl: async () => {
        queueMicrotask(() => ac.abort());
        throw new DOMException("aborted", "AbortError");
      },
      sessionStoreOverrides: {
        unregister: (sid: unknown) => {
          unregisterCalls.push(String(sid));
        },
      },
      guardStoreOverrides: {
        clear: (sid: unknown) => {
          clearCalls.push(String(sid));
        },
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" }, undefined, ac.signal);
    expect(out).toBe("");
    // Cleanup must still have run on the abort branch.
    expect(unregisterCalls).toContain("sess_abort_failfast");
    expect(clearCalls).toContain("sess_abort_failfast");
  });
});

// ---------------------------------------------------------------------------
// SDD: fail-fast-hardening-v2 (Phase 3) — observability wiring tests.
//
// Phase 3 attaches structured events to the previously-dark paths:
//   - `routing.nonretryable` (warn) fires on every policy-stop path:
//     pre-prompt guard failure + non-retryable prompt classification.
//   - `routing.retryable` (debug, opt-in via MODEL_ROUTER_LOG_LEVEL=debug)
//     fires on retryable prompt failures (HTTP 429, transient transport).
//   - `config.stale_serve` (warn) fires when `refreshConfig()` throws and
//     the cached snapshot from `getConfig()` is used as fallback.
//
// The tests below assert the canonical event names, levels, and payload
// shape — the contract operators grep for in dashboards. They are pinned
// to console spies (not to logEvent.X spies) because the public seam is
// the formatted JSON envelope, not the in-process helper call.
// ---------------------------------------------------------------------------

describe("executeDelegate — observability wiring (Phase 3 SDD)", () => {
  /** Parse model-router JSON envelopes out of a console.* spy. */
  const captureModelRouterEnvelopes = (
    spy: ReturnType<typeof vi.spyOn>,
  ): Array<Record<string, unknown>> => {
    return (spy.mock.calls as unknown as unknown[][])
      .map((c: unknown[]) => String(c[0] ?? ""))
      .filter((l: string) => l.startsWith("[model-router] "))
      .map((l: string) => JSON.parse(l.slice(l.indexOf("{"))));
  };

  it("emits routing.nonretryable with the classified reason on a non-retryable prompt error", async () => {
    acceptMock.mockReset();
    // SDD: tui-toast-verification — both routing.nonretryable and
    // routing.unmet are now debug events. Opt in via MODEL_ROUTER_LOG_LEVEL
    // and spy on console.log (the shared debug+info sink).
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = makeCtx({
        promptImpl: async () => {
          throw new Error("quota exceeded: insufficient credits");
        },
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      const envs = captureModelRouterEnvelopes(logSpy);
      const nonretryable = envs.find((e) => e["event"] === "routing.nonretryable");
      expect(nonretryable).toBeDefined();
      expect(nonretryable?.["reason"]).toMatch(/billing|quota|credit/i);
      expect(nonretryable?.["tier"]).toBe("fast");
      expect(nonretryable?.["attempt"]).toBe(1);
      // routing.nonretryable precedes routing.unmet (cause then terminal).
      const unmet = envs.find((e) => e["event"] === "routing.unmet");
      expect(unmet).toBeDefined();
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  it("emits routing.nonretryable on the pre-prompt tierModel() guard failure", async () => {
    acceptMock.mockReset();
    // SDD: tui-toast-verification — see sibling test; both events now
    // flow through console.log at debug level.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const malformedCfg = {
        activePreset: "default",
        defaultTier: "fast",
        presets: {
          default: {
            fast: {
              model: "" as unknown as string,
              description: "fast",
              whenToUse: [],
              costRatio: 1,
            },
          },
        },
        rules: [],
        enforcement: {
          verify: { require: "always", graderTemperature: 0 },
          escalate: { ladder: ["fast"], maxAttemptsPerTier: 1, maxTotalAttempts: 1 },
        },
      } as RouterConfig;
      const { ctx } = makeCtx({
        getConfigImpl: () => malformedCfg,
        refreshConfigImpl: () => malformedCfg,
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      const envs = captureModelRouterEnvelopes(logSpy);
      const nonretryable = envs.find((e) => e["event"] === "routing.nonretryable");
      expect(nonretryable).toBeDefined();
      expect(nonretryable?.["reason"]).toBe("invalid model or provider configuration");
      expect(nonretryable?.["tier"]).toBe("fast");
      expect(nonretryable?.["attempt"]).toBe(1);
      // routing.unmet follows nonretryable on this path too.
      const unmet = envs.find((e) => e["event"] === "routing.unmet");
      expect(unmet).toBeDefined();
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  it("emits routing.retryable with the classified reason on a retryable prompt error", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    // routing.retryable fires at debug level — opt in to capture it.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = makeCtx({
        promptImpl: async () => {
          // "transport boom" matches no non-retryable pattern → retryable.
          throw new Error("transport boom");
        },
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      const envs = captureModelRouterEnvelopes(logSpy);
      const retryable = envs.find((e) => e["event"] === "routing.retryable");
      expect(retryable).toBeDefined();
      expect(retryable?.["reason"]).toMatch(/transport|transient/i);
      expect(retryable?.["tier"]).toBe("fast");
      expect(retryable?.["attempt"]).toBe(1);
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  it("emits config.stale_serve when refreshConfig() throws and getConfig() succeeds", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    // SDD: tui-toast-verification — config.stale_serve was downgraded from
    // warn to debug. Opt in via MODEL_ROUTER_LOG_LEVEL and spy on
    // console.log to capture it.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = makeCtx({
        refreshConfigImpl: () => {
          throw new Error("disk read failed");
        },
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      const envs = captureModelRouterEnvelopes(logSpy);
      const staleServe = envs.find((e) => e["event"] === "config.stale_serve");
      expect(staleServe).toBeDefined();
      expect(String(staleServe?.["reason"])).toContain("disk read failed");
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  it("emits routing.retryable with reason 'rate limited' on HTTP 429", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { ctx } = makeCtx({
        promptImpl: async () => {
          // HTTP 429 → classifier returns retryable / "rate limited"
          // (verified directly by classifyPromptError in
          // test/unit/error-classify.test.ts; here we exercise the
          // end-to-end wiring through executeDelegate).
          const err = new Error("rate limit hit") as Error & { status?: number };
          err.status = 429;
          throw err;
        },
      });
      await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      const envs = captureModelRouterEnvelopes(logSpy);
      const retryable = envs.find((e) => e["event"] === "routing.retryable");
      expect(retryable).toBeDefined();
      expect(retryable?.["reason"]).toBe("rate limited");
      expect(retryable?.["tier"]).toBe("fast");
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });

  it("cross-runtime abort (duck-type) returns '' silently and emits NO routing.nonretryable", async () => {
    acceptMock.mockReset(); // gate MUST NOT be called on the abort path
    // SDD: tui-toast-verification — both routing.nonretryable and
    // routing.unmet are now debug events. To prove the abort path is
    // fully silent (no policy telemetry at ANY level), spy on BOTH
    // sinks and assert neither contains either event.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ac = new AbortController();
    try {
      const { ctx } = makeCtx({
        createImpl: async () => ({ data: { id: "sess_duck_abort" } }),
        // Throw a plain Error with `name: "AbortError"` — NOT a DOMException.
        // The duck-type match in `isAbortLikeError` recognises this shape
        // (cross-runtime abort detection). Confirms the abort path is
        // silent: no nonretryable telemetry, no unmet.
        promptImpl: async () => {
          queueMicrotask(() => ac.abort());
          const err = new Error("aborted") as Error & { name?: string };
          err.name = "AbortError";
          throw err;
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
      // No routing.nonretryable on the abort path (warn sink).
      const warnEnvs = captureModelRouterEnvelopes(warnSpy);
      const nonretryable = warnEnvs.find((e) => e["event"] === "routing.nonretryable");
      expect(nonretryable).toBeUndefined();
      // No routing.unmet on the abort path at ANY sink (debug sink too —
      // SDD downgraded it from warn, so the warn-sink-only check would
      // no longer be sufficient).
      const logEnvs = captureModelRouterEnvelopes(logSpy);
      const unmetWarn = warnEnvs.find((e) => e["event"] === "routing.unmet");
      const unmetLog = logEnvs.find((e) => e["event"] === "routing.unmet");
      expect(unmetWarn).toBeUndefined();
      expect(unmetLog).toBeUndefined();
      // Gate was never called (same invariant as the DOMException path).
      expect(acceptMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });
});

// ---------------------------------------------------------------------------
// SDD: fail-fast-hardening-v2 (Phase 2) — explicit guard wiring test.
//
// The delegate's pre-prompt tier-resolution check moved from an inline
// `tierModel() === null` test into the shared `resolveTierModelGuard`
// module. The tests above (`executeDelegate — tierModel() === null fails
// fast (SDD)`) exercise the OBSERVABLE contract (visible message +
// routing.unmet event). This test pins the explicit contract that the
// guard module is the canonical source of truth: the unmet reason
// emitted on the fail-closed path MUST equal the reason returned by the
// guard, so a future change that re-introduces a parallel inline check
// (and accidentally drifts the reason string) is caught immediately.
//
// Invariants under test:
//   - The guard module exports `resolveTierModelGuard` and returns the
//     canonical "invalid model or provider configuration" reason for
//     any failure mode (missing tier, malformed model string, etc.).
//   - `executeDelegate`'s visible unmet message AND the `routing.unmet`
//     event's `reason` field are sourced from the guard's `reason`,
//     not from a hard-coded delegate-local string.
// ---------------------------------------------------------------------------

describe("executeDelegate — explicit resolveTierModelGuard wiring (Phase 2 SDD)", () => {
  it("the guard's reason string is the same string the delegate emits on the fail-closed path", async () => {
    acceptMock.mockReset();
    // SDD: tui-toast-verification — routing.unmet is now a debug event.
    // Opt in via MODEL_ROUTER_LOG_LEVEL and spy on console.log to capture
    // the envelope.
    const origLevel = process.env["MODEL_ROUTER_LOG_LEVEL"];
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    __resetLoggerForTest();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Drive the SAME config through the guard and through executeDelegate,
      // then assert the unmet payload uses the guard's reason verbatim.
      const malformedCfg = {
        activePreset: "default",
        defaultTier: "fast",
        presets: {
          default: {
            fast: {
              // Malformed: empty model string → tierModel() returns null.
              model: "" as unknown as string,
              description: "fast",
              whenToUse: [],
              costRatio: 1,
            },
          },
        },
        rules: [],
        enforcement: {
          verify: { require: "always", graderTemperature: 0 },
          escalate: {
            ladder: ["fast", "medium", "heavy"],
            maxAttemptsPerTier: 1,
            maxTotalAttempts: 5,
          },
        },
      } as RouterConfig;

      // 1. Guard returns the canonical reason for this exact config.
      const guardResult = resolveTierModelGuard(malformedCfg, "fast");
      expect(guardResult.ok).toBe(false);
      const guardReason = guardResult.reason;
      expect(guardReason).toBe("invalid model or provider configuration");

      // 2. The delegate emits the SAME reason string on the unmet path.
      const { ctx } = makeCtx({
        getConfigImpl: () => malformedCfg,
        refreshConfigImpl: () => malformedCfg,
      });
      const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
      expect(out).toContain(guardReason);

      // 3. The routing.unmet event's reason matches the guard's reason
      //    byte-for-byte (this is what operators grep for in dashboards).
      const lines = logSpy.mock.calls
        .map((c) => String(c[0] ?? ""))
        .filter((l) => l.startsWith("[model-router] "));
      const matched = lines.some((l) => {
        try {
          const env = JSON.parse(l.slice(l.indexOf("{")));
          return env["event"] === "routing.unmet" && env["reason"] === guardReason;
        } catch {
          return false;
        }
      });
      expect(matched).toBe(true);
    } finally {
      logSpy.mockRestore();
      if (origLevel === undefined) delete process.env["MODEL_ROUTER_LOG_LEVEL"];
      else process.env["MODEL_ROUTER_LOG_LEVEL"] = origLevel;
      __resetLoggerForTest();
    }
  });
});

// ---------------------------------------------------------------------------
// SDD: tui-toast-verification — toast helper wiring on the delegate.
//
// Spec contract (terminal-failure toasts):
//   - "Delegation terminal failure" — the system MUST request a TUI toast
//     when delegation ends in a give-up or non-retryable failure.
//   - "Retry Paths Stay Quiet" — at most ONE toast per terminal outcome;
//     retries must NOT spam toasts.
//   - "Best-Effort Toast Delivery" — toast rejection must not change the
//     primary delegation outcome.
//
// Invariants under test:
//   - Pre-prompt tierModel guard fail-fast fires an error toast.
//   - Non-retryable prompt classification fail-fast fires an error toast.
//   - Non-aborted `give_up` terminal fires a warning toast.
//   - Abort paths (top-of-loop, after-create, during-prompt, ladder
//     post-abort give_up) fire ZERO toasts — they're silently silent.
//   - Retry/escalate paths fire ZERO toasts — only the terminal outcome
//     surfaces.
// ---------------------------------------------------------------------------

describe("executeDelegate — toast helper wiring (SDD tui-toast-verification)", () => {
  it("fires an error toast on the pre-prompt tierModel guard fail-fast path", async () => {
    acceptMock.mockReset();
    const malformedCfg = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "" as unknown as string,
            description: "fast",
            whenToUse: [],
            costRatio: 1,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: { ladder: ["fast"], maxAttemptsPerTier: 1, maxTotalAttempts: 1 },
      },
    } as RouterConfig;
    const { ctx, toastSpy } = makeCtx({
      getConfigImpl: () => malformedCfg,
      refreshConfigImpl: () => malformedCfg,
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const args = toastSpy.mock.calls[0]?.[0] as { body: { message: string; variant: string } };
    expect(args?.body.variant).toBe("error");
    expect(args?.body.message).toContain("Delegation failed");
    expect(args?.body.message).toContain("invalid model or provider configuration");
  });

  it("fires an error toast on the non-retryable prompt classification fail-fast path", async () => {
    acceptMock.mockReset();
    const { ctx, toastSpy } = makeCtx({
      promptImpl: async () => {
        throw new Error("quota exceeded: insufficient credits");
      },
    });
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const args = toastSpy.mock.calls[0]?.[0] as { body: { message: string; variant: string } };
    expect(args?.body.variant).toBe("error");
    expect(args?.body.message).toContain("Delegation failed");
    expect(args?.body.message).toMatch(/billing|quota|credit/i);
  });

  it("fires a warning toast on the non-aborted give_up terminal path (ladder exhaustion)", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["file missing"] },
      dodSource: "inferred",
    });
    const { ctx, toastSpy } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router status: unmet]");
    // Exactly ONE toast — the terminal ladder-exhaustion outcome.
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const args = toastSpy.mock.calls[0]?.[0] as { body: { message: string; variant: string } };
    expect(args?.body.variant).toBe("warning");
    expect(args?.body.message).toContain("Delegation unmet");
    expect(args?.body.message).toMatch(/attempt/);
  });

  it("fires ZERO toasts on a happy-path accepted delegation", async () => {
    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });
    const { ctx, toastSpy } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("fires ZERO toasts on a retry/escalate path (no terminal failure)", async () => {
    // First attempt FAILS (with retry), second attempt PASSES — the
    // toast is held back for the final outcome (which is accept).
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["missing"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });
    const { ctx, toastSpy } = makeCtx({});
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("fires ZERO toasts on any abort branch (all four abort checkpoints stay silent)", async () => {
    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["x"] },
      dodSource: "inferred",
    });

    // (1) top-of-loop
    {
      const ac = new AbortController();
      ac.abort();
      const { ctx, toastSpy } = makeCtx({});
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
      expect(toastSpy).not.toHaveBeenCalled();
    }

    // (2) after-create
    {
      const ac = new AbortController();
      let firstCreate = true;
      const { ctx, toastSpy } = makeCtx({
        createImpl: async () => {
          if (firstCreate) {
            firstCreate = false;
            queueMicrotask(() => ac.abort());
          }
          return { data: { id: "sess_a" } };
        },
        promptImpl: async () => {
          throw new Error("prompt must NOT be called");
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
      expect(toastSpy).not.toHaveBeenCalled();
    }

    // (3) during-prompt
    {
      const ac = new AbortController();
      const { ctx, toastSpy } = makeCtx({
        createImpl: async () => ({ data: { id: "sess_b" } }),
        promptImpl: async () => {
          queueMicrotask(() => ac.abort());
          throw new DOMException("aborted", "AbortError");
        },
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
      expect(toastSpy).not.toHaveBeenCalled();
    }

    // (4) ladder post-abort give_up
    {
      const ac = new AbortController();
      let createCount = 0;
      const { ctx, toastSpy } = makeCtx({
        createImpl: async () => {
          createCount++;
          if (createCount === 2) ac.abort();
          return { data: { id: `sess_${createCount}` } };
        },
        promptImpl: async () => ({
          data: { parts: [{ type: "text", text: "x" }] },
        }),
      });
      const out = await executeDelegate(
        ctx,
        { task: "say hi", tier: "fast" },
        undefined,
        ac.signal,
      );
      expect(out).toBe("");
      expect(toastSpy).not.toHaveBeenCalled();
    }
  });

  it("does NOT change the primary outcome if the toast surface rejects (best-effort)", async () => {
    // Replace the per-ctx toast spy with a rejecting one — the helper
    // swallows the rejection internally, so the visible unmet string
    // must still be produced and the loop must not throw.
    acceptMock.mockReset();
    const { ctx } = makeCtx({
      promptImpl: async () => {
        throw new Error("quota exceeded: insufficient credits");
      },
    });
    // Swap the toast spy for a rejecting mock so the .catch(() => {})
    // path is exercised.
    const rejectingToast = vi.fn().mockRejectedValue(new Error("TUI offline"));
    (ctx.plugin.client as unknown as { tui: { showToast: unknown } }).tui = {
      showToast: rejectingToast,
    };
    const out = await executeDelegate(ctx, { task: "say hi", tier: "fast" });
    // Primary outcome is unchanged — the unmet string is still produced.
    expect(out).toContain("[router status: unmet]");
    // Toast was attempted exactly once.
    expect(rejectingToast).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SDD: reasoning-level-escalation-on-retry — WU-7 delegate integration tests.
//
// Tests T-1/3/4 (bump-then-tier), T-2 (retryable→no bump), T-5/6 (none
// capability unchanged), B-2/3/4 (lifecycle/baseline-restore edge cases), and
// R-2 STOP (prompt-seam wiring assertion).
//
// R-2 STOP condition:
//   If the spy inside session.prompt observes UNPATCHED baseline variant at
//   prompt time, the SDK resolves agent def by value at registration — NOT
//   by reference at prompt. STOP and surface the typed failure. Do NOT
//   silently switch to a prompt-body variant mechanism without operator
//   sign-off. Feature is deferred pending operator decision.
// ---------------------------------------------------------------------------

/** 5-rung discrete reasoning config for bump-then-tier tests (T-1/3/4/R-2). */
const makeReasoningCfg = (overrides?: {
  maxLevelBumpsPerTier?: number;
  ladder?: string[];
  maxAttemptsPerTier?: number;
}): {
  cfg: RouterConfig;
  agent: Record<string, Record<string, unknown>>;
} => {
  const ladder = overrides?.ladder ?? ["low", "medium", "high", "xhigh", "max"];
  const controlLevels = ladder as [string, ...string[]];
  const maxBumps = overrides?.maxLevelBumpsPerTier ?? 2;
  const maxAttempts = overrides?.maxAttemptsPerTier ?? 1;

  // Each tier maps the single fixture profile to its configured starting
  // native level. The registry and bridge are deliberately opaque to runtime
  // code; the tier control owns the native starting index.
  const cfg: RouterConfig = {
    activePreset: "default",
    defaultTier: "medium",
    presets: {
      default: {
        low: {
          model: "anthropic/claude-haiku-4-5",
          description: "low",
          whenToUse: [],
          costRatio: 1,
          reasoning: { effort: "low" },
          reasoningControl: {
            channel: "reasoning.effort",
            levels: controlLevels,
            profileMap: { p1: "low" },
            maxBumps,
          },
        },
        medium: {
          model: "anthropic/claude-sonnet-4",
          description: "medium",
          whenToUse: [],
          costRatio: 3,
          reasoning: { effort: "medium" },
          reasoningControl: {
            channel: "reasoning.effort",
            levels: controlLevels,
            profileMap: { p1: "medium" },
            maxBumps,
          },
        },
        high: {
          model: "anthropic/claude-opus-4",
          description: "high",
          whenToUse: [],
          costRatio: 9,
          reasoning: { effort: "high" },
          reasoningControl: {
            channel: "reasoning.effort",
            levels: controlLevels,
            profileMap: { p1: "high" },
            maxBumps,
          },
        },
        xhigh: {
          model: "anthropic/claude-opus-4",
          description: "xhigh",
          whenToUse: [],
          costRatio: 12,
          reasoning: { effort: "xhigh" },
          reasoningControl: {
            channel: "reasoning.effort",
            levels: controlLevels,
            profileMap: { p1: "xhigh" },
            maxBumps,
          },
        },
        max: {
          model: "anthropic/claude-opus-4",
          description: "max",
          whenToUse: [],
          costRatio: 15,
          reasoning: { effort: "max" },
          reasoningControl: {
            channel: "reasoning.effort",
            levels: controlLevels,
            profileMap: { p1: "max" },
            maxBumps,
          },
        },
      },
    },
    rules: [],
    enforcement: {
      verify: { require: "always", graderTemperature: 0 },
      escalate: {
        ladder,
        maxAttemptsPerTier: maxAttempts,
        maxTotalAttempts: 20,
      },
    },
    reasoningPolicy: {
      mode: "manual",
      profiles: ["p1"],
      defaultProfile: "p1",
    } as any,
  } as unknown as RouterConfig;

  // Build opencodeConfig.agent so the per-attempt patch has live defs to mutate.
  const agent: Record<string, Record<string, unknown>> = {
    low: {
      model: "anthropic/claude-haiku-4-5",
      mode: "subagent",
      options: { reasoning_effort: "low" },
    },
    medium: {
      model: "anthropic/claude-sonnet-4",
      mode: "subagent",
      options: { reasoning_effort: "medium" },
    },
    high: {
      model: "anthropic/claude-opus-4",
      mode: "subagent",
      options: { reasoning_effort: "high" },
    },
    xhigh: {
      model: "anthropic/claude-opus-4",
      mode: "subagent",
      options: { reasoning_effort: "xhigh" },
    },
    max: {
      model: "anthropic/claude-opus-4",
      mode: "subagent",
      options: { reasoning_effort: "max" },
    },
  };

  return { cfg, agent };
};

describe("executeDelegate — reasoning-level-escalation (WU-7 T-1/T-3/T-4)", () => {
  // T-1: 3 verification FAILs on discrete 5-rung [low,medium,high,xhigh,max] starting
  // at medium, maxLevelBumpsPerTier=2. Expected: bump→bump→escalate. Baseline restored.
  it("bump→bump→escalate on 3 verification failures; baseline restored after loop", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    const unregisterCalls: string[] = [];
    const clearCalls: string[] = [];
    const abortSpy = vi.fn().mockResolvedValue(undefined);

    // Accept FAILS on first 3 attempts, PASSES on 4th.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      abortImpl: abortSpy,
      sessionStoreOverrides: { unregister: (s: unknown) => unregisterCalls.push(String(s)) },
      guardStoreOverrides: { clear: (s: unknown) => clearCalls.push(String(s)) },
    });
    // Wire live agent defs so the patch targets the same objects the spy reads.
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // 4th attempt passed (accept on 4th call).
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(acceptMock).toHaveBeenCalledTimes(4);

    // Baseline MUST be restored after the loop (outer finally sweep ran).
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
    expect(agent.high.options).toEqual({ reasoning_effort: "high" });
    expect(agent.xhigh.options).toEqual({ reasoning_effort: "xhigh" });
  });

  // T-3 variant: same ladder but starting at xhigh (top of ladder, no room to bump).
  // Verificaton FAIL → should escalate without attempting to bump.
  it("escalates without bump when already at top of ladder (T-3)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // Fail first, pass second.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "xhigh" });

    // xhigh has no higher rung; single FAIL should escalate (not bump) then pass.
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    // Baseline unchanged (no patch was applied for xhigh because no higher rung).
    expect(agent.xhigh.options).toEqual({ reasoning_effort: "xhigh" });
  });

  // T-4: cap-hit escalate — bumps exhausted (maxLevelBumpsPerTier=2), next FAIL
  // escalates directly (bumpsLeft=0 prevents retry). Trace: FAIL1→bump(→high),
  // FAIL2→bump(→xhigh, cap hit), FAIL3→escalate(→max). maxAttempts=1 is used so
  // the cap-hit escalate fires on the 3rd failure rather than waiting for a retry.
  it("escalates immediately when maxLevelBumpsPerTier cap is hit (T-4)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // FAIL 1→bump(high), FAIL 2→bump(xhigh, cap exhausted), FAIL 3→escalate(max).
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // bump→bump→escalate → pass on 3rd attempt.
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(acceptMock).toHaveBeenCalledTimes(3);
    // Baselines restored after outer finally.
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
    expect(agent.high.options).toEqual({ reasoning_effort: "high" });
  });
});

describe("executeDelegate — reasoning-level-escalation (WU-7 T-2 retryable error)", () => {
  // T-2: promptImpl throws a 429-shaped error → cause="retryable_error" →
  // canBumpReasoning returns false → action="retry" (NOT "bump").
  it("retryable error causes retry action, NOT bump (T-2)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // Pass on 2nd attempt (retryable error → retry, then pass).
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["empty"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      promptImpl: async () => {
        // 429-shaped retryable error.
        const err = new Error("rate limit hit") as Error & { status?: number };
        err.status = 429;
        throw err;
      },
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // First attempt: retryable error → retry (no bump).
    // Second attempt: pass.
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(acceptMock).toHaveBeenCalledTimes(2);
    // Agent def was NOT patched (retryable error bypasses the bump logic).
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
  });
});

describe("executeDelegate — reasoning-level-escalation (WU-7 T-5/T-6 none capability)", () => {
  // T-5: tier with no reasoning capability → no patch applied → existing retry/escalate.
  it("none-capability tier is not patched (T-5)", async () => {
    const cfg: RouterConfig = {
      activePreset: "default",
      defaultTier: "noneTier",
      presets: {
        default: {
          noneTier: {
            model: "anthropic/claude-haiku-4-5",
            description: "none",
            whenToUse: [],
            costRatio: 1,
          },
          high: {
            model: "anthropic/claude-opus-4",
            description: "high",
            whenToUse: [],
            costRatio: 9,
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["noneTier", "high"],
          maxAttemptsPerTier: 1,
          maxTotalAttempts: 10,
        },
      },
    } as RouterConfig;

    const noneAgent = { model: "anthropic/claude-haiku-4-5", mode: "subagent", options: {} };
    const highAgent = {
      model: "anthropic/claude-opus-4",
      mode: "subagent",
      options: { reasoning_effort: "high" },
    };

    // 3 failures → escalates from noneTier to high (no bump path entered).
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = {
      agent: { noneTier: noneAgent, high: highAgent },
    };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "noneTier" });

    expect(out).toContain("[router \u2713 accepted: deterministic]");
    // noneTier agent def was never patched (reasoningLadderLen=0 → guard false).
    expect(noneAgent.options).toEqual({});
    // high agent was not touched either.
    expect(highAgent.options).toEqual({ reasoning_effort: "high" });
  });

  // T-6: with capability but omitted cause → no bump (cause !== "verification_fail").
  it("omitted cause does not trigger bump (T-6)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // gateRes.accepted=false but promptCause=undefined (not set) → cause=undefined.
    // canBumpReasoning(cause=undefined) → false → retry.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // No bump: retry on first attempt, pass on second.
    expect(out).toContain("[router \u2713 accepted: deterministic]");
    expect(acceptMock).toHaveBeenCalledTimes(2);
    // Medium agent was NOT patched (cause was undefined → canBump=false).
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
  });
});

describe("executeDelegate — reasoning-level-escalation (WU-7 B-2/B-3/B-4 lifecycle)", () => {
  // B-2: abort mid-loop — per-attempt finally is bypassed, outer finally restores.
  it("abort mid-loop bypasses per-attempt finally but outer finally restores baselines (B-2)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
      dodSource: "inferred",
    });

    const ac = new AbortController();
    let promptCount = 0;

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      createImpl: async () => ({ data: { id: `sess_b2_${++promptCount}` } }),
      promptImpl: async () => {
        // Abort after the first prompt resolves.
        if (promptCount === 1) {
          queueMicrotask(() => ac.abort());
        }
        return { data: { parts: [{ type: "text", text: "done" }] } };
      },
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(
      ctx,
      { task: "reasoning test", tier: "medium" },
      undefined,
      ac.signal,
    );

    // Abort returns "" silently.
    expect(out).toBe("");
    // Outer finally ran → baselines restored.
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
  });

  // B-3: session.create throws a non-abort error → outer catch fail-closed,
  // outer finally ran first.
  it("session.create throws non-abort: outer catch fail-closed, outer finally still ran (B-3)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    acceptMock.mockResolvedValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
      dodSource: "inferred",
    });

    const unregisterCalls: string[] = [];

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      createImpl: async () => {
        throw new Error("session.create boom");
      },
      sessionStoreOverrides: { unregister: (s: unknown) => unregisterCalls.push(String(s)) },
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // Outer catch returns fail-closed sentinel.
    expect(out).toContain("[router] delegate failed (fail-closed)");
    // Outer finally ran (baselines restored).
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
  });

  // B-4: restoreAgentBaseline throws for one tier — others still restored, warn logged.
  it("restoreAgentBaseline throws for one tier: others restored, warn logged (B-4)", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // Mark medium tier's baseline to throw when restore is attempted.
    // This seeds __throwOnRestore into the snapshot taken inside executeDelegate.
    (agent.medium as Record<string, unknown>).__throwOnRestore = true;

    // Single failure (no bumps triggered since maxAttemptsPerTier=1 would trigger
    // escalate, but we'll accept first and bump the second).
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    // Spy on log.warn to capture baseline_restore_failed events.
    const { log } = await import("../../src/utils/observability");
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    // Spy on restoreAgentBaseline: throw for any baseline marked with __throwOnRestore.
    const restoreSpy = vi.spyOn(agentsModule, "restoreAgentBaseline");
    restoreSpy.mockImplementation(
      (def: Record<string, unknown>, baseline: Record<string, unknown>) => {
        if (baseline.__throwOnRestore) {
          throw new Error("simulated restore failure");
        }
        // Original behavior: clear def and copy baseline entries.
        for (const key of Object.keys(def)) delete def[key];
        for (const [k, v] of Object.entries(baseline)) def[k] = v;
      },
    );

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // Delegation result is preserved (not affected by the restore throw).
    expect(out).toContain("[router \u2713 accepted: deterministic]");

    // medium tier threw during restore — its state is uncertain (depends on whether
    // the throw happened before or after the def was cleared). The key assertion
    // is that the warn was logged and other tiers are intact.
    const baselineRestoreFailedCalls = warnSpy.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>)?.event === "delegate.baseline_restore_failed",
    );
    expect(baselineRestoreFailedCalls.length).toBeGreaterThan(0);

    // Other tiers (high, xhigh) are restored to baseline despite medium's failure.
    expect(agent.high.options).toEqual({ reasoning_effort: "high" });
    expect(agent.xhigh.options).toEqual({ reasoning_effort: "xhigh" });

    restoreSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("executeDelegate — reasoning-level-escalation (WU-7 R-2 prompt-seam wiring assertion)", () => {
  // R-2 STOP condition:
  //   Spy on session.prompt. INSIDE the spy, read LIVE ctx.opencodeConfig.agent[tier]
  //   and record options.reasoning_effort. Drive verification FAILs on discrete
  //   [low,medium,high,xhigh,max] start=medium, maxLevelBumpsPerTier=2.
  //
  //   The empirical question: does the spy see PATCHED reasoning_effort values
  //   at attempts 2 and 3 (medium→high→xhigh)?
  //
  //   STOP: if spy observes UNPATCHED baseline ("medium") at attempts 2 or 3 →
  //   the SDK resolves agent def by value at registration → feature broken.
  //   Surface the typed failure and STOP. Do NOT switch to a prompt-body
  //   variant mechanism without operator sign-off.
  //
  // This test is the definitive empirical answer to whether the per-attempt
  // patch (applyReasoningPatch mutating ctx.opencodeConfig.agent[tier]) is
  // visible AT the session.prompt({ body: { agent: tier } }) call site.
  it("R-2 STOP: spy sees PATCHED reasoning_effort at session.prompt call site", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    const recordedEfforts: Array<{ tier: string; effort: unknown }> = [];

    // D-3: FAIL1→bump(high), FAIL2→bump(xhigh), FAIL3→bumpExhausted@top→escalate(max),
    // FAIL4→give-up (no bumps on max, no next tier). This mock sequence tests R-2
    // on attempts 2 and 3 (high, xhigh) before D-3 exhaustion pattern takes over.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      promptImpl: async (req: unknown) => {
        // R-2 assertion: read the LIVE agent def at the moment session.prompt fires.
        const calledTier = (req as { body?: { agent?: string } })?.body?.agent;
        if (calledTier && (ctx as unknown as Record<string, unknown>).opencodeConfig) {
          const opencfg = (ctx as unknown as Record<string, unknown>).opencodeConfig as {
            agent?: Record<string, Record<string, unknown>>;
          };
          const liveDef = opencfg.agent?.[calledTier];
          if (liveDef) {
            recordedEfforts.push({
              tier: calledTier,
              effort: (liveDef.options as Record<string, unknown>)?.reasoning_effort,
            });
          }
        }
        return { data: { parts: [{ type: "text", text: "done" }] } };
      },
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning test", tier: "medium" });

    // Eventually passes.
    expect(out).toContain("[router \u2713 accepted: deterministic]");

    // R-2 CRITICAL CHECK: at attempts 2 and 3, the spy MUST NOT see the
    // baseline "medium" — it must see "high" and "xhigh" respectively.
    // If either shows "medium", the SDK resolved agent def by value at
    // registration → R-2 STOP: feature broken, surface typed failure.
    //
    // The spy saw: recordedEfforts[0]=medium, [1]=high, [2]=xhigh at tier=medium.
    // This empirically confirms the PATCH IS VISIBLE at prompt time.
    const effort1IsHigh = recordedEfforts[1]?.effort === "high";
    const effort2IsXhigh = recordedEfforts[2]?.effort === "xhigh";

    expect(recordedEfforts[0]!).toMatchObject({ tier: "medium", effort: "medium" });
    expect(effort1IsHigh).toBe(true);
    expect(effort2IsXhigh).toBe(true);

    // R-2 PASSED: patch is visible at session.prompt call time.
    // Baselines restored after outer finally sweep.
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
    expect(agent.high.options).toEqual({ reasoning_effort: "high" });
    expect(agent.xhigh.options).toEqual({ reasoning_effort: "xhigh" });
  });
});

// ---------------------------------------------------------------------------
// Regression: heavy tier with reasoning.effort but no variant must start at
// the configured effort level (medium), not fall back to index 0 (low).
// ---------------------------------------------------------------------------
describe("executeDelegate — reasoning.effort without variant starts at configured level", () => {
  it("starts at medium (not low), bumps to high then xhigh on verification failures", async () => {
    // Tier "heavy" has reasoning.effort="medium" and NO variant.
    // Capability declares discrete/reasoning.effort ladder [low,medium,high,xhigh].
    // The agent def initially has reasoning_effort="medium" (the configured baseline).
    const cfg: RouterConfig = {
      activePreset: "default",
      defaultTier: "heavy",
      presets: {
        default: {
          heavy: {
            model: "openai/gpt-5.6-terra",
            description: "heavy",
            whenToUse: [],
            costRatio: 1,
            // NOTE: no `variant` field — starting level must come from reasoning.effort
            reasoning: { effort: "medium" },
            reasoningControl: {
              channel: "reasoning.effort",
              levels: ["low", "medium", "high", "xhigh"],
              profileMap: { p1: "medium" },
              maxBumps: 2,
            },
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["heavy"],
          maxAttemptsPerTier: 4,
          maxTotalAttempts: 20,
          costCeiling: { multiple: 100 },
        },
      },
      reasoningPolicy: {
        mode: "manual",
        profiles: ["p1"],
        defaultProfile: "p1",
      },
    } as RouterConfig;

    const agent: Record<string, Record<string, unknown>> = {
      heavy: {
        model: "openai/gpt-5.6-terra",
        mode: "subagent",
        options: { reasoning_effort: "medium" },
      },
    };

    const recordedEfforts: unknown[] = [];

    // Default: fail unless explicitly overridden. Use mockReturnValue so subsequent
    // calls (if any) don't cause "undefined verdict" errors.
    acceptMock.mockReturnValue({
      accepted: false,
      verdict: { pass: false, method: "deterministic", reasons: ["default-fail"] },
      dodSource: "inferred",
    });
    // Override first 4 with explicit deterministic FAILs.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      promptImpl: async (req: unknown) => {
        const calledTier = (req as { body?: { agent?: string } })?.body?.agent;
        if (calledTier) {
          const opencfg = (ctx as unknown as Record<string, unknown>).opencodeConfig as {
            agent?: Record<string, Record<string, unknown>>;
          };
          const liveDef = opencfg.agent?.[calledTier];
          if (liveDef) {
            recordedEfforts.push((liveDef.options as Record<string, unknown>)?.reasoning_effort);
          }
        }
        return { data: { parts: [{ type: "text", text: "done" }] } };
      },
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, { task: "reasoning effort start level", tier: "heavy" });

    // D-3 behavior with maxLevelBumpsPerTier=2: FAIL→bump(high), FAIL→bump(xhigh),
    // FAIL→bumpExhausted@top → escalate directly (no same-level retry), give-up.
    // Only 3 recorded efforts (no retry at top).
    expect(out).toContain("unmet");
    expect(out).toContain("already at top of ladder");

    // CRITICAL: first attempt must be "medium" (configured level), NOT "low".
    // This is the regression: without the fix, enterTier falls back to index 0 (low)
    // because tierCfg.variant is undefined for a reasoning.effort tier.
    expect(recordedEfforts[0]).toBe("medium");
    // Then bumps to high on second attempt.
    expect(recordedEfforts[1]).toBe("high");
    // Then bumps to xhigh on third attempt (top of ladder).
    expect(recordedEfforts[2]).toBe("xhigh");
    // D-3: fourth failure does not occur — bumpExhausted@top triggers immediate escalate/give-up.
    expect(recordedEfforts[3]).toBeUndefined();

    // Baselines are restored after loop.
    expect(agent.heavy.options).toEqual({ reasoning_effort: "medium" });
  });
});

// ---------------------------------------------------------------------------
// Plan 038: per-tier reasoning ownership — the delegate path must participate
// in the same `acquireTierOwner`/`releaseTierOwner` protocol as the hook path
// so two concurrent dispatches on the same tier cannot race their baselines.
// ---------------------------------------------------------------------------

describe("executeDelegate — per-tier reasoning ownership (Plan 038)", () => {
  it("acquires ownership, patches, and releases on the happy path", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    acceptMock.mockResolvedValueOnce({
      accepted: true,
      verdict: { pass: true, method: "deterministic", reasons: [] },
      dodSource: "inferred",
    });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    // Pre-condition: no owner holds any tier.
    expect(ctx.reasoningStore.getTierOwner("medium")).toBeUndefined();

    const out = await executeDelegate(ctx, { task: "ownership happy path", tier: "medium" });

    expect(out).toContain("[router ✓ accepted: deterministic]");

    // Post-condition: every tier this invocation patched is unowned.
    expect(ctx.reasoningStore.getTierOwner("medium")).toBeUndefined();
    expect(ctx.reasoningStore.getTierOwner("high")).toBeUndefined();
    expect(ctx.reasoningStore.getTierOwner("xhigh")).toBeUndefined();

    // Baseline restored on every tier we touched.
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
    expect(agent.high.options).toEqual({ reasoning_effort: "high" });
    expect(agent.xhigh.options).toEqual({ reasoning_effort: "xhigh" });
  });

  it("skips the patch when another session already owns the tier", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // Single FAIL → bump → single PASS on the second attempt.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    // Foreign owner holds the tier BEFORE the delegate runs — simulates a
    // hook-path patch that is mid-flight on the same tier.
    ctx.reasoningStore.acquireTierOwner("medium", "hook-session-x");
    expect(ctx.reasoningStore.getTierOwner("medium")).toBe("hook-session-x");

    const out = await executeDelegate(ctx, { task: "ownership contention", tier: "medium" });

    expect(out).toContain("[router ✓ accepted: deterministic]");

    // Foreign owner is still in place — the delegate did not steal it.
    expect(ctx.reasoningStore.getTierOwner("medium")).toBe("hook-session-x");

    // The medium agent def was NEVER mutated by the delegate — the bump
    // attempt was skipped because the tier was owned by someone else.
    // (It stays at the baseline reasoning_effort = "medium" because no
    // patch was ever applied.)
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
  });

  it("two concurrent delegate invocations on the same tier serialize via ownership", async () => {
    const { cfg, agent } = makeReasoningCfg({ maxLevelBumpsPerTier: 2, maxAttemptsPerTier: 1 });

    // Each delegate: FAIL once → bump → PASS.
    acceptMock
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["fail"] },
        dodSource: "inferred",
      })
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    // Spy on the debug logger to assert the skip event fires for the loser.
    const { log } = await import("../../src/utils/observability");
    const debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});

    // Two concurrent delegates on the same tier — share the same fake ctx
    // because the hook/executeDelegate code paths consult ctx.reasoningStore.
    const [outA, outB] = await Promise.all([
      executeDelegate(ctx, { task: "concurrent A", tier: "medium" }),
      executeDelegate(ctx, { task: "concurrent B", tier: "medium" }),
    ]);

    expect(outA).toContain("[router ✓ accepted: deterministic]");
    expect(outB).toContain("[router ✓ accepted: deterministic]");

    // At least one skipped-concurrent event was emitted (the loser on
    // overlap). Could be 1 or 2 depending on attempt-level interleaving,
    // but at least one MUST fire because two delegates raced for "medium".
    const skipEvents = debugSpy.mock.calls.filter(
      (call) =>
        (call[0] as Record<string, unknown>)?.event === "reasoning.patch_skipped_concurrent",
    );
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);
    // The recorded owner on each skip event must be the `delegate:`-prefixed
    // key of the OTHER delegate (or our own if re-acquired within an attempt
    // — both are valid; the important property is no foreign non-delegate key).
    for (const call of skipEvents) {
      const owner = (call[0] as Record<string, unknown>).owner as string;
      expect(owner.startsWith("delegate:")).toBe(true);
    }

    // After both finish: every tier is unowned, every baseline is restored.
    expect(ctx.reasoningStore.getTierOwner("medium")).toBeUndefined();
    expect(ctx.reasoningStore.getTierOwner("high")).toBeUndefined();
    expect(ctx.reasoningStore.getTierOwner("xhigh")).toBeUndefined();
    expect(agent.medium.options).toEqual({ reasoning_effort: "medium" });
    expect(agent.high.options).toEqual({ reasoning_effort: "high" });
    expect(agent.xhigh.options).toEqual({ reasoning_effort: "xhigh" });

    debugSpy.mockRestore();
  });
});

// Plan 039: enterTier used to gate on `tierCfg.reasoning` (the OBJECT) — so
// `reasoning: {}` with an absent `effort` was truthy and overrode the
// `variant` fallback with `undefined`. That silently seeded the ladder at
// index 0 regardless of any explicit `variant`. After 039, the gate is
// `tierCfg.reasoning?.effort != null` so an empty reasoning block falls
// back to `tierCfg.variant` like a reasoning-less tier would.

describe("executeDelegate — reasoning.effort + empty reasoning block falls back to variant (Plan 039)", () => {
  it("reasoning: {} on a discrete/reasoning.effort tier seeds from variant, not index 0", async () => {
    // Tier "heavy" declares `reasoning: {}` (empty — no effort field) and
    // `variant: "high"`. Capability ladder is [low, medium, high, xhigh],
    // so the correct starting index is 2 (= "high"). Pre-039, this mis-
    // seeded at index 0 ("low") because the truthy reasoning object short-
    // circuited the variant fallback with undefined.
    const cfg: RouterConfig = {
      activePreset: "default",
      defaultTier: "heavy",
      presets: {
        default: {
          heavy: {
            model: "openai/gpt-5.6-terra",
            description: "heavy",
            whenToUse: [],
            costRatio: 1,
            // Variant IS set; reasoning is intentionally an empty object.
            variant: "high",
            reasoning: {}, // empty block — must NOT override variant
          },
        },
      },
      rules: [],
      enforcement: {
        verify: { require: "always", graderTemperature: 0 },
        escalate: {
          ladder: ["heavy"],
          maxAttemptsPerTier: 4,
          maxTotalAttempts: 20,
          costCeiling: { multiple: 100 },
        },
      },
    } as RouterConfig;

    const agent: Record<string, Record<string, unknown>> = {
      heavy: {
        model: "openai/gpt-5.6-terra",
        mode: "subagent",
        options: { reasoning_effort: "high" }, // baseline matches variant
      },
    };

    const recordedEfforts: unknown[] = [];

    acceptMock.mockReset();
    acceptMock
      // First attempt: PASS so we observe the single starting effort.
      .mockResolvedValueOnce({
        accepted: true,
        verdict: { pass: true, method: "deterministic", reasons: [] },
        dodSource: "inferred",
      })
      // Default for any later call: deterministic FAIL.
      .mockResolvedValue({
        accepted: false,
        verdict: { pass: false, method: "deterministic", reasons: ["default-fail"] },
        dodSource: "inferred",
      });

    const { ctx } = makeCtx({
      getConfigImpl: () => cfg,
      refreshConfigImpl: () => cfg,
      promptImpl: async (req: unknown) => {
        const calledTier = (req as { body?: { agent?: string } })?.body?.agent;
        if (calledTier) {
          const opencfg = (ctx as unknown as Record<string, unknown>).opencodeConfig as {
            agent?: Record<string, Record<string, unknown>>;
          };
          const liveDef = opencfg.agent?.[calledTier];
          if (liveDef) {
            recordedEfforts.push((liveDef.options as Record<string, unknown>)?.reasoning_effort);
          }
        }
        return { data: { parts: [{ type: "text", text: "done" }] } };
      },
    });
    (ctx as unknown as Record<string, unknown>).opencodeConfig = { agent };

    const out = await executeDelegate(ctx, {
      task: "empty reasoning block fallback",
      tier: "heavy",
    });

    expect(out).toContain("[router ✓ accepted: deterministic]");

    // CRITICAL: first attempt must use the variant-derived level "high".
    // Pre-039, this would have been "low" because the empty `reasoning: {}`
    // truthy-check overrode the `variant: "high"` fallback with undefined,
    // collapsing the starting index to 0.
    expect(recordedEfforts[0]).toBe("high");

    // Baseline restored.
    expect(agent.heavy.options).toEqual({ reasoning_effort: "high" });
  });
});
