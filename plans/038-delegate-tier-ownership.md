# Plan 038: Make the delegate path honor per-tier reasoning ownership

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c740f11..HEAD -- src/plugin/delegate.ts src/reasoning/store.ts src/plugin/hooks/tool-execute.ts test/unit/plugin-delegate.test.ts docs/REASONING.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW (skip-patch fallback is strictly safer than racing)
- **Depends on**: none (but execute BEFORE Plan 039 — both edit `src/plugin/delegate.ts`)
- **Category**: bug (concurrency)
- **Planned at**: commit `c740f11`, 2026-08-15

## Why this matters

Two independent systems mutate the same shared agent definitions
(`ctx.opencodeConfig.agent[tier]`) to apply reasoning-level patches:

1. **The hook path** (`tool.execute.before`/`after`) — acquires per-tier
   in-flight ownership via `ctx.reasoningStore.acquireTierOwner` /
   `releaseTierOwner`. This is the documented canonical coordinator
   (`src/reasoning/store.ts:9-14`).
2. **The delegate path** (`executeDelegate`) — patches the same agentDef
   per attempt with its own `tierBaselines` map and **never consults the
   store**.

When two delegate invocations run concurrently on the same tier (or a
delegate overlaps a hook patch), each snapshots its own baseline but they
write the same shared object: A patches → B patches → A finishes and
restores its baseline while B's attempt is still in flight → B runs at the
wrong reasoning level, and B's later restore can clobber A's. Since commit
`910a075` enabled reasoning bumps on more tiers, same-tier concurrency is
realistic. The fix: the delegate must acquire tier ownership before
patching, skip the patch (and log) when another owner holds the tier, and
release ownership in its outer `finally`.

## Current state

Files involved:

- `src/plugin/delegate.ts` — `executeDelegate` (line 152); per-attempt
  patch block (lines 371–399); outer baseline-restore `finally`
  (lines 629–648).
- `src/reasoning/store.ts` — `createReasoningStore` factory; the ownership
  API to reuse. Read-only for this plan (do not modify).
- `src/plugin/hooks/tool-execute.ts` — the hook-path exemplar of
  restore + release (lines 86–120). Read-only for this plan.
- `test/unit/plugin-delegate.test.ts` — delegate test suite (extend).
- `docs/REASONING.md` — documents the "Same-tier in-flight guard"
  (referenced around line 393). One-sentence update.

### Excerpt 1 — ownership API (src/reasoning/store.ts:73-98)

```ts
acquireTierOwner(tierName: string, sessionID: string): boolean {
  const current = tierOwners.get(tierName);
  if (current === undefined || current === sessionID) {
    tierOwners.set(tierName, sessionID);
    return true;
  }
  return false;
},
releaseTierOwner(tierName: string, sessionID: string): boolean {
  if (tierOwners.get(tierName) !== sessionID) return false;
  tierOwners.delete(tierName);
  return true;
},
getTierOwner(tierName: string): string | undefined {
  return tierOwners.get(tierName);
},
```

Semantics: re-acquiring with the SAME key is a no-op returning `true`
(safe across attempts of one invocation); a FOREIGN key returns `false`
and the caller MUST skip; release is owner-checked.

### Excerpt 2 — delegate per-attempt patch (src/plugin/delegate.ts:367-399)

```ts
          // Cause threading: tracks whether the current prompt attempt produced
          // a retryable error (vs a clean prompt whose result was gate-rejected).
          let promptCause: LadderVerdict["cause"];

          // Per-attempt reasoning patch — snapshot baseline once per tier, then
          // apply the reasoning-level patch for the current ladder rung.
          const agentDef =
            state.reasoningLadderLen > 0 ? ctx.opencodeConfig?.agent?.[tier] : undefined;
          if (agentDef && state.reasoningLadderLen > 0) {
            // Snapshot baseline before mutating — used by outer finally sweep.
            if (!tierBaselines.has(tier)) {
              tierBaselines.set(tier, { ...agentDef });
            }
            // Apply reasoning patch for the current level.
            const tierCfg = activeCfg.presets?.[activeCfg.activePreset]?.[tier];
            // ... (capability resolution IIFE, lines 382-394) ...
            const cap: ReasoningCapability = (() => {
              if (tierCfg) {
                return tierCfg.capability ?? inferCapability(tierCfg);
              }
              const unsafe = activeCfg.presets?.[activeCfg.activePreset]?.[tier];
              return unsafe ? inferCapability(unsafe) : { kind: "none" };
            })();
            const patch = translateAtIndex(cap, state.levelIndex);
            if (patch) {
              applyReasoningPatch(agentDef, patch);
            }
          }
```

