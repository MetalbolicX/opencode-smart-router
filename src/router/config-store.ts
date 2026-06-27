// ---------------------------------------------------------------------------
// src/router/config-store.ts — Per-instance async config cache.
//
// `createConfigStore({ cwd })` wraps the pure `readMergedConfig({ cwd })`
// helper (from `./config-loader.ts`) with a per-instance cache. Each
// PluginContext owns one ConfigStore; one instance's refresh no longer
// mutates another instance's cached result.
//
// PR3b changes:
//   - `read()`, `refresh()`, and `getFresh()` are now async. The legacy
//     sync surface was removed because every layer / state read uses
//     `node:fs/promises` end-to-end.
//   - Cache shape upgraded to `{ value, loadedAt }`. `loadedAt` is the
//     millisecond timestamp captured at the moment the disk read
//     returned; PR5 wires a 30s TTL by inspecting it. The shape change
//     is additive: `read()` still returns the unwrapped `value`, so
//     existing callers do not need to be aware of the envelope.
//   - `getFresh()` always forces a disk read and replaces the cache.
//     Mirrors `refresh()` here; the distinction matters once PR5 wires
//     TTL (where `read()` may serve a stale-but-young value, and
//     `getFresh()` is the "command-driven, always-fresh" escape hatch).
// ---------------------------------------------------------------------------

import type { RouterConfig } from "./config.types";
import { readMergedConfig } from "./config-loader";

/**
 * Internal cache envelope. `loadedAt` is the millisecond timestamp at
 * which the disk read returned; PR5 reads it to decide whether to
 * serve the cached value or force a refresh.
 */
interface CachedConfig {
  value: RouterConfig;
  loadedAt: number;
}

/**
 * Per-instance async config cache. One ConfigStore per PluginContext;
 * the cache is private to the store and never shared across instances.
 */
export interface ConfigStore {
  /** Return the cached config (re-read from disk if the cache is empty). */
  read(): Promise<RouterConfig>;
  /** Force a fresh read from disk, replace the cached value, and return it.
   *  `reason` is forwarded to the structured log in PR5; today it is unused. */
  refresh(reason?: string): Promise<RouterConfig>;
  /**
   * Always force a disk read (never serves the cache). Used by command
   * handlers that want the most up-to-date config possible — the legacy
   * `refresh()` semantics. PR5 splits this from `refresh()` so the
   * background TTL driver can call `refresh("ttl")` while the user-
   * facing `/preset` command calls `getFresh()`.
   */
  getFresh(): Promise<RouterConfig>;
  /** Drop the cached value so the next read re-loads from disk. */
  invalidate(): void;
}

/**
 * Build a per-instance `ConfigStore` rooted at `cwd`. The store caches
 * the resolved `RouterConfig` so `read()` is a no-op after the first
 * call until `refresh()`, `getFresh()`, or `invalidate()` runs.
 */
export const createConfigStore = (opts: { cwd: string }): ConfigStore => {
  let cached: CachedConfig | null = null;

  const load = async (): Promise<CachedConfig> => {
    const value = await readMergedConfig(opts);
    cached = { value, loadedAt: Date.now() };
    return cached;
  };

  return {
    async read(): Promise<RouterConfig> {
      if (cached) return cached.value;
      const fresh = await load();
      return fresh.value;
    },
    async refresh(_reason?: string): Promise<RouterConfig> {
      const fresh = await load();
      return fresh.value;
    },
    async getFresh(): Promise<RouterConfig> {
      const fresh = await load();
      return fresh.value;
    },
    invalidate(): void {
      cached = null;
    },
  };
};
