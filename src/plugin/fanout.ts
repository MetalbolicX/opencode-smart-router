// Fanout tool executor (PR 3b) — parallel worker lifecycle + markdown aggregate.
// Admission: depth===1, caller tier {medium|focused|heavy}, not producer/grader/worker,
// enabled, breaker closed, non-empty items, items.length <= maxWorkersPerBatch.

import { DEFAULT_FANOUT_CONFIG } from "../router/config.types";
import { log } from "../utils/observability";
import { resolveTierModelGuard } from "../utils/tier-model-guard";
import { withTimeout } from "../utils/timeout";
import type { PluginContext } from "./context";
import type { FanoutArgs, FanoutItemResult } from "./types";
import { extractPromptText } from "./types";

// ---------------------------------------------------------------------------
// Policy matrix constants
// ---------------------------------------------------------------------------

/** Tiers that can call fanout (callers): medium, focused, heavy. */
const CALLER_TIER_ALLOWLIST = new Set(["medium", "focused", "heavy"]);

/** Tiers that can be workers (callees) when caller is medium. */
const MEDIUM_CALLER_WORKER_ALLOWLIST = new Set(["fast"]);

/** Tiers that can be workers when caller is focused or heavy. */
const HIGH_TIER_WORKER_ALLOWLIST = new Set(["fast", "light", "medium"]);

// ---------------------------------------------------------------------------
// Helper: format a typed rejected aggregate
// ---------------------------------------------------------------------------

/**
 * Format a batch-level rejection as a markdown aggregate string.
 */
export const formatRejectedAggregate = (reason: string): string => {
  return `## fanout batch rejected\n\n- **reason**: ${reason}\n`;
};

// ---------------------------------------------------------------------------
// Worker session cleanup (adapted from delegate.ts cleanupProducerSession)
// ---------------------------------------------------------------------------

/**
 * Clean up all per-worker session state. Called from the per-worker finally
 * block and from early-return paths when session.create succeeds but the
 * subsequent steps fail.
 *
 * session.delete is NEVER called (SDD fix-session-ghost-tui-jump binding rule).
 * session.abort is called on failure paths only (workerSucceeded === false)
 * to avoid discarding a completed session that a developer may want to review.
 */
