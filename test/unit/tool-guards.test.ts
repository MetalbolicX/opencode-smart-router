import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BeforeResult, guardBeforeCall } from "../../src/guard/enforce";
import { createGuardStore } from "../../src/guard/store";
import type { PluginContext } from "../../src/plugin/context";
import {
  applyOrchestratorReasoningPatch,
  assertNestedDelegationAllowed,
  runSubagentGuard,
} from "../../src/plugin/hooks/tool-guards";
import type { HookPayload } from "../../src/plugin/types";
import type { reasoningLevel as ReasoningLevel } from "../../src/reasoning/Reasoning.res.mjs";
import { createReasoningStore } from "../../src/reasoning/store";
import type { Preset, RouterConfig } from "../../src/router/config";
import type { TierConfig } from "../../src/router/config.types";
import type { READ_ONLY_TOOLS } from "../../src/router/tools";
import { __resetLoggerForTest } from "../../src/utils/observability";

// ---------------------------------------------------------------------------
// Fakes for tool-guards tests.
//
// The guards operate on a narrowed slice of PluginContext: sessionStore,
// opencodeConfig, reasoningStore, getConfig(), getFreshConfig(). Other
// fields are not consulted. We build a minimal stub that records call
// counts so we can assert order and per-helper behaviour.
// ---------------------------------------------------------------------------

interface SessionStoreStub {
  isSubagent: (sid: string) => boolean;
  isDescendant?: (sid: string) => boolean;
  isTrivial: (sid: string) => boolean;
  getTier: (sid: string) => string | null;
}

interface GuardHarness {
  ctx: PluginContext;
  sessionStore: SessionStoreStub;
  reasoningStore: ReturnType<typeof createReasoningStore>;
}

const makeGuardHarness = (opts?: { configOverrides?: Partial<RouterConfig> }): GuardHarness => {
  const cfg: RouterConfig = {
    activePreset: "default",
    defaultTier: "fast",
    presets: {
      default: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast",
          whenToUse: [],
          variant: "thinking",
        } as TierConfig,
      },
    },
    rules: [],
    ...(opts?.configOverrides ?? {}),
  } as RouterConfig;
  const preset: Preset = cfg.presets["default"]!;

  const sessionStore: SessionStoreStub = {
    isSubagent: () => false,
    isTrivial: () => false,
    getTier: () => "fast",
  };

  const reasoningStore = createReasoningStore();
  const guardStore = createGuardStore();
  const trajectoryStore = {
    recordToolEvent: () => undefined,
    ensure: () => undefined,
    dump: () => null,
  };

  const ctx = {
    sessionStore: sessionStore as unknown as PluginContext["sessionStore"],
    reasoningStore,
    guardStore,
    trajectoryStore: trajectoryStore as unknown as PluginContext["trajectoryStore"],
    opencodeConfig: { agent: {} },
    getConfig: async () => cfg,
    getFreshConfig: async () => cfg,
    state: { bypassed: false, cleanupTasks: [], shutdownStarted: false },
  } as unknown as PluginContext;

  return { ctx, sessionStore, reasoningStore, ...{ cfg, preset } } as GuardHarness;
};

// ---------------------------------------------------------------------------
// assertNestedDelegationAllowed
//
// Verbatim from hooks.ts lines 127-133. Throws when:
//   - tool ∈ {task, delegate} AND
//   - sessionStore.isDescendant(sid) is true.
// Defensive: when isDescendant is not a function, the helper is a no-op.
// ---------------------------------------------------------------------------

