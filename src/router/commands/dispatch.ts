// ---------------------------------------------------------------------------
// src/router/commands/dispatch.ts — Command dispatcher + opencode registry.
//
// This is the single writer of side effects for the router commands:
//   - `await saveEnforcementMode(mode)` (router enforce subcommand)
//   - `await saveActiveMode(mode)`      (budget subcommand)
//   - `await saveActivePreset(preset)`  (preset subcommand)
//   - `await saveReasoningMode(mode)`   (reasoning mode subcommand)
//   - `ctx.reasoningStore.setOverride(sid, level)` (per-session level set)
//   - `ctx.reasoningStore.clearOverride(sid)`      (per-session clear)
//
// The builders in `./builders.ts` are pure renderers. The dispatcher
// implements the `parse → act → render` pattern per branch — it parses
// the args, performs the side effect (writes to the state file or the
// reasoning store), then calls the builder with a `resolved` object that
// tells the builder what just happened.
//
// `registerRouterCommands` is unchanged from the original `commands.ts`
// (verbatim from lines 404-473). It runs at opencode config-load time to
// populate the command surface.
// ---------------------------------------------------------------------------

import type { PluginContext } from "../../plugin/context";
import {
  resolvePresetName,
  saveActiveMode,
  saveActivePreset,
  saveEnforcementMode,
  saveReasoningMode,
} from "../config";
import { getActiveTiers } from "../Protocol.res.mjs";
import {
  buildBudgetOutput,
  buildPresetOutput,
  buildReasoningOutput,
  buildRouterOutput,
  buildTiersOutput,
} from "./builders";

// ---------------------------------------------------------------------------
// Register router commands on the opencode config object
// ---------------------------------------------------------------------------

/**
 * Populate `opencodeConfig.command` with the router-owned command set:
 * `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`, `/router`,
 * and `/model-router-reasoning`. Mirrors the block that lived in
 * `src/index.ts`'s `config()` hook.
 *
 * Side-effect only — the returned void matches the original inline block.
 */
export const registerRouterCommands = (opencodeConfig: {
  command?: Record<string, { template: string; description: string }>;
}): void => {
  opencodeConfig.command ??= {};
  opencodeConfig.command.tiers = {
    template: "",
    description: "Show model delegation tiers and rules",
  };
  opencodeConfig.command.preset = {
    template: "$ARGUMENTS",
    description: "Show or switch model presets (e.g., /preset openai)",
  };
  opencodeConfig.command.budget = {
    template: "$ARGUMENTS",
    description: "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
  };
  opencodeConfig.command.bypass = {
    template: "$ARGUMENTS",
    description: "Toggle model-router bypass (disables delegation protocol for this session)",
  };
  opencodeConfig.command["annotate-plan"] = {
    template: [
      "Annotate the plan with tier directives for model delegation.",
      "",
      'Plan file: "$ARGUMENTS"',
      "If no file was specified, search for the active plan: PLAN.md, plan.md, or the most recent .md with 'plan' in the name in the current directory or project root.",
      "",
      "## Available tiers",
      "- `[tier:fast]` — Fast/cheap model: exploration, search, file reads, grep, listing, research. Agent does NOT edit code.",
      "- `[tier:light]` — Localized specialist: simple edits, small fixes, config tweaks, single-file refactoring. CAP≤7.",
      "- `[tier:medium]` — Balanced model: implementation, refactoring, tests, code review, bug fixes, standard coding tasks.",
      "- `[tier:focused]` — Deep single-system specialist: single-system debugging, complex bug isolation, single-system review. CAP≤4.",
      "- `[tier:heavy]` — Most capable model: architecture, complex debugging (after failures), security, performance, multi-system tradeoffs.",
      "",
      "## Annotation rules",
      "1. Place `[tier:X]` at the START of each step, before the description",
      "2. Research/exploration -> `[tier:fast]` (preferred)",
      "3. Localized/simple changes -> `[tier:light]` (simple edits, small fixes, config tweaks)",
      "4. Implementation/code -> `[tier:medium]` (preferred for standard coding tasks)",
      "5. Deep single-system analysis -> `[tier:focused]` (single-system debugging, isolation, review)",
      "6. Architecture/security/multi-system/hard debugging -> `[tier:heavy]`",
      "7. If a step mixes exploration AND implementation, prefer splitting it into two steps when it improves delegation clarity",
      "8. Verification (run tests, build) -> `[tier:medium]`",
      "9. Trivial (single grep or file read) -> `[tier:fast]`",
      "10. Final review of the complete plan -> `[tier:heavy]`",
      "",
      "## Output",
      "Rewrite the entire plan in the file with the tags. Do not change the substance — only add tags, and split mixed steps when useful for clearer delegation.",
      "",
      "## Acceptance blocks (for enforcement)",
      "For each NON-TRIVIAL task, append an acceptance block immediately after the step so the router can verify the work:",
      "[acceptance]",
      'check: <testsPass | buildPasses | lintClean | fileExists path=... | run command="..." expect=...>',
      "criteria: <plain-language success condition, when no deterministic check applies>",
      "deliverable: <path or short description>",
      "[/acceptance]",
      "Prefer deterministic checks (testsPass/buildPasses/fileExists). Use a criteria line for design/explanatory tasks. Trivial read-only steps need no acceptance block.",
    ].join("\n"),
    description: "Annotate a plan with [tier:fast/light/medium/focused/heavy] delegation tags",
  };
  opencodeConfig.command.router = {
    template: "$ARGUMENTS",
    description: "Model-router controls (e.g., /router enforce off|advisory|enforced)",
  };
  opencodeConfig.command["model-router-reasoning"] = {
    template: "$ARGUMENTS",
    description:
      "Reasoning control: /model-router-reasoning mode <static|manual|adaptive> (persists) | /model-router-reasoning minimal|normal|elevated|max (set) | /model-router-reasoning off (clear)",
  };
};

