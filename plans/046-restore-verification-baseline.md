# Plan 046: Restore the verification baseline (29 red → documented green)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- test/ vitest.config.ts package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" facts below against the live tree before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Strict TDD note**: This plan is mostly *triage and snapshot
> regeneration*, which is a declared TDD exception (snapshot updates are
> review-gated, not test-first). Wherever this plan fixes a real regression,
> write the failing test FIRST, confirm RED for the right reason, then fix.

## Status

- **Priority**: P1 — hard prerequisite for every other cycle-7 plan
- **Effort**: S–M
- **Risk**: LOW (triage + docs; fixes scoped to what triage proves broken)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`pnpm test` at HEAD is **RED: 29 failed / 2627 passed (83 files), 18 failed snapshots** (observed 3×, stable across runs). The last documented baseline
(`openspec/changes/archive/2026-09-14-tier-fanout-tool/verify-report.md:45`,
"exit 1 solely on the single pre-existing test/unit/packaging.test.ts") is
stale: packaging now PASSES (fixed by commit `88b8e68`), but 29 *other*
failures exist that no document explains. The golden snapshot suites — the
tests designed to catch prompt/tier regressions — are red, so a real
regression is indistinguishable from intended churn. Every other plan in
cycle 7 depends on a trustworthy suite.

## Current state

Failing files at `c780bf7` (run 3×, identical in runs 1 and 3):

