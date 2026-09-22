// ---------------------------------------------------------------------------
// OpenCode V2 package entrypoint.
//
// `src/index.ts` remains the V1 implementation used by the legacy test
// harness and by older OpenCode releases. The package entrypoint points here
// so current OpenCode versions receive the V2 definition object they require.
//
// V2 uses replayable domain transforms and typed session/tool lifecycle hooks
// instead of the V1 hook registry. This entrypoint ports the configuration,
// command, request-context, and AI SDK surfaces that the router can express
// through the V2 API. The legacy V1 implementation remains isolated in
// `src/index.ts` for older OpenCode consumers and its existing test harness.
// ---------------------------------------------------------------------------

import { Plugin } from "@opencode/plugin";

import { buildAgentOptions } from "../router/agents";
import type { Preset, RouterConfig, TierConfig } from "../router/config";
import { createConfigStore } from "../router/config-store";
import { resolveEnforcementMode } from "../router/enforcement";
import { assembleSystemPrompt, getActiveTiers } from "../router/protocol";

const PLUGIN_ID = "opencode-smart-router";
const PROTOCOL_MARKER = "## Model Delegation Protocol — MANDATORY";

type ModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};

type AgentRecord = {
  id: string;
  mode: "subagent" | "primary" | "all";
  model?: ModelRef;
  system?: string;
  description?: string;
  steps?: number;
  color?: string;
  request: { body: Record<string, unknown> };
};

type AgentDraft = {
  list(): readonly AgentRecord[];
  get(id: string): AgentRecord | undefined;
  update(id: string, update: (agent: AgentRecord) => void): void;
};

const modelRef = (model: string, variant?: string): ModelRef => {
  const separator = model.indexOf("/");
  const providerID = separator === -1 ? model : model.slice(0, separator);
  const id = separator === -1 ? model : model.slice(separator + 1);
  return variant ? { providerID, id, variant } : { providerID, id };
};

const modelName = (model: ModelRef | undefined): string => {
  if (!model) return "";
  return `${model.providerID}/${model.id}`;
};

const tierPrompt = (tierName: string, tier: TierConfig, cfg: RouterConfig): string | undefined => {
  const configured = tier.prompt ?? cfg.tierPrompts?.[tierName];
  if (!configured) return undefined;
  return configured;
};

const updateExistingTierAgents = (
  draft: AgentDraft,
  activeTiers: Preset,
  cfg: RouterConfig,
): void => {
  for (const [tierName, tier] of Object.entries(activeTiers)) {
    if (!draft.get(tierName)) continue;

    draft.update(tierName, (agent) => {
      agent.model = modelRef(tier.model, tier.variant);
      agent.mode = "subagent";
      agent.description = tier.description;
      agent.steps = tier.steps;

      const prompt = tierPrompt(tierName, tier, cfg);
      if (prompt) agent.system = prompt;

      if (tier.color) agent.color = tier.color;

      const options = buildAgentOptions(tier);
      if (Object.keys(options).length > 0) {
        agent.request.body = { ...agent.request.body, ...options };
      }
    });
  }
};

const updatePrimaryAgentProtocols = (draft: AgentDraft, cfg: RouterConfig): void => {
  let enforcementEnabled = false;
  try {
    enforcementEnabled = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  } catch {
    // Config validation is fail-soft at plugin load; leave existing agents
    // unchanged if an optional enforcement overlay cannot be resolved.
  }

  for (const agent of draft.list()) {
    if (agent.mode === "subagent" || agent.system?.includes(PROTOCOL_MARKER)) continue;

    draft.update(agent.id, (current) => {
      const protocol = assembleSystemPrompt(cfg, modelName(current.model), enforcementEnabled);
      current.system = current.system ? `${current.system}\n\n${protocol}` : protocol;
    });
  }
};

const findTierForModel = (activeTiers: Preset, model: ModelRef): TierConfig | undefined => {
  const selected = Object.values(activeTiers).find((tier) => {
    const ref = modelRef(tier.model, tier.variant);
    return ref.providerID === model.providerID && ref.id === model.id;
  });
  return selected;
};

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    await ctx.storage.set("loaded", {
      directory: ctx.location.directory,
      version: "v2",
    });

    const store = createConfigStore({ cwd: ctx.location.directory });

    let cfg: RouterConfig;
    try {
      cfg = await store.read();
    } catch {
      // A broken optional router config must not prevent OpenCode itself from
      // starting. The V2 definition has still loaded successfully.
      return;
    }

    const activeTiers = getActiveTiers(cfg);

    await ctx.agent.transform((draft) => {
      updateExistingTierAgents(draft as unknown as AgentDraft, activeTiers, cfg);
      updatePrimaryAgentProtocols(draft as unknown as AgentDraft, cfg);
    });

    await ctx.command.transform((draft) => {
      const definitions: Record<string, string> = {
        tiers: "Show model delegation tiers and rules",
        preset: "Show or switch model presets",
        budget: "Show or switch routing mode",
        bypass: "Toggle model-router bypass",
        "annotate-plan": "Annotate a plan with tier directives",
        router: "Model-router controls",
        "model-router-reasoning": "Control model-router reasoning",
      };

      for (const [name, description] of Object.entries(definitions)) {
        draft.add({
          name,
          description,
          async execute({ sessionID, prompt, delivery }) {
            await ctx.session.prompt({
              sessionID,
              text: `/${name} ${prompt.text}`.trim(),
              delivery,
            });
          },
        });
      }
    });

    await ctx.session.hook("context", (event) => {
      if (
        event.system.some((part) => part.type === "text" && part.text.includes(PROTOCOL_MARKER))
      ) {
        return;
      }

      const protocol = assembleSystemPrompt(
        cfg,
        event.model.providerID ? `${event.model.providerID}/${event.model.id}` : event.model.id,
        enforcementEnabled(cfg),
      );
      event.system.push({ type: "text", text: protocol });
    });

    await ctx.aisdk.hook("language", ({ model, options }) => {
      const tier = findTierForModel(activeTiers, model);
      if (!tier) return;
      Object.assign(options, buildAgentOptions(tier));
    });
  },
});

const enforcementEnabled = (cfg: RouterConfig): boolean => {
  try {
    return resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  } catch {
    return false;
  }
};
