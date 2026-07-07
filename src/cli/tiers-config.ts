// ---------------------------------------------------------------------------
// src/cli/tiers-config.ts — `osr config init` and `osr config paths`.
//
// These two subcommands give users an explicit, scriptable way to create
// the optional `tiers.json` override file (global or repo-local) and to
// discover where the bundled, global, local, and state files live.
//
// Design notes:
//   - `runConfigInit` is the inverse-shape sibling of `runInstall`:
//     idempotent via "file already exists + !force ⇒ throw" (rather than
//     the noop-on-same-state contract used by install). This is intentional:
//     creating a tier config file is a user-driven, single-shot action.
//   - `--from-bundled` reads the shipped `tiers.json` via `configPath()`
//     from `src/router/config-loader.ts` so the copy follows the same
//     resolution rules the runtime uses (source layout vs bundled layout).
//   - `--preset` validates the name against the bundled `presets` block so
//     users do not silently write `{"activePreset":"does-not-exist"}`.
//   - `runConfigPaths` reports existence through the injected `CliFs` for
//     global / local / state; the bundled file is reported through
//     `existsSync` (node:fs) because the bundle lives outside the CLI's
//     in-memory abstraction.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { configPath, localConfigPath } from "../router/config-loader";
import { globalConfigPath, statePath } from "../router/config-paths";
import { backupIfWritable, type CliFs, writeAtomically } from "./config";
import { createRealFs } from "./real-fs";

const JSON_INDENT = 2;

export interface ConfigInitOptions {
  /** Where to write the file. Defaults to `"global"`. */
  target?: "global" | "local";
  /** Bundled preset name to seed as `activePreset` in the new file. */
  preset?: string;
  /** Seed the file with the shipped `tiers.json` content instead of `{}`. */
  fromBundled?: boolean;
  /** Overwrite an existing file (backing it up first). */
  force?: boolean;
  /** Compute the write target + content and report it without touching disk. */
  dryRun?: boolean;
}

export interface ConfigInitResult {
  status: "wrote" | "planned" | "noop";
  /** Absolute path the command targeted (existing or newly-created). */
  path: string;
  /** Backup path created under `--force`, or `null` when no backup was needed. */
  backup: string | null;
  /** Serialized JSON content that was (or would be) written to disk. */
  content: string;
}

export interface ConfigPathsEntry {
  /** Absolute path to the layer / file. */
  path: string;
  /** Whether the file currently exists on disk. */
  exists: boolean;
}

export interface ConfigPathsResult {
  /** Path to the bundled `<plugin>/tiers.json` shipped with the package. */
  bundled: ConfigPathsEntry;
  /** Path to the global `~/.config/opencode-smart-router/tiers.json`. */
  global: ConfigPathsEntry;
  /** Path to the repo-local `<cwd>/.opencode/tiers.json`. */
  local: ConfigPathsEntry;
  /** Path to the persisted runtime state file. */
  state: ConfigPathsEntry;
}

/**
 * Resolve the absolute path `runConfigInit` will write to, based on
 * `target`. Centralized so the dry-run and write branches agree.
 */
const resolveTargetPath = (target: "global" | "local"): string => {
  if (target === "local") return localConfigPath();
  return globalConfigPath();
};

/**
 * Read and parse the bundled `tiers.json`. Throws with a clear message on
 * read / parse failure so the caller can surface it to the operator.
 */
