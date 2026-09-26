# Plan 047: Fix fanout admission-abort slot leak, batch-timeout semantics, and error classification

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on.
> Honor STOP conditions. Update your row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/plugin/fanout.ts src/plugin/fanout-store.ts src/utils/timeout.ts src/utils/error-classify.ts test/unit/plugin-fanout.test.ts`
> On any change, compare "Current state" excerpts against live code; on a
> mismatch, STOP.
>
> **Strict TDD**: This plan changes behavior — every work unit starts with a
> failing test, confirmed RED for the *specified* reason, then the minimum
> implementation, then GREEN. Refactor only while green.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: MED (changes two observable return paths of the fanout tool)
- **Depends on**: plans/046-restore-verification-baseline.md
- **Category**: bug
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

Three defects in the newest feature (plans 044/045, fanout tool):

1. **Permanent slot leak**: if the caller's AbortSignal fires between config
   load and worker start, `executeFanout` returns `""` while every acquired
   fanout slot is still held. `configure()` never resets counters, so
   repeated aborts permanently exhaust `maxConcurrentGlobal` — and if the
   leaked slot was the half-open breaker probe, the breaker is bricked
   forever (`activeGlobal > 0` blocks all future probes).
2. **`batchTimeoutMs` is decorative**: on batch timeout the code sets a
   flag that is never read, then unconditionally awaits ALL workers anyway —
   a "timed-out" batch still blocks up to `workerTimeoutMs` per worker.
   Mid-batch caller abort is mislabeled as timeout and returns an aggregate
   instead of the documented silent `""`.
3. **Misclassification defeats the circuit breaker**: `withTimeout` throws a
   plain `Error("... timed out after Nms")` on timeout but a
   `DOMException("aborted","AbortError")` on abort. The fanout catches test
   only `instanceof DOMException` (any DOMException!) and never detect
   create-path timeouts, so a systemic SDK hang at `session.create` is
   classified `failed` — a *streak-resetting* outcome. The breaker never
   opens exactly when it should protect.

## Current state

Files (roles):
- `src/plugin/fanout.ts` (580 LOC) — the fanout executor
- `src/plugin/fanout-store.ts` (278 LOC) — slot counters + breaker FSM
- `src/utils/timeout.ts` — `withTimeout` helper
- `src/utils/error-classify.ts` — canonical `isAbortLikeError` (line ~114; delegate already consumes it via `classifyPromptError`)
- `test/unit/plugin-fanout.test.ts` + `test/unit/plugin-fanout-store.test.ts` — existing harnesses to extend

**Leak path** (`fanout.ts:248-278` acquisition, `:303-305` return):

```ts
// fanout.ts:267-277 — inside args.items.map(...)
    // Try to acquire fanout slot
    const acquire = ctx.fanoutStore.tryAcquire(item.tier);
    if (!acquire.ok) { /* per-item rejection */ }
    return { item, slotAcquired: true as const, policyRejected: false as const };
```

```ts
// fanout.ts:300-305 — AFTER the map, before worker promises are built
  if (signal?.aborted) {
    return "";            // <- every slotAcquired:true slot leaks here
  }
```

Nothing between the `await ctx.getFreshConfig()` at `fanout.ts:169` and this
return decrements counters; `release()` is only called in the per-worker
`finally` (`fanout.ts:469-472`) for workers that actually start.
`fanout-store.ts:136-141` (`configure`) resets only caps/thresholds, never
`activeGlobal`/`activeByTier`. `fanout-store.ts:181` rejects all half-open
probes while `activeGlobal > 0`.

**Batch-timeout no-op** (`fanout.ts:485-502`):

```ts
  let batchTimedOut = false;
  const batchPromise = Promise.allSettled(workerPromises);
  try {
    await withTimeout(batchPromise, effectiveCfg.batchTimeoutMs, "fanout batch", signal);
  } catch {
    batchTimedOut = true;
  }
  if (batchTimedOut) {
    // On batch timeout, we return what we have. ...
    void workerPromises;                      // <- dead statement
  }
  const rawResults = await batchPromise;      // <- unconditional full wait
```

The doc comment at `fanout.ts:160-161` promises: caller abort → `""`
silently. `Promise.allSettled` never rejects, so the `withTimeout` rejection
at `:490` can only be timeout (plain `Error`) or abort (`DOMException`) —
both currently fall into the same dead-flag path. There is a second
pre-race abort check at `:481-483` (fine to keep).

**Classification** (`timeout.ts:27-28,37,40`):

```ts
  if (signal?.aborted) { throw new DOMException("aborted", "AbortError"); }
  ...
  timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  ...
  abortListener = () => reject(new DOMException("aborted", "AbortError"));
```

Create-path catch (`fanout.ts:348-365`) — any `DOMException` counts as
cancelled; timeouts fall through to `status: "failed"`:

```ts
      } catch (err) {
        if (
          err instanceof DOMException ||
          (err !== null && typeof err === "object" && "name" in err && err.name === "AbortError")
        ) {
          return { ..., status: "cancelled", reason: "session.create aborted" };
        }
        return { ..., status: "failed", reason: `session.create threw: ...` };
      }