| File | Failures | Classification (this plan's job to confirm) |
|------|----------|---------------------------------------------|
| `test/golden/protocol.golden.test.ts` | 10 | Stale goldens — HEAD commit `c780bf7` itself ("chore(config): rotate multi-provider tier models") rotated model ids/failover chains without regenerating snapshots |
| `test/golden/assembled-prompt.golden.test.ts` | 8 | Same — snapshot diffs show rotated model ids (`@fast=qwen-3.8-flash`, `@heavy=gpt-5.6-terra(20x)`) and failover chains (`anthropic→openai→google→github-copilot`) |
| `test/integration/ladder-wiring.test.ts` | 3 | Documented dist-dependent (openspec `tasks.md:39`) — needs `dist/` build artifacts |
| `test/integration/modeA-e2e.test.ts` | 2 | Documented dist-dependent (same source) |
| `test/integration/modeB-e2e.test.ts` | 1 | NOT in any documented baseline |
| `test/integration/layer2-wiring.test.ts` | 3 | NOT in any documented baseline — was green at archive time (verify-report: "2654/2654 pass") |
| `test/integration/failover-compose.test.ts` | 2 | NOT in any documented baseline — was green at archive time |

Additional facts:

- `pnpm run typecheck` EXITS 0 at `c780bf7` (the old TS2322 in
  `ladder.test.ts:268` from cycle 6 is gone — do not re-triage it).
- `test/unit/config-store.test.ts` ("read() after refresh() returns the new
  reference") failed in exactly 1 of 3 runs — suspected order/state flake.
- `pnpm run test:gate` (coverage) cannot produce a report while the suite is
  red — thresholds live at `vitest.config.ts:38-48` (global 80/85/80/80;
  per-dir branch gates 90–95% for guard/verify/router/escalate/telemetry).
- No integration test contains any skip mechanism:
  `grep -rE 'skipIf|describe\.skip|it\.skip' test/integration/` → 0 matches.
- Snapshot files live in `test/golden/__snapshots__/*.snap`.

## Commands you will need

| Purpose   | Command                                  | Expected on success |
|-----------|------------------------------------------|---------------------|
| Install   | `pnpm install`                           | exit 0              |
| Typecheck | `pnpm run typecheck`                     | exit 0              |
| Full suite| `pnpm test`                              | see steps — RED at start, GREEN (or documented) at end |
| One file  | `pnpm test -- test/golden/protocol.golden.test.ts` | per step |
| Update goldens | `pnpm test -- test/golden/protocol.golden.test.ts -u` | snapshots rewritten |
| Build dist | `pnpm run build`                         | exit 0, `dist/` refreshed |
| Coverage  | `pnpm run test:gate`                     | table + thresholds pass (final step) |
| Lint      | `pnpm run lint`                          | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `test/golden/__snapshots__/protocol.golden.test.ts.snap`
- `test/golden/__snapshots__/assembled-prompt.golden.test.ts.snap` (via `-u`, after review)
- `test/integration/*.test.ts` — ONLY to add dist-availability skip guards
  and to fix regressions triage proves real
- `test/unit/config-store.test.ts` — ONLY the flaky-test isolation fix
- `docs/qa/verification-baseline.md` (create)
- `plans/README.md` (status row + verifier note)
- Source files `src/**` — ONLY if triage proves a real regression; keep the
  change minimal and TDD'd

**Out of scope** (do NOT touch):
- `vitest.config.ts` thresholds — do NOT lower numbers to make `test:gate` pass
- Any feature work, refactors, or "while I'm here" cleanup — that is other plans' work
- `test/smoke/**` (opt-in by design, excluded from default run)

## Git workflow

- Branch: `advisor/046-verification-baseline`
- Commit per logical unit, conventional style (match `git log --oneline`):
  e.g. `test(golden): regenerate protocol+prompt snapshots after model rotation`,
  `test(integration): skip dist-dependent wiring tests without build artifacts`,
  `docs(qa): record verification baseline`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reproduce and freeze the inventory

Run `pnpm test` and capture the full failure list. Confirm the counts match
the table in "Current state" (7 files, 29 tests, 18 snapshots).

**Verify**: failure inventory matches (±0). If the count differs by more
than the flaky config-store test appearing/disappearing, STOP and report the
actual inventory.

### Step 2: Review and regenerate the 18 golden snapshot failures

For BOTH golden test files, run them and read every snapshot diff hunk. For
each hunk confirm the delta is **exclusively** rotated model ids, tier
budget/costRatio numbers, or failover-chain strings — i.e. the intended
content of commit `c780bf7`.

Any hunk that changes prompt *wording*, section ordering, or adds/removes
lines beyond model identifiers is a REAL regression — STOP and report it
with the hunk.

If all 18 are rotation-only: regenerate both snapshot files with
`pnpm test -- test/golden -u`, then re-run.

**Verify**: `pnpm test -- test/golden` → all golden files pass; `git diff
test/golden/__snapshots__/` shows only model-id/tier-number changes.

### Step 3: Build dist and triage the 11 integration failures

Run `pnpm run build` FIRST (ladder-wiring/modeA/modeB load built artifacts).
Then run each failing integration file individually:

```
pnpm test -- test/integration/ladder-wiring.test.ts
pnpm test -- test/integration/modeA-e2e.test.ts
pnpm test -- test/integration/modeB-e2e.test.ts
pnpm test -- test/integration/layer2-wiring.test.ts
pnpm test -- test/integration/failover-compose.test.ts
```

Classify each failure:
- **PASSES with fresh dist** → dist-dependence confirmed; go to Step 4.
- **STILL FAILS with fresh dist** → real regression. Symptom observed at
  `c780bf7` (from the audit): escalation never fires
  (`producerCalls.length` expected 4 got 1; `[router ✓ accepted: none]`
  instead of `[router status: unmet]`). Diagnose with a TDD loop: write the
  failing assertion first, find the minimal cause, fix.

Timebox: 2 hours per real regression. If root cause is not found within the
timebox, STOP and report findings so far — do not shotgun-fix.

**Verify**: each file either passes, or has a merged minimal fix with a new
regression test that failed before the fix.

### Step 4: Add graceful skip guards for proven dist-dependent tests

For ONLY the files proven dist-dependent in Step 3, add at the top:

```ts
import { existsSync } from "node:fs";
const distBuilt = existsSync(new URL("../../dist/plugin.mjs", import.meta.url));
const describeWired = distBuilt ? describe : describe.skip;
```

(Adapt the dist path to what Step 3 proved the tests actually load — verify
by reading the import/require in the failing tests.) Use `describeWired` for
the wired suites and emit one loud console line when skipping:
`console.warn("[baseline] dist/ not built — run pnpm run build; skipping wired integration tests")`.

**Verify**: `pnpm test` run WITHOUT `dist/` (temporarily `mv dist dist.bak`,
run, `mv` back) skips those suites with the notice; with `dist/` restored
they run.

### Step 5: Fix or isolate the flaky config-store test

Run `pnpm test -- test/unit/config-store.test.ts --sequence.shuffle --repeat 20`.
If the "read() after refresh()" test fails intermittently: isolate per-test
state (its own temp dir per test — model after the isolation pattern already
used in `test/unit/config-store-ttl.test.ts`). Do not weaken the assertion.

**Verify**: 20 shuffled repeats, 0 failures.

### Step 6: Run coverage and archive the measured baseline

Run `pnpm run test:gate`. Capture the per-directory coverage table. If any
`vitest.config.ts:38-48` threshold fails, report the actual numbers — do NOT
lower thresholds; a genuine coverage gap gets recorded as a follow-up note,
not silently greenwashed.

**Verify**: `pnpm run test:gate` exits 0 (or every threshold breach is
recorded verbatim in the baseline doc and `plans/README.md`).

### Step 7: Write `docs/qa/verification-baseline.md`

Content: date, commit, final suite status (pass counts), per-directory
coverage table, the classification of the old 29 failures (goldens
regenerated / dist-skipped / regression fixed / flake isolated), and the
maintenance rule: **"no NEW failures versus this document"** is the phrasing
all future plans use. Update the cycle-7 verifier note in `plans/README.md`
to point at this file.

**Verify**: file exists; `pnpm test` result matches what it documents.

## Test plan

- No new production tests beyond Step 3 regression tests (if any) — this
  plan's deliverable IS the test baseline.
- Model structure after existing golden/integration files; no new patterns.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0, OR every remaining failure is enumerated verbatim
      in `docs/qa/verification-baseline.md` and matches the run output
- [ ] `pnpm test -- test/golden` exits 0 with snapshots whose diff vs
      `c780bf7` contains only model-id/tier-number changes
- [ ] `pnpm run test:gate` exits 0 or its threshold breaches are recorded
- [ ] `docs/qa/verification-baseline.md` exists and matches reality
- [ ] `grep -rn "exit 1 solely on the single pre-existing" openspec/` returns
      no live (non-archive) claims contradicting the new baseline — archive
      files are historical, leave them
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's failure inventory differs materially from the table above
  (the codebase has drifted).
- Any golden snapshot hunk shows a non-rotation delta (real prompt
  regression — that is a finding, not a snapshot update).
- An integration regression's root cause is not found within the 2-hour
  timebox per file.
- A fix appears to require touching `vitest.config.ts` thresholds or files
  outside the in-scope list.
- `pnpm run build` fails at Step 3 (build breakage is its own emergency).

## Maintenance notes

- Every cycle-7 plan's done criteria assume the baseline this plan writes;
  execute this plan FIRST.
- Reviewers: scrutinize the snapshot diff commit hunk-by-hunk — this is the
  one step where a real regression could be laundered as "rotation".
- The dist-skip guard must never hide a *wired* test in CI once Plan 052
  lands (CI runs `pnpm run build` before `pnpm test`, so skips never fire there).
- Deferred: per-directory coverage gaps (if any surfaced in Step 6) become
  follow-up work; CLI branch-coverage 73%/79% remains parked with plan 022/030 notes.
