// ---------------------------------------------------------------------------
// src/cli/update.ts — `osr update` command.
//
// Detects whether the installed version is stale relative to the npm registry.
// When stale, purges the runtime cache and prints the canonical update
// instruction instead of auto-running install (per locked decision).
//
// Does NOT execute the install command — it only detects + instructs.
// ---------------------------------------------------------------------------

import { rmSync } from "node:fs";
import { fetchLatestVersion, getInstalledVersion, isStale } from "./registry";
import { cachePath } from "./uninstall";

export interface UpdateOptions {
  /** Plan the change and print it without writing. */
  dryRun?: boolean;
}

export interface UpdateResult {
  /** Outcome of the update check. */
  status: "purged" | "planned" | "noop";
  /** Cache path that was (or would be) purged. */
  cachePath: string;
  /** Instruction printed to stdout. Empty when noop. */
  instruction: string;
}

export const runUpdate = async (
  opts: UpdateOptions = {},
  deps?: { fetch?: typeof globalThis.fetch },
): Promise<UpdateResult> => {
  const installed = getInstalledVersion();
  const latest = await fetchLatestVersion(deps?.fetch);

  // If we can't determine the latest version, treat as noop.
  if (latest === null) {
    return { status: "noop", cachePath: cachePath(), instruction: "" };
  }

  if (!isStale(installed, latest)) {
    console.log(`already current`);
    return { status: "noop", cachePath: cachePath(), instruction: "" };
  }

  const path = cachePath();

  if (opts.dryRun) {
    console.log(`[dry-run] Would purge ${path}`);
    return { status: "planned", cachePath: path, instruction: "" };
  }

  // Purge the cache directory (best-effort, silent if missing).
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Path didn't exist — that's fine, we still print the instruction.
  }

  const instruction = `npx opencode-smart-router@latest install`;
  console.log(instruction);

  return { status: "purged", cachePath: path, instruction };
};
