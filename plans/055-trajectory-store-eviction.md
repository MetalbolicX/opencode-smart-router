# Plan 055: Add TrajectoryStore eviction — clear() API, teardown wiring, LRU backstop

> **Executor instructions**: follow step by step; strict TDD. Honor STOP
> conditions. Update your row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/telemetry/trajectory.ts src/plugin/fanout.ts src/plugin/hooks/session.ts test/unit/`
> On any change beyond plan 047's (same fanout file), compare excerpts;
> on mismatch, STOP. Execute AFTER plan 047 (fanout churn).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (worst case: a scorecard is cleared just before an opt-in
  debug dump)
- **Depends on**: plans/046, plans/047 (fanout cleanup wiring lands on top
  of 047's refactor)
- **Category**: perf / bug
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`createTrajectoryStore` returns `{ ensure, get, recordToolEvent,
setStopReason, dump }` — there is NO delete/clear/eviction. `recordToolEvent`
auto-creates a ~25-field `TrajectoryState` for every session that fires one
tool call (wired from the per-tool-call hooks), including transient fanout
workers and subagents. The Map grows monotonically for the lifetime of the
opencode process; fanout's cleanup clears sibling stores
(`changedFileStore`, `sessionStore`, `guardStore` — `fanout.ts:56-85`) but
CANNOT clear trajectory state because no method exists to call. Long-lived
processes pay unbounded memory; uncleared scorecards for sessions whose
opt-in `dump` never fires are pure dead weight.

## Current state

`src/telemetry/trajectory.ts:131-169` (verbatim — the complete factory):

```ts
export const createTrajectoryStore = () => {
  const store = new Map<string, TrajectoryState>();
  const ensureState = (sessionID: string, tier?: string | null): TrajectoryState => {
    let s = store.get(sessionID);
    if (!s) { s = createTrajectory(sessionID, tier); store.set(sessionID, s); }
    return s;
  };
  return {
    ensure(sessionID, tier) { return ensureState(sessionID, tier); },
    get(sessionID) { return store.get(sessionID); },
    recordToolEvent(sessionID, event) { const s = ensureState(sessionID); recordToolEvent(s, event); },
    setStopReason(sessionID, reason) { const s = store.get(sessionID); if (!s) return; setStopReason(s, reason); },
    dump(sessionID) { const s = store.get(sessionID); if (!s) return null; return dumpTrajectory(s); },
  };
};
```

`src/plugin/fanout.ts:56-85` — `cleanupWorkerSession` clears three stores
per worker (changedFileStore/sessionStore/guardStore) but not trajectory.
`src/plugin/context.ts:222` — `trajectoryStore: createTrajectoryStore()` on
the PluginContext. Wiring sites for natural session end: search
`src/plugin/hooks/session.ts` for the session-idle/end handler (runtime.ts
maps `event:` → `handleSessionIdle`) — locate where sessions are cleaned up
on idle and mirror the clear there.

**Conventions**: store factories are closures with typed returns
(`createFanoutStore`, `createSessionStore`); pure metrics helpers live
beside the state; tests for stores live in `test/unit/*-store*.test.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Targeted | `pnpm test -- test/unit/trajectory-store.test.ts test/unit/plugin-fanout.test.ts` | all pass |
| Full | `pnpm test` | no NEW failures vs post-046 baseline |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `src/telemetry/trajectory.ts`
- `src/plugin/fanout.ts` (cleanup wiring — one try/catch block)
- `src/plugin/hooks/session.ts` (idle/end wiring — one fail-soft call)
- `test/unit/trajectory-store.test.ts` (create)
- `test/unit/plugin-fanout.test.ts` (one assertion extension)

**Out of scope**:
- `src/plugin/context.ts`, `src/verify/dispatch.ts`, scorecard file writing
  (`src/utils/log.ts`), metric field shapes, the delegate producer-session
  cleanup (plan 056 unifies teardown — trajectory clear can ride there if
  056 lands first; coordinate via the index)

## Git workflow

- Branch: `advisor/055-trajectory-eviction`
- Commits: `test(telemetry): pin clear() + LRU eviction (RED)`,
  `feat(telemetry): add clear() and bounded LRU to trajectory store`,
  `fix(fanout): clear worker trajectory state on cleanup`,
  `fix(session): clear trajectory state on session idle`.

## Steps

### Step 1 (RED): store tests

Create `test/unit/trajectory-store.test.ts` (model after the direct
pure-store style in `test/unit/config-store.test.ts`). Cases:
1. `clear(sid)` after `recordToolEvent` → `get(sid)` undefined; a later
   `recordToolEvent` re-creates fresh state (counters reset to 0 → 1).
2. LRU backstop: insert `MAX + 10` distinct sessions via `ensure`;
   `store.size`-observable bound — expose size via a new `size()` accessor
   or assert via behavior: after inserting N > cap, `get(firstSid)` is
   undefined and `get(lastSid)` exists; the session being ensured is never
   the evicted one.
3. `clear` of an unknown sid is a no-op (does not throw).

Cap: `MAX_SESSIONS = 256` (module constant, exported for the test).

Run → FAIL (no `clear`, no bound).

### Step 2 (GREEN): implement

Add to the factory: `clear(sessionID: string): void { store.delete(sessionID); }`;
`size(): number`; and in `ensureState`, after `store.set`, enforce the cap:
while `store.size > MAX_SESSIONS`, evict the OLDEST key (Map iteration
order = insertion) that is not `sessionID` itself.

Run → GREEN.

### Step 3 (RED→GREEN): fanout wiring

Extend the fanout cleanup test: after a worker completes, assert
`ctx.trajectoryStore.get(workerSid)` is undefined (spy or real store).
RED (no clear called) → add to `cleanupWorkerSession`, as a FOURTH
try/catch sibling of the existing three (same fail-soft + `log.warn` shape,
store name `"trajectoryStore.clear"`) → GREEN.

### Step 4 (RED→GREEN): session-idle wiring

In `src/plugin/hooks/session.ts`, find the session-idle/end handler. Add a
fail-soft `ctx.trajectoryStore.clear(sessionID)` where the session is
finalized (match the existing error-handling shape there). Test: simulate
the idle event for a tracked session; assert trajectory state cleared.
If the idle handler's harness is integration-level, an assertion in
`test/unit/plugin-hooks.test.ts` (or the existing session-hook test file)
is acceptable — find where session-idle is currently tested and extend it.

### Step 5: gates

Typecheck, targeted, full suite, lint. Update index row.

## Test plan

- Cases enumerated in Steps 1/3/4. Structural pattern: existing store tests.
- Verification: `pnpm test -- test/unit/trajectory-store.test.ts` all pass.

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `test/unit/trajectory-store.test.ts` exists, passes (clear, LRU, no-op)
- [ ] Fanout cleanup clears worker trajectory state (test-asserted)
- [ ] Session-idle clears trajectory state (test-asserted)
- [ ] `pnpm test` no NEW failures vs post-046 baseline; `pnpm run lint` clean
- [ ] `plans/README.md` status row updated

## STOP conditions

- `createTrajectoryStore` excerpt doesn't match (drift).
- Session-idle handler has no clean seam for the clear (e.g. the event
  payload lacks sessionID) — report; do not invent event plumbing.
- Plan 056 already landed and unified teardown including trajectory —
  verify via the index before starting; if so, reduce this plan to Steps
  1–2 (store API) only and note it.

## Maintenance notes

- If scorecard `dump` consumers later need post-clear reads (e.g. "dump on
  session end AFTER clear"), ordering matters — the idle wiring must dump
  before clearing; flag this in review.
- The cap (256) is a backstop, not the primary mechanism; teardown wiring
  is the real fix. Raise the cap only with evidence.
