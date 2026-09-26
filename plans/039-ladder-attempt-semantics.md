# Plan 039: Make escalation-ladder attempt semantics truthful

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c740f11..HEAD -- src/escalate/ladder.ts src/plugin/delegate.ts src/router/config.types.ts test/unit/ladder.test.ts test/unit/plugin-delegate.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (dead-code removal + comment/doc truthing + one tightened
  condition; behavior for valid configs is unchanged and pinned by new tests)
- **Depends on**: execute AFTER Plan 038 (both edit `src/plugin/delegate.ts`;
  038 first, then this one, on the same branch or sequenced merges)
- **Category**: bug / tech-debt (semantics truthfulness)
- **Planned at**: commit `c740f11`, 2026-08-15

## Why this matters

Three small untruths shipped with the 1.9.x reasoning-bump feature
(Plan 034 + the `910a075` alignment fix):

1. **`maxAttemptsPerTier` no longer means what its name says.** With
   `reasoningEscalation.enabled: true` (the SHIPPED default in
   `config/tiers/base.json`, which sets `maxAttemptsPerTier: 2` and
   `maxLevelBumpsPerTier: 2`), a worst-case failing tier now runs
   `1 initial + 2 bumps + 2 retries = 5` produce attempts — not 2. The
   number is still bounded (every attempt counts toward
   `maxTotalAttempts`), but an operator reading the field name will
   under-estimate their worst-case spend per tier by 2.5×.
2. **A dead condition invites future bugs.** `nextAction`'s bump
   fall-through tests `bumpsLeft <= 0`, which the upstream gate
   `canBumpReasoning` makes unreachable — and the adjacent comment
   describes that unreachable path as live behavior.
3. **A truthy gate mis-seeds the ladder start.** `enterTier` checks
   `tierCfg.reasoning` (the OBJECT) instead of
   `tierCfg.reasoning.effort` (the VALUE), so a tier declaring
   `reasoning: {}` on a `discrete`/`reasoning.effort` capability silently
   starts at ladder index 0 instead of falling back to `tierCfg.variant`.

None of these changes routing for the bundled presets (they always set
`effort` explicitly). They bite custom operator configs and future
maintainers. This plan makes the semantics honest without changing the
designed bumps-first-then-retries behavior (that behavior is per spec and
now gets pinned by characterization tests).

## Current state

Files involved:

- `src/escalate/ladder.ts` — pure ladder state machine.
- `src/plugin/delegate.ts` — `enterTier` seeding helper (function-local,
  lines 188–202).
- `src/router/config.types.ts` — `EnforcementConfig.escalate` type (the
  `maxAttemptsPerTier` field at line 89 has NO doc comment).
- `test/unit/ladder.test.ts` — ladder unit tests (extend).
- `test/unit/plugin-delegate.test.ts` — integration tests (extend, one case).

### Excerpt 1 — the invariant that makes the branch dead (src/escalate/ladder.ts:118-130)

```ts
export const canBumpReasoning = (
  state: LadderState,
  policy: EscalatePolicy,
  verdict: LadderVerdict | null | undefined,
): boolean => {
  const re = policy.reasoningEscalation;
  if (!re?.enabled) return false;
  if (state.reasoningLadderLen <= 0) return false;
  const bumpsLeft = (re.maxLevelBumpsPerTier ?? 2) - state.bumpsThisTier;
  if (bumpsLeft <= 0) return false;
  if (verdict?.cause !== "verification_fail") return false;
  return true;
};
```

### Excerpt 2 — the dead disjunct (src/escalate/ladder.ts:168-209)

```ts
  // (5.5) level bump — verification_fail ladder tiers escalate within tier
  // before retrying or escalating to the next tier.
  const bumpEnabled = canBumpReasoning(state, policy, verdict);
  if (bumpEnabled) {
    const re = policy.reasoningEscalation;
    const bumpsLeft = (re?.maxLevelBumpsPerTier ?? 2) - state.bumpsThisTier;
    const rungsRemain = state.levelIndex + 1 < state.reasoningLadderLen;
    if (rungsRemain && bumpsLeft > 0) {
      return {
        action: "bump",
        tier: state.currentTier,
        forcingMessage: buildLadderForcingMessage(verdict?.reasons ?? []),
      };
    }
    // Bumps exhausted: escalate within tier instead of retry.
    // Only escalates here when bumpsLeft <= 0 at a non-top-rung level
    // (top-rung case falls through to branch 7 give_up or tier-escalate below).
    if (!rungsRemain || bumpsLeft <= 0) {
      const next = nextTierAfter(state.currentTier, policy);
      ...
```

