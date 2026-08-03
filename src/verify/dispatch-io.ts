/**
 * src/verify/dispatch-io.ts
 *
 * IO adapter for the verify dispatch layer. All SDK calls, filesystem access,
 * and live PluginContext reads live here. The pure helpers are imported from
 * the ReScript modules (Verify.res.mjs) to keep the TS boundary clean.
 *
 * This is the ONLY file in the verify layer that touches the SDK or PluginContext.
 * All other verify files use only pure ReScript helpers.
 */

import { scrubText } from "../guard/scrub";
import type { PluginContext } from "../plugin/context";
import {
  asTaskToolArgs,
  extractPromptText,
  extractSessionId,
  type SessionCreateResult,
  type SessionPromptResult,
} from "../plugin/types";
import type { RouterConfig } from "../router/config";
import { resolveEnforcementMode } from "../router/enforcement";
import { resolveLadder } from "../router/TierLadder.res.mjs";
import type { tierConfig } from "../router/Protocol.res.mjs";
import { getActiveTiers } from "../router/Protocol.res.mjs";
import { WRITE_TOOLS } from "../router/tools";
import { logEvent } from "../utils/observability";
import { resolveTierModelGuard } from "../utils/TierModelGuard.res.mjs";
import { withTimeout } from "../utils/timeout";
import { showRouterToast } from "../utils/toast";

// Pure helpers from ReScript Verify module
import type { DoD, InferHints } from "./VerifyDoD.res.mjs";
import {
  buildDelegationDoD as buildDelegationDoDPure,
  parseTaskResult as parseTaskResultPure,
  shouldVerifyTask as shouldVerifyTaskPure,
  buildForcingNote as buildForcingNotePure,
  buildAcceptedSuffix as buildAcceptedSuffixPure,
  extractChangedFile as extractChangedFilePure,
  createChangedFileStore as createChangedFileStorePure,
  tierModel as tierModelPure,
} from "./Verify.res.mjs";

import type { GateDeps, GateResult } from "./gate";
import { accept } from "./gate";

