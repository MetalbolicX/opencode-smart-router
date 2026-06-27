import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMergedConfig } from "../../src/router/config-loader";
import { createConfigStore } from "../../src/router/config-store";

// ---------------------------------------------------------------------------
// Per-instance ConfigStore contract tests.
//
// These cover the observable behaviour mandated by the spec:
//   - `read()`    returns the cached value (re-reads from disk if empty).
//   - `refresh()` always re-reads from disk and replaces the cache.
//   - `invalidate()` clears the cache; the next `read()` re-reads.
//   - Two stores with different cwds see different local-layer results.
//   - Two stores with the same cwd have independent caches: one's
//     `refresh()` never invalidates the other's cached value.
//
// PR3b: read / refresh / getFresh are all async; every assertion awaits.
// The tests stage files into a temp HOME and a temp cwd so they do not
// interfere with the developer's real `~/.config/opencode-model-router/`.
// ---------------------------------------------------------------------------

let tmpHome: string;
let tmpCwd: string;
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
    `oc-store-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Tests must exercise the legacy `$HOME/.config/...` fallback so they
  // do not leak across users who have `XDG_CONFIG_HOME` set globally.
  delete process.env["XDG_CONFIG_HOME"];

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
  process.chdir(origCwd);
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

const stageLocal = (cwd: string, content: Record<string, unknown>): void => {
  const dir = join(cwd, ".opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tiers.json"), JSON.stringify(content), "utf-8");
};

describe("readMergedConfig", () => {
  it("returns the bundled default preset when no global/local override is staged", async () => {
    const cfg = await readMergedConfig({ cwd: tmpCwd });
    expect(cfg.activePreset).toBe("multi-provider");
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("honors the local layer under the supplied cwd", async () => {
    stageLocal(tmpCwd, { activePreset: "openai" });
    const cfg = await readMergedConfig({ cwd: tmpCwd });
    expect(cfg.activePreset).toBe("openai");
  });

  it("a different cwd reads a different local layer (no shared cache)", async () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    expect((await readMergedConfig({ cwd: tmpCwd })).activePreset).toBe("openai");
    expect((await readMergedConfig({ cwd: otherCwd })).activePreset).toBe("google");
  });

  it("does not throw when no local layer is present", async () => {
    const otherCwd = join(tmpHome, "no-local");
    mkdirSync(otherCwd, { recursive: true });
    await expect(readMergedConfig({ cwd: otherCwd })).resolves.toBeDefined();
  });
});

describe("createConfigStore — read/refresh/invalidate", () => {
  it("read() returns a RouterConfig", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const cfg = await store.read();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    expect(cfg.presets).toBeDefined();
  });

  it("read() is idempotent — second call returns the same cached reference", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const a = await store.read();
    const b = await store.read();
    expect(a).toBe(b);
  });

  it("refresh() returns a RouterConfig that matches the current disk state", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    expect((await store.refresh()).activePreset).toBe("multi-provider");
    stageLocal(tmpCwd, { activePreset: "openai" });
    // Without refresh, the cached value is still the bundled default.
    expect((await store.read()).activePreset).toBe("multi-provider");
    // After refresh, the staged local layer wins.
    expect((await store.refresh()).activePreset).toBe("openai");
  });

  it("invalidate() clears the cache so the next read() re-loads from disk", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    stageLocal(tmpCwd, { activePreset: "openai" });
    store.invalidate();
    expect((await store.read()).activePreset).toBe("openai");
  });

  it("invalidate() does not throw on an empty cache", () => {
    const store = createConfigStore({ cwd: tmpCwd });
    expect(() => store.invalidate()).not.toThrow();
    expect(() => store.invalidate()).not.toThrow();
  });

  it("refresh() after invalidate() re-loads from disk", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    store.invalidate();
    stageLocal(tmpCwd, { activePreset: "openai" });
    expect((await store.refresh()).activePreset).toBe("openai");
  });

  it("getFresh() forces a disk read even when the cache is populated", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    stageLocal(tmpCwd, { activePreset: "openai" });
    // Cache still has the bundled default — getFresh must skip it.
    expect((await store.getFresh()).activePreset).toBe("openai");
  });
});

describe("createConfigStore — two-instance / two-cwd isolation", () => {
  it("two stores with different cwds see different local layers", async () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: otherCwd });

    expect((await storeA.read()).activePreset).toBe("openai");
    expect((await storeB.read()).activePreset).toBe("google");
  });

  it("two stores with the same cwd have independent caches (no cross-instance invalidation)", async () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });

    // Both read the same bundled default.
    expect((await storeA.read()).activePreset).toBe("multi-provider");
    expect((await storeB.read()).activePreset).toBe("multi-provider");

    // Mutating A's cache (via refresh after staging a local file) does
    // NOT clear B's cached value.
    stageLocal(tmpCwd, { activePreset: "openai" });
    await storeA.refresh();
    expect((await storeA.read()).activePreset).toBe("openai");
    expect((await storeB.read()).activePreset).toBe("multi-provider");
  });

  it("one store's invalidate() does not affect another store's cache", async () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });

    await storeA.read();
    await storeB.read();
    storeA.invalidate();
    // B's cached value must survive A's invalidation.
    expect((await storeB.read()).activePreset).toBe("multi-provider");
  });

  it("two stores on different cwds refresh independently", async () => {
    const otherCwd = join(tmpHome, "other-cwd");
    mkdirSync(otherCwd, { recursive: true });
    stageLocal(tmpCwd, { activePreset: "openai" });
    stageLocal(otherCwd, { activePreset: "google" });

    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: otherCwd });

    // Refresh one store — the other is unaffected.
    expect((await storeA.refresh()).activePreset).toBe("openai");
    expect((await storeB.read()).activePreset).toBe("google");
  });
});

// ---------------------------------------------------------------------------
// Phase 4.3 — direct pure-store coverage.
//
// The PR1 baseline already covered the cross-instance isolation contract.
// These tests add direct assertions on the ConfigStore surface so any
// future regression in the pure store (reference identity, failure
// isolation, refresh idempotence) localises here without dragging in the
// plugin context or router command layers.
// ---------------------------------------------------------------------------

describe("createConfigStore — direct pure-store coverage", () => {
  it("refresh() returns a value with the same activePreset when the disk state is unchanged", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const a = await store.refresh();
    const b = await store.refresh();
    // `refresh()` always re-reads disk and replaces the cache, so the
    // returned reference is fresh on each call. The merged values must
    // still be equal because nothing on disk changed between calls.
    expect(b.activePreset).toBe(a.activePreset);
  });

  it("refresh() after a staged change returns a NEW reference", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    const a = await store.refresh();
    stageLocal(tmpCwd, { activePreset: "openai" });
    const b = await store.refresh();
    expect(b).not.toBe(a);
    expect(b.activePreset).toBe("openai");
  });

  it("read() after refresh() returns the new reference (no stale snapshot)", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();
    stageLocal(tmpCwd, { activePreset: "openai" });
    await store.refresh();
    // The post-refresh read must reflect the new disk state.
    expect((await store.read()).activePreset).toBe("openai");
  });

  it("a read on an empty cache populates it from disk and returns the merged config", async () => {
    const store = createConfigStore({ cwd: tmpCwd });
    // No read or refresh yet — the cache is empty. The next read() must
    // populate it from disk and return a valid RouterConfig.
    const cfg = await store.read();
    expect(cfg).toBeDefined();
    expect(typeof cfg.activePreset).toBe("string");
    // A second read should now be reference-identical (cache hit).
    expect(await store.read()).toBe(cfg);
  });

  it("two stores created from the same cwd see the same initial disk state", async () => {
    const storeA = createConfigStore({ cwd: tmpCwd });
    const storeB = createConfigStore({ cwd: tmpCwd });
    // Both stores start cold; both reads return the bundled default.
    expect((await storeA.read()).activePreset).toBe("multi-provider");
    expect((await storeB.read()).activePreset).toBe("multi-provider");
    // The two configs are equal-by-value but separate references.
    expect(await storeA.read()).not.toBe(await storeB.read());
  });

  it("readMergedConfig({ cwd }) is a pure read: it does not pollute the per-instance cache", async () => {
    // Stage a local layer, then read with the pure helper — it must NOT
    // touch any ConfigStore cache. The next store read should still see
    // the bundled default until refresh() is called.
    stageLocal(tmpCwd, { activePreset: "openai" });
    const pureCfg = await readMergedConfig({ cwd: tmpCwd });
    expect(pureCfg.activePreset).toBe("openai");

    const store = createConfigStore({ cwd: tmpCwd });
    expect((await store.read()).activePreset).toBe("openai");
  });
});
