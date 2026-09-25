/**
 * test/integration/layer2-wiring.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove Layer-2 wiring
 * deterministically (no live models, no network).
 *
 * Option (i) — verify-dispatch appends a forcing note when a task result fails
 *              a deterministic DoD, and is a no-op when enforcement is off.
 * Option (ii) — delegate tool returns accepted vs unmet correctly.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ModelRouterPlugin from "../../src/index";

// ---------------------------------------------------------------------------
// Fake ctx builder
// ---------------------------------------------------------------------------

const makeCtx = (dir: string, promptReply: string, extraConfig?: Record<string, unknown>) => {
  if (extraConfig) {
    const cfgDir = path.join(dir, ".opencode");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "tiers.json"), JSON.stringify(extraConfig, null, 2));
  }
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({
          data: { id: `sess_${Math.random().toString(36).slice(2)}` },
        }),
        prompt: async () => ({
          data: { parts: [{ type: "text", text: promptReply }] },
        }),
      },
    } as any,
  };
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Layer-2 wiring", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedXdgConfigHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml2-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
    // Redirect homedir so loadConfig never reads the real user state file.
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    // Sandbox the XDG config layer too: globalConfigPath() honours
    // $XDG_CONFIG_HOME before $HOME/.config, so an operator's real
    // ~/.config/opencode-smart-router/tiers.json (e.g. one carrying
    // enforcement.verify.require="never") would otherwise leak into the
    // merged config and silently disable verification in these tests.
    process.env.XDG_CONFIG_HOME = path.join(dir, ".xdg-config");
    // Ensure MODEL_ROUTER_ENFORCE is clean (tests that need it set it themselves).
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  });

  afterEach(() => {
    // Restore HOME / USERPROFILE.
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (savedUserProfile !== undefined) {
      process.env.USERPROFILE = savedUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    if (savedXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    // Clean up enforcement override.
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    // Best-effort temp dir removal.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Option (i): verify-dispatch via tool.execute.after
  // -------------------------------------------------------------------------

  describe("Option (i) verify-dispatch — tool.execute.after", () => {
    it("CASE A: appends forcing note when deterministic DoD FAILS (file missing)", async () => {
      process.env.MODEL_ROUTER_ENFORCE = "1";
      const hooks: any = await ModelRouterPlugin(
        makeCtx(dir, "grader/producer reply", {
          enforcement: { verify: { skipFastTier: false } },
        }) as any,
      );

      const input = {
        tool: "task",
        sessionID: "orch",
        args: {
          subagent_type: "fast",
          prompt:
            "Create the report.\n[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]",
        },
      };
      const output = {
        output: "<task_result>\nDONE: report created.\n</task_result>",
        metadata: { sessionId: "child1" },
      };

      await hooks["tool.execute.after"](input, output);

      expect(output.output).toContain("NOT ACCEPTED");
    });

    it("CASE B: does NOT append note when deterministic DoD PASSES (file exists)", async () => {
      process.env.MODEL_ROUTER_ENFORCE = "1";
      fs.writeFileSync(path.join(dir, "present-file.txt"), "ok");
      const hooks: any = await ModelRouterPlugin(makeCtx(dir, "grader/producer reply") as any);

      const input = {
        tool: "task",
        sessionID: "orch",
        args: {
          subagent_type: "fast",
          prompt:
            "Create the file.\n[acceptance]\ncheck: fileExists path=present-file.txt\n[/acceptance]",
        },
      };
      const output = {
        output: "<task_result>\nDONE.\n</task_result>",
        metadata: { sessionId: "child2" },
      };
      const original = output.output;

      await hooks["tool.execute.after"](input, output);

      expect(output.output).not.toContain("NOT ACCEPTED");
      expect(output.output).toBe(original);
    });

    it("CASE C: is a no-op when enforcement is OFF (GA-1 preserved)", async () => {
      // Pin to "off" mode so shouldVerifyTask returns false and the verify block is skipped.
      process.env.MODEL_ROUTER_ENFORCE = "0";
      const hooks: any = await ModelRouterPlugin(makeCtx(dir, "grader/producer reply") as any);

      const input = {
        tool: "task",
        sessionID: "orch",
        args: {
          subagent_type: "fast",
          prompt:
            "Create the report.\n[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]",
        },
      };
      const output = {
        output: "<task_result>\nDONE: report created.\n</task_result>",
        metadata: { sessionId: "child3" },
      };
      const original = output.output;

      await hooks["tool.execute.after"](input, output);

      expect(output.output).toBe(original);
      expect(output.output).not.toContain("NOT ACCEPTED");
    });
  });

  // -------------------------------------------------------------------------
  // Option (ii): delegate tool
  // -------------------------------------------------------------------------

  const fakeCtx = { sessionID: "sess_layer2", abort: new AbortController().signal };

  describe("Option (ii) delegate tool", () => {
    it("CASE D: returns accepted on deterministic PASS", async () => {
      fs.writeFileSync(path.join(dir, "deliver.txt"), "x");
      const hooks: any = await ModelRouterPlugin(
        makeCtx(dir, "I created deliver.txt as requested.") as any,
      );

      const out: string = await hooks.tool.delegate.execute(
        {
          task: "Write the file.\n[acceptance]\ncheck: fileExists path=deliver.txt\n[/acceptance]",
          tier: "fast",
        },
        fakeCtx,
      );

      expect(out).toContain("accepted: deterministic");
    });

    it("CASE E: returns honest unmet on deterministic FAIL", async () => {
      // Fresh temp dir, nope.txt never created.
      const hooks: any = await ModelRouterPlugin(makeCtx(dir, "I totally did it (lying).") as any);

      const out: string = await hooks.tool.delegate.execute(
        {
          task: "Write the file.\n[acceptance]\ncheck: fileExists path=nope.txt\n[/acceptance]",
          tier: "fast",
        },
        fakeCtx,
      );

      expect(out).toContain("status: unmet");
      expect(out).not.toContain("accepted: ");
    });
  });
});
