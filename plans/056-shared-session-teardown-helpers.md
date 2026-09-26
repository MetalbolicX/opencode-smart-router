# Plan 056: Extract the shared session-teardown helpers and log delegate's unexpected-error path

> **Executor instructions**: strict TDD for the new module; the delegate/
> fanout refactors are behavior-preserving and pinned by existing tests as
> characterization. Honor STOP conditions. Update your row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/plugin/delegate.ts src/plugin/fanout.ts src/utils/error-classify.ts test/unit/plugin-delegate.test.ts test/unit/plugin-fanout.test.ts`
> Plans 047 (fanout) and 055 (trajectory wiring) touch the same files —
> this plan MUST execute after them. On excerpt mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touches live session teardown; regression mode is leaked
  or wrongly-aborted sessions — hence characterization-first)
- **Depends on**: plans/046, plans/047 (strictly after; 055 ideally before)
- **Category**: tech-debt
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`cleanupProducerSession` (delegate.ts:62-108) and `cleanupWorkerSession`
(fanout.ts:50-108) are near-identical copies: three identical try/catch
store clears with byte-identical `log.warn` bodies (only the event prefix
differs: `delegate.cleanup_failed` vs `fanout.worker_cleanup_failed`),
followed by the same conditional `session.abort` with a 10s
`withTimeout`. The copies have already drifted (worker version adds
`abortFailedWorkers`; the binding-rule citations differ), and the same
AbortError duck-type check is inlined three times across the two files
while a canonical classifier (`isAbortLikeError` in
`src/utils/error-classify.ts`) already exists — delegate's own comment at
`:463-465` calls classifyPromptError's abort path "the canonical
AbortError check". Any future teardown-policy change must be hand-mirrored
or the copies diverge further.

Additionally, `executeDelegate`'s outer catch (`delegate.ts:682-685`)
converts ANY unexpected throw into the user-visible fail-closed string with
ZERO structured logging — the only catch in the file without one. Operators
cannot distinguish a programming error from a policy stop without a
debugger.

## Current state

`src/plugin/delegate.ts:62-108` (core shape):

```ts
const cleanupProducerSession = async (
  ctx: PluginContext, producerSid: string, shouldAbort = true,
): Promise<void> => {
  try { ctx.changedFileStore.clear(producerSid); }
  catch (err) { log.warn({ event: "delegate.cleanup_failed", store: "changedFileStore.clear", sid: producerSid, error: ... }); }
  try { ctx.sessionStore.unregister(producerSid); } catch (err) { log.warn({ event: "delegate.cleanup_failed", store: "sessionStore.unregister", ... }); }
  try { ctx.guardStore.clear(producerSid); } catch (err) { log.warn({ event: "delegate.cleanup_failed", store: "guardStore.clear", ... }); }
  if (shouldAbort && producerSid) {
    try { await withTimeout(ctx.plugin.client.session.abort({ path: { id: producerSid } }), 10_000, "delegate session.abort"); }
    catch (err) { ... }
  }
};
```

`src/plugin/fanout.ts:50-108` — same three clears with
`fanout.worker_cleanup_failed`, then the conditional abort (label
`"fanout session.abort"`) whose 10s-timeout catch ADDS the sid to
`abortFailedWorkers` and logs `fanout.abort_failed`.

Inline abort checks: `delegate.ts:300-302` (the correct
`instanceof DOMException && name === "AbortError"` OR duck-type),
`fanout.ts:349-352` and `:430-433` (loose `instanceof DOMException` —
already fixed to `isAbortLikeError` by plan 047).

`delegate.ts:682-685` (outer catch, no logging):

```ts
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `[router] delegate failed (fail-closed): the delegation or verification could not complete (${reason}).`;
  }