const cleanupWorkerSession = async (
  ctx: PluginContext,
  workerSid: string,
  workerSucceeded: boolean,
  abortFailedWorkers: Set<string>,
): Promise<void> => {
  try {
    ctx.changedFileStore.clear(workerSid);
  } catch (err) {
    log.warn({
      event: "fanout.worker_cleanup_failed",
      store: "changedFileStore.clear",
      sid: workerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    ctx.sessionStore.unregister(workerSid);
  } catch (err) {
    log.warn({
      event: "fanout.worker_cleanup_failed",
      store: "sessionStore.unregister",
      sid: workerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    ctx.guardStore.clear(workerSid);
  } catch (err) {
    log.warn({
      event: "fanout.worker_cleanup_failed",
      store: "guardStore.clear",
      sid: workerSid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // SDK teardown — fail-soft, null-safe, independent timeouts.
  // session.delete is NEVER called (binding rule from plan 044).
  // session.abort is conditional: only called on non-success paths.
  if (!workerSucceeded && workerSid) {
    log.info({ event: "fanout.worker_aborted", sid: workerSid });
    try {
      await withTimeout(
        ctx.plugin.client.session.abort({ path: { id: workerSid } }),
        10_000,
        "fanout session.abort",
      );
    } catch (err) {
      // 10s abort timeout exceeded — cleanup abort failure.
      // This is a qualifying failure: trips the breaker.
      abortFailedWorkers.add(workerSid);
      log.warn({
        event: "fanout.abort_failed",
        sid: workerSid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

// ---------------------------------------------------------------------------
// Per-worker slot cleanup helper
// ---------------------------------------------------------------------------

/** Releases a fanout slot. Always called from a finally block — never throws. */
const releaseFanoutSlot = (ctx: PluginContext, tier: string): void => {
  try {
    ctx.fanoutStore.release(tier);
  } catch (err) {
    log.warn({
      event: "fanout.slot_release_failed",
      tier,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ---------------------------------------------------------------------------
// Markdown aggregation helpers
// ---------------------------------------------------------------------------

const formatItemResult = (item: FanoutItemResult): string => {
  const line = `## [${item.index + 1}] tier=${item.tier} status=${item.status}`;
  if (item.text) {
    return `${line}\n${item.text}`;
  }
  if (item.reason) {
    return `${line}\n(${item.reason})`;
  }
  return `${line}`;
};

// ---------------------------------------------------------------------------
// Real executor
// ---------------------------------------------------------------------------

/**
 * Execute fanout — real parallel executor (PR 3b).
 *
 * Runs all workers in parallel, races against batchTimeoutMs, and returns a
 * markdown aggregate. Each worker:
 *   1. Acquires a fanout slot (rejects item on cap/breaker fail)
 *   2. Creates a session with parentID = root session (caller's parent's sid)
 *   3. Marks the session as a fanout worker
 *   4. Guards on tier model config (rejects item on invalid config)
 *   5. Runs session.prompt with workerTimeoutMs
 *   6. On success: preserves session for review
 *   7. On failure/timeout: aborts session with 10s timeout
 *   8. Releases fanout slot in finally block
 *
 * When the caller's AbortSignal fires, all outstanding workers are aborted
 * and the function returns "" silently (matching delegate.ts cancellation contract).
 */
export const executeFanout = async (
  ctx: PluginContext,
  args: FanoutArgs,
  callerSid: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const cfg = await ctx.getFreshConfig();
  const fanoutCfg = cfg.fanout;

  // --- Admission gate (same as PR 3a stub, plus caller-is-not-root check) ---

  const depth = ctx.sessionStore.depth(callerSid);
  if (depth !== 1) {
    log.warn({ event: "fanout.batch_rejected", reason: "depth_not_1" });
    return formatRejectedAggregate(`depth ${depth} !== 1; fanout requires depth-1 caller`);
  }

  const callerTier = ctx.sessionStore.getTier(callerSid) ?? "unknown";
  if (!CALLER_TIER_ALLOWLIST.has(callerTier)) {
    log.warn({ event: "fanout.batch_rejected", reason: "caller_tier_not_allowed", callerTier });
    return formatRejectedAggregate(
      `caller tier '${callerTier}' not in allowlist; medium/heavy callers only`,
    );
  }

  if (ctx.sessionStore.isProducerSession(callerSid)) {
    log.warn({ event: "fanout.batch_rejected", reason: "producer_session" });
    return formatRejectedAggregate("producer sessions cannot call fanout");
  }

  if (ctx.graderSessions.has(callerSid)) {
    log.warn({ event: "fanout.batch_rejected", reason: "grader_session" });
    return formatRejectedAggregate("grader sessions cannot call fanout");
  }

  if (ctx.sessionStore.isFanoutWorker(callerSid)) {
    log.warn({ event: "fanout.batch_rejected", reason: "fanout_worker" });
    return formatRejectedAggregate("fanout workers cannot call fanout");
  }

  if (fanoutCfg?.enabled !== true) {
    log.warn({ event: "fanout.batch_rejected", reason: "disabled" });
    return formatRejectedAggregate("fanout disabled (kill switch)");
  }

  // Derive a fully-populated config so downstream uses are always number (not number|undefined)
  const effectiveCfg = { ...DEFAULT_FANOUT_CONFIG, ...fanoutCfg };

  // Thread user config into the store so configured caps and breaker thresholds
  // are actually enforced (R-3).
  ctx.fanoutStore.configure(effectiveCfg);

  // Breaker FSM: reject only when explicitly `open`. `half_open` admits a
  // single probe batch (the design's recovery contract); `closed` admits
  // normally.
  if (ctx.fanoutStore.breakerState() === "open") {
    log.warn({ event: "fanout.batch_rejected", reason: "circuit_open" });
    return formatRejectedAggregate("circuit breaker open");
  }

  if (args.items.length === 0) {
    log.warn({ event: "fanout.batch_rejected", reason: "empty_batch" });
    return formatRejectedAggregate("empty batch; items array must be non-empty");
  }

  const workerAllowlist =
    callerTier === "medium" ? MEDIUM_CALLER_WORKER_ALLOWLIST : HIGH_TIER_WORKER_ALLOWLIST;

  // --- Batch-level cap ---
  if (args.items.length > effectiveCfg.maxWorkersPerBatch) {
    log.warn({
      event: "fanout.batch_rejected",
      reason: "batch_size_exceeded",
      items: args.items.length,
      maxWorkersPerBatch: effectiveCfg.maxWorkersPerBatch,
    });
    return formatRejectedAggregate(
      `items.length ${args.items.length} > maxWorkersPerBatch ${effectiveCfg.maxWorkersPerBatch}`,
    );
  }

  // Admission abort: bail BEFORE acquiring any slot so a pre-aborted caller
  // cannot leak capacity that only per-worker finally blocks would release.
  if (signal?.aborted) return "";

  // --- Per-item policy + slot acquisition ---
  // Policy check is per-item: invalid tier edges get per-item rejection; other items proceed.
  // Empty prompt is also per-item rejection. Slot acquisition failure is per-item;
  // batch rejection only if ALL items fail slot (not policy/empty).
  const itemResults = args.items.map((item) => {
    // Policy check: is this tier allowed for this caller?
    if (!workerAllowlist.has(item.tier)) {
      return {
        item,
        slotAcquired: false as const,
        policyRejected: true as const,
        reason: `tier '${item.tier}' not allowed for '${callerTier}' caller; allowed: ${[...workerAllowlist].join(", ")}`,
      };
    }
    // Empty prompt check: per-item rejection, siblings proceed
    if (!item.prompt || item.prompt.trim() === "") {
      return {
        item,
        slotAcquired: false as const,
        policyRejected: true as const,
        reason: "empty prompt",
      };
    }
    // Try to acquire fanout slot
    const acquire = ctx.fanoutStore.tryAcquire(item.tier);
    if (!acquire.ok) {
      return {
        item,
        slotAcquired: false as const,
        policyRejected: false as const,
        reason: `fanout_slot_acquire: ${acquire.reason}`,
      };
    }
    return { item, slotAcquired: true as const, policyRejected: false as const };
  });

  // If ALL items failed slot acquisition (not policy), return batch-level rejection.
  // Policy failures are per-item; they don't cause batch rejection.
  const allSlotFailed = itemResults.every((r) => !r.slotAcquired);
  if (allSlotFailed) {
    const reason = itemResults
      .filter((r) => !r.slotAcquired)
      .map((r) => `${r.item.tier}: ${r.reason}`)
      .join("; ");
    log.warn({ event: "fanout.batch_rejected", reason: "all_slots_rejected", detail: reason });
    return formatRejectedAggregate(`all fanout slots rejected: ${reason}`);
  }

  // --- Batch started (telemetry) ---
  log.info({
    event: "fanout.batch_started",
    callerSid,
    items: args.items.length,
    maxConcurrentGlobal: effectiveCfg.maxConcurrentGlobal,
  });

  // --- Caller abort: abort all outstanding workers and return "" silently (W-1) ---
  // Mirrors delegate.ts cancellation contract: signal firing mid-batch means the caller
  // cancelled, so we abort in-flight workers and return "" without an aggregate.
  if (signal?.aborted) {
    // Belt-and-braces: if the signal raced us between the hoisted admission
    // check and here, release everything this batch acquired before returning.
    for (const result of itemResults) {
      if (result.slotAcquired) releaseFanoutSlot(ctx, result.item.tier);
    }
    return "";
  }

  // --- Build per-worker promises ---
  // Track cleanup abort failures (10s abort timeout exceeded) for batch-level recording.
  // abortFailedWorkers is populated by cleanupWorkerSession before the worker promise resolves.
  const abortFailedWorkers = new Set<string>();
  const workerPromises = itemResults.map(async (result, idx): Promise<FanoutItemResult> => {
    // Per-item policy rejection (siblings proceed)
    if (result.policyRejected) {
      return {
        index: idx,
        tier: result.item.tier,
        status: "rejected",
        reason: result.reason,
      };
    }

    if (!result.slotAcquired) {
      return {
        index: idx,
        tier: result.item.tier,
        status: "rejected",
        reason: result.reason,
      };
    }

    const item = result.item;

    // Release fanout slot in ALL exit paths (success, fail, timeout, throw)
    try {
      // 1. Create session as a depth-2 child of the caller; workers are terminal leaves
      let workerSid: string;
      try {
        const created = await withTimeout(
          ctx.plugin.client.session.create({
            body: { parentID: callerSid },
            ...(signal ? { signal } : {}),
          }),
          30_000,
          "fanout session.create",
          signal,
        );
        workerSid = created?.data?.id ?? "";
      } catch (err) {
        if (
          err instanceof DOMException ||
          (err !== null && typeof err === "object" && "name" in err && err.name === "AbortError")
        ) {
          return {
            index: idx,
            tier: item.tier,
            status: "cancelled",
            reason: "session.create aborted",
          };
        }
        return {
          index: idx,
          tier: item.tier,
          status: "failed",
          reason: `session.create threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!workerSid) {
        return {
          index: idx,
          tier: item.tier,
          status: "failed",
          reason: "session.create returned no id",
        };
      }

      // 2. Mark as fanout worker (NEW — added in PR 1)
      try {
        ctx.sessionStore.markFanoutWorker(workerSid);
      } catch (err) {
        log.warn({
          event: "fanout.worker_register_failed",
          sid: workerSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 3. Register producer session (fail-soft)
      try {
        ctx.sessionStore.registerProducerSession(workerSid, item.tier, cfg);
      } catch (err) {
        log.warn({
          event: "fanout.worker_register_failed",
          sid: workerSid,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      let workerSucceeded = false;

      try {
        // 4. Guard on tier model config (fail-fast on invalid tier config)
        const guard = resolveTierModelGuard(cfg, item.tier);
        if (!guard.ok) {
          return { index: idx, tier: item.tier, status: "rejected", reason: guard.reason };
        }
        const model = guard.model;

        // 5. Run prompt with worker timeout
        try {
          const res = await withTimeout(
            ctx.plugin.client.session.prompt({
              path: { id: workerSid },
              ...(signal ? { signal } : {}),
              body: {
                ...(model ? { model } : {}),
                agent: item.tier,
                parts: [{ type: "text", text: item.prompt }],
              },
            }),
            effectiveCfg.workerTimeoutMs,
            "fanout session.prompt",
            signal,
          );
          const text = extractPromptText(res);
          workerSucceeded = true;
          log.info({ event: "fanout.worker_completed", sid: workerSid, tier: item.tier });
          return { index: idx, tier: item.tier, status: "completed", text };
        } catch (err) {
          if (
            err instanceof DOMException ||
            (err !== null && typeof err === "object" && "name" in err && err.name === "AbortError")
          ) {
            return {
              index: idx,
              tier: item.tier,
              status: "cancelled",
              reason: "session.prompt aborted",
            };
          }
          // Timeout: withTimeout throws Error("... timed out after Nms")
          if (err instanceof Error && err.message.includes("timed out")) {
            log.info({ event: "fanout.worker_timed_out", sid: workerSid, tier: item.tier });
            return {
              index: idx,
              tier: item.tier,
              status: "timed_out",
              reason: `worker exceeded ${effectiveCfg.workerTimeoutMs}ms; abort attempted`,
            };
          }
          // Non-retryable prompt error — non-qualifying failure
          log.warn({
            event: "fanout.worker_failed",
            sid: workerSid,
            tier: item.tier,
            error: err instanceof Error ? err.message : String(err),
          });
          return {
            index: idx,
            tier: item.tier,
            status: "failed",
            reason: `session.prompt threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } finally {
        // 6. Cleanup: abort on failure/timeout, preserve on success
        await cleanupWorkerSession(ctx, workerSid, workerSucceeded, abortFailedWorkers);
      }
    } finally {
      // 7. ALWAYS release fanout slot (both success and failure paths)
      releaseFanoutSlot(ctx, item.tier);
    }
  });

  // --- Track circuit state before batch (for telemetry) ---
  const preBreakerState = ctx.fanoutStore.breakerState();

  // --- W-1: Mid-batch cancellation check ---
  // Check signal BEFORE racing workers — if already aborted at this point,
  // abort all outstanding workers and return "" silently (per delegate.ts contract).
  if (signal?.aborted) {
    return "";
  }

  // --- Race all workers against batchTimeoutMs ---
  let batchTimedOut = false;
  const batchPromise = Promise.allSettled(workerPromises);

  try {
    await withTimeout(batchPromise, effectiveCfg.batchTimeoutMs, "fanout batch", signal);
  } catch {
    batchTimedOut = true;
  }

  if (batchTimedOut) {
    // On batch timeout, we return what we have. In-flight workers will
    // self-cleanup via their finally blocks when their prompts time out.
    void workerPromises;
  }

  // --- Aggregate ---
  const rawResults = await batchPromise;
  const items: FanoutItemResult[] = rawResults.map((result, idx) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    return {
      index: idx,
      tier: args.items[idx]?.tier ?? "unknown",
      status: "failed",
      reason: `promise settled with rejection: ${result.reason}`,
    };
  });

  // --- Circuit state telemetry ---
  const postBreakerState = ctx.fanoutStore.breakerState();
  if (postBreakerState !== preBreakerState) {
    if (postBreakerState === "open") {
      log.info({ event: "fanout.circuit_open" });
    } else if (postBreakerState === "half_open") {
      log.info({ event: "fanout.circuit_half_open" });
    } else if (postBreakerState === "closed" && preBreakerState !== "closed") {
      log.info({ event: "fanout.circuit_close" });
    }
  }

  // --- Record batch outcome for breaker (R-4: D-3 qualification) ---
  // Only qualifying failures increment the streak; non-qualifying reset it.
  // Call recordOutcome ONCE per batch with the worst outcome.
  // Priority: abort_failed (most severe) > timed_out > failed (non-qualifying) > cancelled > rejected > completed
  const hasTimedOut = items.some((r) => r.status === "timed_out");
  const hasFailed = items.some((r) => r.status === "failed"); // non-retryable prompt error
  const hasCancelled = items.some((r) => r.status === "cancelled");
  const hasRejected = items.some((r) => r.status === "rejected");

  if (abortFailedWorkers.size > 0) {
    // Qualifying: cleanup abort timeout exceeded (most severe — cleanup itself failed)
    ctx.fanoutStore.recordOutcome("abort_failed");
  } else if (hasTimedOut) {
    // Qualifying: worker exceeded workerTimeoutMs
    ctx.fanoutStore.recordOutcome("timed_out");
  } else if (hasFailed) {
    // Non-qualifying: non-retryable prompt error — resets streak in closed
    ctx.fanoutStore.recordOutcome("failed");
  } else if (hasCancelled) {
    // Non-qualifying: caller signal — resets streak in closed
    ctx.fanoutStore.recordOutcome("cancelled");
  } else if (hasRejected) {
    // Non-qualifying: per-item policy rejection — resets streak in closed
    ctx.fanoutStore.recordOutcome("rejected");
  } else if (items.every((r) => r.status === "completed")) {
    ctx.fanoutStore.recordOutcome("completed");
  }

  // --- batch_completed telemetry ---
  const completedCount = items.filter((r) => r.status === "completed").length;
  const failedCount = items.filter((r) => r.status === "failed").length;
  const timedOutCount = items.filter((r) => r.status === "timed_out").length;
  const cancelledCount = items.filter((r) => r.status === "cancelled").length;
  const rejectedCount = items.filter((r) => r.status === "rejected").length;
  const abortFailedCount = abortFailedWorkers.size;
  log.info({
    event: "fanout.batch_completed",
    items: items.length,
    completed: completedCount,
    failed: failedCount,
    timed_out: timedOutCount,
    cancelled: cancelledCount,
    rejected: rejectedCount,
    abort_failed: abortFailedCount,
  });

  // Format aggregate
  if (items.length === 0) {
    return formatRejectedAggregate("no items processed");
  }

  const lines = items.map(formatItemResult);
  return lines.join("\n\n");
};
