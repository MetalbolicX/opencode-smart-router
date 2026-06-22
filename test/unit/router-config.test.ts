import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  loadConfig,
  invalidateConfigCache,
  saveActivePreset,
  saveActiveMode,
  saveEnforcementMode,
} from "../../src/router/config";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  tmpHome = join(
    tmpdir(),
    `oc-test-cfg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpHome, { recursive: true });
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  invalidateConfigCache();
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  invalidateConfigCache();
});

describe("saveActivePreset", () => {
  it("writes the resolved preset to state when valid", () => {
    saveActivePreset("anthropic");
    expect(readState().activePreset).toBe("anthropic");
  });

  it("resolves case-insensitively and persists the canonical name", () => {
    saveActivePreset("Anthropic");
    expect(readState().activePreset).toBe("anthropic");
  });

  it("is a no-op for an unknown preset", () => {
    saveActivePreset("nonexistent");
    expect(readState().activePreset).toBeUndefined();
  });

  it("is a no-op for an empty string", () => {
    saveActivePreset("");
    expect(readState().activePreset).toBeUndefined();
  });

  it("is a no-op for whitespace-only input", () => {
    saveActivePreset("   ");
    expect(readState().activePreset).toBeUndefined();
  });

  it("invalidateConfigCache makes the next loadConfig re-read state", () => {
    saveActivePreset("anthropic");
    invalidateConfigCache();
    expect(loadConfig().activePreset).toBe("anthropic");
  });
});

describe("saveActiveMode", () => {
  it("is a no-op for an unknown mode (modes block absent in default config)", () => {
    saveActiveMode("unknown-mode");
    expect(readState().activeMode).toBeUndefined();
  });

  it("is a no-op for an empty string", () => {
    saveActiveMode("");
    expect(readState().activeMode).toBeUndefined();
  });

  it("is a no-op for whitespace-only input", () => {
    saveActiveMode("   ");
    expect(readState().activeMode).toBeUndefined();
  });
});

describe("saveEnforcementMode", () => {
  it("persists 'off' to state", () => {
    saveEnforcementMode("off");
    expect(readState().enforcementMode).toBe("off");
  });

  it("persists 'advisory' to state", () => {
    saveEnforcementMode("advisory");
    expect(readState().enforcementMode).toBe("advisory");
  });

  it("persists 'enforced' to state", () => {
    saveEnforcementMode("enforced");
    expect(readState().enforcementMode).toBe("enforced");
  });

  it("overwrites a previously-persisted enforcement mode", () => {
    saveEnforcementMode("off");
    saveEnforcementMode("enforced");
    expect(readState().enforcementMode).toBe("enforced");
  });

  it("does not affect the activePreset key on the state file", () => {
    saveEnforcementMode("enforced");
    expect(readState().activePreset).toBeUndefined();
  });
});
