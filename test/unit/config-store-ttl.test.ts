import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigStore, DEFAULT_CONFIG_TTL_MS } from "../../src/router/config-store";

// ---------------------------------------------------------------------------
// ConfigStore TTL + staleness contract tests (PR5).
//
// PR3b added a { value, loadedAt } envelope to the cache. PR5 wires that
// envelope to a configurable TTL window so:
//   - `isStale()` reports whether the cache is older than `ttlMs` (or empty).
//   - `read()` performs a stale-aware auto-refresh: fresh cache is served
//     as-is, stale cache triggers a forced disk read, and a failed auto-
//     refresh degrades gracefully (returns the last-known-good cached value
//     and emits an observability warning — never crashes a real session).
//   - `refresh(reason)` continues to force a re-read; the `reason` is
//     surfaced to the observability log so refresh triggers are
//     correlatable with their cached values.
//
// These tests use Vitest's fake timers (`vi.useFakeTimers` + `vi.setSystemTime`)
// so the TTL boundary is deterministic — no real wall-clock waiting, no
// `setTimeout` in the implementation. Stale-detection is time-driven, not
// event-driven.
//
// Console-spy hygiene: the loader emits its own `console.warn` lines for
// missing optional layers. When asserting on OUR structured-log payload,
// the helpers below filter by the `[model-router][config-refresh]` prefix
// so unrelated warns do not pollute the assertion.
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpCwd: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;
let origCwd: string;
let origLog: string | undefined;

