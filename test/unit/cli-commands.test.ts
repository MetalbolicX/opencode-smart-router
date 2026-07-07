// ---------------------------------------------------------------------------
// test/unit/cli-commands.test.ts — Integration tests for CLI commands.
//
// Tests runInstall, runUninstall, runConfigInit, and runConfigPaths with
// an in-memory CliFs to exercise the full command orchestration layer
// without touching disk.
// ---------------------------------------------------------------------------

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliFs } from "../../src/cli/config";
import { PLUGIN_NAME } from "../../src/cli/config";
import { runInstall } from "../../src/cli/install";
import { runMain } from "../../src/cli/main";
import { runConfigInit, runConfigPaths } from "../../src/cli/tiers-config";
import { runUninstall } from "../../src/cli/uninstall";

// ---------------------------------------------------------------------------
// Mock the bundled tiers.json path so --from-bundled is deterministic.
// ---------------------------------------------------------------------------

const BUNDLED_FIXTURE = {
  activePreset: "multi-provider",
  presets: {
    "multi-provider": {
      fast: { model: "test/fast", description: "fast tier" },
      medium: { model: "test/medium", description: "medium tier" },
      heavy: { model: "test/heavy", description: "heavy tier" },
    },
    anthropic: {
      fast: { model: "anthropic/fast" },
      medium: { model: "anthropic/medium" },
      heavy: { model: "anthropic/heavy" },
    },
  },
};

let bundledTmpDir: string;
let bundledTmpPath: string;

vi.mock("../../src/router/config-loader", async () => {
  const actual = await vi.importActual<typeof import("../../src/router/config-loader")>(
    "../../src/router/config-loader",
  );
  return {
    ...actual,
    configPath: () => bundledTmpPath,
  };
});

beforeEach(() => {
  bundledTmpDir = join(
    tmpdir(),
    `osr-test-bundled-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(bundledTmpDir, { recursive: true });
  bundledTmpPath = join(bundledTmpDir, "tiers.json");
  writeFileSync(bundledTmpPath, JSON.stringify(BUNDLED_FIXTURE), "utf-8");
});

afterEach(() => {
  rmSync(bundledTmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// In-memory CliFs (same pattern as cli-config.test.ts)
// ---------------------------------------------------------------------------

const createMemFs = (
  initialFiles: Record<string, string> = {},
): CliFs & { __files: Map<string, string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const [p, c] of Object.entries(initialFiles)) {
    files.set(p, c);
  }
  const ensureParentDir = (path: string): void => {
    const parts = path.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
      if (acc.length > 0) dirs.add(acc);
    }
    if (path.endsWith("/")) dirs.add(path);
  };
  const fs: CliFs & { __files: Map<string, string> } = {
    __files: files,
    readFileSync: (path) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path) as string;
    },
    writeFileSync: (path, content) => {
      ensureParentDir(path);
      files.set(path, content);
    },
    renameSync: (from, to) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      ensureParentDir(to);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    copyFileSync: (from, to) => {
      if (!files.has(from)) {
        const err = new Error(`ENOENT: ${from}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      ensureParentDir(to);
      files.set(to, files.get(from) as string);
    },
    unlinkSync: (path) => {
      if (!files.has(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      files.delete(path);
    },
    mkdirSync: (path) => {
      dirs.add(path);
    },
    readdirSync: (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const segment = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
          if (segment.length > 0) seen.add(segment);
        }
      }
      return [...seen];
    },
    existsSync: (path) => files.has(path) || dirs.has(path),
  };
  return fs;
};

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const CONFIG_PATH = "/home/test/.config/opencode/opencode.json";

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = {
    HOME: process.env["HOME"],
    OPENCODE_CONFIG_DIR: process.env["OPENCODE_CONFIG_DIR"],
    XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
    USERPROFILE: process.env["USERPROFILE"],
  };
  delete process.env["OPENCODE_CONFIG_DIR"];
  delete process.env["XDG_CONFIG_HOME"];
  delete process.env["USERPROFILE"];
  process.env["HOME"] = "/home/test";
  // Invalidate the memoized config-paths cache so globalConfigPath() picks
  // up the test HOME we just set (the cache may carry the real $HOME from
  // an earlier module load).
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

