// ---------------------------------------------------------------------------
// src/reasoning/store.ts — Per-plugin-instance reasoning override store.
//
// Mirrors `src/guard/store.ts` (closure-factory pattern, Map keyed by
// sessionID). Owns three concerns:
//
//   1. Per-session override (`set/get/clear` for a `ReasoningLevel`)
//   2. Per-tier baseline (`set/get` for the static agent def, captured once
//      at config time so the runtime `tool.execute.after` hook can restore it
//      after a `tool.execute.before` patch)
//   3. Pending note (`setPendingNote` / `takePendingNote`) — defers a
//      `surfaceLimits`-driven advisory banner from the before-hook to the
//      after-hook, mirroring how the guard store handles advisory notes.
//
// Concurrent patches on the same tier are NOT supported in this PR (open
// question from the design). See `plans/010-adaptive-reasoning.md` for the
// mutex question; the helper is intentionally minimal until an integration
// test proves a race exists.
// ---------------------------------------------------------------------------

import type { ReasoningLevel } from "./capability.js";

/**
 * Static agent def snapshot taken at config time. The runtime
 * `tool.execute.before` patch mutates a SHALLOW COPY in-place; `tool.execute.after`
 * restores the captured baseline reference, so concurrent unrelated patches
 * to other tiers never see each other's state.
 */
export type AgentBaseline = Record<string, unknown>;

/**
 * Factory: returns a fresh store per plugin instance. No module-level
 * singleton — concurrent plugin instances must not share mutable state.
 */
export const createReasoningStore = () => {
  const overrides = new Map<string, ReasoningLevel>();
  const baselines = new Map<string, AgentBaseline>();
  const pendingNotes = new Map<string, string>();

  return {
    // ----- session override ------------------------------------------------
    getOverride(sessionID: string): ReasoningLevel | undefined {
      return overrides.get(sessionID);
    },
    setOverride(sessionID: string, level: ReasoningLevel): void {
      overrides.set(sessionID, level);
    },
    clearOverride(sessionID: string): void {
      overrides.delete(sessionID);
    },

    // ----- tier baseline (captured at config time) ------------------------
    setBaseline(tierName: string, baseline: AgentBaseline): void {
      baselines.set(tierName, baseline);
    },
    getBaseline(tierName: string): AgentBaseline | undefined {
      return baselines.get(tierName);
    },

    // ----- pending note (deferred from before- to after-hook) --------------
    setPendingNote(sessionID: string, note: string): void {
      pendingNotes.set(sessionID, note);
    },
    takePendingNote(sessionID: string): string | undefined {
      const n = pendingNotes.get(sessionID);
      if (n !== undefined) pendingNotes.delete(sessionID);
      return n;
    },

    // ----- session teardown ------------------------------------------------
    /** Drop every per-session record for `sessionID`. Baselines are kept. */
    clear(sessionID: string): void {
      overrides.delete(sessionID);
      pendingNotes.delete(sessionID);
    },
  };
};
