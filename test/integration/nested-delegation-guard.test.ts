import { describe, expect, it } from "vitest";
import { createSessionStore } from "../../src/router/sessions";
import { handleToolExecuteBefore } from "../../src/plugin/hooks";
import { createReasoningStore } from "../../src/reasoning/store";
import type { PluginContext } from "../../src/plugin/context";

// ---------------------------------------------------------------------------
// Integration test: real store + real hook wiring for depth-based guard.
//
// Uses the real createSessionStore() (not a mock) to prove the
// store→handler wiring from session.created through handleToolExecuteBefore.
// This is the test that proves the real end-to-end path, complementing the
// mock-based unit tests in plugin-hooks.test.ts.
// ---------------------------------------------------------------------------

const makeRealHarness = () => {
  const sessionStore = createSessionStore();
  const reasoningStore = createReasoningStore();

  const ctx = {
    plugin: { directory: "/tmp", client: {} as any } as any,
    initialConfig: {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "fast",
            whenToUse: [],
          },
        },
      },
      rules: [],
      enforcement: { verify: { graderTemperature: 0 } },
    } as any,
    activeTiersAtLoad: {
      fast: {
        model: "anthropic/claude-haiku-4-5",
        description: "fast",
        whenToUse: [],
      },
    } as any,
    getConfig: async () => ctx.initialConfig,
    refreshConfig: async () => ctx.initialConfig,
    getFreshConfig: async () => ctx.initialConfig,
    dispose: async () => {},
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
    sessionStore,
    trajectoryStore: {
      ensure: () => {},
      recordToolEvent: () => {},
      dump: () => null,
    },
    guardStore: { get: () => null, clear: () => {} },
    changedFileStore: { record: () => {}, get: () => [], clear: () => {} },
    reasoningStore,
    graderSessions: new Set<string>(),
    verifyMutex: {} as any,
    seams: { exec: {} as any, fs: {} as any },
    opencodeConfig: {
      agent: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          mode: "subagent",
          description: "fast",
          prompt: "test",
          variant: "low",
        },
      },
    },
  } as unknown as PluginContext;

  return { ctx, sessionStore };
};

describe("nested-delegation-guard — real store + real hook wiring", () => {
  it("depth-1 child task is blocked by the depth guard", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    // 1) session.created fires for the orchestrator's child session.
    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });

    // The child is not a subagent per se (not registered via chat.message or
    // delegate), but it is a descendant (depth >= 1). The depth guard checks
    // isDescendant() which uses depth() — verify depth is 1.
    expect(sessionStore.depth("sid-child")).toBe(1);
    expect(sessionStore.isDescendant("sid-child")).toBe(true);

    // 2) The child tries to call "task" — this must be blocked.
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-child", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-1 child delegate is blocked by the depth guard", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-child")).toBe(1);

    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-child", tool: "delegate", args: { task: "do work" } },
        { args: { task: "do work" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-0 orchestrator task is NOT blocked", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    // Orchestrator has no parent (root session).
    sessionStore.registerFromSessionCreated({ sessionID: "sid-orch", parentID: null as any });
    expect(sessionStore.depth("sid-orch")).toBe(0);
    expect(sessionStore.isDescendant("sid-orch")).toBe(false);

    // Orchestrator calling task is fine (reasoning-patch path runs).
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-orch", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("depth-2 grandchild task is blocked", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    sessionStore.registerFromSessionCreated({ sessionID: "sid-grandchild", parentID: "sid-child" });
    expect(sessionStore.depth("sid-grandchild")).toBe(2);
    expect(sessionStore.isDescendant("sid-grandchild")).toBe(true);

    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-grandchild", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("depth-1 child read-only tool is NOT blocked", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-child")).toBe(1);

    // Read-only tools pass through to guardBeforeCall (not blocked by depth guard).
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-child", tool: "read", args: { file_path: "a.ts" } },
        { args: { file_path: "a.ts" } },
      ),
    ).resolves.toBeUndefined();
  });

  it("unregister clears depth tracking: child is not a descendant after unregister", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    sessionStore.registerFromSessionCreated({ sessionID: "sid-child", parentID: "sid-orch" });
    expect(sessionStore.depth("sid-child")).toBe(1);
    expect(sessionStore.isDescendant("sid-child")).toBe(true);

    sessionStore.unregister("sid-child");

    // After unregister the session is gone from tracking.
    expect(sessionStore.depth("sid-child")).toBe(0);
    expect(sessionStore.isDescendant("sid-child")).toBe(false);
  });

  it("session.created without parentID: depth 0, not a descendant", async () => {
    const { ctx, sessionStore } = makeRealHarness();

    // A root session (no parentID) — depth 0.
    sessionStore.registerFromSessionCreated({ sessionID: "sid-root", parentID: null as any });
    expect(sessionStore.depth("sid-root")).toBe(0);
    expect(sessionStore.isDescendant("sid-root")).toBe(false);

    // Root session calling task is not blocked.
    await expect(
      handleToolExecuteBefore(
        ctx,
        { sessionID: "sid-root", tool: "task", args: { subagent_type: "fast" } },
        { args: { subagent_type: "fast" } },
      ),
    ).resolves.toBeUndefined();
  });
});
