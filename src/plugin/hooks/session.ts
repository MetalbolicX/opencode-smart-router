// ---------------------------------------------------------------------------
// src/plugin/hooks/session.ts — Session event handler.
//
// Carries `handleSessionIdle` (handles `session.created` for parentID
// registration and `session.idle` for record-only scorecard + opt-in
// trajectory dump) plus the local helper `extractParentID`.
//
// `extractParentID` is a private helper — it is NOT re-exported from the
// barrel. It only needs to be visible inside this module.
// ---------------------------------------------------------------------------

import { formatScorecard } from "../../guard/Guard.res.mjs";
import { writeTrajectoryLog } from "../../utils/log";
import type { PluginContext } from "../context";
import type { HookEventPayload } from "../types";

// ---------------------------------------------------------------------------
// session.created — parentID extraction helper.
// ---------------------------------------------------------------------------

/**
 * Extracts the parentID from a session.created event's properties.
 * Returns null if the event has no info.parentID (root session).
 * Safe to call on any event shape — returns null on missing fields.
 */
const extractParentID = (props: Record<string, unknown> | undefined): string | null => {
  const info = props?.info as Record<string, unknown> | undefined;
  const pid = info?.parentID;
  if (typeof pid === "string") return pid;
  return null;
};

// ---------------------------------------------------------------------------
// event (session.idle) — record-only scorecard + opt-in trajectory dump.
// ---------------------------------------------------------------------------

export const handleSessionIdle = async (
  ctx: PluginContext,
  payload: HookEventPayload,
): Promise<void> => {
  const event = payload?.event;

  // Plan 020: handle session.created — record parentID so depth is available
  // before the child's first tool call.
  if (event?.type === "session.created") {
    const props = event?.properties as Record<string, unknown> | undefined;
    const sid = props?.sessionID as string | undefined;
    if (typeof sid !== "string") return;
    const parentID = extractParentID(props);
    // Only call registerFromSessionCreated if the store exposes it (defensive:
    // it may not exist in older store implementations).
    if (typeof ctx.sessionStore.registerFromSessionCreated === "function") {
      try {
        ctx.sessionStore.registerFromSessionCreated({ sessionID: sid, parentID });
      } catch {
        // best-effort: store registration must never crash a real session
      }
    }
    return;
  }

  if (event?.type !== "session.idle") return;
  const props = event?.properties as Record<string, unknown> | undefined;
  const sid = props?.sessionID as string | undefined;
  if (typeof sid !== "string") return;

  // Per-delegation scorecard: only when enforcement was active (guard state exists).
  try {
    const gstate = ctx.guardStore.get(sid);
    if (gstate) {
      const line = formatScorecard(gstate, ctx.sessionStore.getTier(sid));
      writeTrajectoryLog(sid, line, "scorecard");
    }
  } catch {
    // best-effort: a scorecard must never crash a real session
  }

  // Opt-in full trajectory dump (unchanged gating).
  if (process.env.MODEL_ROUTER_TRAJECTORY_DEBUG !== "1") return;
  const dump = ctx.trajectoryStore.dump(sid);
  if (!dump) return;
  writeTrajectoryLog(sid, dump);
};