```

**Conventions**: plugin-internal modules live beside their consumers
(`src/plugin/*`); structured events keep EXACT names (consumers grep them);
`log.warn`/`log.error` payloads carry `event`, and `error` stringified.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Characterization | `pnpm test -- test/unit/plugin-delegate.test.ts test/unit/plugin-fanout.test.ts` | all pass BEFORE refactor |
| Full | `pnpm test` | no NEW failures vs post-046 baseline |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `src/plugin/session-teardown.ts` (create)
- `src/plugin/delegate.ts`, `src/plugin/fanout.ts` (refactor to the shared module)
- `test/unit/session-teardown.test.ts` (create)
- `test/unit/plugin-delegate.test.ts` (new unexpected-error-log test)

**Out of scope**:
- Any behavior change to teardown semantics (abort-on-failure-only, no
  session.delete, 10s timeout, fail-soft stores) — this is a pure
  consolidation; the ONLY behavior delta is the added log line in the
  outer catch
- `src/verify/dispatch.ts` event-emission duplication (separate concern,
  deferred with cycle-2 notes)
- The reasoning-ownership finally block in delegate (`:655-681`)

## Git workflow

- Branch: `advisor/056-shared-teardown`
- Commits: `test(teardown): cover the shared session-teardown module (RED)`,
  `refactor(plugin): extract shared session teardown helpers`,
  `fix(delegate): log unexpected errors in the fail-closed outer catch`.

## Steps

### Step 0: Characterization baseline

Run both delegate and fanout suites; record the pass counts. Every subsequent
step must keep them green.

### Step 1 (RED): the shared module's tests

Create `test/unit/session-teardown.test.ts` with a minimal mock ctx (the
three stores throwing/succeeding on demand; `plugin.client.session.abort`
mock). Test the module's exported API:

```ts
// src/plugin/session-teardown.ts — target shape
export const clearSessionStores = (ctx: PluginContext, sid: string, eventPrefix: "delegate" | "fanout.worker"): Promise<void>;
// three fail-soft clears, log.warn events exactly:
//   `${eventPrefix}.cleanup_failed` — wait: event names must stay EXACT:
//   delegate path -> "delegate.cleanup_failed"; fanout path -> "fanout.worker_cleanup_failed".
//   Accept the FULL event string per call site instead of a prefix:
export const clearSessionStores = (ctx: PluginContext, sid: string, event: "delegate.cleanup_failed" | "fanout.worker_cleanup_failed"): Promise<void>;
export const abortSessionWithTimeout = (ctx: PluginContext, sid: string, label: string, timeoutMs = 10_000): Promise<void>;
// rejects on timeout/abort failure (callers keep their abortFailedWorkers logic)
export { isAbortLikeError } from "../utils/error-classify"; // single re-export point
```

Cases: each store throwing still clears the others; warn events fire with
the exact event string; abort success resolves; abort timeout rejects.
Run → FAIL (module doesn't exist).

### Step 2 (GREEN): implement the module; refactor both consumers

Implement `session-teardown.ts`. Then:
- `cleanupProducerSession` delegates to `clearSessionStores(ctx, sid,
  "delegate.cleanup_failed")` + `abortSessionWithTimeout(ctx, sid,
  "delegate session.abort")` behind the `shouldAbort` flag.
- `cleanupWorkerSession` likewise with `"fanout.worker_cleanup_failed"` and
  label `"fanout session.abort"`, KEEPING its abortFailedWorkers +
  `fanout.abort_failed` handling in its local catch.
- Replace delegate's remaining inline abort check (`:300-302`) with
  `isAbortLikeError` imported from the shared module.
- PRESERVE plan 055's trajectory-clear wiring if it landed (fourth store
  clear) — if 055 has NOT landed, add the trajectory clear to the shared
  module NOW as the canonical place and mark 055's fanout step done-by-056
  in the index.

Run characterization suites → identical pass counts. Full suite → no NEW failures.

### Step 3 (RED→GREEN): delegate outer-catch logging

Test: force an unexpected throw inside `executeDelegate` (e.g. mock
`ctx.getConfig` to reject with a non-config error on the FIRST call so the
outer — not inner — catch fires; or mock `buildEscalatePolicy`'s input path
via an invalid-but-passing config; pick the least invasive injection that
reaches `delegate.ts:682`). Assert: a `log.error` event
`delegate.unexpected_error` fires with the error message, AND the returned
string still matches the existing fail-closed wording (byte-for-byte).
RED → add to the catch:

```ts
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error({ event: "delegate.unexpected_error", error: reason, stack: err instanceof Error ? err.stack : undefined });
    return `[router] delegate failed (fail-closed): ...`;  // unchanged string
  }
```

GREEN. (If `log.error` does not exist in the observability surface, check
`src/utils/observability.ts` for the error-level helper — runtime.ts:198
uses `log.error`, so it exists.)

### Step 4: gates

Typecheck, full suite, lint; update index row.

## Test plan

- Step 1 module tests; Step 3 log test; characterization = existing
  delegate/fanout suites unchanged.
- Model mock-ctx construction after `test/unit/plugin-fanout.test.ts`.

## Done criteria

- [ ] `src/plugin/session-teardown.ts` exists; both consumers use it
- [ ] `grep -n "changedFileStore.clear" src/plugin/delegate.ts src/plugin/fanout.ts` returns hits ONLY inside the shared module (i.e. zero in the two consumers)
- [ ] Exact event names preserved: `grep -rn "delegate.cleanup_failed\|fanout.worker_cleanup_failed"` still matches, now emitted from one place
- [ ] `delegate.unexpected_error` test passes
- [ ] `pnpm test` no NEW failures vs post-046 baseline; typecheck/lint clean
- [ ] `plans/README.md` status row updated (note the 055 interplay)

## STOP conditions

- Characterization suites show ANY delta after the refactor — restore and
  report; a behavior change means the extraction is not pure.
- The two teardown paths resist unification because of a REAL semantic
  difference beyond abortFailedWorkers (report it; maybe the duplication
  is justified).
- Plan 047/055 rows are not DONE (sequencing).

## Maintenance notes

- Future teardown changes (new store, abort policy) land in
  `session-teardown.ts` once and both tools inherit them.
- Reviewers: diff the deleted inline blocks against the new module — the
  only acceptable diffs are the event-string parameterization and the
  abortFailedWorkers hook.