```

The prompt-path catch at `fanout.ts:430-433` has the same loose
`instanceof DOMException`; it DOES handle timeouts at `:442`
(`err.message.includes("timed out")` → `status: "timed_out"`, the qualifying
kind). Breaker semantics (`fanout-store.ts:213-263`): `timed_out` /
`abort_failed` increment the streak; `failed` RESETS it (and closes
half-open). So create-hangs resetting the streak is exactly wrong.

`delegate.ts:300-302` shows the correct abort pattern
(`instanceof DOMException && err.name === "AbortError"` or duck-typed name),
and `classifyPromptError` (`utils/error-classify.ts`, consumed at
`delegate.ts:466`) is the canonical classifier.

**Conventions to match**: structured `log.*` events with `event:` names
(`fanout.*` prefix); per-worker `try/finally` release style
(`releaseFanoutSlot`, `fanout.ts:115-125`); tests mock `ctx.plugin.client`
(see existing tests in `test/unit/plugin-fanout.test.ts`).

## Commands you will need

| Purpose   | Command                                        | Expected |
|-----------|------------------------------------------------|----------|
| Typecheck | `pnpm run typecheck`                           | exit 0   |
| Fanout tests | `pnpm test -- test/unit/plugin-fanout.test.ts test/unit/plugin-fanout-store.test.ts` | all pass |
| Full suite| `pnpm test` (post-046 baseline)                | no NEW failures vs baseline |
| Lint      | `pnpm run lint`                                | exit 0   |

## Scope

**In scope**:
- `src/plugin/fanout.ts`
- `test/unit/plugin-fanout.test.ts`

**Out of scope**:
- `src/plugin/fanout-store.ts` — store semantics are correct; only its
  callers misuse it (if you believe the store must change, STOP)
- `src/utils/timeout.ts`, `src/utils/error-classify.ts` — read-only imports
- `src/plugin/delegate.ts` — plan 056 handles its cleanup/logging
- `session.abort`-on-success policy and the `session.delete is NEVER called` rule (plan 044 binding rule) — preserve both

## Git workflow

- Branch: `advisor/047-fanout-correctness`
- Commits: `test(fanout): pin admission-abort slot release (RED)`, `fix(fanout): release slots on admission-abort return`, etc. — keep RED commits separate from GREEN commits so reviewers can see TDD provenance.

## Steps

### Work Unit 1 — admission-abort slot leak (strict TDD)

**Step 1.1 (RED)**: Add a test: configure the store with
`maxConcurrentGlobal: 1`; caller is valid depth-1 medium; ONE valid item;
`signal` already aborted (or aborts during `getFreshConfig` — simplest:
pass a pre-aborted `AbortSignal` to `executeFanout`). Assert:
`executeFanout` returns `""` AND a SECOND batch (same store, fresh signal)
is admitted (not rejected `global_cap` / `circuit_open`) — proving counters
returned to zero.

Run: `pnpm test -- test/unit/plugin-fanout.test.ts` → new test FAILS with
the second batch rejected (leak present).

**Step 1.2 (GREEN)**: In `executeFanout`:
1. Hoist an `if (signal?.aborted) return "";` check to immediately BEFORE
   the per-item acquisition map (after the batch-cap check at
   `fanout.ts:231-242`, before `:248`).
2. Belt-and-braces: in the existing `:303-305` abort return, first release
   every `itemResults` entry with `slotAcquired === true` via
   `releaseFanoutSlot(ctx, item.tier)`.

Run the fanout tests → GREEN. Full `pnpm test` → no NEW failures.

### Work Unit 2 — batch timeout returns settled-so-far; abort returns "" (strict TDD)

**Step 2.1 (RED)**: Two tests:
- **Timeout partials**: two workers; worker A's `session.prompt` resolves
  quickly, worker B's hangs (mock never resolves); `batchTimeoutMs` small
  (e.g. 50ms via `configure`). Assert: `executeFanout` RESOLVES with a
  markdown aggregate containing A's `status=completed`, B reported as
  `status=timed_out` (batch deadline), and — critically — resolution happens
  WITHOUT waiting for B (assert the returned promise settles while B is
  still pending; afterwards, let B's mock reject to avoid dangling handles).
- **Mid-batch abort → ""**: worker A hanging; abort the signal after batch
  start. Assert return value is exactly `""`.

Run → both FAIL (current code awaits everything / returns aggregate).

**Step 2.2 (GREEN)**: Replace `fanout.ts:485-502` with incremental settle
tracking:

```ts
// Record settlements as they happen so a batch deadline can aggregate
// settled-so-far instead of blocking on every worker.
const settled: Array<PromiseSettledResult<FanoutItemResult>> = new Array(workerPromises.length);
let settledCount = 0;
workerPromises.forEach((p, i) => {
  void p.then(
    (v) => { settled[i] = { status: "fulfilled", value: v }; settledCount++; },
    (r) => { settled[i] = { status: "rejected", reason: r }; settledCount++; },
  );
});

