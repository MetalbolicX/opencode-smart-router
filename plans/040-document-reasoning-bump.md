# Plan 040: Document the reasoning-bump escalation ladder (1.9.0 feature)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c740f11..HEAD -- docs/ESCALATION.md docs/CONFIG_REFERENCE.md docs/LINE_REFERENCES.md src/escalate/ladder.ts`
> If any in-scope doc changed since this plan was written, compare the
> "Current state" excerpts against the live files before proceeding; on a
> mismatch, treat it as a STOP condition. (The ladder.ts entry is included
> so you can confirm the CODE your docs will describe still matches Excerpts
> 1–3.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (documentation only — no code, no config changes)
- **Depends on**: Plan 039 (its doc-comment wording is the canonical
  phrasing for the attempt-semantics fix here; execute 040 after 039)
- **Category**: docs
- **Planned at**: commit `c740f11`, 2026-08-15

## Why this matters

The reasoning-bump feature (Plan 034, shipped in 1.9.0/1.9.1) changed the
escalation ladder's decision table, added two config fields, and changed
what `maxAttemptsPerTier` means in practice — but the three operator-facing
docs that describe escalation still document the pre-bump world:

- `docs/ESCALATION.md` — decision table has no bump row; the config table
  omits `reasoningEscalation`; the safety-net paragraph's formula ignores
  bump attempts.
- `docs/CONFIG_REFERENCE.md` — `escalate.maxAttemptsPerTier` described as
  "Max attempts at each rung before advancing" (now inaccurate);
  `reasoningEscalation.enabled` / `maxLevelBumpsPerTier` absent entirely.
- `docs/LINE_REFERENCES.md` — describes the ladder as
  "retry → fast → medium → heavy": stale tier names AND no bump action.

This is an operator-config-driven product: an operator who cannot discover
`reasoningEscalation` cannot tune it, and one who trusts the current
`maxAttemptsPerTier` wording will mis-estimate worst-case spend per tier
(see Plan 039 for the real arithmetic). Docs are the feature surface here.

## Current state

Files to edit (all verified at commit `c740f11`):

- `docs/ESCALATION.md` — Layer-3 ladder doc.
- `docs/CONFIG_REFERENCE.md` — config field reference.
- `docs/LINE_REFERENCES.md` — file-by-file architecture map.

### Ground truth from the code (what the docs must say)

**Excerpt 1 — decision table today** (`docs/ESCALATION.md:28-29`):

```markdown
| 4 | `attemptsThisTier < maxAttemptsPerTier` | **RETRY** same tier |
| 5 | higher tier exists in ladder | **ESCALATE** |
```

There is no bump row. The actual decision order in
`src/escalate/ladder.ts:132-224` (`nextAction`) is:
(1) pass → ACCEPT; (2) aborted → GIVE_UP; (3)+(5) cost ceiling → GIVE_UP;
(4) `totalAttempts >= maxTotalAttempts` → GIVE_UP;
(5.5) `canBumpReasoning` true AND rungs remain → **BUMP** reasoning level
within tier; (5.5-fallthrough) bump-eligible but top of rung → ESCALATE;
(6) bump-ineligible AND `attemptsThisTier < maxAttemptsPerTier` → RETRY;
(7) else ESCALATE / GIVE_UP.

**Excerpt 2 — bump gating** (`src/escalate/ladder.ts:110-130`):

```ts
/**
 * Pure gating function for the bump branch. Returns true only when:
 *   - feature is enabled (policy.reasoningEscalation.enabled === true)
 *   - the current tier has a reasoning ladder (state.reasoningLadderLen > 0)
 *   - there are bumps remaining within this tier
 *     (state.bumpsThisTier < policy.reasoningEscalation.maxLevelBumpsPerTier)
 *   - the verdict cause is "verification_fail" (not "retryable_error" or absent)
 */
```

**Excerpt 3 — attempt accounting** (`src/escalate/ladder.ts:226-239` +
`config/tiers/base.json:14-20`):

- Bumps do NOT increment `attemptsThisTier` (that counts produce attempts).
- Worst-case produce attempts per tier = 1 (initial) + `maxLevelBumpsPerTier`
  (bumps) + `maxAttemptsPerTier` (retries). With the shipped defaults
  (`maxAttemptsPerTier: 2`, `maxLevelBumpsPerTier: 2`) that is 5.
- Every attempt (bumps included) counts toward `maxTotalAttempts`
  (`recordAttempt`, ladder.ts:82-89; checked at ladder.ts:156 BEFORE the
  bump branch) — `maxTotalAttempts` is the hard global bound.
- Shipped config enables the feature:
  `"reasoningEscalation": { "enabled": true, "maxLevelBumpsPerTier": 2 }`.

**Excerpt 4 — stale rows**:

- `docs/CONFIG_REFERENCE.md:57`:
  `| \`maxAttemptsPerTier\` | \`number\` | \`1\` | Max attempts at each rung before advancing. Must be integer ≥ 0. |`
- `docs/LINE_REFERENCES.md:36`:
  `- **\`src/escalate/ladder.ts\`** — escalation loop: retry → fast → medium → heavy, bounded by attempt and cost ceilings; emits final \`status: met | unmet\`.`

### Repo conventions that apply

- Docs use GitHub-flavored markdown tables for field references (see
  `CONFIG_REFERENCE.md` lines 43–57) and short prose + tables in
  `ESCALATION.md`. Match the surrounding formatting exactly (column
  headers, backticks around identifiers).
- `docs/ESCALATION.md:47-49` already lists `ladder` and
  `maxAttemptsPerTier` in its config table — extend that table, don't
  restructure it.
- The exact worst-case phrasing to reuse (from Plan 039's doc comment,
  `src/router/config.types.ts` after 039 lands):
  "Worst-case produce attempts per tier = 1 (initial) +
  maxLevelBumpsPerTier (bumps) + maxAttemptsPerTier (retries)."

## Commands you will need

| Purpose    | Command                                    | Expected on success |
|------------|--------------------------------------------|---------------------|
| Typecheck  | `pnpm run typecheck`                       | exit 0 (docs can't break it — sanity only) |
| Tests      | `pnpm test`                                | exit 0 (sanity only) |

## Scope

**In scope** (the only files you should modify):

- `docs/ESCALATION.md`
- `docs/CONFIG_REFERENCE.md`
- `docs/LINE_REFERENCES.md`

**Out of scope** (do NOT touch):

- Any file under `src/`, `config/`, `test/`, or `scripts/` — this is a
  docs-only plan. If the code contradicts Excerpts 1–3 above, STOP.
- `docs/REASONING.md` — its "Same-tier in-flight guard" section is Plan
  038's to update; its capability-model content is already accurate.
- `docs/VERIFICATION.md`, `docs/ENFORCEMENT_PRESETS.md` — the preset
  examples there set `maxAttemptsPerTier` but predate the bump feature;
  updating preset examples is a separate editorial decision (see
  Maintenance notes).

## Git workflow

- Branch: `advisor/040-document-reasoning-bump`
- Commit style: conventional commits. Suggested:
  `docs(escalation): document reasoning-bump branch, config fields, and attempt arithmetic`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Update docs/ESCALATION.md — decision table + bump section

1. In the decision table (Excerpt 1's region), insert the bump branch
   between the cost-ceiling row and the retry row (keep the table's
   existing numbering style; renumber following rows if the table is
   numbered — prefer appending new rows with the next sequential numbers
   rather than renumbering, if the table's numbers are referenced
   elsewhere in the file — check with
   `grep -n "step 4\|row 4\|(4)" docs/ESCALATION.md` first):

   `| <n> | bump eligible (\`reasoningEscalation.enabled\`, tier has a reasoning ladder, bumps remaining, verdict cause = verification_fail) AND rungs remain above current level | **BUMP** reasoning level within the same tier (does not consume the retry budget) |`

   `| <n+1> | bump eligible but already at top rung | **ESCALATE** to next tier |`

2. In the config table (`ESCALATION.md:47-49` region), add:

   `| \`reasoningEscalation.enabled\` | \`false\` | Enables the bump branch: on verification FAIL, raise the tier's reasoning level before falling back to retries/tier escalation. |`

   `| \`reasoningEscalation.maxLevelBumpsPerTier\` | \`2\` | Max reasoning-level bumps within one tier. Bumps do not count against \`maxAttemptsPerTier\`. |`

3. Fix the \`maxAttemptsPerTier\` row wording to: "Retries allowed within a
   tier after its reasoning bumps are exhausted. Worst-case produce
   attempts per tier = 1 + maxLevelBumpsPerTier + this value (every attempt
   also counts toward maxTotalAttempts, the hard global bound)."

4. Update the safety-net paragraph (`ESCALATION.md:80`, "An independent
   hard iteration cap derived from `ladder.length × maxAttemptsPerTier`
   sits beside the policy...") to mention that bump attempts are bounded
   by `maxTotalAttempts` (checked before the bump branch) and that the
   delegate loop's independent `safetyMax` cap still applies.

**Verify**: `grep -n "BUMP" docs/ESCALATION.md` → ≥ 2 matches (decision
table + prose). `grep -c "maxLevelBumpsPerTier" docs/ESCALATION.md` → ≥ 2.

### Step 2: Update docs/CONFIG_REFERENCE.md — escalate field table

1. Fix the `maxAttemptsPerTier` row (Excerpt 4, line 57) to the same
   wording as Step 1.3 (this file's table has a Default column — keep the
   existing default value `1` as the documented default; note the bundled
   preset ships `2` only if the table already documents shipped-vs-default
   distinctions; otherwise leave defaults untouched).

2. Add two rows directly after `maxAttemptsPerTier` (match column format
   `| field | type | default | description |`):

   `| \`reasoningEscalation\` | \`object\` | — | Reasoning-level escalation within a tier before tier fallback. See [ESCALATION.md](./ESCALATION.md). |`

   `| \`reasoningEscalation.maxLevelBumpsPerTier\` | \`number\` | \`2\` | Max reasoning-level bumps per tier (only when \`reasoningEscalation.enabled\` is true). Must be integer ≥ 0. |`

3. In the validation section (`CONFIG_REFERENCE.md:164-165` region), add:

   `| \`escalate.reasoningEscalation.maxLevelBumpsPerTier\` must be an integer ≥ 0 when present. |`

   (Confirm against the actual validator in
   `src/router/config-validate*.ts` FIRST — `grep -rn "maxLevelBumpsPerTier" src/router/`.
   If no validator enforces it, word the row as "should be" instead of
   "must be" — never document validation that doesn't exist.)

**Verify**: `grep -c "reasoningEscalation" docs/CONFIG_REFERENCE.md` → ≥ 3.

### Step 3: Update docs/LINE_REFERENCES.md — ladder entry

Replace the stale entry (Excerpt 4, line 36) with:

`- **\`src/escalate/ladder.ts\`** — escalation loop: retry → reasoning-level bump (within tier, when enabled) → escalate → fast → light → medium → focused → heavy, bounded by attempt and cost ceilings; emits final \`status: met | unmet\`.`

**Verify**: `grep -n "bump" docs/LINE_REFERENCES.md` → ≥ 1 match, and the
old "retry → fast → medium → heavy" string is gone:
`grep -c "retry → fast → medium → heavy" docs/LINE_REFERENCES.md` → 0.

### Step 4: Sanity gate

**Verify**: `pnpm run typecheck` → exit 0 (untouched, sanity).
**Verify**: `pnpm test` → exit 0 (untouched, sanity).
**Verify**: `git status --short` → only the three in-scope docs modified.

## Test plan

Not applicable — docs-only plan. Verification is the grep checks embedded
in each step plus the sanity gates in Step 4.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -q "maxLevelBumpsPerTier" docs/ESCALATION.md`
- [ ] `grep -q "maxLevelBumpsPerTier" docs/CONFIG_REFERENCE.md`
- [ ] `grep -q "reasoningEscalation" docs/CONFIG_REFERENCE.md`
- [ ] `grep -q "BUMP" docs/ESCALATION.md`
- [ ] `! grep -q "retry → fast → medium → heavy" docs/LINE_REFERENCES.md`
- [ ] `grep -q "bump" docs/LINE_REFERENCES.md`
- [ ] `pnpm run typecheck` and `pnpm test` still exit 0
- [ ] No files outside the three in-scope docs are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code excerpts (ladder.ts excerpts above) do not match the live
  code — the docs must describe reality, not this plan.
- The decision table in `ESCALATION.md` uses a numbering scheme that other
  parts of the doc (or other docs) reference by number, and inserting rows
  would break those references — report the referencing lines.
- You discover the config validator DOES enforce
  `reasoningEscalation` fields in a way that contradicts the wording you
  were told to write in Step 2.3 — quote the validator lines and report.
- Plan 039 has not landed and the `config.types.ts` doc comment referenced
  as the canonical phrasing is absent — you may still proceed using the
  wording quoted in Excerpt 3 of THIS plan, but note it in your report.

## Maintenance notes

- When Plan 015 (adaptive engine) or any future change alters the decision
  table in `nextAction`, `docs/ESCALATION.md`'s table must be updated in
  the same PR — it is now the operator-facing mirror of that function.
- `docs/ENFORCEMENT_PRESETS.md` preset examples set `maxAttemptsPerTier`
  without bump context; a future editorial pass could add
  `reasoningEscalation` to one preset example — deliberately deferred
  (preset tuning is a product decision, not a docs fix).
- Reviewers: check every claim added against the Excerpts above; reject
  any wording that promises validation or behavior the code doesn't have.