Note what is missing: no `acquireTierOwner` anywhere in this file
(`grep -n "acquireTierOwner" src/plugin/delegate.ts` → no matches).

### Excerpt 3 — baseline declaration + outer finally (src/plugin/delegate.ts:217-220 and 629-648)

```ts
    // Per-tier baseline snapshot for reasoning patch restoration.
    // Declared INSIDE executeDelegate (function-scope) so concurrent
    // invocations never share the map (R-5 from spec).
    const tierBaselines = new Map<string, Record<string, unknown>>();
```

```ts
    } finally {
      // WU-6: baseline restore sweep — restore all patched agent defs to their
      // pre-patch baselines. Runs on every exit path (accept, give_up, throw,
      // safety-net, abort return). Best-effort: individual failures are logged
      // and do not propagate.
      for (const [tierName, baseline] of tierBaselines) {
        const def = ctx.opencodeConfig?.agent?.[tierName];
        if (def) {
          try {
            restoreAgentBaseline(def, baseline);
          } catch (e) {
            log.warn({
              event: "delegate.baseline_restore_failed",
              tier: tierName,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }
```

### Excerpt 4 — hook-path release exemplar (src/plugin/hooks/tool-execute.ts:90-108)

```ts
  if (tool === "task" && ctx.opencodeConfig?.agent) {
    try {
      const subagentType = (input?.args as Record<string, unknown> | undefined)?.subagent_type as
        | string
        | undefined;
      const agentDef = subagentType ? ctx.opencodeConfig.agent[subagentType] : undefined;
      if (subagentType && agentDef) {
        const baseline = ctx.reasoningStore.getBaseline(subagentType);
        if (baseline) {
          restoreAgentBaseline(agentDef, baseline);
        }
        // Release the per-tier in-flight ownership acquired in
        // `handleToolExecuteBefore`. ...
        if (sid) {
          ctx.reasoningStore.releaseTierOwner(subagentType, sid);
        }
      }
    } catch (err) { ... }
  }
```

Key design fact: the hook path uses the **session id** as owner key. The
delegate must use a DIFFERENT key shape so that a delegate and a hook patch
on the same tier genuinely conflict (if the delegate used the parent session
id verbatim, it would collide-or-pass incorrectly with the hook's own
acquire for that same session). It must also be unique per delegate
invocation, so two parallel delegates from one parent conflict with each
other.

### Repo conventions that apply

- Logging: structured `log.debug` / `log.warn` with an `event` key — see
  Excerpt 3 and `tool-execute.ts:114`. The event name
  `reasoning.patch_skipped_concurrent` is already documented in
  `docs/REASONING.md` (~line 393) for the hook path — reuse that exact
  event name.
- `ctx.reasoningStore` is part of `PluginContext` (used at
  `tool-execute.ts:97,107`) — no new context field needed.
- Tests: `test/unit/plugin-delegate.test.ts` builds a fake `ctx`; existing
  bump-scenario tests (circa lines 2527–3086) show how delegate runs are
  driven and asserted. Model new tests on them.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Install   | `pnpm install`                                   | exit 0              |
