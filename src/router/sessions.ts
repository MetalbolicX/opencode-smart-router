import { fingerprintToolCall } from "../guard/fingerprint";
import { isTextPart } from "../plugin/types";
import type { RouterConfig } from "./config";
import { READ_ONLY_TOOLS } from "./tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Cap = number | "none";

export interface SubagentState {
  tierName: string;
  cap: Cap;
  calls: number;
  /** Fingerprint → call index where this fingerprint was first seen. */
  seen: Map<string, number>;
  trivial: boolean;
}

// ---------------------------------------------------------------------------
// Fallback caps when tiers.json has no tierCaps block.
// ---------------------------------------------------------------------------

/** Fallback caps when tiers.json has no tierCaps block. */
export const DEFAULT_TIER_CAPS: Record<string, number> = {
  fast: 8,
  medium: 5,
  heavy: 3,
};

// ---------------------------------------------------------------------------
// Cap directive parser
// ---------------------------------------------------------------------------

/** Extract the first `CAP:N` or `CAP:none` directive from a dispatch prompt. */
export const parseCapDirective = (text: string): Cap | null => {
  const m = text.match(/\bCAP\s*:\s*(none|\d+)\b/i);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  if (raw === "none") return "none";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// ---------------------------------------------------------------------------
// Dispatch text extractor (internal)
// ---------------------------------------------------------------------------

/** Best-effort extraction of textual content from a chat.message output payload. */
const extractDispatchText = (output: unknown): string => {
  const o = output as Record<string, unknown> | undefined;
  const parts = (o?.parts as unknown[]) ?? [];
  const chunks: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      chunks.push(p);
    } else if (isTextPart(p)) {
      chunks.push(p.text);
    } else if (p && typeof p === "object") {
      const rec = p as Record<string, unknown>;
      if (typeof rec.text === "string") chunks.push(rec.text);
      else if (typeof rec.content === "string") chunks.push(rec.content);
    }
  }
  if (chunks.length === 0) {
    const msg = o?.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === "string") chunks.push(content);
  }
  return chunks.join("\n");
};

// ---------------------------------------------------------------------------
// Cap banner builder
// ---------------------------------------------------------------------------

