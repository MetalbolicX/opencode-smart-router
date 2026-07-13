// src/verify/checker.ts
//
// Temperature pinning is a WIRING concern (chat.params keyed to the grader session),
// out of scope for this pure module.
// Producer != grader is enforced structurally (GraderDispatch MUST create a FRESH session
// each call) AND defensively here by sessionID inequality check (step 5).

import { scrubText } from "../guard/scrub";
import type { Verdict } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArtefactView {
  finalReturnText: string;
  changedFiles: { path: string; status: string }[];
  declaredOutputs: string[];
}

export interface GraderRequest {
  tier: string;
  system: string;
  prompt: string;
}

export interface GraderResult {
  sessionID: string;
  text: string;
}

/** MUST create a FRESH session each call */
export type GraderDispatch = (req: GraderRequest) => Promise<GraderResult>;

export interface CheckerDeps {
  dispatchGrader: GraderDispatch;
  ladder?: string[]; // default ["fast","medium","heavy"]
  minGraderTier?: string | null; // optional floor
}

export interface CheckerInput {
  criteria: string[];
  artefact: ArtefactView;
  producerTier: string;
  producerSessionID: string;
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

export const tierRank = (tier: string, ladder: string[]): number => {
  const i = ladder.indexOf(tier);
  return i < 0 ? 0 : i; // unknown tier falls back to rank 0 (fast)
};

export const atLeastProducerTier = (
  producerTier: string,
  opts?: { ladder?: string[]; minGraderTier?: string | null },
): string => {
  const ladder = opts?.ladder ?? ["fast", "medium", "heavy"];
  let idx = tierRank(producerTier, ladder);
  if (opts?.minGraderTier != null) {
    idx = Math.max(idx, tierRank(opts.minGraderTier, ladder));
  }
  const clamped = Math.min(idx, ladder.length - 1);
  return ladder[clamped] ?? producerTier;
};

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const GRADER_SYSTEM =
  'You are an independent, skeptical verification grader. You did NOT produce this work and have no stake in it. Evaluate ONLY whether the artefact satisfies EACH acceptance criterion below. For every criterion, cite concrete evidence from the artefact. If the evidence is missing, ambiguous, partial, or you are uncertain for ANY reason, you MUST fail that criterion. Default to FAIL. Do not give the benefit of the doubt. Output ONLY a single JSON object on one line: {"pass": boolean, "reasons": string[]}. Set pass=true ONLY if every criterion is satisfied with cited evidence; otherwise pass=false with a reason per failed criterion.';

export const buildGradingPrompt = (input: CheckerInput): { system: string; prompt: string } => {
  const lines: string[] = [];

  lines.push("## Acceptance criteria (ALL must be satisfied)");
  for (let i = 0; i < input.criteria.length; i++) {
    lines.push(`${i + 1}. ${input.criteria[i]}`);
  }

  lines.push("");
  lines.push("## Artefact to evaluate");
  lines.push("### Final return text");
  lines.push(scrubText(input.artefact.finalReturnText) || "(empty)");

  lines.push("");
  lines.push("### Changed files");
  if (input.artefact.changedFiles.length > 0) {
    for (const f of input.artefact.changedFiles) {
      lines.push(`- ${f.status} ${scrubText(f.path)}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("");
  lines.push("### Declared outputs");
  if (input.artefact.declaredOutputs.length > 0) {
    for (const o of input.artefact.declaredOutputs) {
      lines.push(`- ${scrubText(o)}`);
    }
  } else {
    lines.push("(none)");
  }

  lines.push("");
  lines.push("Respond with the JSON verdict now.");

  return { system: GRADER_SYSTEM, prompt: lines.join("\n") };
};

// ---------------------------------------------------------------------------
// Verdict parser
// ---------------------------------------------------------------------------

export const parseGraderVerdict = (text: string): { pass: boolean; reasons: string[] } | null => {
  try {
    let raw: string | null = null;

    // Try fenced ```json ... ``` first
    const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(text);
    if (fenced) {
      raw = fenced[1] ?? null;
    } else {
      // Extract first "{" to last "}" as fallback
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        raw = text.slice(start, end + 1);
      }
    }

    if (raw === null) return null;

    // Try strict parse first
    try {
      const result = JSON.parse(raw) as unknown;
      if (typeof result === "object" && result !== null) {
        const r = result as Record<string, unknown>;
        if (typeof r["pass"] === "boolean") {
          const reasons = Array.isArray(r["reasons"])
            ? r["reasons"].filter((item): item is string => typeof item === "string")
            : [];
          return { pass: r["pass"] as boolean, reasons };
        }
        // Fallback: look for verdict field (used by @heavy models with reasoning)
        if (typeof r["verdict"] === "string") {
          const verdictStr = r["verdict"].toLowerCase();
          const approved = /approv|pass|accept|yes/i.test(verdictStr);
          const reasons = Array.isArray(r["reasons"])
            ? r["reasons"].filter((item): item is string => typeof item === "string")
            : [r["verdict"] as string];
          return { pass: approved, reasons };
        }
      }
    } catch {
      // fall through to null
    }

    return null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const runChecker = async (input: CheckerInput, deps: CheckerDeps): Promise<Verdict> => {
  // 1. Empty criteria
  if (input.criteria.length === 0) {
    return { pass: false, method: "none", skipped: true, reasons: ["no criteria to grade"] };
  }

  // 2. Determine grader tier
  const graderTier = atLeastProducerTier(input.producerTier, {
    ladder: deps.ladder,
    minGraderTier: deps.minGraderTier,
  });

  // 3. Build prompt
  const { system, prompt } = buildGradingPrompt(input);

  // 4. Dispatch grader
  let res: GraderResult;
  try {
    res = await deps.dispatchGrader({ tier: graderTier, system, prompt });
  } catch (err) {
    return {
      pass: false,
      method: "checker",
      reasons: [scrubText("grader dispatch failed: " + String(err))],
      errored: true,
    };
  }

  // 5. Independence check (fail-closed)
  if (res.sessionID === input.producerSessionID || !res.sessionID) {
    return {
      pass: false,
      method: "checker",
      reasons: [
        "grader session is not independent of the producer (producer=grader); refusing to accept",
      ],
      errored: true,
    };
  }

  // 6. Parse verdict
  const parsed = parseGraderVerdict(res.text);
  if (parsed === null) {
    return {
      pass: false,
      method: "checker",
      reasons: [
        "could not parse grader verdict; defaulting to FAIL",
        scrubText(res.text.slice(0, 300)),
      ],
      errored: true,
    };
  }

  // 7. Return verdict
  return {
    pass: parsed.pass === true,
    method: "checker",
    reasons: parsed.reasons.map(scrubText),
    evidence: scrubText("grader=" + graderTier),
  };
};
