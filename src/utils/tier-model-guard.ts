// ---------------------------------------------------------------------------
// src/utils/tier-model-guard.ts — Shared tier-resolution guard.
//
// The delegate loop (`src/plugin/delegate.ts`) and the verify/grader dispatch
// (`src/verify/dispatch.ts`) both need to resolve a tier name to a
// `{ providerID, modelID }` pair before calling `client.session.prompt`.
// Until v2 each caller did this inline:
//
//   - delegate.ts used `tierModel() === null` and emitted its own
//     `[router status: unmet]` message.
//   - dispatch.ts used `tierModel(...) ?? undefined` and silently
//     fell through with no model (which the SDK happily replaces with a
//     server-default model — i.e. the grader asked "is this OK?" and got an
//     answer from a model the operator never picked).
//
// Both paths must fail closed the same way. This guard wraps `tierModel()`
// and returns a discriminated result so the callers keep ownership of
// telemetry (`routing.unmet`), attempt counts, and the exact return string:
//
//   { ok: true,  model: { providerID, modelID } }
//   { ok: false, reason: "invalid model or provider configuration" }
//
// The reason is the single canonical string used across callers. The dispatch
// wiring emits `routing.unmet` with `tier` set, the delegate wiring emits it
// with `attempts` set, and both return early without invoking the prompt.
//
// The guard is intentionally pure: it does NOT log, does NOT throw, and does
// NOT format the caller-visible message. That keeps `src/utils` composable
// while preserving the existing module boundaries — `delegate.ts` and
// `dispatch.ts` keep ownership of attempt counters, session ids, and return
// contracts. See `docs/sdd/fail-fast-hardening-v2/design.md` for the
// decision matrix.
// ---------------------------------------------------------------------------

import type { RouterConfig } from "../router/config";
import { tierModel } from "../verify/dispatch";

/** Result of `resolveTierModelGuard`. Discriminated by `ok`. */
export interface TierModelGuardResult {
  ok: boolean;
  /** Present iff `ok === true`. */
  model?: { providerID: string; modelID: string };
  /** Canonical invalid-config reason. Present iff `ok === false`. */
  reason?: "invalid model or provider configuration";
}

/**
 * Resolve a tier name to `{ providerID, modelID }` via the canonical
 * `tierModel()` helper, returning a discriminated result.
 *
 * Failure modes (any of which => `ok: false`):
 *   - The tier name is absent from the active preset.
 *   - The tier's `model` field is missing or not a string.
 *   - The model string is malformed (no `provider/model` slash, or the slash
 *     is at the first/last position so provider or model would be empty).
 *
 * The canonical reason is `"invalid model or provider configuration"` so
 * every fail-closed path produces the same operator-visible string,
 * regardless of which caller invoked the guard.
 */
export const resolveTierModelGuard = (cfg: RouterConfig, tier: string): TierModelGuardResult => {
  const model = tierModel(cfg, tier);
  if (model === null) {
    return { ok: false, reason: "invalid model or provider configuration" };
  }
  return { ok: true, model };
};
