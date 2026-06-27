import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ModelRouterPlugin from "../../src/index";
import { readMergedConfig } from "../../src/router/config-loader";
import { resolveEnforcementMode } from "../../src/router/enforcement";

describe("router-command integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedXdgConfigHome: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real state file is never touched.
    testHomeDir = join(tmpdir(), `oc-mr-router-cmd-${Date.now()}`);
    mkdirSync(testHomeDir, { recursive: true });
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    // Tests must exercise the legacy `$HOME/.config/...` fallback so they
    // do not leak across users who have `XDG_CONFIG_HOME` set globally.
    delete process.env.XDG_CONFIG_HOME;
    hooks = await ModelRouterPlugin({} as any);
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    if (savedXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    }
  });

  it("enforce enforced persists + reload", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"](
      { command: "router", arguments: "enforce enforced" },
      out,
    );
    expect(out.parts[0].text).toContain("enforced");
    expect(out.parts[0].text).toContain("persisted");
    expect(
      resolveEnforcementMode({
        config: await readMergedConfig({ cwd: process.cwd() }),
        env: {},
      }).mode,
    ).toBe("enforced");
  });

  it("enforce off persists", async () => {
    // Prime to enforced first so "off" is a meaningful state transition.
    await hooks["command.execute.before"](
      { command: "router", arguments: "enforce enforced" },
      { parts: [] as any[] },
    );

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce off" }, out);
    expect(out.parts[0].text).toContain("off");
    expect(
      resolveEnforcementMode({
        config: await readMergedConfig({ cwd: process.cwd() }),
        env: {},
      }).mode,
    ).toBe("off");
  });

  it("enforce with no mode shows current + usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce" }, out);
    expect(out.parts[0].text).toContain("Usage:");
    expect(out.parts[0].text).toContain("Current enforcement mode");
  });

  it("invalid mode shows usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce loud" }, out);
    expect(out.parts[0].text).toContain("Usage:");
  });

  it("bare /router shows status", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    expect(out.parts[0].text).toContain("Enforcement:");
  });
});