let batchDeadlineExceeded = false;
try {
  await withTimeout(batchPromise, effectiveCfg.batchTimeoutMs, "fanout batch", signal);
} catch (err) {
  if (isAbortLikeError(err)) return "";        // caller cancelled — silent, documented contract
  batchDeadlineExceeded = true;                // timeout (or unexpected) — aggregate below
}

const rawResults: Array<PromiseSettledResult<FanoutItemResult>> = batchDeadlineExceeded
  ? settled.map((s, i) => s ?? { status: "fulfilled" as const, value: {
        index: i, tier: args.items[i]?.tier ?? "unknown",
        status: "timed_out" as const, reason: "batch deadline exceeded" } })
  : ((await batchPromise) as Array<PromiseSettledResult<FanoutItemResult>>);
```

Import `isAbortLikeError` from `../utils/error-classify` (verify the exact
export name at drift check; it is the function used by
`classifyPromptError`). Keep the downstream aggregation
(`rawResults.map(...)` at `:503-513`) unchanged. In-flight workers still
self-release slots via their own `finally` — PRESERVE that property (do not
add any wait-for-stragglers).

Delete the dead `if (batchTimedOut) { void workerPromises; }` block and the
`batchTimedOut` variable entirely.

Run fanout tests → GREEN. Also update any existing test that pinned the old
always-wait behavior — if an existing test legitimately pinned "timeout
still returns full aggregate", change it to the new contract and say so in
the commit message.

### Work Unit 3 — correct abort/timeout classification (strict TDD)

**Step 3.1 (RED)**: Three tests:
- `session.create` mock rejects with `Error("fanout session.create timed out
  after 30000ms")` (the exact error `withTimeout` throws) → expect item
  `status: "timed_out"` and, for a batch of only that item,
  `recordOutcome("timed_out")` observable via the store's breaker reaching
  `open` after `failureThreshold` such batches (default 3).
- `session.create` mock rejects with a `DOMException("…", "TimeoutError")`
  (name ≠ AbortError) → expect `status: "failed"`, NOT `cancelled`.
- `session.prompt` mock rejects with `DOMException("…", "TypeError")` →
  expect `failed`/`timed_out` classification per message, NOT `cancelled`.

Run → FAIL (current code: create-timeout → `failed`; any DOMException →
`cancelled`).

**Step 3.2 (GREEN)**: In `fanout.ts`:
- Replace BOTH inline checks (`:349-352` create catch, `:430-433` prompt
  catch) with `isAbortLikeError(err)`.
- In the create catch, add the same timeout detection the prompt catch uses:
  `err instanceof Error && err.message.includes("timed out")` →
  `status: "timed_out"` with reason `"session.create timed out"`.
- Keep all existing reason-string prefixes stable where tests assert them;
  new reasons may be added.

Run → GREEN; full suite → no NEW failures.

### Step 4: Full verification

`pnpm run typecheck` → 0. `pnpm test` → matches post-046 baseline exactly.
`pnpm run lint` → 0.

## Test plan

- All new tests in `test/unit/plugin-fanout.test.ts`, modeled after its
  existing mocked-`ctx` harness (mock `ctx.plugin.client.session.*`,
  `ctx.fanoutStore` real instance via `createFanoutStore()`).
- Cases (summary): admission-abort releases slots (WU1); batch deadline
  returns partial aggregate without waiting (WU2); mid-batch abort returns
  "" (WU2); create-timeout → timed_out + breaker trips (WU3); non-abort
  DOMException not cancelled (WU3); pre-existing green cases unchanged.
- Verification: `pnpm test -- test/unit/plugin-fanout.test.ts` → all pass.

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` shows no NEW failures vs the post-046 baseline
- [ ] New tests for all three work units exist and pass
- [ ] `grep -n "batchTimedOut" src/plugin/fanout.ts` returns nothing
- [ ] `grep -n "instanceof DOMException" src/plugin/fanout.ts` returns nothing
- [ ] `grep -n "isAbortLikeError" src/plugin/fanout.ts` returns ≥1 import/use
- [ ] No files outside in-scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The fanout excerpts above do not match live code (drift).
- You find yourself editing `src/plugin/fanout-store.ts` — the plan asserts
  the store is correct; a needed store change means the analysis was wrong.
- An existing test pins the OLD batch-timeout behavior in a way that is
  semantically load-bearing (not just snapshot-of-implementation) — report
  the conflict instead of rewriting it silently.
- `isAbortLikeError` is not exported from `src/utils/error-classify.ts`
  under that name (find the canonical export, propose the import, but if it
  does not exist at all — STOP).

## Maintenance notes

- Plan 056 (shared teardown helpers) refactors this file next — land 047
  first, sequence 056 after.
- Reviewers: the two behavior changes observable to callers are (a) batch
  deadline now actually bounds the call, (b) abort returns "" mid-batch.
  Both are the documented contract (`fanout.ts:149-161` doc comment);
  reviewers should confirm the doc comment and behavior now agree.
- The breaker-brick scenario (leaked half-open probe) is worth a line in
  `docs/ENFORCEMENT_PRESETS.md` if it documents fanout breaker recovery.
