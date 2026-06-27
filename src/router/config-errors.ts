// ---------------------------------------------------------------------------
// src/router/config-errors.ts — Typed errors for config/state file failures.
//
// PR3a introduces the minimal surface needed to replace silent `catch {}`
// suppression in `config-state.ts`: a tagged `RouterStateError` that the
// loader can catch and surface observably.
//
// PR3b will extend this file with `RouterConfigError` and a unified
// `ConfigErrorKind` taxonomy that distinguishes `missing` (warn + defaults)
// from `unreadable` / `malformed` / `invalid` (fail-loud). The shape below
// is intentionally small so the PR3b extension is additive.
// ---------------------------------------------------------------------------

/**
 * Thrown when the persisted runtime state file exists but cannot be parsed
 * or does not deserialize to a plain object. Distinct from a missing file
 * (which warns + returns defaults) so callers can fail-loud on corrupt
 * state instead of silently dropping the user's `/preset` / `/router`
 * overrides.
 *
 * `cause` carries the underlying parser error for diagnostics.
 */
export class RouterStateError extends Error {
  override readonly name = "RouterStateError";
  readonly path: string;

  constructor(path: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`router state file at ${path} is malformed: ${reason}`, { cause });
    this.path = path;
  }
}