`bumpEnabled === true` requires `bumpsLeft > 0` (Excerpt 1, same formula:
`(re.maxLevelBumpsPerTier ?? 2) - state.bumpsThisTier`). So inside the
`if (bumpEnabled)` block, `bumpsLeft <= 0` is always false and the second
condition reduces to `if (!rungsRemain)`. The comment above it describes an
unreachable distinction.

### Excerpt 3 — attempt accounting (src/escalate/ladder.ts:200-208 and 226-239)

```ts
    // (6) retry within tier — non-bump cases only (retryable, non-ladder,
    // feature-off, omitted cause) enter this branch byte-for-byte.
    if (state.attemptsThisTier < policy.maxAttemptsPerTier) {
      return { action: "retry", ... };
    }
```

```ts
  if (action.action === "retry") {
    return { ...state, attemptsThisTier: state.attemptsThisTier + 1 };
  }
  if (action.action === "bump") {
    // Bump advances the reasoning level within the current tier.
    // Does NOT increment attemptsThisTier — that counts produce attempts,
    // not internal reasoning-level steps.
    return {
      ...state,
      levelIndex: state.levelIndex + 1,
      bumpsThisTier: state.bumpsThisTier + 1,
    };
  }
```

Worst case per tier with `maxAttemptsPerTier: 2`, `maxLevelBumpsPerTier: 2`:
initial attempt + 2 bumps + 2 retries = 5 produce attempts.
(`recordAttempt` counts every attempt toward `totalAttempts`, and branch (4)
`totalAttempts >= maxTotalAttempts` (line 156) is checked before the bump
branch — so the global bound holds; the untruth is the FIELD NAME, not the
bound.)

### Excerpt 4 — the truthy gate (src/plugin/delegate.ts:188-202)

```ts
    const enterTier = (s: LadderState, t: string): LadderState => {
      const tierCfg = activeCfg.presets?.[activeCfg.activePreset]?.[t];
      if (!tierCfg) return s;
      const cap: ReasoningCapability = tierCfg.capability ?? inferCapability(tierCfg);
      // For discrete/reasoning.effort tiers, the configured starting level comes
      // from tierCfg.reasoning.effort (the explicit effort setting). Fall back to
      // tierCfg.variant for backward compat when reasoning is not set.
      const variant =
        cap.kind === "discrete" && cap.field === "reasoning.effort" && tierCfg.reasoning
          ? tierCfg.reasoning.effort
          : tierCfg.variant;
      const levelIndex = levelIndexForVariant(cap, variant) ?? 0;
      const reasoningLadderLen = capabilityLadderLength(cap);
      return { ...s, levelIndex, reasoningLadderLen };
    };
```

`tierCfg.reasoning` is truthy when the key exists even if `effort` is
undefined (`reasoning: {}`), so `variant` becomes `undefined` instead of
falling back to `tierCfg.variant` — contradicting the comment two lines
above. (`levelIndexForVariant(cap, undefined)` on a discrete cap returns
`undefined` → `?? 0` → index 0.)

### Excerpt 5 — the undocumented field (src/router/config.types.ts:86-93)

```ts
  escalate?: {
    floorTier?: string | null;
    ladder?: string[];
    maxAttemptsPerTier?: number;
    maxTotalAttempts?: number;
    costCeiling?: { base?: string; multiple?: number };
    reasoningEscalation?: ReasoningEscalationConfig;
  };
```

### Shipped config values (config/tiers/base.json:11-21)

```json
  "enforcement": {
    "escalate": {
      "ladder": ["fast", "light", "medium", "focused", "heavy"],
      "maxAttemptsPerTier": 2,
      "maxTotalAttempts": 10,
      "costCeiling": { "multiple": 50 },
      "reasoningEscalation": { "enabled": true, "maxLevelBumpsPerTier": 2 }
    }
  }
```

### Repo conventions that apply

- Ladder code is pure (no side effects; the module docstring says so) —
  keep every change here pure. Logging belongs to callers.
