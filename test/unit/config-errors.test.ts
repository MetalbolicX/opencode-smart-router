import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigErrorKind,
  RouterConfigError,
  RouterStateError,
} from "../../src/router/config-errors";
import { readConfigLayer } from "../../src/router/config-loader";

// ---------------------------------------------------------------------------
// Error taxonomy unit tests.
//
// Covers the typed `RouterConfigError` + `ConfigErrorKind` union added in
// PR3b, plus the pre-existing `RouterStateError` from PR3a. Every kind maps
// to a documented operator-facing behaviour:
//   - "missing"               → warn + defaults (optional layer absent)
//   - "unreadable"            → fail-loud
//   - "malformed"             → fail-loud (JSON.parse threw / non-object root)
//   - "invalid"               → fail-loud (schema violation; reserved for future)
//   - "stale_refresh_failed"  → soft-warn (PR5 TTL background refresh)
// ---------------------------------------------------------------------------

describe("ConfigErrorKind — exhaustive union", () => {
  const expected: ConfigErrorKind[] = [
    "missing",
    "unreadable",
    "malformed",
    "invalid",
    "stale_refresh_failed",
  ];

  it.each(expected)("declares '%s' as a valid kind", (kind) => {
    const err = new RouterConfigError(kind, "/tmp/example.json", new Error("x"));
    expect(err.kind).toBe(kind);
  });
});

describe("RouterConfigError", () => {
  it("names the file path in the message", () => {
    const err = new RouterConfigError("unreadable", "/tmp/foo.json", new Error("EACCES"));
    expect(err.message).toContain("/tmp/foo.json");
    expect(err.message).toContain("EACCES");
  });

  it("preserves the underlying cause via Error.cause", () => {
    const cause = new Error("permission denied");
    const err = new RouterConfigError("unreadable", "/tmp/foo.json", cause);
    expect(err.cause).toBe(cause);
  });

  it("stringifies non-Error causes", () => {
    const err = new RouterConfigError("malformed", "/tmp/foo.json", "raw string");
    expect(err.message).toContain("raw string");
  });

  it("uses the kind as the discriminator (not the message)", () => {
    const a = new RouterConfigError("unreadable", "/tmp/x.json", new Error("a"));
    const b = new RouterConfigError("malformed", "/tmp/x.json", new Error("a"));
    expect(a.kind).not.toBe(b.kind);
  });

  it("appends a custom message when provided", () => {
    const err = new RouterConfigError(
      "unreadable",
      "/tmp/foo.json",
      new Error("EACCES"),
      "global layer (custom) is unreadable",
    );
    expect(err.message).toContain("global layer (custom) is unreadable");
    expect(err.message).toContain("EACCES");
  });

  it("is an instance of Error and carries the type name", () => {
    const err = new RouterConfigError("malformed", "/tmp/foo.json", new Error("bad json"));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RouterConfigError");
  });
});

describe("RouterStateError — preserved from PR3a", () => {
  it("names the file path in the message", () => {
    const err = new RouterStateError("/tmp/state.json", new Error("bad json"));
    expect(err.message).toContain("/tmp/state.json");
    expect(err.message).toContain("bad json");
  });

  it("is an instance of Error and carries the type name", () => {
    const err = new RouterStateError("/tmp/state.json", new Error("x"));
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RouterStateError");
  });
});

// ---------------------------------------------------------------------------
// readConfigLayer integration — failure modes map to typed kinds.
//
// Staging real files in a tmpdir isolates the loader from the developer's
// real $HOME. The bundled layer is the only required layer in
// `readConfigLayer`'s API, so we stage corrupt / unreadable files at the
// global or local path (which are required:false, so they warn instead of
// throwing) and trigger failures on a synthetic required layer to assert
// the kind mapping.
// ---------------------------------------------------------------------------

describe("readConfigLayer — failure modes emit typed RouterConfigError kinds", () => {
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
      `oc-err-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  it("returns undefined (warn+default) when an optional layer is missing (ENOENT)", async () => {
    const result = await readConfigLayer({
      kind: "global",
      path: join(tmpHome, ".config", "opencode-smart-router", "tiers.json"),
      required: false,
    });
    expect(result).toBeUndefined();
  });

  it("throws RouterConfigError(kind='unreadable') when a required layer is missing", async () => {
    await expect(
      readConfigLayer({
        kind: "bundled",
        path: join(tmpHome, "does-not-exist.json"),
        required: true,
      }),
    ).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "unreadable",
    });
  });

  it("throws RouterConfigError(kind='malformed') when JSON.parse fails", async () => {
    const p = join(tmpHome, "tiers.json");
    writeFileSync(p, "{not valid json", "utf-8");
    await expect(
      readConfigLayer({ kind: "local", path: p, required: false }),
    ).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "malformed",
    });
  });

  it("throws RouterConfigError(kind='malformed') when root is not a plain object", async () => {
    const p = join(tmpHome, "tiers-array.json");
    writeFileSync(p, "[]", "utf-8");
    await expect(
      readConfigLayer({ kind: "local", path: p, required: false }),
    ).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "malformed",
    });
  });

  it("throws RouterConfigError(kind='malformed') when root is a string", async () => {
    const p = join(tmpHome, "tiers-string.json");
    writeFileSync(p, '"just a string"', "utf-8");
    await expect(
      readConfigLayer({ kind: "local", path: p, required: false }),
    ).rejects.toMatchObject({
      name: "RouterConfigError",
      kind: "malformed",
    });
  });

  it("returns the parsed object on a well-formed layer", async () => {
    const p = join(tmpHome, "tiers-ok.json");
    writeFileSync(p, JSON.stringify({ activePreset: "openai" }), "utf-8");
    const result = await readConfigLayer({ kind: "local", path: p, required: false });
    expect(result).toEqual({ activePreset: "openai" });
  });
});
