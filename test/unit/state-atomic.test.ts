import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readState, statePath, writeState } from "../../src/router/config";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;
let origXDG_CONFIG_HOME: string | undefined;

beforeEach(async () => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  origXDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];
  tmpHome = join(
    tmpdir(),
    `oc-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  // Tests must exercise the legacy `$HOME/.config/...` fallback so they
  // do not leak across users who have `XDG_CONFIG_HOME` set globally.
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
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

describe("writeState / readState — atomic file operations", () => {
  it("(i) writeState then readState round-trips activePreset", async () => {
    await writeState({ activePreset: "openai" });
    const s = await readState();
    expect(s.activePreset).toBe("openai");
  });

  it("(ii) merge: subsequent writeState preserves earlier keys", async () => {
    await writeState({ activePreset: "openai" });
    await writeState({ enforcementMode: "enforced" });
    const s = await readState();
    expect(s.activePreset).toBe("openai");
    expect(s.enforcementMode).toBe("enforced");
  });

  it("(iii) state file is valid JSON ending in newline", async () => {
    await writeState({ activePreset: "anthropic" });
    const content = readFileSync(statePath(), "utf-8");
    // Throws if invalid JSON
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.activePreset).toBe("anthropic");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("(iv) no leftover .tmp-* files after writeState", async () => {
    await writeState({ activePreset: "openai" });
    const dir = dirname(statePath());
    const files = readdirSync(dir);
    const tmps = files.filter((f) => f.includes(".tmp-"));
    expect(tmps).toHaveLength(0);
  });

  it("(v) enforcementMode persists round-trip", async () => {
    await writeState({ enforcementMode: "advisory" });
    const s = await readState();
    expect(s.enforcementMode).toBe("advisory");
  });

  it("readState returns {} when no state file exists", async () => {
    // tmpHome is fresh — no state file written yet
    const s = await readState();
    expect(s).toEqual({});
  });
});