const readBundledTiers = (): Record<string, unknown> => {
  const path = configPath();
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`bundled tiers.json at ${path} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
};

/**
 * Compute the JSON content that will be written for the given options.
 * Validates `--preset` against the bundled `presets` block when supplied.
 * Throws on invalid preset names so the user gets feedback before any disk
 * mutation happens.
 */
const computeContent = (
  opts: Required<Pick<ConfigInitOptions, "preset" | "fromBundled">>,
): Record<string, unknown> => {
  if (opts.preset && opts.fromBundled) {
    throw new Error("--preset and --from-bundled are mutually exclusive");
  }
  if (opts.fromBundled) {
    return readBundledTiers();
  }
  if (opts.preset) {
    const bundled = readBundledTiers();
    const presets = bundled.presets;
    if (!presets || typeof presets !== "object" || Array.isArray(presets)) {
      throw new Error("bundled tiers.json is missing a valid `presets` block");
    }
    const names = Object.keys(presets as Record<string, unknown>);
    // Case-insensitive resolution — matches `resolvePresetName()` semantics.
    const normalized = opts.preset.trim().toLowerCase();
    const match = names.find((name) => name.toLowerCase() === normalized);
    if (!match) {
      throw new Error(
        `unknown preset '${opts.preset}'. Available presets: ${names.join(", ") || "(none)"}`,
      );
    }
    return { activePreset: match };
  }
  return {};
};

/**
 * Run `osr config init` against the chosen target.
 *
 * Steps: pick target path → compute content → check collision → backup
 * (under --force) → atomic write. Dry-run stops before any disk mutation.
 */
export const runConfigInit = (
  opts: ConfigInitOptions = {},
  fs: CliFs = createRealFs(),
): ConfigInitResult => {
  const target = opts.target ?? "global";
  if (target !== "global" && target !== "local") {
    throw new Error(`invalid target '${String(target)}' — expected 'global' or 'local'`);
  }

  const path = resolveTargetPath(target);
  const contentObj = computeContent({
    preset: opts.preset ?? "",
    fromBundled: opts.fromBundled ?? false,
  });
  const content = JSON.stringify(contentObj, null, JSON_INDENT);

  // Dry-run: report the planned write (target + content) without touching
  // disk or throwing on collisions. The user wants to know what WOULD
  // happen, so we surface the would-be path and content regardless.
  if (opts.dryRun) {
    const collision = fs.existsSync(path) && !opts.force;
    console.log(`[dry-run] Would write to ${path}:`);
    console.log(content);
    if (collision) {
      console.log(
        `[dry-run] NOTE: file already exists — re-run without --dry-run to apply (or add --force to overwrite).`,
      );
    }
    return { status: "planned", path, backup: null, content };
  }

  // Collision guard: an existing file aborts unless `--force`. Reported
  // as a user-facing error with a `--force` hint so the next step is
  // obvious.
  if (fs.existsSync(path) && !opts.force) {
    throw new Error(
      `tiers file already exists at ${path}\n` +
        `  Re-run with --force to back it up and overwrite, or edit it directly.`,
    );
  }

  // Backup only when the target existed (no point backing up a fresh file).
  const backup = fs.existsSync(path) ? backupIfWritable(path, fs) : null;
  writeAtomically(path, content, fs);

  console.log(`✓ Wrote tiers config`);
  console.log(`  path:   ${path}`);
  if (backup) console.log(`  backup: ${backup}`);

  return { status: "wrote", path, backup, content };
};

/**
 * Resolve the four on-disk paths the CLI cares about and report their
 * existence. The bundled tier path is checked against the real filesystem
 * (it lives inside the plugin package, outside the CLI's in-memory world);
 * global / local / state are checked against the injected `CliFs` so tests
 * can drive them with a `createMemFs` instance.
 */
export const runConfigPaths = (fs: CliFs = createRealFs()): ConfigPathsResult => {
  const bundledPath = configPath();
  const globalPath = globalConfigPath();
  const localPath = localConfigPath();
  const stateFilePath = statePath();

  const result: ConfigPathsResult = {
    bundled: { path: bundledPath, exists: existsSync(bundledPath) },
    global: { path: globalPath, exists: fs.existsSync(globalPath) },
    local: { path: localPath, exists: fs.existsSync(localPath) },
    state: { path: stateFilePath, exists: fs.existsSync(stateFilePath) },
  };

  console.log(`bundled: ${result.bundled.path}${result.bundled.exists ? "" : " (missing)"}`);
  console.log(`global:  ${result.global.path}${result.global.exists ? "" : " (missing)"}`);
  console.log(`local:   ${result.local.path}${result.local.exists ? "" : " (missing)"}`);
  console.log(`state:   ${result.state.path}${result.state.exists ? "" : " (missing)"}`);

  return result;
};
