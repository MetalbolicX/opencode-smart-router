/**
 * src/verify/gate.ts — Layer 2 acceptance gate (PURE orchestration core).
 *
 * The gate is the single decision point that turns "the producer says it
 * finished" into "the producer's output was objectively accepted". It is
 * shared by BOTH usage modes (Mode A on-the-fly dispatch and Mode B plan
 * annotation) and by BOTH wirings (Option (i) verify-dispatch around the
 * built-in `task` tool, and Option (ii) the plugin-owned `delegate` tool),
 * so there is exactly ONE accept/verify code path (GA-5).
 *
 * Design invariants:
 *  - FAIL-CLOSED: a verification error never yields acceptance.
 *  - NEVER silently accept a non-trivial delegation that has no checkable DoD.
 *  - producer != grader and grader >= producer are enforced inside runChecker;
 *    the gate never grades anything itself.
 *  - PURE: all side-effecting work (exec/fs/grader dispatch) is injected via
 *    deps; this module imports no fs/network/SDK.
 */
import type { Verdict } from "./types";
import type { DeterministicDeps } from "./types";
import type { DoD } from "./dod";
import { isCheckable } from "./dod";
import { runDeterministic } from "./deterministic";
import { runChecker } from "./checker";
import type { ArtefactView, CheckerDeps } from "./checker";

/** The concrete, inspectable result of a delegation (artefact contract §3.3). */
export interface Artefact {
  changedFiles: { path: string; status: string }[];
  finalReturnText: string;
  declaredOutputs: string[];
  producerSessionID: string;
  producerTier: string;
}

/** The delegation being judged: its DoD plus dispatch-time classification. */
export interface Delegation {
  dod: DoD;
  /** Trivial dispatches (classified at dispatch, m2) bypass verification (GA-6). */
  trivial?: boolean;
  /** Mode A (on-the-fly) vs Mode B (plan annotation) — drives the no-DoD message. */
  mode?: "modeA" | "modeB";
}

export interface GateDeps {
  deterministic: DeterministicDeps;
  checker: CheckerDeps;
  /**
   * verify.require: "never" disables the gate (accept without verifying);
   * "whenDoDPresent" (default) and "always" both verify when the DoD is
   * checkable and apply the no-DoD policy otherwise.
   *
   * Phase 5 (PR3): unknown values are treated FAIL-CLOSED as "always" so a
   * typo can never silently disable verification. Config validation in
   * `validateConfig()` rejects unknown values outright; this defensive
   * coercion is the last-line guard for runtime callers that bypass
   * config validation (tests, ad-hoc wiring).
   */
  require?: string;
}

export interface GateResult {
  accepted: boolean;
  verdict: Verdict;
  /** Convenience mirror of dod.source for the caller's trajectory record. */
  dodSource: DoD["source"];
}

const view = (artefact: Artefact): ArtefactView => {
  return {
    finalReturnText: artefact.finalReturnText,
    changedFiles: artefact.changedFiles,
    declaredOutputs: artefact.declaredOutputs,
  };
};

/**
 * Decide whether a delegation's artefact meets its DoD.
 * Returns { accepted, verdict, dodSource }; accepted is true ONLY when a
 * verifier returned pass===true (or the gate is explicitly disabled).
 */
/**
 * Normalize a `verify.require` value to a known set, failing closed on
 * anything the schema does not recognize. Unknown strings are coerced to
 * "always" so a typo can never silently disable verification.
 */
const normalizeRequire = (
  raw: string | undefined,
): "never" | "whenDoDPresent" | "always" => {
  if (raw === undefined) return "whenDoDPresent";
  if (raw === "never" || raw === "whenDoDPresent" || raw === "always") return raw;
  return "always";
};

export const accept = async (
  delegation: Delegation,
  artefact: Artefact,
  deps: GateDeps,
): Promise<GateResult> => {
  const dod = delegation.dod;
  const dodSource = dod.source;
  const require = normalizeRequire(deps.require);

  // verify.require === "never": Layer 2 is configured off; do not gate.
  if (require === "never") {
    return {
      accepted: true,
      verdict: {
        pass: false,
        method: "none",
        skipped: true,
        reasons: ["verification disabled (verify.require=never)"],
      },
      dodSource,
    };
  }

  // Trivial dispatch (classified at dispatch, m2) carrying only an AUTO-INFERRED
  // DoD: bypass verification overhead (GA-6 proportional). An explicit author
  // [acceptance] block (source "explicit"/"annotation") is a deliberate request
  // to verify and is always honored, even for a trivially-classified dispatch.
  if (delegation.trivial && dod.source === "inferred") {
    return {
      accepted: true,
      verdict: {
        pass: false,
        method: "none",
        skipped: true,
        reasons: ["trivial dispatch; verification skipped (auto-inferred DoD)"],
      },
      dodSource,
    };
  }

  // No checkable DoD: apply the proportional / never-silently-accept policy.
  if (!isCheckable(dod)) {
    if (delegation.trivial) {
      return {
        accepted: true,
        verdict: {
          pass: false,
          method: "none",
          skipped: true,
          reasons: ["trivial dispatch; verification skipped"],
        },
        dodSource,
      };
    }
    const reason =
      delegation.mode === "modeB"
        ? "no acceptance block on a non-trivial plan task (Mode B is strict): add an [acceptance] ... [/acceptance] block to this task"
        : "no checkable DoD for a non-trivial dispatch (Mode A): provide an [acceptance] block or let auto-inference supply one";
    return {
      accepted: false,
      verdict: { pass: false, method: "none", skipped: true, reasons: [reason] },
      dodSource,
    };
  }

  // Checkable DoD: dispatch on the normalized kind. normalizeDoD() guarantees
  // a checkable DoD is "deterministic" (when any checks exist) or "checker"
  // (criteria only), which realises verify.preferDeterministic at
  // DoD-construction time. Both verifiers are contractually FAIL-CLOSED: they
  // catch their own errors and return a non-passing Verdict, never throwing.
  // The two wirings (Option i verify-dispatch / Option ii delegate tool) still
  // wrap accept() defensively so that any unexpected throw surfaces as a
  // visible failure (forcing note / honest status), never a silent accept.
  let verdict: Verdict;
  if (dod.kind === "deterministic") {
    verdict = await runDeterministic(dod, deps.deterministic);
  } else {
    // "checker" is the only remaining checkable kind.
    verdict = await runChecker(
      {
        criteria: dod.criteria,
        artefact: view(artefact),
        producerTier: artefact.producerTier,
        producerSessionID: artefact.producerSessionID,
      },
      deps.checker,
    );
  }

  return { accepted: verdict.pass === true, verdict, dodSource };
};
