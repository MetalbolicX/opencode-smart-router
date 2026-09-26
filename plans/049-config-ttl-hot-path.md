# Plan 049: Route the system-prompt transform through the TTL cache instead of a forced disk read per message

> **Executor instructions**: Follow step by step; verify each gate. Honor
> STOP conditions. Update your row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/plugin/hooks/system-config.ts src/plugin/context.ts src/router/config-store.ts test/unit/get-fresh-config.test.ts test/unit/plugin-hooks.test.ts`
> On any change, compare excerpts; on mismatch, STOP.
>
> **Strict TDD**: behavior change is test-first.

## Status

- **Priority**: P1 (perf, hottest path in the plugin)
- **Effort**: S
- **Risk**: LOW–MED (hand-edited `tiers.json` propagates up to 5 min late on
  this one path; command-driven changes stay immediate — see analysis)
- **Depends on**: plans/046-restore-verification-baseline.md
- **Category**: perf
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`handleSystemTransform` runs on EVERY orchestrator system-prompt assembly.
It calls `ctx.getFreshConfig()` — which ALWAYS re-reads and re-merges all
config layers (bundled/global/local `tiers.json` + state overlay) from disk —
and it does so BEFORE the subagent early-return, so subagent sessions pay
the full multi-file read and then discard the result. The 5-minute TTL cache
that exists precisely for this never serves the hottest message-level path.
This is a known finding first recorded in audit cycle 2 (2026-07-01,
"Config cache TTL bypass on the hot path") and explicitly deferred until the
verification baseline was trustworthy (plan 011, now DONE). Its precondition
is met; the hooks-split moved the line but did not fix it.

## Current state

`src/plugin/hooks/system-config.ts:27-57` (verbatim core):

```ts
export const handleSystemTransform = async (
  ctx: PluginContext,
  _input: HookPayload,
  output: HookPayload,
): Promise<void> => {
  if (ctx.state.bypassed) return;
  // getFreshConfig() returns the refreshed config and falls back to the
  // cached value if the file read fails.
  const cfg = await ctx.getFreshConfig();          // <- forced disk read

  // Skip injection for child (subagent) sessions.
  const sessionID = _input?.sessionID as string | undefined;
  if (sessionID && ctx.sessionStore.isSubagent(sessionID)) return;   // <- AFTER the read
  ...
  enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
  (output.system as string[]).push(assembleSystemPrompt(cfg, orchestratorModel, enfOn));
```

`src/plugin/context.ts:175-187`:

```ts
    async getConfig(): Promise<RouterConfig> {
      return configStore.read();                    // TTL-aware
    },
    async refreshConfig(): Promise<RouterConfig> {
      return configStore.refresh();
    },
    async getFreshConfig(this: PluginContext): Promise<RouterConfig> {
      try {
        return await this.refreshConfig();          // ALWAYS disk
      } catch {
        return await this.getConfig();
      }
    },
```

`src/router/config-store.ts:154-161` — `refresh()`/`getFresh()` both call
`load()` unconditionally (only `read()` at `:122-148` is TTL-aware).
`DEFAULT_CONFIG_TTL_MS = 5 * 60 * 1000` (`config-store.ts:46`).

Freshness analysis (why LOW–MED risk): command-driven config changes
(`/preset`, router commands) call `getFresh()`/`refresh()` themselves, which
REPLACE the cache — immediate for the next message. Only direct hand-edits
of `tiers.json` on disk now propagate on the TTL boundary (≤5 min) instead
of instantly on the next message. The config-store header (`:43-45`)
documents the TTL as exactly this tradeoff.

**Deliberately out of this plan**: `src/plugin/fanout.ts:169` also calls
`ctx.getFreshConfig()` — KEEP it. Fanout is a containment boundary running
at most once per batch (not per message); reading fresh config there is
correct kill-switch hygiene.

**Conventions**: hook handlers take `(ctx, input, output)`; spy-based tests
exist in `test/unit/get-fresh-config.test.ts` (context surface) and
`test/unit/plugin-hooks.test.ts` (transform surface — per codegraph blast
radius, it covers `handleSystemTransform`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Targeted | `pnpm test -- test/unit/get-fresh-config.test.ts test/unit/plugin-hooks.test.ts` | all pass |
| Full | `pnpm test` | no NEW failures vs post-046 baseline |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `src/plugin/hooks/system-config.ts`
- `test/unit/plugin-hooks.test.ts` (or a new `test/unit/system-config.test.ts` if the transform cases live elsewhere — check where existing handleSystemTransform tests are before adding)

**Out of scope**:
- `src/plugin/context.ts`, `src/router/config-store.ts` — no store changes
- `src/plugin/fanout.ts:169` — stays `getFreshConfig` (documented above)
- Any enforcement/protocol behavior

## Git workflow

- Branch: `advisor/049-config-ttl-hot-path`
- Commits: `test(hooks): pin cached-config read on system transform (RED)` then `perf(hooks): serve system transform from TTL cache; skip subagent read`.

## Steps

### Step 1 (RED): pin the cached read

Add two tests where the existing transform tests live:

1. **Subagent short-circuit**: `_input.sessionID` registered as a subagent
   (via the harness's sessionStore); spies on `ctx.getConfig` and
   `ctx.getFreshConfig`. Assert NEITHER is called (today `getFreshConfig`
   IS called → RED).
2. **Orchestrator path**: unregistered session; spies assert `getConfig`
   called exactly once and `getFreshConfig` NEVER called; the system prompt
   is still appended (existing assertions cover content).

Run → both FAIL (current code calls `getFreshConfig` before the guard).

### Step 2 (GREEN): reorder + swap

In `handleSystemTransform`:
1. Move the `sessionID`/`isSubagent` early-return ABOVE any config access.
2. Replace `const cfg = await ctx.getFreshConfig();` with
   `const cfg = await ctx.getConfig();`
3. Update the adjacent comment to state the TTL contract:
   "Config comes from the TTL cache (≤5 min staleness for hand-edits);
   command-driven changes replace the cache immediately."

Run targeted → GREEN. Run full suite → no NEW failures (in particular
`test/integration/config-async.test.ts` and the golden prompt tests).

### Step 3: verify + close

`pnpm run typecheck`, `pnpm run lint` → 0. Update `plans/README.md` row.

## Test plan

- The two Step-1 tests, modeled on the spy patterns already present in
  `test/unit/get-fresh-config.test.ts` (vi.spyOn on context methods).
- No new fixtures needed.

## Done criteria

- [ ] `pnpm run typecheck` exits 0
- [ ] New tests pass; `pnpm test` no NEW failures vs post-046 baseline
- [ ] `grep -n "getFreshConfig" src/plugin/hooks/system-config.ts` returns nothing
- [ ] `grep -n "getFreshConfig" src/plugin/fanout.ts` still returns the line 169 call (unchanged, by design)
- [ ] No files outside in-scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- The excerpt doesn't match (drift).
- Any test legitimately requires per-message fresh config on the transform
  path (e.g. a documented contract that hand-edited tiers.json appears in
  the very next message) — report; that is a product decision, not a bug.
- Moving the early-return changes behavior for sessions whose sessionID is
  missing/undefined (the guard requires a truthy sessionID — keep exactly
  `if (sessionID && ...)` semantics).

## Maintenance notes

- If operators report "my tiers.json edit didn't apply", the TTL is the
  first suspect; `/preset`-style commands bypass it by design.
- Plan 051 (load serialization) touches the same store; orthogonal changes,
  any order after this plan.
