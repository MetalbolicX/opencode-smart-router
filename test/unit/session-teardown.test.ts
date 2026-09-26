import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/utils/observability";
import { abortSessionWithTimeout, clearSessionStores } from "../../src/plugin/session-teardown";
import type { PluginContext } from "../../src/plugin/context";

const makeContext = (abort: () => Promise<unknown>): PluginContext => {
  const clear = vi.fn();
  const unregister = vi.fn();
  return {
    changedFileStore: { clear },
    sessionStore: { unregister },
    guardStore: { clear: vi.fn() },
    trajectoryStore: { clear: vi.fn() },
    plugin: { client: { session: { abort } } },
  } as PluginContext;
};

describe("shared session teardown", () => {
  afterEach(() => vi.restoreAllMocks());

  it("clears every store when one clear fails and preserves the event name", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const abort = vi.fn(async () => ({}));
    const ctx = makeContext(abort);
    vi.mocked(ctx.changedFileStore.clear).mockImplementation(() => {
      throw new Error("clear failed");
    });

    await clearSessionStores(ctx, "sid", "delegate.cleanup_failed");

    expect(ctx.sessionStore.unregister).toHaveBeenCalledWith("sid");
    expect(ctx.guardStore.clear).toHaveBeenCalledWith("sid");
    expect(ctx.trajectoryStore.clear).toHaveBeenCalledWith("sid");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "delegate.cleanup_failed",
      store: "changedFileStore.clear",
      sid: "sid",
      error: "clear failed",
    }));
  });

  it("preserves the fanout cleanup event name", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ctx = makeContext(async () => ({}));
    vi.mocked(ctx.guardStore.clear).mockImplementation(() => {
      throw new Error("guard failed");
    });

    await clearSessionStores(ctx, "worker", "fanout.worker_cleanup_failed");

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "fanout.worker_cleanup_failed",
      store: "guardStore.clear",
      sid: "worker",
      error: "guard failed",
    }));
  });

  it("resolves when abort succeeds and rejects when abort times out", async () => {
    const success = makeContext(async () => ({}));
    await expect(abortSessionWithTimeout(success, "sid", "test abort")).resolves.toBeUndefined();

    const pending = makeContext(() => new Promise(() => {}));
    await expect(abortSessionWithTimeout(pending, "sid", "test abort", 1)).rejects.toThrow("test abort");
  });
});
