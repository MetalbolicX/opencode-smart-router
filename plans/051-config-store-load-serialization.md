# Plan 051: Serialize config-store loads — in-flight dedup + generation guard

> **Executor instructions**: Follow step by step; verify each gate. Honor
> STOP conditions. Update your row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/router/config-store.ts test/unit/config-store.test.ts test/unit/config-store-ttl.test.ts`
> On any change, compare excerpts; on mismatch, STOP.
>
> **Strict TDD**: behavior change is test-first, using an injected load seam
> for deterministic concurrency (the repo's established seam pattern — see
> `src/verify/types.ts` FsSeam/ExecSeam precedent).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (dedup collapses redundant reads; force paths keep semantics)
- **Depends on**: plans/046-restore-verification-baseline.md (baseline
  trustworthy; this file's tests were also touched by 046's flake fix —
  rebase carefully)
- **Category**: bug
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`createConfigStore.load()` unconditionally assigns
`cached = { value, loadedAt: Date.now() }` after its await, with no
in-flight dedup and no sequencing. Three concurrent entry points exist
(`read()` ttl-auto, `refresh()`, `getFresh()`), and the store header
documents a background TTL driver running concurrently with user-facing
commands. Two failure modes:

1. **Last-writer-wins race**: two overlapping loads where the earlier-started
   finishes last leave the cache holding the OLDER config with a FRESH
   `loadedAt` — a model switch, guard change, or `fanout.enabled` kill
   switch on disk is then silently ignored for up to 5 minutes despite the
   operator having "just changed it".
2. **Load stampede**: at every TTL boundary, each stale reader fires its own
   `readMergedConfig` (3-file disk read + merge + validate).

## Current state

`src/router/config-store.ts:98-174` (verbatim core):

```ts
export const createConfigStore = (opts: { cwd: string; ttlMs?: number }): ConfigStore => {
  const ttlMs = opts.ttlMs ?? DEFAULT_CONFIG_TTL_MS;
  let cached: CachedConfig | null = null;

  const load = async (reason?: string): Promise<CachedConfig> => {
    const value = await readMergedConfig({ cwd: opts.cwd });
    cached = { value, loadedAt: Date.now() };        // <- unconditional assignment
    ...
    return cached;
  };
  ...
  return {
    async read() { return readWithStaleness(); },     // -> load("ttl-auto") when stale
    async refresh(reason?) { const fresh = await load(reason); return fresh.value; },
    async getFresh() { const fresh = await load("getFresh"); return fresh.value; },
    invalidate(): void { cached = null; },            // <- in-flight load can repopulate after this
    ...
```

`readWithStaleness` (`:122-148`) serves `cached.value` when fresh, loads on
stale, fail-serves last-known-good on load error. There is no
`inflight`/`pending` anywhere in the file.

Callers: 6 call sites of `createConfigStore` per `src/plugin/context.ts`
(one per PluginContext). Concurrent use documented in the ConfigStore
interface comment (`:71-77`: background TTL driver vs user commands).

**Conventions**: stores are closure-factory modules with an interface +
implementation split (see `FanoutStore` in `fanout-store.ts`); tests in
`test/unit/config-store.test.ts` ("direct pure-store coverage" describe
block) use real temp dirs — for THIS plan use an injected seam instead
(deterministic), following the deps-seam style of `src/verify/types.ts`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Targeted | `pnpm test -- test/unit/config-store.test.ts test/unit/config-store-ttl.test.ts test/integration/config-async.test.ts` | all pass |
| Full | `pnpm test` | no NEW failures vs post-046 baseline |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `src/router/config-store.ts`
- `test/unit/config-store.test.ts`

**Out of scope**:
- `src/router/config-loader.ts` (`readMergedConfig`) — imported as-is
- `src/plugin/context.ts` — no caller changes
- TTL values, fail-soft semantics, log payload shape (`ConfigRefreshLog`)

## Git workflow

- Branch: `advisor/051-config-store-serialization`
- Commits: `test(config-store): pin in-flight dedup + invalidate generation (RED)`, `fix(config-store): dedup concurrent loads; guard assignment by generation`.

## Steps

### Step 1 (RED): seam + failing tests

Extend `createConfigStore` opts with an internal, test-only seam (documented
as such): `loadImpl?: (opts: { cwd: string }) => Promise<RouterConfig>`
defaulting to `readMergedConfig`. Then add tests with deferred promises:

1. **Dedup**: `loadImpl` returns a controllable deferred. Call
   `store.refresh("a")` and `store.getFresh()` concurrently. Resolve the
   deferred once. Assert `loadImpl` was called EXACTLY ONCE and both
   callers receive the SAME value.
2. **Invalidate wins over in-flight load**: start `refresh()` (deferred
   pending), call `invalidate()`, then resolve the deferred. Assert
   `loadedAtMs()` returns `null` (cache empty — the stale completion must
   NOT repopulate) and `isStale()` is `true`.
3. **Out-of-order safety (generation guard)**: with dedup, two public loads
   coalesce — the out-of-order hazard moves to "load started, invalidate,
   load completes". Test 2 covers it via the generation guard.

Run → tests 1 and 2 FAIL (no dedup; invalidate repopulated).

### Step 2 (GREEN): implement

Inside `createConfigStore`:

```ts
let inflight: Promise<CachedConfig> | null = null;
let generation = 0;   // bumped by invalidate(); completions from an older generation never write

const load = async (reason?: string): Promise<CachedConfig> => {
  if (inflight) return inflight;
  const myGeneration = generation;
  inflight = (async () => {
    const value = await (opts.loadImpl ?? readMergedConfig)({ cwd: opts.cwd });
    if (myGeneration === generation) {
      cached = { value, loadedAt: Date.now() };
      logConfigRefresh({ ... });      // keep payload shape; log only on the write path
    }
    return cached ?? { value, loadedAt: Date.now() };
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
};
```

And `invalidate(): void { generation += 1; cached = null; inflight = null; }`
(detaching `inflight` is safe: awaiting callers already hold the promise;
its completion simply won't write).

Preserve: `readWithStaleness` logic, fail-soft path, `ConfigRefreshLog`
fields, and the exact `reason` strings ("initial", "ttl-auto", "getFresh",
caller-supplied). One nuance to keep honest: with dedup, a `refresh("command")`
that piggybacks on an in-flight `ttl-auto` load logs under whichever reason
STARTED the load — acceptable, note it in a code comment.

Run targeted → GREEN. Run the full suite (especially
`test/integration/config-async.test.ts`) → no NEW failures.

### Step 3: gates

`pnpm run typecheck`, `pnpm run lint` → 0. Update `plans/README.md`.

## Test plan

- The two Step-1 tests (dedup; invalidate-generation), plus keep every
  existing config-store / config-store-ttl test green (they exercise the
  default `readMergedConfig` path via real temp dirs).
- Model the deferred-promise harness after any existing async test in
  `test/unit/config-store-ttl.test.ts` (fake timers / controllable fs).

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] New dedup + invalidate-generation tests pass
- [ ] `pnpm test` no NEW failures vs post-046 baseline
- [ ] `grep -cn "readMergedConfig" src/router/config-store.ts` still ≥1 (default seam)
- [ ] No files outside in-scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The excerpt doesn't match (drift), or plan 046's flake fix changed this
  test file in a way that conflicts (report the conflict; do not re-litigate 046).
- Dedup would change any behavior asserted by
  `test/integration/config-async.test.ts` (e.g. it counts disk reads) —
  report the specific assertion.
- You are tempted to cache-by-value or add TTL logic changes — out of scope.

## Maintenance notes

- The seam (`loadImpl`) is test-only surface; do not wire it into
  production callers.
- If a future feature needs per-layer loads, the generation guard must move
  with the cache-assignment code — single place, keep it there.