/** Build the banner appended to every read-only tool result in a subagent session. */
export const buildCapBanner = (
  state: SubagentState,
  isRedundant: boolean,
  previousCall: number | undefined,
  tool: string,
): string => {
  const lines: string[] = [];
  const capDisplay = state.cap === "none" ? "∞" : String(state.cap);
  lines.push(`[cap: ${state.calls}/${capDisplay}]`);

  if (isRedundant && previousCall !== undefined) {
    lines.push(
      `[⚠ REDUNDANT: this is the same ${tool} you ran at call #${previousCall}. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]`,
    );
  }

  if (state.cap !== "none") {
    const remaining = state.cap - state.calls;
    if (remaining <= 0) {
      lines.push(
        `[⚠ CAP REACHED (${state.calls}/${state.cap}): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]`,
      );
    } else if (remaining <= 2) {
      lines.push(`[⚠ CAP WARNING: ${remaining} read-only call(s) remaining before forced return]`);
    }
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Read-only tools set (imported from ./tools — single source of truth)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trivial classifier
// ---------------------------------------------------------------------------

/** Normalise a taskPattern keyword to a lowercase stem for substring matching. */
const normTaskKw = (kw: string): string => {
  return kw.toLowerCase().split("(")[0]!.split("/")[0]!.trim();
};

/**
 * Classify a dispatch as "trivial" AT DISPATCH TIME (m2): conservative,
 * tier-gated. Only a `fast`-tier dispatch whose text matches a fast taskPattern
 * and contains NO medium/heavy signal is trivial. Real work (medium/heavy tier,
 * or implementation keywords) is NEVER trivial — so proportional bypass can
 * never silently disable enforcement on real work.
 */
export const classifyTrivial = (
  dispatchText: string,
  tier: string | null,
  cfg: RouterConfig,
): boolean => {
  if (tier !== "fast") return false;
  const text = (dispatchText || "").toLowerCase();
  if (!text.trim()) return false;
  const disqualifiers = [...(cfg.taskPatterns?.medium ?? []), ...(cfg.taskPatterns?.heavy ?? [])];
  for (const kw of disqualifiers) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return false;
  }
  const fast = cfg.taskPatterns?.fast ?? [];
  for (const kw of fast) {
    const n = normTaskKw(kw);
    if (n.length >= 3 && text.includes(n)) return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Session store factory
// ---------------------------------------------------------------------------

/**
 * Creates a per-plugin-instance session store that owns the subagent tracking
 * state (session IDs + cap state). Returns methods the hooks delegate to.
 * Concurrency: Set/Map are per-store-instance, NOT module-level singletons.
 */
export const createSessionStore = () => {
  const subagentSessionIDs = new Set<string>();
  const subagentCapState = new Map<string, SubagentState>();

  // Plan 020/021: parent/depth tracking for nested delegation guard.
  // parentMap: child sessionID → parent sessionID (only for registered children).
  const parentMap = new Map<string, string>();
  // Memoized depth cache. Recomputed lazily on first access per session.
  const depthCache = new Map<string, number>();

  /**
   * Compute depth by walking up the parent chain, with cycle protection.
   * Returns 0 for root/unregistered sessions.
   */
  const computeDepth = (sid: string, visited: Set<string> = new Set()): number => {
    if (visited.has(sid)) return 0; // cycle guard — treat as root
    const parent = parentMap.get(sid);
    if (!parent) return 0; // no parent = root
    visited.add(sid);
    const parentDepth = computeDepth(parent, visited);
    return parentDepth + 1;
  };

  return {
    /** Returns true when sessionID belongs to a tracked subagent session. */
    isSubagent(sessionID: string): boolean {
      return subagentSessionIDs.has(sessionID);
    },

    /** Returns the tier name for a tracked subagent session, or null. */
    getTier(sessionID: string): string | null {
      return subagentCapState.get(sessionID)?.tierName ?? null;
    },

    /** Returns true when the session was classified as trivial at dispatch time. */
    isTrivial(sessionID: string): boolean {
      return subagentCapState.get(sessionID)?.trivial === true;
    },

    /**
     * Register a plugin-created producer session (from the delegate tool) so that
     * Layer-1 (tool.execute.before) guards it like any other subagent. trivial:false
     * ensures the producer is always fully enforced (never downgraded to advisory).
     */
    registerProducerSession(sessionID: string, tier: string, cfg: RouterConfig): void {
      subagentSessionIDs.add(sessionID);
      const baseline = cfg.tierCaps?.[tier] ?? DEFAULT_TIER_CAPS[tier] ?? 5;
      subagentCapState.set(sessionID, {
        tierName: tier,
        cap: baseline,
        calls: 0,
        seen: new Map(),
        trivial: false,
      });
    },

    /**
     * Called from the session.created hook event. Registers a child session
     * with its parentID so depth and parent tracking are available before the
     * child's first tool call. This is the foundation of the nested-delegation
     * guard: the depth is derived synchronously at session creation time.
     */
    registerFromSessionCreated(input: { sessionID: string; parentID: string | null }): void {
      // Invalidate cached depth for this session and all descendants.
      // For simplicity we clear the whole cache; a full descendant walk is
      // deferred until the profile shows this as a hotspot.
      depthCache.clear();
      if (input.parentID != null) {
        parentMap.set(input.sessionID, input.parentID);
      }
    },

    /**
     * Returns the depth of the session (0 = root/unregistered, 1 = direct child,
     * 2 = grandchild, etc.). Uses a memoized cache with lazy recomputation.
     */
    depth(sessionID: string): number {
      let d = depthCache.get(sessionID);
      if (d !== undefined) return d;
      d = computeDepth(sessionID);
      depthCache.set(sessionID, d);
      return d;
    },

    /** Returns the parent sessionID for a child session, or null for root/unregistered. */
    parentOf(sessionID: string): string | null {
      return parentMap.get(sessionID) ?? null;
    },

    /** Returns true when sessionID is a descendant (depth >= 1). */
    isDescendant(sessionID: string): boolean {
      return this.depth(sessionID) >= 1;
    },

    /** Remove a session from tracking (used to clean up delegate producer sessions). */
    unregister(sessionID: string): void {
      subagentSessionIDs.delete(sessionID);
      subagentCapState.delete(sessionID);
      parentMap.delete(sessionID);
      depthCache.delete(sessionID);
    },

    /**
     * Called from the chat.message hook. If the incoming message is directed
     * at a registered tier agent, records the session and initialises its cap state.
     * Accepts `tierNames` (from getActiveTiers) so this module doesn't need to
     * import protocol.ts.
     */
    registerFromChatMessage(
      input: { agent?: string; sessionID: string },
      output: unknown,
      cfg: RouterConfig,
      tierNames: string[],
    ): void {
      if (input.agent && tierNames.includes(input.agent)) {
        subagentSessionIDs.add(input.sessionID);

        // Initialize cap state on first dispatch; reset on subsequent rounds to the same
        // subagent session (rare but supported — treats each round as a fresh budget).
        const tierName = input.agent;
        const dispatchText = extractDispatchText(output);
        const override = parseCapDirective(dispatchText);
        const baseline = cfg.tierCaps?.[tierName] ?? DEFAULT_TIER_CAPS[tierName] ?? 5;
        const cap: Cap = override ?? baseline;
        subagentCapState.set(input.sessionID, {
          tierName,
          cap,
          calls: 0,
          seen: new Map(),
          trivial: classifyTrivial(dispatchText, tierName, cfg),
        });
      }
    },

    /**
     * Called from the tool.execute.after hook. Appends a cap/redundancy banner
     * to the tool output for tracked subagent sessions running read-only tools.
     * Mutates outputRef.output in place (same as the inlined hook logic).
     */
    recordToolCall(
      input: { sessionID: string; tool: string; args: unknown },
      outputRef: Record<string, unknown>,
    ): void {
      const state = subagentCapState.get(input.sessionID);
      if (!state) return; // not a tracked subagent session
      if (!READ_ONLY_TOOLS.has(input.tool)) return;

      const fp = fingerprintToolCall(input.tool, input.args);
      const previousCall = state.seen.get(fp);
      const isRedundant = previousCall !== undefined;

      state.calls += 1;
      if (!isRedundant) {
        state.seen.set(fp, state.calls);
      }

      const banner = buildCapBanner(state, isRedundant, previousCall, input.tool);

      const existing = typeof outputRef.output === "string" ? outputRef.output : "";
      outputRef.output = existing ? `${existing}\n\n${banner}` : banner;
    },
  };
};
