// ---------------------------------------------------------------------------
// src/router/commands/builders.ts — Pure renderers for the router commands.
//
// Each builder is a PURE function: it reads the cfg + args (and the optional
// `resolved` state from the dispatcher), renders text, and returns it.
// The builders NEVER call `save*` from `./config` and NEVER mutate
// `ctx.reasoningStore.setOverride/clearOverride` — those side effects are
// the dispatcher's job (see `./dispatch.ts`).
//
// When `resolved` is present, the builder trusts it as the source of truth
// for the just-performed action (e.g. `resolved.enforceMode === "off"`) and
// renders the "set to X" message accordingly. When `resolved` is absent
// (legacy direct-test calls that remain untouched), the builder falls back
// to inferring the action from `args` — this is the parity path that keeps
// the existing 7+ direct builder tests green without modification.
//
// See sdd/plugin-decomposition/design § Phase 3 for the full rationale.
// ---------------------------------------------------------------------------

import type { PluginContext } from "../../plugin/context";
// Type imports from original TS files (type definitions preserved for backward compat)
import type { reasoningCapability as ReasoningCapability, reasoningLevel as ReasoningLevel } from "../../reasoning/Reasoning.res.mjs";
// Value imports from ReScript facade
import { inferCapability, translateLevel } from "../../reasoning/Reasoning.res.mjs";
import type { RouterConfig } from "../config";
import { resolvePresetName } from "../config";
import { resolveEnforcementMode } from "../enforcement";
import { getActiveTiers } from "../protocol";

const REASONING_LEVELS: ReadonlySet<ReasoningLevel> = new Set([
  "minimal",
  "normal",
  "elevated",
  "max",
]);

// ---------------------------------------------------------------------------
// /router command output
// ---------------------------------------------------------------------------

