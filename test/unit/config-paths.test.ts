import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetPathsForTest,
  globalConfigPath,
  type ResolvedConfigPaths,
  resolveConfigPaths,
  resolveConfigRoot,
  resolveLegacyConfigRoot,
  stateLegacyPath,
  statePath,
} from "../../src/router/config-paths";

// ---------------------------------------------------------------------------
// XDG-aware path resolver — unit tests.
//
// These cover the documented precedence order:
//   1. $XDG_CONFIG_HOME (preferred, when set)
//   2. $HOME/.config       (legacy fallback)
//   3. $USERPROFILE/.config (Windows fallback when HOME is missing)
//   4. os.homedir()/.config (last resort)
//
// Each test resets the memoized result so env-var changes between cases are
// reflected immediately. The tests use unique tmpdir-based paths so the
// developer's real $HOME is never read or written.
// ---------------------------------------------------------------------------

describe("resolveConfigRoot", () => {
  const restoreEnv = (saved: NodeJS.ProcessEnv): void => {
    for (const k of Object.keys(saved)) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  afterEach(() => {
    __resetPathsForTest();
  });

  it("prefers $XDG_CONFIG_HOME when set", () => {
    const saved = { ...process.env };
    try {
      process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      expect(resolveConfigRoot()).toBe("/custom/xdg");
    } finally {
      restoreEnv(saved);
    }
  });

  it("falls back to $HOME/.config when XDG is unset", () => {
    const saved = { ...process.env };
    try {
      delete process.env["XDG_CONFIG_HOME"];
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      expect(resolveConfigRoot()).toBe("/home/someone/.config");
    } finally {
      restoreEnv(saved);
    }
  });

  it("falls back to $USERPROFILE/.config on Windows when HOME is missing", () => {
    const saved = { ...process.env };
    try {
      delete process.env["XDG_CONFIG_HOME"];
      delete process.env["HOME"];
      process.env["USERPROFILE"] = "C:/Users/someone";
      __resetPathsForTest();
      expect(resolveConfigRoot()).toBe(join("C:/Users/someone", ".config"));
    } finally {
      restoreEnv(saved);
    }
  });

  it("ignores an empty $XDG_CONFIG_HOME (falls through to $HOME)", () => {
    const saved = { ...process.env };
    try {
      process.env["XDG_CONFIG_HOME"] = "   ";
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      expect(resolveConfigRoot()).toBe("/home/someone/.config");
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("resolveLegacyConfigRoot", () => {
  afterEach(() => {
    __resetPathsForTest();
  });

  it("ignores $XDG_CONFIG_HOME and always uses $HOME/.config", () => {
    const saved = { ...process.env };
    try {
      process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      // resolveLegacyConfigRoot is intentionally XDG-independent so the
      // read-fallback path mirrors the historical install layout.
      expect(resolveLegacyConfigRoot()).toBe("/home/someone/.config");
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("falls back to $USERPROFILE/.config when $HOME is missing", () => {
    const saved = { ...process.env };
    try {
      delete process.env["HOME"];
      process.env["USERPROFILE"] = "C:/Users/someone";
      __resetPathsForTest();
      expect(resolveLegacyConfigRoot()).toBe(join("C:/Users/someone", ".config"));
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("resolveConfigPaths", () => {
  afterEach(() => {
    __resetPathsForTest();
  });

  it("returns the expected triple when XDG is set", () => {
    const saved = { ...process.env };
    try {
      process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      const paths: ResolvedConfigPaths = resolveConfigPaths();
      expect(paths.globalConfig).toBe(join("/custom/xdg", "opencode-model-router", "tiers.json"));
      expect(paths.statePreferred).toBe(
        join("/custom/xdg", "opencode", "opencode-model-router.state.json"),
      );
      // stateLegacy mirrors $HOME regardless of XDG.
      expect(paths.stateLegacy).toBe(
        join("/home/someone", ".config", "opencode", "opencode-model-router.state.json"),
      );
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("falls back to $HOME/.config when XDG is unset (statePreferred === stateLegacy)", () => {
    const saved = { ...process.env };
    try {
      delete process.env["XDG_CONFIG_HOME"];
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      const paths = resolveConfigPaths();
      expect(paths.globalConfig).toBe(
        join("/home/someone", ".config", "opencode-model-router", "tiers.json"),
      );
      // With no XDG, preferred and legacy collapse to the same path.
      expect(paths.statePreferred).toBe(paths.stateLegacy);
      expect(paths.statePreferred).toBe(
        join("/home/someone", ".config", "opencode", "opencode-model-router.state.json"),
      );
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("memoizes the result for the same env", () => {
    const saved = { ...process.env };
    try {
      process.env["HOME"] = "/home/someone";
      delete process.env["XDG_CONFIG_HOME"];
      __resetPathsForTest();
      const a = resolveConfigPaths();
      const b = resolveConfigPaths();
      // Reference equality (same memoized envelope).
      expect(b).toBe(a);
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("re-resolves when env changes", () => {
    const saved = { ...process.env };
    try {
      delete process.env["XDG_CONFIG_HOME"];
      process.env["HOME"] = "/home/a";
      __resetPathsForTest();
      const before = resolveConfigPaths();

      process.env["HOME"] = "/home/b";
      __resetPathsForTest();
      const after = resolveConfigPaths();

      expect(after).not.toBe(before);
      expect(before.globalConfig).toContain("/home/a");
      expect(after.globalConfig).toContain("/home/b");
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("convenience accessors", () => {
  afterEach(() => {
    __resetPathsForTest();
  });

  it("globalConfigPath() returns the XDG or legacy tiers.json path", () => {
    const saved = { ...process.env };
    try {
      delete process.env["XDG_CONFIG_HOME"];
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      expect(globalConfigPath()).toBe(
        join("/home/someone", ".config", "opencode-model-router", "tiers.json"),
      );
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("statePath() and stateLegacyPath() return the documented triple entries", () => {
    const saved = { ...process.env };
    try {
      process.env["XDG_CONFIG_HOME"] = "/custom/xdg";
      process.env["HOME"] = "/home/someone";
      __resetPathsForTest();
      expect(statePath()).toBe(join("/custom/xdg", "opencode", "opencode-model-router.state.json"));
      expect(stateLegacyPath()).toBe(
        join("/home/someone", ".config", "opencode", "opencode-model-router.state.json"),
      );
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Smoke check: the resolver never throws when the host env is unusual.
// This guards against regressions in the fallback chain.
// ---------------------------------------------------------------------------

describe("resolveConfigPaths — hostile env smoke", () => {
  it("does not throw when HOME, USERPROFILE, and XDG are all unset", () => {
    const saved = { ...process.env };
    try {
      delete process.env["HOME"];
      delete process.env["USERPROFILE"];
      delete process.env["XDG_CONFIG_HOME"];
      __resetPathsForTest();
      expect(() => resolveConfigPaths()).not.toThrow();
    } finally {
      for (const k of Object.keys(saved)) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// Reference a tmpdir path so the build doesn't strip the `tmpdir` import.
void tmpdir;