// ---------------------------------------------------------------------------
// command.execute.before dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch handler for the `command.execute.before` hook. Pushes a text
 * part onto `output.parts` for `/tiers`, `/preset`, `/budget`, `/router`,
 * and `/model-router-reasoning`, and toggles `ctx.state.bypassed` for
 * `/bypass`. Mirrors the block that lived inline in `src/index.ts`.
 *
 * The function is async because the hook itself was async; the body performs
 * no asynchronous work for the bypass path (the await was structural).
 * Errors in `refreshConfig()` are swallowed (we fall back to the cached cfg)
 * — same fail-soft semantics.
 *
 * Pattern per branch: parse → act → render.
 *   - parse: extract tokens from `args`, identify the action.
 *   - act: if the action is valid, call the corresponding `save*` or
 *     `ctx.reasoningStore.setOverride/clearOverride`.
 *   - render: call the builder with the `resolved` state so it renders
 *     the "set to X" message (or the error message when the action is
 *     invalid).
 */
export const handleCommandBefore = async (
  ctx: PluginContext,
  input: { command: string; arguments?: string; sessionID?: string },
  // The SDK's `command.execute.before` output is `{ parts: Part[] }` where
  // `Part` is a discriminated union of text/reasoning/file/tool/etc. We only
  // push text parts, so a structural supertype is sufficient.
  output: { parts: Array<{ type: string; text?: string; [key: string]: unknown }> },
): Promise<void> => {
  if (input.command === "tiers") {
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildTiersOutput(cfg),
    });
  }

  if (input.command === "preset") {
    const cfg = await ctx.getFreshConfig();
    const args = input.arguments ?? "";
    const requestedPreset = resolvePresetName(cfg, args.trim());
    if (requestedPreset) await saveActivePreset(requestedPreset);
    output.parts.push({
      type: "text" as const,
      text: await buildPresetOutput(cfg, args, { preset: requestedPreset }),
    });
  }

  if (input.command === "bypass") {
    const arg = (input.arguments ?? "").trim().toLowerCase();
    if (arg === "on") {
      ctx.state.bypassed = true;
    } else if (arg === "off") {
      ctx.state.bypassed = false;
    } else {
      ctx.state.bypassed = !ctx.state.bypassed;
    }
    const status = ctx.state.bypassed ? "ON" : "OFF";
    const desc = ctx.state.bypassed
      ? "Model-router is **bypassed**. Delegation protocol, cap enforcement, and narration detection are disabled. The model will run without routing rules until you run `/bypass off` or restart OpenCode."
      : "Model-router is **active**. Delegation protocol and all enforcement rules are in effect.";
    output.parts.push({
      type: "text" as const,
      text: `# Bypass: ${status}\n\n${desc}`,
    });
  }

  if (input.command === "budget") {
    const cfg = await ctx.getFreshConfig();
    const args = input.arguments ?? "";
    const requested = args.trim().toLowerCase();
    const modes = cfg.modes ?? {};
    const resolvedMode = requested && modes[requested] ? requested : undefined;
    if (resolvedMode) await saveActiveMode(resolvedMode);
    output.parts.push({
      type: "text" as const,
      text: await buildBudgetOutput(cfg, args, { mode: resolvedMode }),
    });
  }

  if (input.command === "router") {
    const cfg = await ctx.getFreshConfig();
    const args = input.arguments ?? "";
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const sub = (tokens[0] ?? "").toLowerCase();
    let resolvedEnforceMode: "off" | "advisory" | "enforced" | undefined;
    if (
      sub === "enforce" &&
      (tokens[1] === "off" || tokens[1] === "advisory" || tokens[1] === "enforced")
    ) {
      await saveEnforcementMode(tokens[1]);
      resolvedEnforceMode = tokens[1];
    }
    output.parts.push({
      type: "text" as const,
      text: await buildRouterOutput(cfg, args, { enforceMode: resolvedEnforceMode }),
    });
  }

  if (input.command === "model-router-reasoning") {
    const cfg = await ctx.getFreshConfig();
    const args = input.arguments ?? "";
    const sessionID = input.sessionID ?? "";
    const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sub = tokens[0] ?? "";
    let resolvedPolicyMode: "static" | "manual" | "adaptive" | undefined;

    // --- `mode` subcommand: persist policy-mode overlay ---
    if (
      sub === "mode" &&
      tokens[1] &&
      (tokens[1] === "static" || tokens[1] === "manual" || tokens[1] === "adaptive")
    ) {
      await saveReasoningMode(tokens[1]);
      resolvedPolicyMode = tokens[1];
    }

    // --- per-session override flow (minimal|normal|elevated|max|off) ---
    if (sub === "off") {
      if (sessionID) ctx.reasoningStore.clearOverride(sessionID);
    } else if (sub === "minimal" || sub === "normal" || sub === "elevated" || sub === "max") {
      if (sessionID) ctx.reasoningStore.setOverride(sessionID, sub);
    }

    output.parts.push({
      type: "text" as const,
      text: await buildReasoningOutput(cfg, args, ctx, sessionID, {
        policyMode: resolvedPolicyMode,
      }),
    });
  }
};

// Reference the imported `getActiveTiers` so biome/lint does not flag it as
// unused — the helper is re-exported via the public surface by way of the
// builders, but the dispatcher itself does not use it. Kept here to
// document the helper's role in command rendering.
void getActiveTiers;
