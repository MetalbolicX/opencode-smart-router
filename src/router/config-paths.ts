// ---------------------------------------------------------------------------
// src/router/config-paths.ts — XDG-aware path resolution for config + state.
//
// Resolves where to look for tiers.json (global override) and the persisted
// runtime state file. Order:
//   1. If `$XDG_CONFIG_HOME` is set, use it as the root.
//   2. Otherwise, fall back to `$HOME/.config`.
//   3. On Windows, where `$HOME` may be unreliable for path-rooted configs,
//      fall back to `$USERPROFILE/.config` when `$HOME` is unset.
//
// The state file has TWO candidate locations so existing installs keep
// working without manual migration: `statePreferred` (XDG) and
// `stateLegacy` (`$HOME/.config/opencode/...`). Readers prefer the
// preferred location and fall back to legacy; writers always target the
// preferred location. The first successful write migrates the user
// forward; subsequent reads at the new location become authoritative.
//
// All functions here are PURE — no fs, no process side effects beyond
// reading `process.env`. The cache lives at the module level so repeated
// calls in a single process stay cheap; tests can call `__resetPathsForTest`
// to force a fresh resolve when env vars change between cases.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolved on-disk locations for global config + state. Returned by
 * `resolveConfigPaths()`. `stateLegacy` is always populated so the read
 * fallback can target it without re-deriving from env.
 */
export interface ResolvedConfigPaths {
  /** Absolute path to the global `tiers.json` (XDG or legacy). */
  globalConfig: string;
  /** Absolute path to the preferred state file location (XDG when set). */
  statePreferred: string;
  /** Absolute path to the legacy state file location (`$HOME/.config/opencode/...`). */
  stateLegacy: string;
}

// ---------------------------------------------------------------------------
// Internal: resolve the XDG/legacy config root.
// ---------------------------------------------------------------------------

/**
 * Resolve the root directory that holds XDG-style config files.
 *
 * Precedence:
 *   1. `$XDG_CONFIG_HOME` if set and non-empty.
 *   2. `$HOME/.config` if `$HOME` is set.
 *   3. `$USERPROFILE/.config` as a Windows fallback when `$HOME` is missing.
 *   4. The result of `os.homedir()` joined with `.config` as the final fallback.
 *
 * Always returns an absolute path. Never throws.
 */
export const resolveConfigRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env["XDG_CONFIG_HOME"];
  if (typeof xdg === "string" && xdg.trim().length > 0) {
    return xdg;
  }
  const home = env["HOME"];
  if (typeof home === "string" && home.trim().length > 0) {
    return join(home, ".config");
  }
  const userProfile = env["USERPROFILE"];
  if (typeof userProfile === "string" && userProfile.trim().length > 0) {
    return join(userProfile, ".config");
  }
  return join(homedir(), ".config");
};

/**
 * Resolve the legacy config root (`$HOME/.config` regardless of XDG).
 * Used to compute the legacy state file location so the read fallback
 * can target a path that mirrors the historical install layout.
 */
export const resolveLegacyConfigRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env["HOME"];
  if (typeof home === "string" && home.trim().length > 0) {
    return join(home, ".config");
  }
  const userProfile = env["USERPROFILE"];
  if (typeof userProfile === "string" && userProfile.trim().length > 0) {
    return join(userProfile, ".config");
  }
  return join(homedir(), ".config");
};

// ---------------------------------------------------------------------------
// Cached resolve
//
// We memoize at the module level so repeated calls in one process are
// cheap. Tests use `__resetPathsForTest` to invalidate the cache after
// mutating env vars.
// ---------------------------------------------------------------------------

let cached: { env: NodeJS.ProcessEnv; paths: ResolvedConfigPaths } | null = null;

const sameEnv = (a: NodeJS.ProcessEnv, b: NodeJS.ProcessEnv): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};

/**
 * Compute the resolved config paths for the current env. Memoized;
 * re-evaluate only when the relevant env vars change.
 */
export const resolveConfigPaths = (env: NodeJS.ProcessEnv = process.env): ResolvedConfigPaths => {
  if (cached && sameEnv(cached.env, env)) {
    return cached.paths;
  }

  const root = resolveConfigRoot(env);
  const legacyRoot = resolveLegacyConfigRoot(env);

  const paths: ResolvedConfigPaths = {
    globalConfig: join(root, "opencode-model-router", "tiers.json"),
    statePreferred: join(root, "opencode", "opencode-model-router.state.json"),
    stateLegacy: join(legacyRoot, "opencode", "opencode-model-router.state.json"),
  };

  cached = { env: { ...env }, paths };
  return paths;
};

/**
 * Drop the memoized result. Test-only — production code never needs to
 * call this because env changes mid-process are not part of the spec.
 */
export const __resetPathsForTest = (): void => {
  cached = null;
};

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/**
 * Global user-level override path for tiers.json. XDG-first, legacy
 * fallback. Re-evaluated from env on each call's first miss; otherwise
 * served from the memoized `resolveConfigPaths()` result.
 */
export const globalConfigPath = (): string => {
  return resolveConfigPaths().globalConfig;
};

/**
 * Preferred state file path (XDG when `$XDG_CONFIG_HOME` is set). The
 * loader writes here; readers prefer this and fall back to `stateLegacyPath()`.
 */
export const statePath = (): string => {
  return resolveConfigPaths().statePreferred;
};

/**
 * Legacy state file path (`$HOME/.config/opencode/...`). Used ONLY as
 * the read fallback so existing installs keep working. The loader never
 * writes to this path; a successful read here is followed by a write to
 * `statePath()` to migrate the user forward on the next state mutation.
 */
export const stateLegacyPath = (): string => {
  return resolveConfigPaths().stateLegacy;
};
