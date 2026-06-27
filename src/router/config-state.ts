// ---------------------------------------------------------------------------
// src/router/config-state.ts — Runtime state persistence.
//
// `readState()` / `writeState()` manage the on-disk state file at
// `~/.config/opencode/opencode-model-router.state.json`. The state
// overlays ONLY `activePreset`, `activeMode`, and `enforcementMode` on
// top of the merged manual config; it never touches `tiers.json`.
//
// `saveActivePreset()`, `saveActiveMode()`, and `saveEnforcementMode()`
// are the user-facing state-mutation helpers called from `/preset`,
// `/budget`, and `/router enforce` commands. They each validate the
// requested value against the current merged config and skip the
// write if the value is invalid.
//
// PR2 task 2.6 migrates these helpers from the legacy `loadConfig()`
// singleton to the pure `readMergedConfig()` pipeline so the singleton
// can be removed (task 2.7).
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RouterState } from "./config.types";
import { RouterStateError } from "./config-errors";
import { readMergedConfig } from "./config-loader";
import { resolvePresetName } from "./config-resolve";

// ---------------------------------------------------------------------------
// State file path
// ---------------------------------------------------------------------------

export const statePath = (): string => {
  return join(homedir(), ".config", "opencode", "opencode-model-router.state.json");
};

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

/**
 * Read current persisted state.
 *
 * Policy (per config-error-handling spec):
 *   - Missing file → operator-facing warning + return `{}` (warn+default).
 *   - Present-but-unreadable / unparsable / non-object file → throw
 *     `RouterStateError` so the loader fails loud instead of silently
 *     dropping the user's `/preset` / `/router` overrides.
 *
 * This replaces the prior silent `catch {}` that suppressed every
 * failure mode and returned `{}` — which caused corrupted state to look
 * identical to "first run" and lose user choices without any signal.
 */
export const readState = (): RouterState => {
  const p = statePath();
  if (!existsSync(p)) {
    // eslint-disable-next-line no-console
    console.warn(`router state: no file at ${p}; starting with empty state`);
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err) {
    throw new RouterStateError(p, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RouterStateError(p, err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RouterStateError(p, new Error("state file root must be a JSON object"));
  }
  return parsed as RouterState;
};

/** Write state to disk atomically (merges with existing keys). */
export const writeState = (patch: Partial<RouterState>): void => {
  const state = { ...readState(), ...patch };
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, p);
};

// ---------------------------------------------------------------------------
// State save helpers — write user-selected state.
//
// PR2 task 2.6: these now resolve the requested value against a freshly
// read merged config (`readMergedConfig`) and write ONLY to the state
// file. The legacy module-level cache invalidation is gone — every
// `readMergedConfig` call is a pure disk read.
// ---------------------------------------------------------------------------

export const saveActivePreset = (presetName: string): void => {
  const cfg = readMergedConfig({ cwd: process.cwd() });
  const resolved = resolvePresetName(cfg, presetName);
  if (!resolved) {
    return;
  }

  // Persist user-selected preset to state file only — never mutate tiers.json
  writeState({ activePreset: resolved });
};

export const saveActiveMode = (modeName: string): void => {
  const cfg = readMergedConfig({ cwd: process.cwd() });
  if (!cfg.modes?.[modeName]) {
    return;
  }

  writeState({ activeMode: modeName });
};

export const saveEnforcementMode = (mode: "off" | "advisory" | "enforced"): void => {
  writeState({ enforcementMode: mode });
};