export const buildRouterOutput = async (
  cfg: RouterConfig,
  args: string,
  _resolved?: { enforceMode?: "off" | "advisory" | "enforced" },
): Promise<string> => {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();
  if (sub === "enforce") {
    const mode = (tokens[1] ?? "").toLowerCase();
    if (mode === "off" || mode === "advisory" || mode === "enforced") {
      const desc =
        mode === "off"
          ? "Hard-block guard disabled (default routing behaviour)."
          : mode === "advisory"
            ? "Guard evaluates and surfaces banners but never hard-blocks."
            : "Guard hard-blocks subagent tool calls that violate budget / redundancy / self-script policy.";
      return [
        `Enforcement mode set to **${mode}** and persisted.`,
        "",
        desc,
        "",
        "Note: the `MODEL_ROUTER_ENFORCE` env var, when set to `0` or `1`, overrides this setting.",
      ].join("\n");
    }
    const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
    return [
      `Current enforcement mode: **${current}**`,
      "",
      "Usage: `/router enforce <off|advisory|enforced>`",
    ].join("\n");
  }
  const current = resolveEnforcementMode({ config: cfg, env: process.env }).mode;
  return [
    `# Model Router`,
    `Enforcement: **${current}**`,
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// /tiers command output
// ---------------------------------------------------------------------------

export const buildTiersOutput = (cfg: RouterConfig): string => {
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [`# Model Delegation Tiers`, `Active preset: **${cfg.activePreset}**\n`];

  for (const [name, tier] of Object.entries(tiers)) {
    const thinkingStr = tier.thinking
      ? ` | thinking: ${tier.thinking.budgetTokens} tokens`
      : tier.reasoning
        ? ` | reasoning: effort=${tier.reasoning.effort}`
        : "";
    lines.push(`## @${name} -> \`${tier.model}\`${thinkingStr}`);
    lines.push(tier.description);
    lines.push(`Steps: ${tier.steps ?? "default"}`);
    lines.push(`Use when: ${tier.whenToUse.join(", ")}\n`);
  }

  lines.push("## Delegation Rules");
  for (const r of cfg.rules) lines.push(`- ${r}`);
  lines.push(`\nDefault tier: @${cfg.defaultTier}`);
  lines.push(`\nAvailable presets: ${Object.keys(cfg.presets).join(", ")}`);
  lines.push(`Switch with: \`/preset <name>\``);
  lines.push(`Edit \`tiers.json\` to customize.`);

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// /budget command output
// ---------------------------------------------------------------------------

export const buildBudgetOutput = async (
  cfg: RouterConfig,
  args: string,
  _resolved?: { mode?: string },
): Promise<string> => {
  const modes = cfg.modes;
  if (!modes || Object.keys(modes).length === 0) {
    return 'No modes configured in tiers.json. Add a "modes" section to enable budget mode.';
  }

  const requested = args.trim().toLowerCase();
  const currentMode = cfg.activeMode || "normal";

  // No args: show current mode and available modes
  if (!requested) {
    const lines = ["# Routing Modes\n"];
    for (const [name, mode] of Object.entries(modes)) {
      const active = name === currentMode ? " <- active" : "";
      lines.push(
        `- **${name}**${active}: ${mode.description} (default tier: @${mode.defaultTier})`,
      );
    }
    lines.push(`\nSwitch with: \`/budget <mode>\``);
    return lines.join("\n");
  }

  // Switch mode
  if (modes[requested]) {
    const mode = modes[requested];
    return [
      `Routing mode switched to **${requested}**.`,
      "",
      mode.description,
      `Default tier: @${mode.defaultTier}`,
      ...(mode.overrideRules?.length
        ? ["", "Active rules:", ...mode.overrideRules.map((r) => `- ${r}`)]
        : []),
      "",
      "Mode change takes effect immediately on the next message.",
    ].join("\n");
  }

  return `Unknown mode: "${requested}". Available: ${Object.keys(modes).join(", ")}`;
};

// ---------------------------------------------------------------------------
// /preset command output
// ---------------------------------------------------------------------------

export const buildPresetOutput = async (
  cfg: RouterConfig,
  args: string,
  resolved?: { preset?: string },
): Promise<string> => {
  const requestedPreset = args.trim();

  // No args: show available presets
  if (!requestedPreset) {
    const lines = ["# Available Presets\n"];
    for (const [name, tiers] of Object.entries(cfg.presets)) {
      const active = name === cfg.activePreset ? " <- active" : "";
      const models = Object.entries(tiers)
        .map(([tier, t]) => `${tier}: ${t.model.split("/").pop()}`)
        .join(", ");
      lines.push(`- **${name}**${active}: ${models}`);
    }
    lines.push(`\nSwitch with: \`/preset <name>\``);
    return lines.join("\n");
  }

  // Switch preset
  const resolvedPreset = resolved?.preset ?? resolvePresetName(cfg, requestedPreset);
  if (resolvedPreset) {
    const tiers = cfg.presets[resolvedPreset];
    if (!tiers) {
      return `Unknown preset: "${requestedPreset}". Available: ${Object.keys(cfg.presets).join(", ")}`;
    }
    const models = Object.entries(tiers)
      .map(([tier, t]) => `  @${tier} -> ${t.model}`)
      .join("\n");
    return [
      `Preset switched to **${resolvedPreset}**.`,
      "",
      models,
      "",
      "Selection is now persisted in ~/.config/opencode/opencode-smart-router.state.json.",
      "Restart OpenCode for subagent model registration to take effect.",
      "System prompt delegation rules update immediately.",
    ].join("\n");
  }

  return `Unknown preset: "${requestedPreset}". Available: ${Object.keys(cfg.presets).join(", ")}`;
};

// ---------------------------------------------------------------------------
// /model-router-reasoning command output (PR 3 of adaptive-reasoning-engine).
//
// Two responsibilities, parsed from the first token:
//   1. `mode <static|manual|adaptive>` — persist a runtime policy-mode switch.
//      The PERSIST call (saveReasoningMode) is in the dispatcher; the builder
//      only renders.
//   2. `<level>` (one of `minimal|normal|elevated|max`, or `off`) — set /
//      clear the per-session override on `ctx.reasoningStore`. The override
//      mutation (setOverride/clearOverride) is in the dispatcher; the builder
//      only renders.
//
// Honors `reasoningPolicy.surfaceLimits`: when true, emits an advisory note
// describing any collapse (e.g. `normal` and `elevated` both mapping to
// `medium` on a 3-level discrete ladder — documented quirk of the
// `Math.round(rank/3 * (len-1))` formula in PR 1). Defaults to silent no-op.
// ---------------------------------------------------------------------------

/**
 * Describe a tier's capability in plain English for the command output.
 * Compact form: the tier name + the kind + a one-line hint about what it
 * can satisfy.
 */
const describeCapability = (tierName: string, cap: ReasoningCapability): string => {
  switch (cap.kind) {
    case "none":
      return `@${tierName}: no reasoning control (the tier is left as-is).`;
    case "binary":
      return `@${tierName}: binary variant (elevated: ${cap.elevated}${cap.baseline ? `, baseline: ${cap.baseline}` : ""}).`;
    case "discrete": {
      const channel = cap.field === "variant" ? "variant" : "reasoning_effort";
      return `@${tierName}: discrete ${channel} ladder [${(cap.levels ?? []).join(" < ")}].`;
    }
    case "budgeted":
      return `@${tierName}: budgeted (thinking tokens per level: ${Object.entries(cap.recommended ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}).`;
    default:
      return `@${tierName}: unknown capability.`;
  }
};

/**
 * Detect when a discrete-ladder translation collapses two requested levels
 * onto the same rung (the documented `Math.round(rank/3 * (len-1))` quirk
 * for 3-level ladders: normal + elevated both map to index 1 = medium).
 *
 * Returns a one-line advisory note when a collapse happened, or `undefined`
 * when every requested level maps to a distinct rung.
 */
const detectCollapse = (cap: ReasoningCapability, level: ReasoningLevel): string | undefined => {
  if (cap.kind !== "discrete") return undefined;
  // Compare the resolved patch for `level` against the resolved patch for
  // the level one rank below. If they're equal, the requested level has
  // collapsed onto a coarser rung.
  const RANK: Record<ReasoningLevel, number> = { minimal: 0, normal: 1, elevated: 2, max: 3 };
  const rank = RANK[level];
  if (rank <= 0) return undefined;
  const lower = (Object.keys(RANK) as ReasoningLevel[]).find((k) => RANK[k] === rank - 1);
  if (!lower) return undefined;
  const here = translateLevel(cap, level);
  const below = translateLevel(cap, lower);
  if (!here || !below) return undefined;
  // Compare the patch payload — same channel output means collapse.
  if (here.variant !== undefined && here.variant === below.variant) {
    return `Note: '${level}' collapses to '${here.variant}' (same as '${lower}') on this tier's ladder — surface the limit by enabling reasoningPolicy.surfaceLimits.`;
  }
  if (here.options && below.options) {
    if (JSON.stringify(here.options) === JSON.stringify(below.options)) {
      const key = Object.keys(here.options)[0] ?? "";
      return `Note: '${level}' collapses onto '${lower}' for this tier (${key}=${here.options[key]}).`;
    }
  }
  return undefined;
};

export const buildReasoningOutput = async (
  cfg: RouterConfig,
  args: string,
  _ctx: PluginContext,
  _sessionID: string,
  _resolved?: { policyMode?: "static" | "manual" | "adaptive" },
): Promise<string> => {
  const surfaceLimits = cfg.reasoningPolicy?.surfaceLimits === true;
  const policyMode = cfg.reasoningPolicy?.mode ?? "static";

  const tokens = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "";

  // Show help when no args — describe every active tier's capability and
  // the full subcommand surface (mode + level).
  if (tokens.length === 0) {
    const tiers = getActiveTiers(cfg);
    const lines: string[] = [
      `# Reasoning Overrides`,
      `Policy mode: **${policyMode}** (surfaceLimits: ${surfaceLimits ? "on" : "off"})`,
      "",
    ];
    for (const [name, tier] of Object.entries(tiers)) {
    const cap: ReasoningCapability = tier.capability ?? (inferCapability(tier) as ReasoningCapability);
      lines.push(describeCapability(name, cap));
    }
    lines.push(
      "",
      "Set per-session override: `/model-router-reasoning minimal|normal|elevated|max`. Clear with `/model-router-reasoning off`.",
      "Switch persisted policy mode: `/model-router-reasoning mode <static|manual|adaptive>`.",
      "Applies to the next `task` dispatch in this session only.",
    );
    return lines.join("\n");
  }

  // --- `mode` subcommand: persists a policy-mode overlay via state file. ---
  if (sub === "mode") {
    const modeArg = tokens[1] ?? "";
    if (!modeArg) {
      return [
        `Current reasoning policy mode: **${policyMode}**`,
        "",
        "Usage: `/model-router-reasoning mode <static|manual|adaptive>`",
        "`static` uses each tier's default reasoning level.",
        "`manual` enables per-session overrides via `minimal|normal|elevated|max`.",
        "`adaptive` picks a level from task signals (prompt + description + tier + trivial flag) via `reasoningPolicy.adaptive`.",
      ].join("\n");
    }
    if (modeArg === "static" || modeArg === "manual" || modeArg === "adaptive") {
      const desc =
        modeArg === "static"
          ? "Per-tier defaults are in effect — per-session overrides are ignored at task dispatch."
          : modeArg === "manual"
            ? "Per-session overrides are enabled — `/model-router-reasoning minimal|normal|elevated|max` will take effect on the next task dispatch."
            : "Adaptive selector picks the level from task signals (prompt + description + tier + trivial flag). Per-session overrides still win when set. Tune `reasoningPolicy.adaptive` (keywordRules, tierDefaults, defaultLevel) to taste.";
      return [
        `Reasoning policy mode set to **${modeArg}** and persisted.`,
        "",
        desc,
        "",
        "Takes effect on the next config refresh.",
      ].join("\n");
    }
    return `Unknown mode: "${modeArg}". Use one of: static, manual, adaptive (or run '/model-router-reasoning mode' for the current value).`;
  }

  // --- per-session override flow (minimal|normal|elevated|max|off) ---
  if (sub === "off") {
    return [
      "Reasoning override cleared.",
      "",
      "Next task dispatches in this session will use the tier's baseline reasoning.",
    ].join("\n");
  }

  if (!REASONING_LEVELS.has(sub as ReasoningLevel)) {
    return `Unknown level: "${sub}". Use one of: minimal, normal, elevated, max (or "off" to clear). Run '/model-router-reasoning mode' to switch the policy.`;
  }

  // Per-tier acknowledgement: which tiers can actually satisfy the level,
  // which collapse, and which can't (none capability → silent no-op unless
  // surfaceLimits is enabled).
  const tiers = getActiveTiers(cfg);
  const lines: string[] = [
    `Reasoning override set to **${sub}** for this session.`,
    "",
    "Per-tier behaviour:",
  ];
  let anyCollapse = false;
  for (const [name, tier] of Object.entries(tiers)) {
    const cap: ReasoningCapability = tier.capability
      ? (tier.capability as ReasoningCapability)
      : (inferCapability(tier) as ReasoningCapability);
    if (cap.kind === "none") {
      if (surfaceLimits) lines.push(`- @${name}: unsupported (no reasoning control).`);
      continue;
    }
    const resolved = translateLevel(cap, sub as ReasoningLevel);
    if (!resolved) {
      if (surfaceLimits) {
        lines.push(`- @${name}: level '${sub}' is a no-op for this tier's capability.`);
      }
      continue;
    }
    if (resolved.variant !== undefined) {
      lines.push(`- @${name}: variant = '${resolved.variant}'.`);
    }
    if (resolved.options) {
      lines.push(`- @${name}: options = ${JSON.stringify(resolved.options)}.`);
    }
    const note = detectCollapse(cap, sub as ReasoningLevel);
    if (note) {
      anyCollapse = true;
      if (surfaceLimits) lines.push(`  ${note}`);
    }
  }
  if (anyCollapse && !surfaceLimits) {
    lines.push(
      "",
      "(One or more tiers collapse this level onto a coarser rung. Enable `reasoningPolicy.surfaceLimits` to see which.)",
    );
  }
  lines.push("", "Takes effect on the next `task` dispatch in this session.");
  return lines.join("\n");
};
