// src/verify/types.ts
// Pure types for the deterministic verifier. No runtime code.

export type VerifyMethod = "deterministic" | "checker" | "none";

export interface Verdict {
  pass: boolean;
  method: VerifyMethod;
  reasons: string[];
  evidence?: string;
  /** true when nothing was actually verified (SKIPPED != PASS) */
  skipped?: boolean;
  /** true when verification could not run due to infrastructure failure (dispatch error, parse failure, timeout) */
  errored?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type ExecSeam = (
  command: string,
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>;

export interface FsSeam {
  fileExists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
}

export interface MutexRegistry {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface DeterministicDeps {
  exec: ExecSeam;
  fs: FsSeam;
  cwd: string;
  mutex?: MutexRegistry;
  /** per-check timeout in ms; default 120000 */
  timeoutMs?: number;
  /** permitted command first-token basenames; default DEFAULT_ALLOWLIST */
  allowlist?: string[];
  defaults?: {
    testCommand?: string;
    buildCommand?: string;
    lintCommand?: string;
  };
}
