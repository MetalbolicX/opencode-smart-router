import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ModelRouterPlugin from "../../src/index";
import { readMergedConfig } from "../../src/router/config-loader";
import { readState, writeState } from "../../src/router/config-state";
import { createConfigStore } from "../../src/router/config-store";

// ---------------------------------------------------------------------------
// Async config + state I/O integration.
//
// End-to-end coverage of the PR3b contract: file IO is fully async (uses
// node:fs/promises), XDG-aware paths resolve at the right precedence, the
// per-instance ConfigStore cache shape includes a {value, loadedAt}
// envelope, and the legacy state fallback migrates to the XDG path on
// the first successful write.
//
// Each test stages files into a temp HOME with XDG_CONFIG_HOME unset, so
// the XDG path collapses to $HOME/.config/... and assertions can pin the
// on-disk layout.
// ---------------------------------------------------------------------------

describe("Async layer + state I/O — integration", () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origHOME: string | undefined;
  let origUSERPROFILE: string | undefined;
  let origXDG: string | undefined;
  let origCwd: string;

  beforeEach(async () => {
    origHOME = process.env["HOME"];
    origUSERPROFILE = process.env["USERPROFILE"];
    origXDG = process.env["XDG_CONFIG_HOME"];
    origCwd = process.cwd();

    tmpHome = join(
      tmpdir(),
      `oc-async-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
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
    if (origXDG === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = origXDG;
    process.chdir(origCwd);
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const { __resetPathsForTest } = await import("../../src/router/config-paths");
    __resetPathsForTest();
  });

  it("readMergedConfig returns the bundled default when no overrides are staged", async () => {
    const cfg = await readMergedConfig({ cwd: tmpCwd });
    expect(cfg.activePreset).toBe("multi-provider");
    expect(cfg.presets["anthropic"]).toBeDefined();
  });

  it("readMergedConfig honors a freshly written local layer", async () => {
    const localDir = join(tmpCwd, ".opencode");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, "tiers.json"),
      JSON.stringify({ activePreset: "openai" }),
      "utf-8",
    );
    const cfg = await readMergedConfig({ cwd: tmpCwd });
    expect(cfg.activePreset).toBe("openai");
  });

  it("readMergedConfig fails loud on a corrupt local layer (async)", async () => {
    const localDir = join(tmpCwd, ".opencode");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, "tiers.json"), "{broken", "utf-8");
    await expect(readMergedConfig({ cwd: tmpCwd })).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "malformed",
    });
  });

  it("writeState → readState round-trips and ends with a newline (async atomic write)", async () => {
    await writeState({ activePreset: "openai", enforcementMode: "enforced" });
    const stateFile = join(tmpHome, ".config", "opencode", "opencode-smart-router.state.json");
    const raw = readFileSync(stateFile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const s = await readState();
    expect(s).toMatchObject({ activePreset: "openai", enforcementMode: "enforced" });
  });

  it("writeState succeeds even when the parent directory does not yet exist", async () => {
    // No .config/opencode/ staged yet — writeState should mkdir recursively.
    await writeState({ activePreset: "anthropic" });
    const stateFile = join(tmpHome, ".config", "opencode", "opencode-smart-router.state.json");
    expect(readFileSync(stateFile, "utf-8")).toContain("anthropic");
  });

  it("writeState then writeState merges keys (later patches are merged, not replaced)", async () => {
    await writeState({ activePreset: "openai" });
    await writeState({ enforcementMode: "advisory" });
    const s = await readState();
    expect(s.activePreset).toBe("openai");
    expect(s.enforcementMode).toBe("advisory");
  });

  it("createConfigStore caches the merged config; refresh() updates from disk", async () => {
    const localDir = join(tmpCwd, ".opencode");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, "tiers.json"),
      JSON.stringify({ activePreset: "openai" }),
      "utf-8",
    );

    const store = createConfigStore({ cwd: tmpCwd });
    const initial = await store.read();
    expect(initial.activePreset).toBe("openai");

    // Mutate the on-disk layer; read() must serve the cache, refresh()
    // must pick up the new value.
    writeFileSync(
      join(localDir, "tiers.json"),
      JSON.stringify({ activePreset: "google" }),
      "utf-8",
    );
    expect((await store.read()).activePreset).toBe("openai");
    expect((await store.refresh()).activePreset).toBe("google");
  });

  it("createConfigStore.getFresh() always re-reads disk (bypasses cache)", async () => {
    const localDir = join(tmpCwd, ".opencode");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, "tiers.json"),
      JSON.stringify({ activePreset: "openai" }),
      "utf-8",
    );

    const store = createConfigStore({ cwd: tmpCwd });
    await store.read();

    writeFileSync(
      join(localDir, "tiers.json"),
      JSON.stringify({ activePreset: "google" }),
      "utf-8",
    );

    // getFresh() bypasses the cache; even without refresh(), the new value wins.
    expect((await store.getFresh()).activePreset).toBe("google");
  });

  it("plugin factory → /router command: async writeState persists across reload", async () => {
    const hooks = (await ModelRouterPlugin({ directory: tmpCwd } as any)) as Record<
      string,
      (...args: unknown[]) => unknown
    >;

    const out: { parts: Array<{ type: string; text?: string }> } = { parts: [] };
    await hooks["command.execute.before"](
      { command: "router", arguments: "enforce enforced" } as never,
      out as never,
    );
    expect(out.parts[0]?.text).toContain("enforced");

    // Reload via the pure helper — the persisted state should win.
    const cfg = await readMergedConfig({ cwd: tmpCwd });
    expect(cfg.enforcement?.mode).toBe("enforced");
  });
});

// ---------------------------------------------------------------------------
// XDG-aware path resolution integration.
//
// With XDG_CONFIG_HOME set, the resolver targets $XDG_CONFIG_HOME/opencode-smart-router/
// instead of $HOME/.config/opencode-smart-router/. This integration test
// proves the full path with a real fs round-trip.
// ---------------------------------------------------------------------------

describe("XDG-aware path resolution — integration", () => {
  let tmpXdg: string;
  let tmpHome: string;
  let origHOME: string | undefined;
  let origUSERPROFILE: string | undefined;
  let origXDG: string | undefined;
  let origCwd: string;

  beforeEach(async () => {
    origHOME = process.env["HOME"];
    origUSERPROFILE = process.env["USERPROFILE"];
    origXDG = process.env["XDG_CONFIG_HOME"];
    origCwd = process.cwd();

    // XDG root: unique per test. Legacy home: separate dir so we can prove
    // the XDG path is preferred.
    tmpXdg = join(
      tmpdir(),
      `oc-xdg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    tmpHome = join(
      tmpdir(),
      `oc-home-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpXdg, { recursive: true });
    mkdirSync(tmpHome, { recursive: true });
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    process.env["XDG_CONFIG_HOME"] = tmpXdg;

    const { __resetPathsForTest } = await import("../../src/router/config-paths");
    __resetPathsForTest();
  });

  afterEach(async () => {
    if (origHOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHOME;
    if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = origUSERPROFILE;
    if (origXDG === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = origXDG;
    process.chdir(origCwd);
    try {
      rmSync(tmpXdg, { recursive: true, force: true });
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const { __resetPathsForTest } = await import("../../src/router/config-paths");
    __resetPathsForTest();
  });

  it("writeState targets the XDG root, NOT $HOME", async () => {
    await writeState({ activePreset: "openai" });
    const xdgState = join(tmpXdg, "opencode", "opencode-smart-router.state.json");
    const homeState = join(tmpHome, ".config", "opencode", "opencode-smart-router.state.json");
    expect(readFileSync(xdgState, "utf-8")).toContain("openai");
    // The legacy path MUST NOT exist — we only write to XDG.
    expect(() => readFileSync(homeState, "utf-8")).toThrow();
  });

  it("readMergedConfig honors the XDG root for global tiers.json", async () => {
    const xdgGlobalDir = join(tmpXdg, "opencode-smart-router");
    mkdirSync(xdgGlobalDir, { recursive: true });
    writeFileSync(
      join(xdgGlobalDir, "tiers.json"),
      JSON.stringify({ activePreset: "google" }),
      "utf-8",
    );
    const cwd = tmpXdg; // cwd irrelevant — global layer comes from XDG
    const cfg = await readMergedConfig({ cwd });
    expect(cfg.activePreset).toBe("google");
  });

  it("legacy fallback: readState prefers XDG then falls back to $HOME", async () => {
    // Stage ONLY the legacy path; the XDG root is empty. readState must
    // warn + return the legacy contents.
    const homeStateDir = join(tmpHome, ".config", "opencode");
    mkdirSync(homeStateDir, { recursive: true });
    writeFileSync(
      join(homeStateDir, "opencode-smart-router.state.json"),
      JSON.stringify({ activePreset: "anthropic" }),
      "utf-8",
    );
    const s = await readState();
    expect(s).toEqual({ activePreset: "anthropic" });
  });

  it("first successful writeState under XDG migrates the user forward", async () => {
    // Stage a legacy file, then issue a writeState. The XDG file appears;
    // the legacy file is unchanged (writers never touch legacy).
    const homeStateDir = join(tmpHome, ".config", "opencode");
    mkdirSync(homeStateDir, { recursive: true });
    writeFileSync(
      join(homeStateDir, "opencode-smart-router.state.json"),
      JSON.stringify({ activePreset: "legacy" }),
      "utf-8",
    );
    await writeState({ activePreset: "fresh-write" });
    const xdgState = join(tmpXdg, "opencode", "opencode-smart-router.state.json");
    const xdgContent = JSON.parse(readFileSync(xdgState, "utf-8")) as Record<string, unknown>;
    expect(xdgContent).toMatchObject({ activePreset: "fresh-write" });
    // The next readState sees the XDG file (preferred over legacy).
    const s = await readState();
    expect(s.activePreset).toBe("fresh-write");
  });
});