export interface ChangedFile {
  path: string;
  status: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export const extractChangedFile = (tool: string, args: unknown): ChangedFile | null => {
  return extractChangedFilePure(tool, args as Parameters<typeof extractChangedFilePure>[1]) as ChangedFile | null;
};

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export const createChangedFileStore = () => {
  const store = createChangedFileStorePure();
  return {
    record(sessionID: string, tool: string, args: unknown): void {
      store.record(sessionID, tool, args as Parameters<typeof store.record>[2]);
    },
    get(sessionID: string): ChangedFile[] {
      return store.get(sessionID) as ChangedFile[];
    },
    clear(sessionID: string): void {
      store.clear(sessionID);
    },
  };
};

/**
 * Parsed shape of the built-in `task` tool's after-hook output.
 *
 * - `finalReturnText`: the child's final return (extracted from
 *   `<task_result>...</task_result>` when present, otherwise the whole output).
 * - `childSessionID`: the producer subagent session id, taken from
 *   `output.metadata.sessionId` (or `sessionID`).
 * - `parentSessionID`: the orchestrator/root session id, taken from
 *   `output.metadata.parentSessionId` (or `parentSessionID`). This is the
 *   metadata-first source of truth for grader session parenting in the
 *   verify-after-task path — NEVER the subagent `input.sessionID`.
 */
export interface ParsedTaskResult {
  finalReturnText: string;
  childSessionID: string | null;
  parentSessionID: string | null;
}

/**
 * Parse the built-in `task` tool's after-hook output.
 */
export const parseTaskResult = (output: unknown): ParsedTaskResult => {
  const result = parseTaskResultPure(output as Parameters<typeof parseTaskResultPure>[0]);
  return {
    finalReturnText: result.finalReturnText,
    childSessionID: result.childSessionID,
    parentSessionID: result.parentSessionID,
  };
};

/**
 * Build the DoD for a delegation from its dispatch text.
 */
export const buildDelegationDoD = (
  args: { prompt?: string | null; description?: string | null; acceptance?: string | null },
  hints: InferHints = {},
): DoD => {
  return buildDelegationDoDPure(
    {
      prompt: args.prompt ?? null,
      description: args.description ?? null,
      acceptance: args.acceptance ?? null,
    },
    hints,
  ) as unknown as DoD;
};

/** Resolve a tier name to {providerID, modelID} for client.session.prompt. */
export const tierModel = (
  cfg: RouterConfig,
  tierName: string,
): { providerID: string; modelID: string } | null => {
  return tierModelPure(cfg as unknown as tierConfig, tierName) as { providerID: string; modelID: string } | null;
};

/** Decide whether a built-in `task` tool call should be verify-dispatched (Option i). */
export const shouldVerifyTask = (
  tool: string,
  mode: string,
  require?: string,
): boolean => {
  return shouldVerifyTaskPure(tool, mode, require ?? null);
};

/** Build the advisory forcing note appended to a task result the gate did not accept. */
export const buildForcingNote = (
  reasons: string[],
  escalation?: { producerTier?: string | null; nextTier?: string | null },
): string => {
  return buildForcingNotePure(
    reasons,
    escalation ? { producerTier: escalation.producerTier ?? null, nextTier: escalation.nextTier ?? null } : null,
  );
};

/** Suffix appended to an accepted delegate-tool result. */
export const buildAcceptedSuffix = (method: string): string => {
  return buildAcceptedSuffixPure(method);
};

// ---------------------------------------------------------------------------
// Adapter functions (Slice 3).
// ---------------------------------------------------------------------------

/** Per-tier grader dispatcher. */
export const dispatchGrader = async (
  ctx: PluginContext,
  req: { tier: string; system: string; prompt: string },
  parentSessionID?: string | null,
): Promise<{ sessionID: string; text: string }> => {
  const cfg = await ctx.getConfig();
  const created = await withTimeout(
    ctx.plugin.client.session.create(
      parentSessionID ? { body: { parentID: parentSessionID } } : {},
    ) as Promise<SessionCreateResult>,
    30_000,
    "grader session.create",
  );
  const sid = extractSessionId(created);
  if (!sid) return { sessionID: "", text: "" };
  ctx.graderSessions.add(sid);
  try {
    const guard = resolveTierModelGuard(cfg, req.tier);
    if (!guard.ok) {
      logEvent.routing.unmet({ reason: guard.reason, tier: req.tier });
      return { sessionID: "", text: "" };
    }
    const model = guard.model;
    const res = await withTimeout(
      ctx.plugin.client.session.prompt({
        path: { id: sid },
        body: {
          model,
          system: req.system,
          parts: [{ type: "text", text: req.prompt }],
        },
      }) as Promise<SessionPromptResult>,
      120_000,
      "grader session.prompt",
    );
    const text = extractPromptText(res);
    return { sessionID: sid, text };
  } finally {
    ctx.graderSessions.delete(sid);
    try {
      await ctx.plugin.client.session.abort({ path: { id: sid } });
    } catch {
      // best-effort: cleanup MUST never throw out of the finally block.
    }
  }
};

/** Assemble `GateDeps` from the live seams and config snapshot. */
export const buildGateDeps = async (
  ctx: PluginContext,
  parentSessionID?: string | null,
): Promise<GateDeps> => {
  const cfg = await ctx.getConfig();
  return {
    deterministic: {
      exec: ctx.seams.exec,
      fs: ctx.seams.fs,
      cwd: ctx.plugin.directory,
      mutex: ctx.verifyMutex,
    },
    checker: {
      dispatchGrader: (req) => dispatchGrader(ctx, req, parentSessionID),
      ladder: resolveLadder(cfg),
      minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
    },
    require: cfg.enforcement?.verify?.require,
  };
};

/** Adapter for `tool.execute.after`. */
export const verifyTaskAfterHook = async (
  ctx: PluginContext,
  input: unknown,
  output: Record<string, unknown>,
): Promise<void> => {
  const inputRec = (input ?? {}) as Record<string, unknown>;
  const toolName = inputRec["tool"];
  if (typeof toolName !== "string") return;

  const parsedEarly = parseTaskResult(output);
  let childSessionID: string | null = parsedEarly.childSessionID;

  try {
    const taskArgs = asTaskToolArgs(inputRec["args"]);
    const activeCfg = await ctx.getConfig();
    let mode = "off";
    try {
      mode = resolveEnforcementMode({ config: activeCfg, env: process.env }).mode;
    } catch {
      // fall through with mode "off"
    }
    const requireMode = activeCfg.enforcement?.verify?.require;
    if (!shouldVerifyTask(toolName, mode, requireMode)) return;

    const parsed = parsedEarly;
    const { finalReturnText, parentSessionID } = parsed;
    const producerTier = taskArgs?.subagent_type ?? "fast";
    const verifyCfg = activeCfg.enforcement?.verify;
    const skipTiers = verifyCfg?.skipTiers ?? (verifyCfg?.skipFastTier ?? true ? ["fast"] : []);
    if (skipTiers.includes(producerTier)) return;

    const dod = buildDelegationDoD({
      prompt: taskArgs?.prompt,
      description: taskArgs?.description,
    });
    const artefact = {
      changedFiles: childSessionID ? ctx.changedFileStore.get(childSessionID) : [],
      finalReturnText,
      declaredOutputs: dod.deliverable ? [dod.deliverable] : [],
      producerSessionID: childSessionID ?? "",
      producerTier,
    };
    const trivial = childSessionID ? ctx.sessionStore.isTrivial(childSessionID) : false;
    const hookTimeoutMs = activeCfg.enforcement?.verify?.hookTimeoutMs ?? 30_000;
    let res: GateResult;
    try {
      res = await withTimeout(
        accept(
          { dod, trivial, mode: "modeA" },
          artefact,
          await buildGateDeps(ctx, parentSessionID),
        ),
        hookTimeoutMs,
        "verifyTaskAfterHook.accept",
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logEvent.verification.fail({
        sid: childSessionID ?? "",
        producerTier,
        method: "checker",
        dodSource: "explicit",
        skipped: false,
        reasonCount: 1,
        reasons: [reason],
        crashed: true,
      });
      res = {
        accepted: false,
        dodSource: "explicit",
        verdict: {
          pass: false,
          method: "checker",
          reasons: [reason],
          errored: true,
        },
      };
    }

    const eventPayload = {
      sid: childSessionID ?? "",
      parentSid: parentSessionID ?? "",
      producerTier,
      method: res.verdict.method,
      dodSource: res.dodSource,
      skipped: res.verdict.skipped === true,
      reasonCount: res.verdict.reasons.length,
    };

    if (res.accepted) {
      logEvent.verification.pass(eventPayload);
    } else if (res.verdict.skipped) {
      logEvent.verification.skipped({ ...eventPayload, reasons: res.verdict.reasons });
    } else if (res.verdict.errored) {
      logEvent.verification.fail({ ...eventPayload, reasons: res.verdict.reasons });
      showRouterToast(ctx.plugin.client, {
        message: "Verification inconclusive (grader error)",
        variant: "warning",
      });
    } else {
      logEvent.verification.fail({ ...eventPayload, reasons: res.verdict.reasons });
      showRouterToast(ctx.plugin.client, {
        message: "Delegation not accepted by verification",
        variant: "warning",
      });
      const ladder = resolveLadder(activeCfg);
      const li = ladder.indexOf(producerTier);
      const nextTier = li >= 0 && li < ladder.length - 1 ? ladder[li + 1] : null;
      const note = scrubText(buildForcingNote(res.verdict.reasons, { producerTier, nextTier }));
      const existing = output["output"];
      output["output"] = typeof existing === "string" ? existing + "\n\n" + note : note;
    }
  } catch (err) {
    logEvent.verification.fail({
      sid: "",
      producerTier: "",
      method: "none",
      dodSource: "explicit",
      skipped: false,
      reasonCount: 1,
      reasons: [err instanceof Error ? err.message : String(err)],
      crashed: true,
    });
    showRouterToast(ctx.plugin.client, {
      message: "Verification failed unexpectedly",
      variant: "error",
    });
  } finally {
    const sid = childSessionID ?? "";
    try {
      ctx.changedFileStore.clear(sid);
    } catch {
      // non-fatal
    }
    try {
      ctx.sessionStore.unregister(sid);
    } catch {
      // non-fatal
    }
    try {
      ctx.guardStore.clear(sid);
    } catch {
      // non-fatal
    }
    if (childSessionID) {
      try {
        await withTimeout(
          ctx.plugin.client.session.abort({ path: { id: childSessionID } }),
          10_000,
          "task child session.abort",
        );
      } catch {
        // best-effort: cleanup MUST never throw out of the finally block.
      }
    }
  }
};
