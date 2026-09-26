# Plan 058: Align resolveLadder's default branch with the documented 5-tier contract

> **Executor instructions**: strict TDD. The DECISION embedded below was
> approved by the operator on 2026-09-25 ("follow the recommendation":
> align the code to the module's documented contract). Honor STOP
> conditions. Update your row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/router/tier-ladder.ts test/unit/tier-ladder.test.ts`
> On any change, compare excerpts; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: MED (changes the default ladder for configs without an explicit
  ladder AND without a usable active preset — behavior change for
  configless/presetless setups, approved by operator)
- **Depends on**: plans/046
- **Category**: bug (documented-contract violation) / decision implemented
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`tier-ladder.ts`'s header documents precedence branch 3 as:
"default `['fast','light','medium','focused','heavy']` filtered to present
names". The code returns a hardcoded `["fast","medium","heavy"]` instead,
and the exported `DEFAULT_TIER_NAMES` constant (`:18`) is dead — its only
occurrence repo-wide is its own definition. A future consumer reading
either the header or the constant will build on a contract the code does
not implement. Two of the three tier-ladder-adjacent hardcodings in the
repo (`verify/checker.ts:61`, `router/sessions.ts:134`) are already tracked
as plan 022 residue; this third site is the resolver itself.

## Current state

`src/router/tier-ladder.ts` (complete, 50 lines — key parts):

```ts
 * Precedence (spec: ladder-resolution precedence):
 *   1. explicit enforcement.escalate.ladder  → returned as-is (copied)
 *   2. preset tiers sorted by costRatio ascending (stable insertion tie-break)
 *   3. default ['fast','light','medium','focused','heavy'] filtered to present names
 ...
/** The five named tiers in costRatio order (canonical default fallback). */
export const DEFAULT_TIER_NAMES = ["fast", "light", "medium", "focused", "heavy"] as const;
 ...
export const resolveLadder = (cfg: RouterConfig): string[] => {
  const explicit = cfg.enforcement?.escalate?.ladder;
  if (explicit != null && Array.isArray(explicit)) { return [...explicit]; }
  const preset = cfg.presets?.[cfg.activePreset];
  if (preset) {
    const entries = Object.entries(preset);
    if (entries.length > 0) { /* costRatio sort */ return sorted.map(([name]) => name); }
  }
  // 3. Default filtered to present tier names (when preset is empty or absent)
  // An absent/empty preset falls back to the 3-tier default (fast, medium, heavy).
  return ["fast", "medium", "heavy"];
};
```

Note the internal contradiction: header (`:10`) says filtered 5-tier;
inline comment (`:47-48`) says 3-tier. The inline comment matches today's
code; the header matches the spec. The operator approved making the CODE
match the header.

**Blast radius** (codegraph): `resolveLadder` has 6 callers in
`src/escalate/ladder.ts` + `src/verify/dispatch.ts`; covered by
`test/unit/tier-ladder.test.ts`.

**Interplay (out of scope, do not touch)**: `verify/checker.ts:61`
(`atLeastProducerTier` default `["fast","medium","heavy"]`) and
`router/sessions.ts:134` (`tier !== "fast"` triviality gate) — plan 022
residue. This plan does NOT change those; if their tests reference the
3-tier default via resolveLadder they may need expectation updates ONLY for
the branch-3 cases (see Step 2).

**Semantics decision for "filtered to present names"**: branch 3 fires only
when the active preset is absent/empty. "Present" is therefore defined as
the union of tier names across ALL presets in `cfg.presets` (the only
available notion of present); when that union is empty (no presets at all),
return the full canonical 5 — an empty ladder would be strictly worse
(escalation impossible).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Targeted | `pnpm test -- test/unit/tier-ladder.test.ts` | all pass |
| Full | `pnpm test` | no NEW failures vs post-046 baseline |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `src/router/tier-ladder.ts`
- `test/unit/tier-ladder.test.ts`

**Out of scope**:
- `src/verify/checker.ts`, `src/router/sessions.ts` (022 residue)
- Branches 1 and 2 of resolveLadder (explicit ladder; costRatio sort)
- `DEFAULT_TIER_NAMES` type/export shape (keep `as const`)

## Git workflow

- Branch: `advisor/058-tier-ladder-default`
- Commits: `test(tier-ladder): pin documented 5-tier filtered default (RED)`,
  `fix(tier-ladder): implement the documented filtered default ladder`.

## Steps

### Step 1 (RED): pin the documented contract

Add three cases to `test/unit/tier-ladder.test.ts`:

1. `cfg` with NO presets at all (and no explicit ladder) →
   `resolveLadder(cfg)` returns
   `["fast","light","medium","focused","heavy"]` (full canonical 5).
2. `cfg` with presets whose union of tier names is `{fast, medium}` (active
   preset name pointing at an empty/missing preset) → returns
   `["fast","medium"]` (filtered).
3. `cfg` with a preset containing all five names in NON-costRatio order but
   active preset absent → returns the canonical ORDER
   `["fast","light","medium","focused","heavy"]` (DEFAULT_TIER_NAMES order
   filters, not insertion order).

Run → FAIL (current: `["fast","medium","heavy"]` always).

### Step 2 (GREEN): implement branch 3

```ts
  // 3. Default filtered to present tier names (when preset is empty or absent).
  // "Present" = union of tier names across all presets; with no presets at
  // all, the full canonical five is the only sensible non-empty default.
  const knownNames = new Set<string>();
  for (const preset of Object.values(cfg.presets ?? {})) {
    for (const tierName of Object.keys(preset ?? {})) knownNames.add(tierName);
  }
  if (knownNames.size === 0) return [...DEFAULT_TIER_NAMES];
  return DEFAULT_TIER_NAMES.filter((name) => knownNames.has(name));
```

Update the inline comment (`:47-48`) to match the header (delete the
"3-tier default" sentence). `DEFAULT_TIER_NAMES` becomes consumed (dead-export
finding resolved).

Run targeted → GREEN. Then FULL suite: any test that previously relied on
the 3-tier branch-3 default will surface here — update ONLY the branch-3
expectations, and list each updated assertion in your report. If a test
relies on branch-3 semantics through `checker.ts:61`'s SEPARATE hardcoded
ladder, it must NOT change (out of scope) — if it fails, STOP and report.

### Step 3: gates

Typecheck, full suite, lint; update index row (and add a one-line note to
plan 022's row: resolver site fixed by 058; checker/sessions sites remain).

## Test plan

- The three Step-1 cases; existing branch-1/branch-2 cases unchanged.
- Structural pattern: existing `test/unit/tier-ladder.test.ts` style.

## Done criteria

- [ ] `pnpm test -- test/unit/tier-ladder.test.ts` passes incl. 3 new cases
- [ ] `grep -n "DEFAULT_TIER_NAMES" src/router/tier-ladder.ts` shows the filter consuming it (no longer dead)
- [ ] `grep -n '\["fast", "medium", "heavy"\]' src/router/tier-ladder.ts` returns nothing
- [ ] `pnpm test` no NEW failures vs post-046 baseline (any expectation updates enumerated in the report)
- [ ] `plans/README.md` rows for this plan AND plan 022 updated

## STOP conditions

- A NON-branch-3 test fails in a way that requires touching
  `checker.ts`/`sessions.ts` (022 territory) — report.
- Drift in the excerpt.
- You find downstream code that BREAKS (not just re-expects) on a 5-name
  branch-3 ladder (e.g. assumes ladder length 3) — report; that's a real
  integration finding, not a test update.

## Maintenance notes

- Plan 022's residue (checker/sessions hardcodings) is now the only
  3-tier-hardcoded pair left; when 022 executes it should consume
  `DEFAULT_TIER_NAMES`/`resolveLadder` rather than re-hardcode.
- Reviewers: confirm the behavior change is limited to configs WITHOUT an
  explicit ladder AND without a usable active preset — everything else is
  byte-identical.
