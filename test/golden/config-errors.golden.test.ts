import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouterConfigError, RouterStateError } from "../../src/router/config-errors";
import { readMergedConfig } from "../../src/router/config-loader";
import { readState, writeState } from "../../src/router/config-state";

// ---------------------------------------------------------------------------
// Golden error-message tests.
//
// These pin the exact phrasing of every operator-facing message that the
// loader / state pipeline emits. Changing these strings is a breaking
// change for log scrapers and operator runbooks, so any future PR must
// update the snapshots deliberately.
//
// Snapshots live in test/golden/__snapshots__/config-errors.golden.test.ts.snap
// and are produced by vitest's built-in snapshot mechanism.
// ---------------------------------------------------------------------------

describe("golden — operator-facing error messages", () => {
  let tmpHome: string;
  let origHOME: string | undefined;
  let origUSERPROFILE: string | undefined;
  let origXDG: string | undefined;

  beforeEach(() => {
    origHOME = process.env["HOME"];
    origUSERPROFILE = process.env["USERPROFILE"];
    origXDG = process.env["XDG_CONFIG_HOME"];
    tmpHome = join(
      tmpdir(),
      `oc-gold-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpHome, { recursive: true });
    process.env["HOME"] = tmpHome;
    process.env["USERPROFILE"] = tmpHome;
    delete process.env["XDG_CONFIG_HOME"];
  });

  afterEach(() => {
    if (origHOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = origHOME;
    if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = origUSERPROFILE;
    if (origXDG === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = origXDG;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("global layer malformed JSON", async () => {
    const dir = join(tmpHome, ".config", "opencode-model-router");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tiers.json"), "{not json", "utf-8");
    await expect(readMergedConfig({ cwd: tmpHome })).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "malformed",
      path: join(dir, "tiers.json"),
    });
  });

  it("global layer missing (optional) is warn+default, NOT an error", async () => {
    // No file staged → no throw, just an undefined global layer. The
    // bundled default wins and the message is logged to stderr only.
    const cfg = await readMergedConfig({ cwd: tmpHome });
    expect(cfg.activePreset).toBe("multi-provider");
  });

  it("local layer malformed JSON", async () => {
    const dir = join(tmpHome, ".opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tiers.json"), "{not json", "utf-8");
    await expect(readMergedConfig({ cwd: tmpHome })).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "malformed",
    });
  });

  it("state file present but malformed throws RouterStateError", async () => {
    const dir = join(tmpHome, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode-model-router.state.json"), "{not json", "utf-8");
    await expect(readState()).rejects.toBeInstanceOf(RouterStateError);
  });

  it("state file present with non-object root throws RouterStateError", async () => {
    const dir = join(tmpHome, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode-model-router.state.json"), "[]", "utf-8");
    await expect(readState()).rejects.toBeInstanceOf(RouterStateError);
  });

  it("writeState on a fresh HOME succeeds and the file is valid JSON ending in newline", async () => {
    await writeState({ activePreset: "openai", enforcementMode: "enforced" });
    const stateDir = join(tmpHome, ".config", "opencode");
    const file = join(stateDir, "opencode-model-router.state.json");
    expect(readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    expect(parsed).toEqual({ activePreset: "openai", enforcementMode: "enforced" });
  });

  it("readState returns {} with an operator warning when no state file exists", async () => {
    // The implementation logs to stderr via console.warn — we capture the
    // snapshot of the returned value (the spec's contract).
    const s = await readState();
    expect(s).toEqual({});
  });

  it("RouterConfigError message format (kind='unreadable')", () => {
    const err = new RouterConfigError(
      "unreadable",
      "/tmp/x.json",
      new Error("EACCES: permission denied"),
    );
    // Pinned phrasing — see design.md "Migration / Rollout".
    expect(err.message).toMatchSnapshot("RouterConfigError.unreadable");
  });

  it("RouterConfigError message format (kind='malformed')", () => {
    const err = new RouterConfigError(
      "malformed",
      "/tmp/x.json",
      new Error("Unexpected token } in JSON at position 4"),
    );
    expect(err.message).toMatchSnapshot("RouterConfigError.malformed");
  });

  it("RouterConfigError message format (kind='invalid')", () => {
    const err = new RouterConfigError(
      "invalid",
      "/tmp/x.json",
      new Error("'activePreset' must be a non-empty string"),
    );
    expect(err.message).toMatchSnapshot("RouterConfigError.invalid");
  });

  it("RouterConfigError message format (kind='stale_refresh_failed')", () => {
    const err = new RouterConfigError(
      "stale_refresh_failed",
      "/tmp/x.json",
      new Error("EIO: i/o error"),
    );
    expect(err.message).toMatchSnapshot("RouterConfigError.stale_refresh_failed");
  });

  it("RouterStateError message format", () => {
    const err = new RouterStateError("/tmp/x.json", new Error("Unexpected end of JSON input"));
    expect(err.message).toMatchSnapshot("RouterStateError");
  });
});
