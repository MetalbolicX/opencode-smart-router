// ---------------------------------------------------------------------------
// src/cli/registry.ts — npm registry freshness helpers.
//
// Single source of truth for "is the installed package stale?" detection.
// Used by `status` (PR2), `doctor` (PR2), and `update` (PR4) — keeping the
// logic here means every consumer agrees on what "stale" means and how to
// degrade when the registry is unreachable.
//
// Design notes:
//   - `fetchLatestVersion()` bypasses pnpm v11's `minimumReleaseAge: 1440`
//     gate by hitting npm's registry directly via Node 20+ global `fetch`.
//     A short `AbortSignal.timeout` keeps a flaky network from stalling
//     `osr doctor` / `osr status`.
//   - `getInstalledVersion()` reuses the source-vs-bundle path-probe pattern
//     from `src/router/config-loader.ts#getPluginRoot()` so the same module
//     finds the right `package.json` whether it's running from `src/` or
//     bundled into `dist/`.
//   - `compareSemver()` is intentionally simple: numeric comparison of
//     dotted segments, prerelease suffix stripped, fail-closed to `0` on
//     any parse error. The CLI never makes decisions based on partial
//     versions, so a conservative `0` is the safest default.
//   - `isStale()` is the one-liner the consumers reach for: it folds the
//     `null` cases (`installed === null`, `latest === null`) into `false`
//     so callers do not need their own guards.
// ---------------------------------------------------------------------------

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliFs } from "./config";
import { createRealFs } from "./real-fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The subset of `fetch` we depend on. Aliasing the global type lets tests
 * inject a mock fetch without re-declaring the full `fetch` signature.
 */
export type RegistryFetch = typeof globalThis.fetch;

/**
 * The subset of `CliFs` needed to probe for and read `package.json`.
 * Narrows the seam so tests can build a tiny in-memory fs without wiring
 * every method the wider `CliFs` exposes.
 */
export type VersionFs = Pick<CliFs, "readFileSync" | "existsSync">;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLUGIN_NAME = "opencode-smart-router";
const REGISTRY_URL = `https://registry.npmjs.org/${PLUGIN_NAME}/latest`;
const DEFAULT_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// getInstalledVersion
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to the plugin's `package.json`. Tries both
 * layouts the project ships with:
 *   1. Source layout — `src/cli/registry.ts` → `../../package.json` (repo root)
 *   2. Bundled layout — `dist/cli/registry.mjs` → `../../package.json` (repo root)
 *
 * Falls back to the source root when neither probe matches (e.g. inside
 * the test harness with a fully-injected mem-fs); the subsequent read
 * will surface a clear `null` instead of throwing.
 */
const resolvePackageJsonPath = (fs: VersionFs): string => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = join(__dirname, "../..");
  const bundledRoot = join(__dirname, "..");
  if (fs.existsSync(join(sourceRoot, "package.json"))) return join(sourceRoot, "package.json");
  if (fs.existsSync(join(bundledRoot, "package.json"))) return join(bundledRoot, "package.json");
  // Default to the source root so the caller gets a deterministic ENOENT
  // when neither layout is reachable (rather than a surprise throw).
  return join(sourceRoot, "package.json");
};

/**
 * Read the bundled package's `version` field. Returns `null` on any
 * failure — missing file, malformed JSON, non-object root, missing or
 * non-string version. Never throws; the caller decides how to degrade.
 *
 * Accepts an optional `pluginRoot` so tests can pin the read to a known
 * path without having to mock `import.meta.url`. Defaults to the
 * source/bundled path probe above.
 */
export const getInstalledVersion = (
  fs: VersionFs = createRealFs(),
  pluginRoot?: string,
): string | null => {
  const pkgPath = pluginRoot ? join(pluginRoot, "package.json") : resolvePackageJsonPath(fs);
  if (!fs.existsSync(pkgPath)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(pkgPath);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || version.length === 0) return null;
  return version;
};

// ---------------------------------------------------------------------------
// fetchLatestVersion
// ---------------------------------------------------------------------------

/**
 * Hit `https://registry.npmjs.org/opencode-smart-router/latest` and return
 * the `version` string. Always resolves with a `string | null`:
 *   - `string` on HTTP 2xx with a JSON body whose `version` is a non-empty string
 *   - `null` on non-2xx, timeout (via `AbortSignal.timeout`), malformed JSON,
 *     missing/non-string `version`, or any thrown error
 *
 * The default `fetchImpl` is `globalThis.fetch` (Node 20+ ships this
 * natively). Tests inject a mock to drive every branch deterministically.
 */
export const fetchLatestVersion = async (
  fetchImpl: RegistryFetch = globalThis.fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string | null> => {
  try {
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return null;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const version = (body as Record<string, unknown>).version;
    if (typeof version !== "string" || version.length === 0) return null;
    return version;
  } catch {
    // Covers network rejection, AbortError from the timeout, and any
    // unexpected throw from a misbehaving `fetch` polyfill.
    return null;
  }
};

// ---------------------------------------------------------------------------
// compareSemver / isStale
// ---------------------------------------------------------------------------

/**
 * Parse a dotted version string into numeric segments. Strips a trailing
 * `-<prerelease>` suffix (we only compare the release parts). Returns
 * `null` on any failure — empty input, whitespace, non-numeric segments,
 * leading/trailing dots — so the caller can fail-closed.
 */
const parseSemver = (input: string | null | undefined): number[] | null => {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const base = trimmed.split("-", 1)[0] ?? "";
  if (base.length === 0) return null;
  const parts = base.split(".");
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
};

/**
 * Compare two semver-ish strings segment-by-segment, treating missing
 * trailing segments as `0`. Returns:
 *   - `-1` when `a < b`
 *   -  `0` when `a == b` (after segment padding + prerelease strip)
 *   -  `1` when `a > b`
 *
 * Fails closed to `0` on `null` / `undefined` / empty / unparseable input.
 * The CLI never makes decisions based on partial versions; "I don't know"
 * collapses to "treat them as equal" so the user sees a stale/fresh
 * comparison rather than a forced upgrade or downgrade.
 */
export const compareSemver = (
  a: string | null | undefined,
  b: string | null | undefined,
): -1 | 0 | 1 => {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (parsedA === null || parsedB === null) return 0;
  const len = Math.max(parsedA.length, parsedB.length);
  for (let i = 0; i < len; i++) {
    const av = parsedA[i] ?? 0;
    const bv = parsedB[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
};

/**
 * One-liner for the common case. Returns `true` only when `installed`
 * parses, `latest` parses, and `installed < latest`. Returns `false` for
 * any other case (equal, greater-than, missing inputs, unparseable
 * inputs) so callers can use it as a clean boolean without their own
 * null-guards.
 */
export const isStale = (
  installed: string | null | undefined,
  latest: string | null | undefined,
): boolean => {
  return compareSemver(installed, latest) < 0;
};
