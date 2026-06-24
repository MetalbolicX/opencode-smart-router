// ---------------------------------------------------------------------------
// src/router/tools.ts — Shared tool classification sets.
//
// Single source of truth for the four tool sets that guard, verify, and
// router modules agree on. Before this file existed, the same `new Set(...)`
// definitions were duplicated across `src/guard/guards.ts` and
// `src/verify/dispatch.ts` (with `src/router/sessions.ts` owning a fifth,
// `READ_ONLY_TOOLS`, that the session cap banner consumes).
//
// Conventions used by every consumer:
// - `READ_ONLY_TOOLS`: tools that count against the read-only cap and never
//   mutate the workspace.
// - `WRITE_TOOLS`: tools that produce a changed-file record (write/edit/patch/
//   multiedit) — the narrow set used by `extractChangedFile`.
// - `MUTATION_TOOLS`: the broader mutation set used by the guard's `classify`
//   to bucket a tool call as `kind === "mutation"`. Includes `bash` because
//   `bash` calls are how the model actually applies changes when it doesn't
//   use the file-write tools.
// - `FINISH_TOOLS`: tools that mark the delegation as terminally complete.
//
// `READ_ONLY_TOOLS` is also re-declared in `src/router/sessions.ts` for the
// session cap banner (intentionally preserved to avoid a churn diff in callers
// like `src/plugin/hooks.ts`). The two definitions MUST stay byte-equal;
// update them together.
// ---------------------------------------------------------------------------

/** Tools that count against the read-only cap and never mutate the workspace. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "read",
  "glob",
  "ls",
]);

/** Tools that produce a changed-file record (used by `extractChangedFile`). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
  "multiedit",
]);

/** Broader mutation set used by the guard's `classify` to bucket tool calls. */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
  "bash",
  "multiedit",
]);

/** Tools that mark the delegation as terminally complete. */
export const FINISH_TOOLS: ReadonlySet<string> = new Set([
  "finish",
  "return",
  "task_complete",
]);