| Typecheck | `pnpm run typecheck`                             | exit 0, no errors   |
| Tests     | `pnpm test -- test/unit/plugin-delegate.test.ts` | all pass            |
| Full tests| `pnpm test`                                      | all pass            |
| Lint      | `pnpm run lint`                                  | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/plugin/delegate.ts` — ownership acquire/skip/release around the
  existing patch block; owner-key + owned-tier bookkeeping.
- `test/unit/plugin-delegate.test.ts` — new tests.
- `docs/REASONING.md` — one-to-three sentence update to the
  "Same-tier in-flight guard" section.

**Out of scope** (do NOT touch):

- `src/reasoning/store.ts` — the API is sufficient as-is.
- `src/plugin/hooks/tool-execute.ts` / `src/plugin/hooks/tool-guards.ts` —
  the hook path already coordinates correctly (and Plans 029/031 own
  tool-guards.ts changes).
- `src/router/agents.ts` (`applyReasoningPatch`, `restoreAgentBaseline`) —
  mechanics stay identical.
- The ladder logic (`src/escalate/ladder.ts`) — no interaction.

## Git workflow

- Branch: `advisor/038-delegate-tier-ownership`
- Commit style: conventional commits. Suggested:
  `fix(delegate): acquire per-tier reasoning ownership before patching`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add owner-key and owned-tier bookkeeping

In `executeDelegate`, next to the `tierBaselines` declaration
(Excerpt 3, line ~220), add:

```ts
    // Per-invocation ownership key for the reasoning store. Derived from the
    // FIRST producer session id so it is unique per delegate invocation and
    // deliberately distinct from any hook-path session id — a delegate and a
    // concurrent hook patch (or two parallel delegates) on the same tier must
    // genuinely conflict, and the loser skips its patch.
    let patchOwnerKey: string | null = null;
    // Tiers this invocation successfully acquired and must release in the
    // outer finally. Only tiers we PATCHED are restored (tierBaselines
    // entries); ownership tracking is kept separate because a skipped patch
    // must still never release someone else's lock.
    const ownedTiers = new Set<string>();
```

**Verify**: `pnpm run typecheck` → exit 0.

### Step 2: Acquire before patching; skip when contended

Wrap the patch block (Excerpt 2) so that it only mutates on ownership.
Target shape:

```ts
          const agentDef =
            state.reasoningLadderLen > 0 ? ctx.opencodeConfig?.agent?.[tier] : undefined;
          if (agentDef && state.reasoningLadderLen > 0) {
            patchOwnerKey ??= `delegate:${producerSid}`;
            if (!ctx.reasoningStore.acquireTierOwner(tier, patchOwnerKey)) {
              log.debug({
                event: "reasoning.patch_skipped_concurrent",
                tier,
                owner: ctx.reasoningStore.getTierOwner(tier) ?? "unknown",
              });
              // Run this attempt unpatched — mutating a tier another owner
              // holds would race their baseline. Do NOT snapshot, do NOT
              // applyReasoningPatch.
            } else {
              ownedTiers.add(tier);
              // Snapshot baseline before mutating — used by outer finally sweep.
              if (!tierBaselines.has(tier)) {
                tierBaselines.set(tier, { ...agentDef });
              }
              // ... existing capability resolution + translateAtIndex +
              // applyReasoningPatch, unchanged ...
            }
          }
```

Keep the capability-resolution IIFE and `translateAtIndex`/
`applyReasoningPatch` code exactly as they are — they just move inside the
`else`. `producerSid` is already in scope at this point (extracted at
line ~293, before this block). Note `??=` fixes the key on the first patch
of the invocation and keeps it stable across attempts/tiers.

**Verify**: `pnpm run typecheck` → exit 0.
**Verify**: `grep -n "acquireTierOwner" src/plugin/delegate.ts` → 1 match.

### Step 3: Release ownership in the outer finally

In the outer `finally` (Excerpt 3), BEFORE the baseline-restore loop, add:

```ts
      for (const ownedTier of ownedTiers) {
        ctx.reasoningStore.releaseTierOwner(ownedTier, patchOwnerKey ?? "");
      }