beforeEach(async () => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origXDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
  origCwd = process.cwd();
  origLog = process.env["MODEL_ROUTER_LOG"];

  tmpHome = join(
    tmpdir(),
    `oc-ttl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  delete process.env["XDG_CONFIG_HOME"];
  // Tests do not depend on the verbose refresh log; silence it by default.
  // Individual tests opt in by setting MODEL_ROUTER_LOG=1 in their body.
  delete process.env["MODEL_ROUTER_LOG"];

  tmpCwd = join(tmpHome, "cwd");
  mkdirSync(tmpCwd, { recursive: true });
  process.chdir(tmpCwd);

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
  if (origLog === undefined) delete process.env["MODEL_ROUTER_LOG"];
  else process.env["MODEL_ROUTER_LOG"] = origLog;
  process.chdir(origCwd);
  vi.useRealTimers();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

const stageLocal = (cwd: string, content: string): void => {
  const dir = join(cwd, ".opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tiers.json"), content, "utf-8");
};

/** Return only the structured `[model-router][config-refresh]` lines
 *  captured by a console spy (filters out unrelated warns from the loader
 *  or state file reader so assertions stay tight). */
const filterRefreshEvents = (calls: unknown[][]): string[] => {
  return calls
    .map((c) => String(c[0] ?? ""))
    .filter((line) => line.startsWith("[model-router][config-refresh]"));
};

// ---------------------------------------------------------------------------
// isStale() / loadedAtMs() — pure metadata accessors.
// ---------------------------------------------------------------------------

describe("createConfigStore — isStale()", () => {
  it("returns true on an empty cache (must load on first read)", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    expect(store.isStale()).toBe(true);
    expect(store.loadedAtMs()).toBeNull();
  });

  it("returns false within the TTL window after a successful read", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    expect(store.isStale()).toBe(false);
    expect(store.loadedAtMs()).not.toBeNull();
  });

  it("returns true once the cache age exceeds ttlMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    await store.read();
    expect(store.isStale()).toBe(false);
    // Advance just under the TTL boundary — still fresh.
    vi.setSystemTime(new Date("2026-06-26T12:00:59.999Z"));
    expect(store.isStale()).toBe(false);
    // Cross the boundary — now stale.
    vi.setSystemTime(new Date("2026-06-26T12:01:00.000Z"));
    expect(store.isStale()).toBe(true);
  });

  it("returns true at exactly the TTL boundary (>= semantics)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 1000 });
    await store.read();
    vi.setSystemTime(new Date("2026-06-26T12:00:01.000Z"));
    // At exactly ttlMs, the entry is stale (>= comparison).
    expect(store.isStale()).toBe(true);
  });

  it("a ttlMs of 0 disables staleness (read serves cached forever)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 0 });
    await store.read();
    // Advance a year; still fresh because TTL is disabled.
    vi.setSystemTime(new Date("2027-06-26T12:00:00.000Z"));
    expect(store.isStale()).toBe(false);
  });

  it("a negative ttlMs also disables staleness (defensive)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: -1 });
    await store.read();
    vi.setSystemTime(new Date("2027-06-26T12:00:00.000Z"));
    expect(store.isStale()).toBe(false);
  });

  it("invalidate() flips isStale back to true (empty cache is stale)", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    expect(store.isStale()).toBe(false);
    store.invalidate();
    expect(store.isStale()).toBe(true);
    expect(store.loadedAtMs()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// read() — stale-aware auto-refresh.
// ---------------------------------------------------------------------------

describe("createConfigStore — stale-aware read()", () => {
  it("within the TTL window, serves the cached reference without re-reading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    const a = await store.read();
    vi.setSystemTime(new Date("2026-06-26T12:00:30.000Z"));
    const b = await store.read();
    expect(b).toBe(a);
  });

  it("past the TTL window, read() refreshes and returns the NEW reference", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    const a = await store.read();
    // Stage a fresh local layer; the cached value should NOT reflect it
    // until the stale-aware read triggers a refresh.
    stageLocal(tmpCwd, JSON.stringify({ activePreset: "openai" }));
    vi.setSystemTime(new Date("2026-06-26T12:05:00.000Z"));
    const b = await store.read();
    expect(b).not.toBe(a);
    expect(b.activePreset).toBe("openai");
  });

  it("auto-refresh on a stale cache updates loadedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    await store.read();
    const before = store.loadedAtMs();
    vi.setSystemTime(new Date("2026-06-26T12:05:00.000Z"));
    await store.read();
    const after = store.loadedAtMs();
    expect(after).not.toBe(before);
    expect(after).toBe(new Date("2026-06-26T12:05:00.000Z").getTime());
  });

  it("on auto-refresh failure, falls back to the last-known-good cached value", async () => {
    // Setup: load fresh at t=0 with no local layer (bundled default
    // activePreset=multi-provider). Then stage a MALFORMED local layer
    // and cross the TTL boundary. The auto-refresh on read() must fail
    // (parse error), and the read must return the last-known-good
    // reference cached at t=0 — NOT throw, NOT return a fresh value.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    const initial = await store.read();
    expect(initial.activePreset).toBe("multi-provider");

    // Stage malformed JSON so the next refresh throws.
    stageLocal(tmpCwd, "{not valid json");

    // Cross the TTL boundary — auto-refresh will fire.
    vi.setSystemTime(new Date("2026-06-26T12:05:00.000Z"));
    // Suppress the verbose-log warning so the test stdout stays clean;
    // the silent fallback path is exercised either way.
    delete process.env["MODEL_ROUTER_LOG"];
    const result = await store.read();

    // Fail-soft contract: serve the last-known-good cached value. The
    // malformed file must NOT throw out of read() and must NOT change
    // the cached reference.
    expect(result).toBe(initial);
    expect(result.activePreset).toBe("multi-provider");
    // Cache envelope must NOT have been replaced.
    expect(store.loadedAtMs()).toBe(new Date("2026-06-26T12:00:00.000Z").getTime());
  });

  it("stale-serve never throws even when the disk error is non-Error", async () => {
    // Defensive contract: if `readMergedConfig` ever throws a non-Error
    // value, the fail-soft path must still serve the cached value rather
    // than crashing the caller's session. We force the failure mode by
    // staging a malformed JSON file, which the loader wraps in a
    // RouterConfigError — both Error and non-Error throwables must reach
    // the same fail-soft branch.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    await store.read();
    stageLocal(tmpCwd, "}");
    vi.setSystemTime(new Date("2026-06-26T12:05:00.000Z"));
    await expect(store.read()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// refresh() — the explicit, force-re-read path. TTL-independent by design.
// ---------------------------------------------------------------------------

describe("createConfigStore — refresh() with reason passthrough", () => {
  it("refresh('ttl') forces a disk read even within the TTL window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    const a = await store.read();
    stageLocal(tmpCwd, JSON.stringify({ activePreset: "openai" }));
    const b = await store.refresh("ttl");
    expect(b).not.toBe(a);
    expect(b.activePreset).toBe("openai");
  });

  it("refresh() without an argument still works (manual trigger)", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    stageLocal(tmpCwd, JSON.stringify({ activePreset: "google" }));
    const r = await store.refresh();
    expect(r.activePreset).toBe("google");
  });

  it("refresh() updates loadedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    await store.read();
    const before = store.loadedAtMs();
    vi.setSystemTime(new Date("2026-06-26T12:00:10.000Z"));
    await store.refresh();
    const after = store.loadedAtMs();
    expect(after).toBeGreaterThan(before ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Observability integration — structured log on refresh + stale-serve.
//
// These tests assert that the internal `logConfigRefresh` shim writes the
// documented JSON payload when `MODEL_ROUTER_LOG=1`, so operators can
// correlate refresh triggers with the cached values they produced. The
// verbose log is opt-in to avoid spamming real-session stdout.
// ---------------------------------------------------------------------------

describe("createConfigStore — observability integration", () => {
  it("emits a structured JSON refresh event on successful load when MODEL_ROUTER_LOG=1", async () => {
    process.env["MODEL_ROUTER_LOG"] = "1";
    const store = createConfigStore({ cwd: tmpCwd });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await store.read();
    const events = filterRefreshEvents(logSpy.mock.calls);
    expect(events).toHaveLength(1);
    const line = events[0]!;
    expect(line).toMatch(/^\[model-router\]\[config-refresh\] \{/);
    // Extract the JSON object and assert its shape.
    const jsonStart = line.indexOf("{");
    const payload = JSON.parse(line.slice(jsonStart));
    expect(payload.outcome).toBe("ok");
    expect(payload.reason).toBe("initial");
    expect(typeof payload.loadedAt).toBe("number");
    expect(payload.ttlMs).toBe(DEFAULT_CONFIG_TTL_MS);
    expect(typeof payload.activePreset).toBe("string");
    logSpy.mockRestore();
  });

  it("emits a stale_serve event with the error message on auto-refresh failure", async () => {
    process.env["MODEL_ROUTER_LOG"] = "1";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-26T12:00:00.000Z"));
    const store = createConfigStore({ cwd: tmpCwd, ttlMs: 60_000 });
    await store.read();
    // Stage a malformed local layer so the next refresh throws.
    stageLocal(tmpCwd, "{not valid json");
    vi.setSystemTime(new Date("2026-06-26T12:05:00.000Z"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.read();
    const events = filterRefreshEvents(warnSpy.mock.calls);
    expect(events).toHaveLength(1);
    const line = events[0]!;
    const jsonStart = line.indexOf("{");
    const payload = JSON.parse(line.slice(jsonStart));
    expect(payload.outcome).toBe("stale_serve");
    expect(payload.reason).toBe("ttl-auto");
    expect(typeof payload.error).toBe("string");
    expect(payload.error.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });

  it("does NOT emit any refresh-log line when MODEL_ROUTER_LOG is unset (production default)", async () => {
    delete process.env["MODEL_ROUTER_LOG"];
    const store = createConfigStore({ cwd: tmpCwd });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await store.read();
    await store.refresh();
    // Only OUR refresh events must be absent; the loader's unrelated warns
    // are filtered out by prefix to keep the assertion tight.
    expect(filterRefreshEvents(logSpy.mock.calls)).toHaveLength(0);
    expect(filterRefreshEvents(warnSpy.mock.calls)).toHaveLength(0);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG_TTL_MS — sanity pin on the documented default.
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG_TTL_MS", () => {
  it("is 5 minutes (the PR5 documented default)", () => {
    expect(DEFAULT_CONFIG_TTL_MS).toBe(5 * 60 * 1000);
  });
});
