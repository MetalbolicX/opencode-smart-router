// ---------------------------------------------------------------------------
// src/plugin/hooks/chat.ts — Chat-message hook handlers.
//
// Carries the three chat-shaped handlers: `handleChatParams` (temperature
// override for open grader sessions), `handleChatMessage` (tier info
// registration + scorecard initialisation), and `handleTextComplete`
// (narration detection on completed text parts).
//
// Each handler is a verbatim extraction from the original `src/plugin/hooks.ts`
// monolith. Bodies are unchanged — same call order, same fail-soft semantics.
// ---------------------------------------------------------------------------

import { detectNarration } from "../../guard/narration";
import { getActiveTiers } from "../../router/protocol";
import type { PluginContext } from "../context";
import { asChatMessageInput, type HookPayload } from "../types";

// ---------------------------------------------------------------------------
// chat.params — temperature override for open grader sessions.
// ---------------------------------------------------------------------------

export const handleChatParams = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  try {
    const sessionID = input?.sessionID as string | undefined;
    if (sessionID && ctx.graderSessions.has(sessionID)) {
      const cfg = await ctx.getConfig();
      output.temperature = cfg.enforcement?.verify?.graderTemperature ?? 0;
    }
  } catch {
    // best-effort: never crash a real session
  }
};

// ---------------------------------------------------------------------------
// chat.message — register tier info and initialise trajectory scorecard.
//
// IMPORTANT: must run BEFORE system.transform so the subagent registry is
// populated when system.transform asks `sessionStore.isSubagent(sessionID)`.
// ---------------------------------------------------------------------------

export const handleChatMessage = async (
  ctx: PluginContext,
  input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  // Re-read cfg so /preset switches take effect without restart.
  // getFreshConfig() tries a forced refresh and falls back to the cached
  // value on read failure.
  const cfg = await ctx.getFreshConfig();
  const tierNames = Object.keys(getActiveTiers(cfg));
  const chatInput = asChatMessageInput(input);
  if (!chatInput) return; // fail-soft: malformed payload
  ctx.sessionStore.registerFromChatMessage(chatInput, output, cfg, tierNames);

  // Record-only: initialise a trajectory scorecard for tracked subagents.
  const sid = chatInput.sessionID;
  if (ctx.sessionStore.isSubagent(sid)) {
    ctx.trajectoryStore.ensure(sid, chatInput.agent ?? null);
  }
};

// ---------------------------------------------------------------------------
// experimental.text.complete — narration detection on completed text parts.
// ---------------------------------------------------------------------------

export const handleTextComplete = async (
  ctx: PluginContext,
  _input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  const text = output?.text;
  if (typeof text !== "string" || text.length < 20) return;

  const found = detectNarration(text);
  if (found.length === 0) return;

  const quoted = found.map((m) => `"${m.slice(0, 60)}${m.length > 60 ? "…" : ""}"`).join(", ");
  output.text = `${text}\n\n[⚠ narration detected: ${quoted}]`;
};