- Comments explain WHY and state invariants (see Excerpt 3's bump comment)
  — match that style.
- Tests: `test/unit/ladder.test.ts` uses table/property style with plain
  `describe`/`it`; Plan 036 recently added boundary-branch coverage —
  check for name collisions before adding describe blocks.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Install   | `pnpm install`                                   | exit 0              |
| Typecheck | `pnpm run typecheck`                             | exit 0, no errors   |
| Ladder tests | `pnpm test -- test/unit/ladder.test.ts`       | all pass            |
| Delegate tests | `pnpm test -- test/unit/plugin-delegate.test.ts` | all pass        |
| Full tests| `pnpm test`                                      | all pass            |
| Lint      | `pnpm run lint`                                  | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/escalate/ladder.ts` — collapse the dead disjunct + fix its comment
  (Excerpt 2). Nothing else in this file.
- `src/plugin/delegate.ts` — the one-line condition tighten in `enterTier`
  (Excerpt 4).
- `src/router/config.types.ts` — add a doc comment to `maxAttemptsPerTier`
  (Excerpt 5).
- `test/unit/ladder.test.ts` — characterization tests (Step 4).
- `test/unit/plugin-delegate.test.ts` — one integration case (Step 5).

**Out of scope** (do NOT touch):

- `config/tiers/base.json` and `tiers.json` — the SHIPPED values stay
  exactly as they are. This plan documents behavior; it does not retune it.
- Renaming `maxAttemptsPerTier` — a breaking config-schema change rejected
  during planning (compat cost > truthfulness gain; the doc comment +
  CONFIG_REFERENCE wording in Plan 040 carry the truth instead).
- The bump/retry ORDER (bumps first, then retries) — that is the designed
  Plan 034 behavior and is now pinned by tests.
- `nextAction` branches (1)–(5) and (7), `advance`, `canBumpReasoning`,
  `recordAttempt` — untouched.
- User-facing docs (`docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`,
  `docs/LINE_REFERENCES.md`) — Plan 040 owns them.

## Git workflow

- Branch: `advisor/039-ladder-attempt-semantics` (same branch as 038 if
  sequenced together, 038's commits first)
- Commit style: conventional commits. Suggested:
  `fix(ladder): collapse dead bump fall-through, document attempt semantics`
  and `fix(delegate): tighten enterTier effort gate for empty reasoning blocks`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Collapse the dead disjunct in nextAction

In `src/escalate/ladder.ts`, replace lines 182–185 (comment + condition,
Excerpt 2) with:

```ts
    // Top of the tier's reasoning ladder (no rungs remain above the current
    // level): escalate to the next tier. NOTE: `bumpsLeft <= 0` can NEVER be
    // true here — `canBumpReasoning` (line ~127) already returned false for
    // bumpsLeft <= 0, and this block only runs when it returned true. The
    // bumps-exhausted case therefore also lands here, via the `!rungsRemain`
    // path after the last bump consumed the final rung.
    if (!rungsRemain) {
```

Everything inside the `if` body (the `nextTierAfter` escalate/give_up
return) stays byte-identical. Do not remove the `bumpsLeft` local if
`rungsRemain && bumpsLeft > 0` (line 175) still uses it — it does; keep it.

**Verify**: `pnpm test -- test/unit/ladder.test.ts` → all pass (the
boundary tests from Plan 036 should be unaffected; if any test names the
dead path, STOP per conditions below).

### Step 2: Tighten the enterTier gate in delegate.ts

In `src/plugin/delegate.ts` (Excerpt 4), change the condition:

```ts
      const variant =
        cap.kind === "discrete" && cap.field === "reasoning.effort" && tierCfg.reasoning
          ? tierCfg.reasoning.effort
          : tierCfg.variant;
```

to:

```ts
      const variant =
        cap.kind === "discrete" && cap.field === "reasoning.effort" && tierCfg.reasoning?.effort != null
          ? tierCfg.reasoning.effort
          : tierCfg.variant;
```

And extend the comment above it by one line: `An empty reasoning block
({}) has no effort — fall back to variant (the object-truthy check used
before 039 mis-seeded such tiers at index 0).` TypeScript narrows
`tierCfg.reasoning` to non-optional after the `!= null` optional-chain
check, so the consequent type-checks without a cast.

**Verify**: `pnpm run typecheck` → exit 0.

### Step 3: Document the field semantics on the type

In `src/router/config.types.ts`, give `maxAttemptsPerTier` a doc comment
(matching the style of the `verify.skipFastTier` comment two blocks above):

```ts
    /**
     * Retries allowed within a tier AFTER its reasoning-level bumps are
     * exhausted (bumps run first when reasoningEscalation.enabled). Worst-case
     * produce attempts per tier = 1 (initial) + maxLevelBumpsPerTier (bumps)
     * + this field (retries). Every attempt also counts toward
     * maxTotalAttempts, which is the hard global bound.
     */
    maxAttemptsPerTier?: number;
```

**Verify**: `pnpm run typecheck` → exit 0.

### Step 4: Characterization tests for the attempt arithmetic

Extend `test/unit/ladder.test.ts` with a describe block
("attempt accounting with bumps (039 characterization)") containing:

1. **Bumps do not consume the retry budget**: policy
   `{ ladder: ["fast","medium"], maxAttemptsPerTier: 2, maxTotalAttempts: 10,
   reasoningEscalation: { enabled: true, maxLevelBumpsPerTier: 2 } }`, state
   seeded on a tier with a 3-rung ladder (`reasoningLadderLen: 3`).
   Drive: FAIL(verification_fail) → expect `bump`; apply `advance`; FAIL →
   `bump`; FAIL → now `bumpsLeft === 0` so `canBumpReasoning` is false →
   expect `retry` (NOT escalate), because `attemptsThisTier === 0 < 2`
   still. Assert `attemptsThisTier` stayed 0 across both bumps.
2. **Worst-case per-tier arithmetic**: continue the sequence — FAIL →
   `retry` (attemptsThisTier 1), FAIL → `retry` (attemptsThisTier 2),
   FAIL → now `attemptsThisTier === 2` → expect `escalate` to "medium".
   Total produce attempts on the tier: 5 (1 initial + 2 bumps + 2 retries).
   Assert the final action is escalate and that no `retry` was returned
   once `attemptsThisTier` reached 2.
3. **Top-of-rung bump-exhausted escalates**: state at `levelIndex === 2`
   (top of a 3-rung ladder) with `bumpsThisTier === 1 < 2` — rungs do NOT
   remain, so expect `escalate` (not `bump`), pinning the collapsed
   branch's live behavior.

Check first that Plan 036's boundary tests don't already cover a case
under an identical name; if they do, extend rather than duplicate.

**Verify**: `pnpm test -- test/unit/ladder.test.ts` → all pass including
the new block.

### Step 5: Integration case for the empty-reasoning gate

Extend `test/unit/plugin-delegate.test.ts` with one case modeled after the
existing bump-seeding/wiring tests (circa lines 2527–3086): configure a
tier with a `discrete`/`reasoning.effort` capability (e.g.
`levels: ["low","medium","high","xhigh"]`), `reasoning: {}` (empty object)
and `variant: "high"`. Run one delegate attempt that reaches the patch
block and assert the applied patch corresponds to `levelIndex` 2 (the
variant-derived index) rather than 0 — concretely: the tier's agentDef
`options.reasoning_effort` (or the equivalent seam the neighboring tests
inspect) equals `"high"`, not `"low"`.

**Verify**: `pnpm test -- test/unit/plugin-delegate.test.ts` → all pass.

### Step 6: Full gate

**Verify**: `pnpm test` → exit 0.
**Verify**: `pnpm run lint` → exit 0.

## Test plan

Steps 4–5 above: three pure-ladder characterization cases pinning bump/retry
accounting and the collapsed branch, plus one integration case pinning
variant fallback for `reasoning: {}`. Patterns: existing
`test/unit/ladder.test.ts` table style and the delegate bump-scenario tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests present and passing
- [ ] `grep -n "bumpsLeft <= 0" src/escalate/ladder.ts` returns matches ONLY
      inside `canBumpReasoning` (line ~127) — none in `nextAction`
- [ ] `grep -n "tierCfg.reasoning?.effort != null" src/plugin/delegate.ts`
      returns 1 match
- [ ] `grep -B1 "maxAttemptsPerTier?: number" src/router/config.types.ts`
      shows the new doc comment
- [ ] `git diff c740f11..HEAD -- config/tiers/base.json tiers.json` is EMPTY
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above do not match the live code (drift).
- Any existing test asserts the `bumpsLeft <= 0` disjunct inside `nextAction`
  as a DISTINCT reachable path (that would mean the invariant above is
  wrong — e.g. `canBumpReasoning` and `nextAction` drifted to different
  formulas — and the "dead" branch is live; the fix design changes).
- `levelIndexForVariant` does not return `undefined` for an absent variant
  on a discrete cap (check `src/reasoning/translate.ts:52-64`), which would
  change the `?? 0` analysis in Excerpt 4.
- Plan 038 has NOT landed and you were told to work standalone: the
  `enterTier` change (Step 2) is file-adjacent to 038's patch block —
  coordinate instead of producing conflicting diffs.
- The characterization tests in Step 4 FAIL against the pre-change code
  (run them before editing if unsure) — that means the shipped arithmetic
  differs from Excerpt 3's reading; report the actual observed sequence.

## Maintenance notes

- Plan 040 (docs) quotes the exact worst-case formula from Step 3's doc
  comment — land 039 before 040.
- Plan 015 (adaptive engine, TODO) will consume `attemptsThisTier` /
  `bumpsThisTier`; the characterization tests added here are the safety net
  for that work. If 015 changes the accounting, it must update these tests
  deliberately, not incidentally.
- If a future preset raises `maxLevelBumpsPerTier`, remember the per-tier
  worst case grows with it; `maxTotalAttempts` remains the real brake
  (checked in branch 4 BEFORE the bump branch).
- Reviewers: the collapsed condition must stay behavior-identical — the
  diff should touch a comment and one boolean expression, nothing else in
  `nextAction`.
