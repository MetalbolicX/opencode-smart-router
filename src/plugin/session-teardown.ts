import { log } from "../utils/observability";

export { isAbortLikeError } from "../utils/error-classify";

type SessionStoreContext = {
  changedFileStore: { clear(sid: string): void };
  sessionStore: { unregister(sid: string): void };
  guardStore: { clear(sid: string): void };
  trajectoryStore: { clear(sid: string): void };
};
type AbortContext = {
  plugin: {
    client: {
      session: { abort(input: { path: { id: string } }): Promise<unknown> };
    };
  };
};

export const clearSessionStores = async (
  ctx: SessionStoreContext,
  sid: string,
  event: "delegate.cleanup_failed" | "fanout.worker_cleanup_failed",
): Promise<void> => {
  const clears: Array<[string, () => void]> = [
    ["changedFileStore.clear", () => ctx.changedFileStore.clear(sid)],
    ["sessionStore.unregister", () => ctx.sessionStore.unregister(sid)],
    ["guardStore.clear", () => ctx.guardStore.clear(sid)],
    ["trajectoryStore.clear", () => ctx.trajectoryStore.clear(sid)],
  ];

  for (const [store, clear] of clears) {
    try {
      clear();
    } catch (err) {
      log.warn({ event, store, sid, error: err instanceof Error ? err.message : String(err) });
    }
  }
};

export const abortSessionWithTimeout = async (
  ctx: AbortContext,
  sid: string,
  label: string,
  timeoutMs = 10_000,
): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.plugin.client.session.abort({ path: { id: sid } }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};
