// ---------------------------------------------------------------------------
// src/plugin/hooks/system-config.ts — System prompt transform + config hook.
//
// Carries the two load-time / pre-dispatch hooks: `handleSystemTransform`
// (injects the delegation protocol into the orchestrator system prompt)
// and `handleConfig` (registers tier agents + router commands on the
// opencode config object at plugin load time, captures per-tier baselines).
//
// Each handler is a verbatim extraction from the original
// `src/plugin/hooks.ts` monolith. Bodies are unchanged.
// ---------------------------------------------------------------------------

import { registerTierAgents } from "../../router/agents";
import { registerRouterCommands } from "../../router/commands";
import type { Preset } from "../../router/config";
import { resolveEnforcementMode } from "../../router/enforcement";
import type { tierConfig } from "../../router/Protocol.res.mjs";
import { assembleSystemPrompt } from "../../router/Protocol.res.mjs";
import { log } from "../../utils/observability";
import type { PluginContext } from "../context";
import type { HookPayload } from "../types";

// ---------------------------------------------------------------------------
// experimental.chat.system.transform — inject delegation protocol for the
// primary orchestrator only (never for tracked subagents).
// ---------------------------------------------------------------------------

export const handleSystemTransform = async (
  ctx: PluginContext,
  _input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  // getFreshConfig() returns the refreshed config and falls back to the
  // cached value if the file read fails.
  const cfg = await ctx.getFreshConfig();

  // Skip injection for child (subagent) sessions.
  // Child sessions are detected via session.created events with a parentID.
  const sessionID = _input?.sessionID as string | undefined;
  if (sessionID && ctx.sessionStore.isSubagent(sessionID)) return;

  // For Claude-backed orchestrators, prepend an adversarial opener that
  // revokes the cached "Claude Code explorer" priming for the routing
  // role. Detection is by orchestrator model, not preset.
  const model = _input?.model as { providerID?: string; modelID?: string } | undefined;
  const providerID = model?.providerID ?? "";
  const modelID = model?.modelID ?? "";
  const orchestratorModel = providerID && modelID ? `${providerID}/${modelID}` : modelID;

  let enfOn = false;
  try {
    enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  } catch (err) {
    log.warn({ event: "enforcement.resolve_failed", error: String(err) });
  }
  (output.system as string[]).push(assembleSystemPrompt(cfg as unknown as tierConfig, orchestratorModel, enfOn));
};

// ---------------------------------------------------------------------------
// config — register tier agents and router commands at load time.
// ---------------------------------------------------------------------------

export const handleConfig = async (
  ctx: PluginContext,
  activeTiersAtLoad: Preset,
  opencodeConfig: any,
): Promise<void> => {
  // The config() hook runs once at plugin load time, so the load-time
  // snapshot is the right cfg here (matches the original behaviour where
  // `cfg` was initialised from loadConfig() once at factory start).
  registerTierAgents(opencodeConfig, activeTiersAtLoad, ctx.initialConfig);
  registerRouterCommands(opencodeConfig);

  // PR 2 of adaptive-reasoning: capture the baseline agent def per tier so
  // the runtime `tool.execute.after` hook can restore exactly the shape
  // `registerTierAgents` produced. We snapshot AFTER registration so the
  // baseline is the post-static-build output (including any prompt / color /
  // variant / options the static config emitted). Same-tier patches are
  // serialised by the per-tier in-flight owner in
  // `ctx.reasoningStore.acquireTierOwner` — see `src/reasoning/store.ts`.
  ctx.opencodeConfig = opencodeConfig;
  const agentMap = opencodeConfig?.agent as Record<string, Record<string, unknown>> | undefined;
  if (agentMap) {
    for (const [tierName, agentDef] of Object.entries(agentMap)) {
      // Deep enough to survive a shallow `restoreAgentBaseline` replace —
      // a structuredClone covers nested options/variant objects.
      ctx.reasoningStore.setBaseline(tierName, structuredClone(agentDef));
    }
  }
};
