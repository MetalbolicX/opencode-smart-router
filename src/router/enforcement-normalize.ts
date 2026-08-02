// ---------------------------------------------------------------------------
// src/router/enforcement-normalize.ts — Enforcement normalization helper.
//
// `normalizeEnforcement()` collapses an optional `EnforcementConfig` into a
// record with a default `mode` of `"advisory"` so downstream consumers never
// branch on `undefined`.
//
// This function is NOT in the ReScript Validate facade because it does not
// validate — it only normalizes. It lives here so the `config.ts` barrel can
// re-export it alongside the Validate facade.
// ---------------------------------------------------------------------------

import type { EnforcementConfig } from "./config.types";

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export const normalizeEnforcement = (
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } => {
  return { mode: e?.mode ?? "advisory" };
};