describe("assertNestedDelegationAllowed", () => {
  it("throws when tool is 'task' and session is a descendant", () => {
    const sessionStore: SessionStoreStub = {
      isDescendant: () => true,
      isSubagent: () => false,
      isTrivial: () => false,
      getTier: () => null,
    };
    expect(() => assertNestedDelegationAllowed("sid-child", "task", sessionStore as never)).toThrow(
      /Nested subagent delegation is not allowed/,
    );
  });

  it("throws when tool is 'delegate' and session is a descendant", () => {
    const sessionStore: SessionStoreStub = {
      isDescendant: () => true,
      isSubagent: () => false,
      isTrivial: () => false,
      getTier: () => null,
    };
    expect(() =>
      assertNestedDelegationAllowed("sid-child", "delegate", sessionStore as never),
    ).toThrow(/Nested subagent delegation is not allowed/);
  });

  it("does not throw when tool is 'task' but session is not a descendant", () => {
    const sessionStore: SessionStoreStub = {
      isDescendant: () => false,
      isSubagent: () => false,
      isTrivial: () => false,
      getTier: () => null,
    };
    expect(() =>
      assertNestedDelegationAllowed("sid-orch", "task", sessionStore as never),
    ).not.toThrow();
  });

  it("does not throw for non-task / non-delegate tools even on a descendant", () => {
    const sessionStore: SessionStoreStub = {
      isDescendant: () => true,
      isSubagent: () => true,
      isTrivial: () => false,
      getTier: () => "fast",
    };
    expect(() =>
      assertNestedDelegationAllowed("sid-child", "read", sessionStore as never),
    ).not.toThrow();
    expect(() =>
      assertNestedDelegationAllowed("sid-child", "bash", sessionStore as never),
    ).not.toThrow();
  });

  it("is a defensive no-op when isDescendant is not a function on the store", () => {
    const sessionStore: SessionStoreStub = {
      // intentionally omit isDescendant
      isSubagent: () => true,
      isTrivial: () => false,
      getTier: () => "fast",
    };
    // Should not throw — older session store implementations without
    // isDescendant are tolerated.
    expect(() =>
      assertNestedDelegationAllowed("sid-child", "task", sessionStore as never),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyOrchestratorReasoningPatch
//
// Verbatim from hooks.ts lines 162-309 (return; replaced with return true;
// and the closing brace added so the helper is self-contained).
// Returns `true` when the orchestrator path was consumed (dispatcher must
// NOT fall through to subagent guard). Returns `false` when the caller is
// not on the orchestrator path.
// ---------------------------------------------------------------------------

describe("applyOrchestratorReasoningPatch", () => {
  beforeEach(() => {
    __resetLoggerForTest();
  });

  it("returns true for an orchestrator task call when the policy resolves a patch", async () => {
    // Mirror the `setupReasoningHarness` pattern from plugin-hooks.test.ts:
    //   - tier carries a binary capability (`variant: "thinking"`)
    //   - live agent def starts at variant "low" so the patch is observable
    //   - reasoning policy mode "manual" + override "elevated" triggers a patch
    const { ctx } = makeGuardHarness({
      configOverrides: {
        reasoningPolicy: { mode: "manual" },
      },
    });
    const baseline = {
      model: "anthropic/claude-haiku-4-5",
      mode: "subagent",
      description: "fast",
      prompt: "test prompt",
      variant: "low",
    };
    const agentDef = { ...baseline };
    (ctx.opencodeConfig as { agent?: Record<string, Record<string, unknown>> }).agent = {
      fast: agentDef,
    };
    ctx.reasoningStore.setBaseline("fast", structuredClone(baseline));
    ctx.reasoningStore.setOverride("sid-orch", "elevated");

    const consumed = await applyOrchestratorReasoningPatch({
      ctx,
      sid: "sid-orch",
      tool: "task",
      output: { args: { subagent_type: "fast", prompt: "x", description: "y" } } as HookPayload,
    });

    expect(consumed).toBe(true);
    expect(agentDef.variant).toBe("thinking");
  });

  it("returns false when sid is undefined (caller is not the orchestrator path)", async () => {
    const { ctx } = makeGuardHarness();
    const consumed = await applyOrchestratorReasoningPatch({
      ctx,
      sid: undefined,
      tool: "task",
      output: {} as HookPayload,
    });
    expect(consumed).toBe(false);
  });

  it("returns false when tool is not 'task'", async () => {
    const { ctx } = makeGuardHarness();
    const consumed = await applyOrchestratorReasoningPatch({
      ctx,
      sid: "sid-orch",
      tool: "read",
      output: {} as HookPayload,
    });
    expect(consumed).toBe(false);
  });

  it("returns false when the caller is already a subagent", async () => {
    const { ctx } = makeGuardHarness();
    ctx.sessionStore.isSubagent = () => true;
    const consumed = await applyOrchestratorReasoningPatch({
      ctx,
      sid: "sid-sub",
      tool: "task",
      output: {} as HookPayload,
    });
    expect(consumed).toBe(false);
  });

  it("returns true (no mutation) when opencodeConfig.agent is undefined", async () => {
    const { ctx } = makeGuardHarness();
    (ctx as { opencodeConfig?: unknown }).opencodeConfig = undefined;
    const consumed = await applyOrchestratorReasoningPatch({
      ctx,
      sid: "sid-orch",
      tool: "task",
      output: { args: { subagent_type: "fast" } } as HookPayload,
    });
    // Gate matched: orchestrator task call, no agent map to mutate.
    // The helper reports "consumed" so the dispatcher does NOT fall
    // through to the subagent guard for a non-subagent orchestrator.
    expect(consumed).toBe(true);
  });

  it("re-throws a __tierGuardError from resolveTierModelGuard (does NOT swallow it)", async () => {
    const { ctx } = makeGuardHarness({
      configOverrides: {
        reasoningPolicy: { mode: "manual" },
      },
    });
    const agentDef = { mode: "subagent", variant: "low", prompt: "p" } as Record<string, unknown>;
    (ctx.opencodeConfig as { agent?: Record<string, Record<string, unknown>> }).agent = {
      fast: agentDef,
    };

    // Force the runtime guard to fail by giving the tier an obviously
    // malformed model string. The runtime tier-model guard catches
    // provider/model parse errors and surfaces them with __tierGuardError.
    // We override ctx.getConfig to return a config with a broken model.
    const cfg = await ctx.getConfig();
    (cfg as RouterConfig).presets.default!.fast = {
      model: "not-a-valid-model",
      description: "broken",
      whenToUse: [],
    } as TierConfig;
    ctx.getConfig = async () => cfg;
    ctx.reasoningStore.setOverride("sid-orch", "elevated");

    await expect(
      applyOrchestratorReasoningPatch({
        ctx,
        sid: "sid-orch",
        tool: "task",
        output: { args: { subagent_type: "fast", prompt: "x" } } as HookPayload,
      }),
    ).rejects.toThrow();
  });

  it("swallows a non-guard error (best-effort patch) and still reports consumed=true", async () => {
    const { ctx } = makeGuardHarness({
      configOverrides: {
        reasoningPolicy: { mode: "manual" },
      },
    });
    const agentDef = { mode: "subagent", variant: "low", prompt: "p" } as Record<string, unknown>;
    (ctx.opencodeConfig as { agent?: Record<string, Record<string, unknown>> }).agent = {
      fast: agentDef,
    };
    // Freeze the agent def so applyReasoningPatch's `agentDef.variant = ...`
    // assignment throws (non-guard, patch-internal) — the helper must
    // log a warning and return true rather than propagating.
    Object.freeze(agentDef);

    const consumed = await applyOrchestratorReasoningPatch({
      ctx,
      sid: "sid-orch",
      tool: "task",
      output: { args: { subagent_type: "fast", prompt: "x" } } as HookPayload,
    });
    expect(consumed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSubagentGuard
//
// Verbatim from hooks.ts lines 311-351. Throws when:
//   - subagent session calls the built-in `task` tool (nested delegation)
//   - guardBeforeCall returns res.block === true
// Records a trajectory event on block.
// ---------------------------------------------------------------------------

describe("runSubagentGuard", () => {
  it("throws when a subagent session calls the built-in 'task' tool", async () => {
    const { ctx } = makeGuardHarness();
    ctx.sessionStore.isSubagent = () => true;
    await expect(
      runSubagentGuard({
        ctx,
        sid: "sid-sub",
        tool: "task",
        output: { args: {} } as HookPayload,
      }),
    ).rejects.toThrow(/Nested subagent delegation is not allowed/);
  });

  it("is a no-op when the session is not a subagent", async () => {
    const { ctx } = makeGuardHarness();
    ctx.sessionStore.isSubagent = () => false;
    const guardBeforeCallSpy = vi.fn();
    (ctx as { guardStore?: unknown }).guardStore = {
      get: () => null,
      set: guardBeforeCallSpy,
    };
    await expect(
      runSubagentGuard({
        ctx,
        sid: "sid-orch",
        tool: "read",
        output: { args: {} } as HookPayload,
      }),
    ).resolves.toBeUndefined();
    // guardBeforeCall is invoked only for subagent sessions.
    expect(guardBeforeCallSpy).not.toHaveBeenCalled();
  });

  it("calls guardBeforeCall for a subagent+non-task tool and returns when no block", async () => {
    const { ctx } = makeGuardHarness();
    ctx.sessionStore.isSubagent = () => true;

    // Provide an enforced cfg with a real guard store so guardBeforeCall can
    // evaluate. Use a benign command (`ls`) that does NOT match the
    // anti-self-script regex, so the helper returns without throwing.
    const enforcedCfg: RouterConfig = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "f",
            whenToUse: [],
          } as TierConfig,
        },
      },
      rules: [],
      enforcement: { mode: "enforced" },
    } as RouterConfig;
    ctx.getConfig = async () => enforcedCfg;

    await expect(
      runSubagentGuard({
        ctx,
        sid: "sid-sub",
        tool: "bash",
        output: { args: { command: "ls" } } as HookPayload,
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when guardBeforeCall returns res.block === true", async () => {
    const { ctx } = makeGuardHarness();
    ctx.sessionStore.isSubagent = () => true;

    // Enforced + trivial:false + self-script args (`node -e ...`) =>
    // guardBeforeCall returns block:true with anti_self_script.
    const enforcedCfg: RouterConfig = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "f",
            whenToUse: [],
          } as TierConfig,
        },
      },
      rules: [],
      enforcement: { mode: "enforced" },
    } as RouterConfig;
    ctx.getConfig = async () => enforcedCfg;

    await expect(
      runSubagentGuard({
        ctx,
        sid: "sid-sub",
        tool: "bash",
        output: { args: { command: "node -e 'process.exit(0)'" } } as HookPayload,
      }),
    ).rejects.toThrow(/DENIED|self.?script|node -e/i);
  });

  it("records a trajectory tool-event on block (blocked: true, selfScript marker)", async () => {
    const { ctx } = makeGuardHarness();
    ctx.sessionStore.isSubagent = () => true;

    const recorded: Array<{ tool: string; blocked?: boolean; selfScript?: boolean }> = [];
    (ctx.trajectoryStore as unknown as { recordToolEvent: (sid: string, ev: unknown) => void }) = {
      recordToolEvent: (_sid: string, ev: unknown) => {
        recorded.push(ev as { tool: string; blocked?: boolean; selfScript?: boolean });
      },
    };

    const enforcedCfg: RouterConfig = {
      activePreset: "default",
      defaultTier: "fast",
      presets: {
        default: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "f",
            whenToUse: [],
          } as TierConfig,
        },
      },
      rules: [],
      enforcement: { mode: "enforced" },
    } as RouterConfig;
    ctx.getConfig = async () => enforcedCfg;

    await expect(
      runSubagentGuard({
        ctx,
        sid: "sid-sub",
        tool: "bash",
        output: { args: { command: "node -e 'process.exit(0)'" } } as HookPayload,
      }),
    ).rejects.toThrow();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].blocked).toBe(true);
    expect(recorded[0].selfScript).toBe(true);
  });

  it("is a no-op when sid is undefined", async () => {
    const { ctx } = makeGuardHarness();
    await expect(
      runSubagentGuard({
        ctx,
        sid: undefined,
        tool: "bash",
        output: { args: {} } as HookPayload,
      }),
    ).resolves.toBeUndefined();
  });
});

// Reference type-only imports so biome doesn't drop the unused symbols
// (these imports are used by the assertions above; keeping them surfaced
// makes the test file self-documenting about what it depends on).
const _typeRefBeforeResult: BeforeResult | undefined = undefined;
const _typeRefLevel: ReasoningLevel | undefined = undefined;
const _typeRefReadOnly: typeof READ_ONLY_TOOLS | undefined = undefined;
void _typeRefBeforeResult;
void _typeRefLevel;
void _typeRefReadOnly;
void guardBeforeCall;
