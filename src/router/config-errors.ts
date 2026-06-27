// ---------------------------------------------------------------------------
// src/router/config-errors.ts — Typed errors for config/state file failures.
//
// PR3a introduced `RouterStateError` so the loader could distinguish a
// missing state file (warn + defaults) from a present-but-corrupt one
// (throw) instead of silently swallowing every failure mode.
//
// PR3b adds the unified `ConfigErrorKind` taxonomy and the `RouterConfigError`
// type. Every I/O / parse failure in the loader/state pipeline is thrown
// as a `RouterConfigError` (or, for state-only files, a `RouterStateError`)
// carrying a discriminator `kind`. Callers and operators can branch on
// the kind to decide between `console.warn` + defaults and a hard
// startup-time failure.
//
// Mapping of kinds → operator behaviour:
//   - "missing"               → warn + defaults (optional layer absent).
//                                Thrown ONLY when a required layer is missing
//                                and the loader wants the operator to know
//                                (the bundled layer is required, but it never
//                                raises "missing" via this path — it raises
//                                "unreadable" instead, because a missing bundled
//                                file IS an unreadable built-in).
//   - "unreadable"            → fail-loud. The file exists on disk but the
//                                runtime could not open / read it (EACCES,
//                                EISDIR, EIO, etc.).
//   - "malformed"             → fail-loud. JSON.parse threw, or the parsed
//                                root is not a plain object / array.
//   - "invalid"               → fail-loud. The parsed object failed
//                                `validateConfig()` (schema violation).
//   - "stale_refresh_failed"  → soft-warn. The TTL-driven background refresh
//                                raised one of the above kinds; the runtime
//                                continues to serve the last-known-good
//                                cached value and emits an operator warning
//                                + structured log event. (PR5 wires the TTL
//                                itself; this kind is reserved here so the
//                                loader can fail-loud on a one-shot read but
//                                soft-warn on a periodic refresh.)
// ---------------------------------------------------------------------------

/**
 * Discriminator for `RouterConfigError`. Each kind maps to a documented
 * operator-facing behaviour in `spec/config-error-handling.md` and
 * `spec/async-config-io.md`. Adding a new kind requires updating both
 * specs and the golden-error-message tests in `test/golden/`.
 */
export type ConfigErrorKind =
  | "missing"
  | "unreadable"
  | "malformed"
  | "invalid"
  | "stale_refresh_failed";

/**
 * Thrown by the config-loader / config-state pipeline for every I/O or
 * parse failure. `kind` is the stable discriminator the loader and
 * startup-time error handler use to decide between warn+default and
 * fail-loud. `path` is the on-disk file that triggered the error so the
 * operator-facing message can name it without re-deriving from `cause`.
 *
 * `cause` carries the underlying parser / fs error for diagnostics; it
 * is preserved through the standard `Error.cause` chain (Node 18+).
 */
export class RouterConfigError extends Error {
  override readonly name = "RouterConfigError";
  readonly kind: ConfigErrorKind;
  readonly path: string;

  constructor(kind: ConfigErrorKind, path: string, cause: unknown, message?: string) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const prefix = message ?? `config file at ${path} (kind=${kind})`;
    super(`${prefix}: ${reason}`, { cause });
    this.kind = kind;
    this.path = path;
  }
}

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
