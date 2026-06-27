import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "../../src/plugin/context";

// ---------------------------------------------------------------------------
// Graceful shutdown lifecycle (PR5).
//
// Covers:
//   - PluginContext.dispose() is exposed on the surface and idempotent.
//   - Cleanup tasks run in reverse-registration (LIFO) order.
//   - Cleanup tasks run even when one throws.
//   - The config cache is invalidated on dispose so a late read triggers
//     a fresh load.
//   - The double-shutdown path (opencode hot-reload) is a no-op the second
//     time, so a half-cleaned context cannot be re-flushed.
//   - `Hooks.dispose` (the opencode plugin lifecycle hook) is wired and
//     delegates to `ctx.dispose()`; emits the structured lifecycle.shutdown
//     event at the documented phases.
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;
let origCwd: string;

beforeEach(async () => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origXDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
  origCwd = process.cwd();

  tmpHome = join(
    tmpdir(),
    `oc-shutdown-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  delete process.env["XDG_CONFIG_HOME"];

  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

afterEach(async () => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  if (origXDG_CONFIG_HOME === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = origXDG_CONFIG_HOME;
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
  vi.restoreAllMocks();
});

describe("PluginContext.dispose()", () => {
  it("is exposed on the context", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    expect(typeof ctx.dispose).toBe("function");
  });

  it("returns a promise that resolves on success", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    await expect(ctx.dispose()).resolves.toBeUndefined();
  });

  it("flips state.shutdownStarted on first call", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    expect(ctx.state.shutdownStarted).toBe(false);
    await ctx.dispose();
    expect(ctx.state.shutdownStarted).toBe(true);
  });

  it("is idempotent — second call is a no-op", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    let runs = 0;
    ctx.state.cleanupTasks.push(() => {
      runs += 1;
    });
    await ctx.dispose();
    await ctx.dispose();
    await ctx.dispose();
    expect(runs).toBe(1);
  });

  it("runs cleanup tasks in reverse registration order (LIFO)", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const order: number[] = [];
    ctx.state.cleanupTasks.push(() => order.push(1));
    ctx.state.cleanupTasks.push(() => order.push(2));
    ctx.state.cleanupTasks.push(() => order.push(3));
    await ctx.dispose();
    expect(order).toEqual([3, 2, 1]);
  });

  it("clears the cleanupTasks registry after dispose", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    ctx.state.cleanupTasks.push(() => undefined);
    expect(ctx.state.cleanupTasks.length).toBe(1);
    await ctx.dispose();
    expect(ctx.state.cleanupTasks.length).toBe(0);
  });

  it("keeps running cleanup tasks even when one throws", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const order: string[] = [];
    ctx.state.cleanupTasks.push(() => order.push("a"));
    ctx.state.cleanupTasks.push(() => {
      throw new Error("cleanup boom");
    });
    ctx.state.cleanupTasks.push(() => order.push("c"));
    await ctx.dispose();
    expect(order).toEqual(["c", "a"]);
  });

  it("invalidates the config cache so the next read re-loads from disk", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    // Warm the cache.
    const before = await ctx.getConfig();
    expect(before).toBeDefined();
    await ctx.dispose();
    // After dispose, the cache is invalidated — the next getConfig()
    // must return a NEW reference (proving a fresh read happened).
    const after = await ctx.getConfig();
    expect(after).not.toBe(before);
  });

  it("never throws even if cleanup tasks throw", async () => {
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    ctx.state.cleanupTasks.push(() => {
      throw new Error("first boom");
    });
    ctx.state.cleanupTasks.push(() => {
      throw new Error("second boom");
    });
    await expect(ctx.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hooks.dispose — the opencode plugin lifecycle hook.
// ---------------------------------------------------------------------------

describe("Hooks.dispose — opencode plugin lifecycle", () => {
  it("is exposed on the runtime hooks record", async () => {
    const { assembleRuntimeHooks } = await import("../../src/plugin/runtime");
    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const hooks = assembleRuntimeHooks(ctx, ctx.activeTiersAtLoad, false);
    expect(typeof hooks.dispose).toBe("function");
  });

  it("calls ctx.dispose() and emits lifecycle.shutdown events at the documented phases", async () => {
    const { assembleRuntimeHooks } = await import("../../src/plugin/runtime");
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();

    const ctx = await createPluginContext({ directory: tmpHome } as any);
    const hooks = assembleRuntimeHooks(ctx, ctx.activeTiersAtLoad, false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await hooks.dispose?.();

    const lines = logSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((l) => l.includes("lifecycle.shutdown"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // The first event announces "starting"; the second announces "complete".
    expect(lines[0]).toContain('"phase":"starting"');
    expect(lines[lines.length - 1]).toContain('"phase":"complete"');
  });

  it("emits lifecycle.shutdown with phase=error when ctx.dispose() throws", async () => {
    const { assembleRuntimeHooks } = await import("../../src/plugin/runtime");
    const { __resetLoggerForTest } = await import("../../src/utils/observability");
    process.env["MODEL_ROUTER_LOG_LEVEL"] = "debug";
    __resetLoggerForTest();

    const ctx = await createPluginContext({ directory: tmpHome } as any);
    // Sabotage ctx.dispose so it throws — the dispose hook must catch it.
    vi.spyOn(ctx, "dispose").mockImplementation(() => Promise.reject(new Error("synthetic boom")));
    const hooks = assembleRuntimeHooks(ctx, ctx.activeTiersAtLoad, false);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await hooks.dispose?.();

    // Error-level events land on stderr (console.error).
    const lines = errSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .filter((l) => l.includes("lifecycle.shutdown"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('"phase":"error"');
    expect(lines[0]).toContain("synthetic boom");
  });

  it("calls ctx.dispose() exactly once even when the hook fires twice", async () => {
    // The hook itself fires the lifecycle events each time it runs, but
    // the underlying ctx.dispose() short-circuits after the first call
    // (idempotency contract). The observable check: cleanup tasks run
    // exactly once across two hook invocations.
    const { assembleRuntimeHooks } = await import("../../src/plugin/runtime");

    const ctx = await createPluginContext({ directory: tmpHome } as any);
    let cleanupRuns = 0;
    ctx.state.cleanupTasks.push(() => {
      cleanupRuns += 1;
    });

    const hooks = assembleRuntimeHooks(ctx, ctx.activeTiersAtLoad, false);
    await hooks.dispose?.();
    await hooks.dispose?.();
    await hooks.dispose?.();

    expect(cleanupRuns).toBe(1);
    expect(ctx.state.shutdownStarted).toBe(true);
  });
});
