import type { LadderState } from "./Ladder.res.mjs";
import { formatLadderScorecard } from "./Ladder.res.mjs";
import { writeTrajectoryLog } from "../utils/log";
import { logEvent } from "../utils/observability";

// ---------------------------------------------------------------------------
// I/O wrappers for Ladder module
// ---------------------------------------------------------------------------

/** Append-only temp-file dump for a finished delegation. Writes under
 *  `<tmpdir>/opencode-smart-router-trajectory/<sid>.delegate.log` (same dir
 *  the event-hook scorecard uses) and never throws — a logging failure must
 *  never crash a real session. */
export const dumpDelegateScorecard = (
  sid: string,
  state: LadderState,
  accepted: boolean,
  method: string,
): void => {
  const line = formatLadderScorecard(state, accepted, method);
  writeTrajectoryLog(sid, line, "delegate");
  const payload = {
    sid,
    finalTier: state.currentTier,
    totalAttempts: state.totalAttempts,
    escalations: state.escalations,
    cost: state.cumulativeCost,
    verdict: accepted ? "PASS" : "UNMET",
    method,
  };
  if (accepted) {
    logEvent.routing.accepted(payload);
  } else {
    logEvent.routing.unmet(payload);
  }
};

/** Emit a structured routing.escalated event when the ladder promotes a
 *  producer to a higher tier. */
export const logEscalation = (
  sid: string,
  from: string,
  to: string,
  reason: string,
  attempts: number,
): void => {
  logEvent.routing.escalated({ sid, from, to, reason, attempts });
};

/** Emit a structured routing.delegated event when a delegation attempt begins. */
export const logDelegation = (
  sid: string,
  tier: string,
  attempt: number,
  isRetry: boolean,
): void => {
  logEvent.routing.delegated({ sid, tier, attempt, isRetry });
};