```

(`releaseTierOwner` is owner-checked and already returns `false` on a
foreign release, so this is safe even in odd teardown orders. `patchOwnerKey`
is non-null whenever `ownedTiers` is non-empty; the `?? ""` is only for the
type system.) The existing baseline-restore loop stays unchanged — it now
only ever contains tiers this invocation actually patched.

**Verify**: `pnpm run typecheck` → exit 0.
**Verify**: `grep -n "releaseTierOwner" src/plugin/delegate.ts` → 1 match.

### Step 4: Tests

Extend `test/unit/plugin-delegate.test.ts`. Use the existing bump-scenario
tests in that file as the structural pattern for driving `executeDelegate`
with a fake `ctx`. Ensure the fake `ctx` exposes a REAL
`createReasoningStore()` instance (import from `src/reasoning/store.ts`;
other test files such as `test/unit/plugin-hooks.test.ts` already do this).
Add cases:

1. **Patch applied + ownership released**: run one delegate that reaches the
   patch block on a ladder tier; assert during the run (or via a spy on
   `applyReasoningPatch`'s effect — the agentDef was mutated) and after
   completion assert `ctx.reasoningStore.getTierOwner(tier) === undefined`
   and the agentDef was restored to baseline.
2. **Contended tier skips patch**: pre-acquire the tier with a foreign key
   (`ctx.reasoningStore.acquireTierOwner(tier, "hook-session-x")`) before
   invoking executeDelegate; assert the delegate completes without throwing,
   the agentDef was NOT mutated by the delegate, and the foreign owner is
   still `"hook-session-x"` afterwards (delegate neither stole nor released
   it).
3. **Concurrent delegates serialize**: two executeDelegate invocations on
   the same tier started together — the second's patch is skipped (assert
   via the `reasoning.patch_skipped_concurrent` log event or by inspecting
   ownership mid-flight); after both finish, ownership is fully released
   (`getTierOwner` undefined) and the baseline is restored.

**Verify**: `pnpm test -- test/unit/plugin-delegate.test.ts` → all pass.

### Step 5: Docs touch-up + full gate

In `docs/REASONING.md`, find the "Same-tier in-flight guard" section (the
anchor referenced around line 393). Add one-to-three sentences stating that
the plugin-owned `delegate` tool path participates in the same ownership
protocol using a `delegate:<producerSid>` key, skipping its patch and
emitting `reasoning.patch_skipped_concurrent` when the tier is contended.
Match the section's existing tone/format.

**Verify**: `pnpm test` → exit 0 (full suite, no regressions).
**Verify**: `pnpm run lint` → exit 0.

## Test plan

Cases listed in Step 4: happy-path acquire/release, foreign-owner skip
(no steal, no release), concurrent-delegate serialization. Pattern:
existing bump/wiring tests in `test/unit/plugin-delegate.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new ownership tests exist and pass
- [ ] `grep -c "acquireTierOwner\|releaseTierOwner" src/plugin/delegate.ts`
      returns `2` (one each)
- [ ] `grep -rn "reasoning.patch_skipped_concurrent" src/ docs/` shows the
      event in delegate.ts AND in docs/REASONING.md
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above do not match the live code (drift).
- The fake `ctx` in `test/unit/plugin-delegate.test.ts` has no
  `reasoningStore` field and wiring one in requires changing a shared test
  helper used by many other suites — report the helper's path instead of
  editing it.
- `PluginContext` does not actually expose `reasoningStore` (it does at the
  planned commit — if that changed, the whole approach needs re-reading).
- Any existing delegate test asserts the agentDef IS mutated under
  contention (i.e. the suite pins the racing behavior as desired) — that
  would contradict this plan's premise; report it.
- You find the hook path also acquires for the DELEGATE's producer sessions
  (double-acquire interplay) — report; do not untangle blindly.

## Maintenance notes

- Plan 039 (ladder semantics) edits `delegate.ts` again — land this plan
  first, as the index notes.
- Plan 015 (adaptive reasoning engine, TODO) will likely add more patch
  call sites — every new one MUST go through `acquireTierOwner` with the
  same `delegate:`-prefixed key discipline. Reviewers: any new
  `applyReasoningPatch` call not guarded by an ownership check is a bug.
- The skip is deliberately fail-open for the PATCH (attempt runs unpatched)
  but never for correctness: verification gating is unaffected. If future
  work wants contended patches to queue instead of skip, that is a store
  API change (waiters), not a delegate change.