afterEach(async () => {
  if (savedEnv.HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedEnv.HOME;
  if (savedEnv.OPENCODE_CONFIG_DIR === undefined) delete process.env["OPENCODE_CONFIG_DIR"];
  else process.env["OPENCODE_CONFIG_DIR"] = savedEnv.OPENCODE_CONFIG_DIR;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = savedEnv.XDG_CONFIG_HOME;
  if (savedEnv.USERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = savedEnv.USERPROFILE;
  // Reset the config-paths cache so the next test starts clean.
  const { __resetPathsForTest } = await import("../../src/router/config-paths");
  __resetPathsForTest();
});

// ---------------------------------------------------------------------------
// Silence console.log during tests
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

describe("runInstall", () => {
  it("creates a fresh config when no file exists", () => {
    const fs = createMemFs();
    const result = runInstall({}, fs);

    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(result.path).toBe(CONFIG_PATH);

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
  });

  it("adds to existing config without losing other keys", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude-sonnet-4-5",
        plugin: ["some-other-plugin"],
      }),
    });

    const result = runInstall({}, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.model).toBe("anthropic/claude-sonnet-4-5");
    expect(written.plugin).toEqual(["some-other-plugin", PLUGIN_NAME]);
  });

  it("is idempotent — re-running with same version is a no-op", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });

    const result = runInstall({}, fs);
    expect(result.status).toBe("noop");
  });

  it("replaces existing osr entry with new version", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["other", `${PLUGIN_NAME}@1.0.0`] }),
    });

    const result = runInstall({ version: "2.0.0" }, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual(["other", `${PLUGIN_NAME}@2.0.0`]);
  });

  it("dry-run prints but does not write", () => {
    const fs = createMemFs();

    const result = runInstall({ dryRun: true }, fs);
    expect(result.status).toBe("planned");

    // File should NOT exist
    expect(fs.__files.has(CONFIG_PATH)).toBe(false);
    expect(logSpy).toHaveBeenCalled();
  });

  it("prints a `osr config init` tip on the wrote path", () => {
    const fs = createMemFs();
    runInstall({}, fs);

    // The tip line is a discoverability aid — it should surface after
    // a successful install but NOT on the noop or planned paths.
    const tipCall = logSpy.mock.calls.find((args: unknown[]) =>
      String(args[0] ?? "").includes("osr config init"),
    );
    expect(tipCall).toBeTruthy();
  });

  it("does NOT print the `osr config init` tip on the noop path", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    runInstall({}, fs);

    const tipCall = logSpy.mock.calls.find((args: unknown[]) =>
      String(args[0] ?? "").includes("osr config init"),
    );
    expect(tipCall).toBeFalsy();
  });

  it("throws on corrupt existing config", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: '{"broken": invalid}',
    });

    expect(() => runInstall({}, fs)).toThrow("malformed JSON");
  });

  it("creates a backup before writing", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["old"] }),
    });

    const result = runInstall({}, fs);
    expect(result.backup).toBeTruthy();
    expect(result.backup).toMatch(/\.bak\./);
  });

  it("handles config with no plugin array", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ model: "test" }),
    });

    const result = runInstall({}, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
    expect(written.model).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// runUninstall
// ---------------------------------------------------------------------------

describe("runUninstall", () => {
  it("removes osr from plugin array", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["other", PLUGIN_NAME] }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("wrote");
    expect(result.removed).toEqual([PLUGIN_NAME]);

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual(["other"]);
  });

  it("removes plugin key entirely when array becomes empty", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME], model: "test" }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("wrote");

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toBeUndefined();
    expect(written.model).toBe("test");
  });

  it("is a no-op when not installed", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: ["other"] }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("noop");
    expect(result.removed).toEqual([]);
  });

  it("is a no-op when config has no plugin array", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ model: "test" }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("noop");
  });

  it("is a no-op when config file doesn't exist", () => {
    const fs = createMemFs();

    const result = runUninstall({}, fs);
    expect(result.status).toBe("noop");
  });

  it("dry-run prints but does not write", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });

    const result = runUninstall({ dryRun: true }, fs);
    expect(result.status).toBe("planned");

    // Config should be unchanged
    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
  });

  it("throws on corrupt existing config", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: '{"broken": invalid}',
    });

    expect(() => runUninstall({}, fs)).toThrow("malformed JSON");
  });

  it("removes versioned osr entries", () => {
    const fs = createMemFs({
      [CONFIG_PATH]: JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0`, "other"],
      }),
    });

    const result = runUninstall({}, fs);
    expect(result.status).toBe("wrote");
    expect(result.removed).toEqual([`${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0`]);

    const written = JSON.parse(fs.__files.get(CONFIG_PATH)!);
    expect(written.plugin).toEqual(["other"]);
  });
});

// ---------------------------------------------------------------------------
// runConfigInit / runConfigPaths
//
// Plan 019 — add explicit `osr config init` and `osr config paths` commands.
// These tests drive the new CLI module with the same in-memory CliFs as the
// install/uninstall tests above, plus vi.mock to pin the bundled tiers path
// for deterministic --from-bundled behavior.
// ---------------------------------------------------------------------------

const GLOBAL_TIERS_PATH = "/home/test/.config/opencode-smart-router/tiers.json";

describe("runConfigInit", () => {
  describe("target selection", () => {
    it("defaults to writing the global override path", () => {
      const fs = createMemFs();
      const result = runConfigInit({}, fs);

      expect(result.path).toBe(GLOBAL_TIERS_PATH);
      expect(result.status).toBe("wrote");
      expect(fs.__files.has(GLOBAL_TIERS_PATH)).toBe(true);
    });

    it("target: 'local' writes to <cwd>/.opencode/tiers.json", () => {
      const fs = createMemFs();
      const result = runConfigInit({ target: "local" }, fs);

      const expectedLocal = join(process.cwd(), ".opencode", "tiers.json");
      expect(result.path).toBe(expectedLocal);
      expect(fs.__files.has(expectedLocal)).toBe(true);
    });
  });

  describe("content selection", () => {
    it("default content is the empty object {}", () => {
      const fs = createMemFs();
      const result = runConfigInit({}, fs);

      expect(JSON.parse(result.content)).toEqual({});
      const written = JSON.parse(fs.__files.get(GLOBAL_TIERS_PATH)!);
      expect(written).toEqual({});
    });

    it("--preset <name> writes { activePreset: <name> }", () => {
      const fs = createMemFs();
      const result = runConfigInit({ preset: "multi-provider" }, fs);

      const written = JSON.parse(fs.__files.get(GLOBAL_TIERS_PATH)!);
      expect(written).toEqual({ activePreset: "multi-provider" });
      expect(JSON.parse(result.content)).toEqual({ activePreset: "multi-provider" });
    });

    it("invalid preset names throw against the bundled presets object", () => {
      const fs = createMemFs();
      expect(() => runConfigInit({ preset: "does-not-exist" }, fs)).toThrow(/preset/i);
      expect(fs.__files.has(GLOBAL_TIERS_PATH)).toBe(false);
    });

    it("--from-bundled copies the bundled tiers.json content", () => {
      const fs = createMemFs();
      const result = runConfigInit({ fromBundled: true }, fs);

      expect(fs.__files.has(GLOBAL_TIERS_PATH)).toBe(true);
      const written = JSON.parse(fs.__files.get(GLOBAL_TIERS_PATH)!);
      expect(written.presets["multi-provider"]).toBeDefined();
      expect(written.presets["anthropic"]).toBeDefined();
      expect(written.activePreset).toBe("multi-provider");
      expect(result.content).toContain("multi-provider");
    });

    it("--preset and --from-bundled together throw", () => {
      const fs = createMemFs();
      expect(() => runConfigInit({ preset: "anthropic", fromBundled: true }, fs)).toThrow(
        /--preset|--from-bundled|mutually exclusive/i,
      );
      expect(fs.__files.has(GLOBAL_TIERS_PATH)).toBe(false);
    });
  });

  describe("collision + dry-run semantics", () => {
    it("existing file without --force throws with --force hint", () => {
      const fs = createMemFs({
        [GLOBAL_TIERS_PATH]: JSON.stringify({ activePreset: "openai" }),
      });

      expect(() => runConfigInit({}, fs)).toThrow(/--force/);
      // Original file unchanged
      expect(JSON.parse(fs.__files.get(GLOBAL_TIERS_PATH)!)).toEqual({ activePreset: "openai" });
    });

    it("--force creates a backup then overwrites", () => {
      const fs = createMemFs({
        [GLOBAL_TIERS_PATH]: JSON.stringify({ activePreset: "openai" }),
      });

      const result = runConfigInit({ force: true }, fs);

      expect(result.status).toBe("wrote");
      expect(result.backup).toBeTruthy();
      expect(result.backup).toMatch(/\.bak\./);
      // New content overwrote the file
      expect(JSON.parse(fs.__files.get(GLOBAL_TIERS_PATH)!)).toEqual({});
    });

    it("--dry-run prints but writes nothing", () => {
      const fs = createMemFs();

      const result = runConfigInit({ dryRun: true }, fs);

      expect(result.status).toBe("planned");
      expect(fs.__files.has(GLOBAL_TIERS_PATH)).toBe(false);
      // The content is still computed and returned for display
      expect(JSON.parse(result.content)).toEqual({});
    });
  });
});

describe("runConfigPaths", () => {
  it("returns bundled, global, local, and state paths with existence flags", () => {
    const fs = createMemFs({
      [GLOBAL_TIERS_PATH]: JSON.stringify({ activePreset: "anthropic" }),
    });

    const result = runConfigPaths(fs);

    // All four entries are present
    expect(result.bundled.path).toBeTruthy();
    expect(result.global.path).toBe(GLOBAL_TIERS_PATH);
    expect(result.local.path).toBe(join(process.cwd(), ".opencode", "tiers.json"));
    expect(result.state.path).toBeTruthy();

    // Global file exists in the in-memory fs
    expect(result.global.exists).toBe(true);
    // Local file does not exist
    expect(result.local.exists).toBe(false);
  });

  it("reports false for paths that do not exist", () => {
    const fs = createMemFs();
    const result = runConfigPaths(fs);

    expect(result.global.exists).toBe(false);
    expect(result.local.exists).toBe(false);
    expect(result.state.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher routing (runMain) — verifies the new `config` command group
// is recognized by strict parseArgs and that unknown subcommands exit 2.
// We only assert exit codes for the dry-run / paths / error paths because
// the no-dry-run branches hit the real fs (the test HOME may not be writable).
// ---------------------------------------------------------------------------

describe("runMain — config dispatch", () => {
  it("config init --dry-run exits 0 (write paths skipped)", () => {
    const result = runMain(["node", "cli.mjs", "config", "init", "--dry-run"]);
    expect(result.command).toBe("config");
    expect(result.exitCode).toBe(0);
  });

  it("config paths dispatches to runConfigPaths (read-only)", () => {
    const result = runMain(["node", "cli.mjs", "config", "paths"]);
    expect(result.command).toBe("config");
    expect(result.exitCode).toBe(0);
  });

  it("config with unknown subcommand exits 2", () => {
    const result = runMain(["node", "cli.mjs", "config", "bogus"]);
    expect(result.exitCode).toBe(2);
  });

  it("config with missing subcommand exits 2", () => {
    const result = runMain(["node", "cli.mjs", "config"]);
    expect(result.exitCode).toBe(2);
  });

  it("strict parseArgs accepts --preset <name>", () => {
    // --dry-run is the only safe way to exercise the dispatch path without
    // hitting the real fs; if parseArgs rejected --preset, runMain would
    // return exitCode 2 from the parse-error branch.
    const result = runMain([
      "node",
      "cli.mjs",
      "config",
      "init",
      "--dry-run",
      "--preset",
      "anthropic",
    ]);
    expect(result.exitCode).toBe(0);
  });

  it("strict parseArgs accepts --from-bundled", () => {
    const result = runMain(["node", "cli.mjs", "config", "init", "--dry-run", "--from-bundled"]);
    expect(result.exitCode).toBe(0);
  });

  it("strict parseArgs accepts --force", () => {
    const result = runMain(["node", "cli.mjs", "config", "init", "--dry-run", "--force"]);
    expect(result.exitCode).toBe(0);
  });

  it("strict parseArgs accepts --target <global|local>", () => {
    let captured = "";
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      captured += String(msg) + "\n";
    });
    try {
      const result = runMain([
        "node",
        "cli.mjs",
        "config",
        "init",
        "--dry-run",
        "--target",
        "local",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`exitCode=${result.exitCode} stderr=${captured}`);
      }
      expect(result.exitCode).toBe(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("strict parseArgs rejects unknown flag with exit 2", () => {
    const result = runMain(["node", "cli.mjs", "config", "init", "--bogus-flag"]);
    expect(result.exitCode).toBe(2);
  });
});
