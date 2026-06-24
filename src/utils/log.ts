// ---------------------------------------------------------------------------
// src/utils/log.ts — Shared trajectory-log writer.
//
// Both `src/plugin/hooks.ts` (per-delegation scorecard + opt-in full
// trajectory dump) and `src/escalate/ladder.ts` (delegate scorecard) append
// session-scoped log lines to `<tmpdir>/opencode-model-router-trajectory/`.
// This helper centralises the mkdir+append pattern so the directory, the
// fail-soft semantics, and the filename convention all stay in one place.
//
// Naming: the helper writes `<sid>.log` by default. Callers that need a
// disambiguating suffix pass `subdir` and the file becomes
// `<sid>.<subdir>.log` (e.g., `writeTrajectoryLog(sid, line, "scorecard")` →
// `<sid>.scorecard.log`). This matches the three existing filename patterns
// the codebase already expects in tests (`<sid>.log`, `<sid>.scorecard.log`,
// `<sid>.delegate.log`) without introducing a real subdirectory layer.
//
// Fail-soft: any IO error is swallowed so a logging failure can never crash
// a real session — matches the call sites the helper replaces.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Top-level directory every trajectory log file lives under. */
const TRAJECTORY_DIR = "opencode-model-router-trajectory";

/**
 * Append `content` to a session-scoped trajectory log under
 * `<tmpdir>/opencode-model-router-trajectory/<sid>[.<subdir>].log`. The
 * directory is created on demand (recursive), and the write is append-only
 * so multiple invocations for the same `sid` accumulate without truncation.
 *
 * @param sid     Session id (or any other filename-safe token) that scopes
 *                the log file.
 * @param content Text to append. A trailing newline is added if `content`
 *                does not already end with one.
 * @param subdir  Optional filename suffix inserted between `<sid>` and `.log`.
 *                Used to disambiguate log kinds without changing the parent
 *                directory (e.g., `"scorecard"` → `<sid>.scorecard.log`).
 */
export function writeTrajectoryLog(
  sid: string,
  content: string,
  subdir?: string,
): void {
  try {
    const dir = join(tmpdir(), TRAJECTORY_DIR);
    mkdirSync(dir, { recursive: true });
    const filename = subdir ? `${sid}.${subdir}.log` : `${sid}.log`;
    const line = content.endsWith("\n") ? content : `${content}\n`;
    writeFileSync(join(dir, filename), line, { flag: "a" });
  } catch {
    // best-effort only — a logging failure must never crash a real session.
  }
}
