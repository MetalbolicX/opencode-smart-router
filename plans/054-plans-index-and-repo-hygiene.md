# Plan 054: Reconcile the plans index with reality and purge repo-hygiene strays

> **Executor instructions**: follow steps in order; every removal is gated
> by a verification command FIRST. Honor STOP conditions. Update your row
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- plans/README.md README.md package.json .gitignore openspec/ src/reasoning/policy.ts`
> On any change beyond this plan's own predecessors, compare notes; on
> mismatch, STOP.

## Status

- **Priority**: P2 (truth-telling: future audits index off this file)
- **Effort**: S
- **Risk**: LOW (deletions of provably-dead files + status-row corrections)
- **Depends on**: none (but coordinate with 053: it creates AGENTS.md; this
  plan links it from the index)
- **Category**: tech-debt
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

The plans index has drifted from shipped reality (plan 015 is TODO in the
index but its engine is shipped; plan 030 is TODO but `test:gate` exists;
plan 025 directs ReScript work in a repo with no ReScript), and the repo
tracks stale twins of primary artifacts: `README.md.bak` (921 diff lines
behind README.md), `.opencode/plugins/opencode-model-router.ts.bak`, a root
decision record that belongs in `docs/adr/`, and a duplicate un-archived
`openspec/changes/tier-fanout-tool/` that is byte-identical to its archive
copy. Generated `dist/**/*.res.mjs` from the removed ReScript toolchain can
still ship in the npm tarball (`files: ["dist/", ...]` with no clean step).
A 40.7K stale README twin is a grep-trap for every future agent.

## Current state

Verified facts at `c780bf7`:

- **Index drift** (`plans/README.md`):
  - Row 015 (`:38`) = TODO; but `src/reasoning/adaptive.ts:211` ships
    `selectAdaptiveLevelV2`, consumed by `src/reasoning/policy.ts`
    (`resolveReasoningProfile`, `:64+`), wired at
    `src/plugin/hooks/tool-guards.ts:181,223`; tests exist
    (`test/unit/adaptive-selector.test.ts`). Engine shipped.
  - Row 030 (`:53`) = TODO; but `package.json` has `test:gate` and
    `prepublishOnly` chains it; `vitest.config.ts:26-48` has thresholds.
    Done.
  - Plan 025 = TODO; ReScript fully removed (`test:res` is
    `echo 'no rescript tests'`; zero `.res` in src/; plan's target files
    cannot exist). Obsolete.
  - Rows 009 (TODO since cycle 1) and 022-residue stand — keep, add notes.
  - 022 residue CONFIRMED still present at `c780bf7`:
    `src/verify/checker.ts:61` (`["fast","medium","heavy"]` default ladder)
    and `src/router/sessions.ts:134` (`tier !== "fast"` triviality gate).
- **Tracked strays** (`git ls-files`): `README.md.bak`,
  `.opencode/plugins/opencode-model-router.ts.bak`,
  `sdd-artifacts-plugin-fix.md` (root; a decision record / porting guide).
- **openspec duplicate**: `openspec/changes/tier-fanout-tool/` coexists with
  `openspec/changes/archive/2026-09-14-tier-fanout-tool/`; audit verified
  both `tasks.md`/`apply-progress.md` pairs byte-identical.
- **README.md:994-1000**: a `# Plan 041 migration` fragment appended AFTER
  the `## License` section (the document's end).
- **README.md:296-300**: "Local clone" instructs `npm install` while the
  repo is pnpm-locked and the Testing section says `pnpm install`.
- **package.json**: `test:res` is a no-op echo; `prebuild` duplicates
  `build`'s first step and never auto-runs under pnpm (no
  `enable-pre-post-scripts`, no `.npmrc`).
- **dist residue**: `dist/src/**/*.res.mjs` files exist on disk from the
  ReScript era; `files: ["dist/", ...]` would pack them (prepublish runs
  build, nothing cleans dist first).
- **Stale comment**: `src/reasoning/policy.ts:43-48` says task text is
  "wired in a later PR of Plan 015" with an empty-haystack placeholder —
  but tool-guards threads real signals (V2 wiring at `tool-guards.ts:181,223`).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Identity check | `diff -q openspec/changes/tier-fanout-tool/tasks.md openspec/changes/archive/2026-09-14-tier-fanout-tool/tasks.md` (and apply-progress.md) | identical |
| Reference check | `grep -rn "test:res\|README.md.bak\|opencode-model-router.ts.bak" README.md docs/ package.json .github/ scripts/ 2>/dev/null` | no live references |
| Build clean check | `pnpm run build && find dist -name "*.res.mjs" \| wc -l` | 0 after Step 6 |

## Scope

**In scope**:
- `plans/README.md`, `README.md`, `.gitignore`, `package.json`,
  `src/reasoning/policy.ts` (comment only),
  `rolldown.config.js` OR the `build` script (dist clean — pick one),
  file deletions/moves listed below, `openspec/changes/tier-fanout-tool/` (remove)

**Out of scope**:
- `src/verify/checker.ts` / `src/router/sessions.ts` (022's residue — only
  annotate the index, do not fix code)
- The archived openspec copy, `docs/adr/0000-0002`, any `.bak` content
  recovery (nothing imports them)
- Plan 009 execution (only annotate)

## Git workflow

- Branch: `advisor/054-index-hygiene`
- Commits, one per logical unit: `docs(plans): reconcile cycle 1-6 statuses with shipped reality`,
  `chore: remove tracked backup strays and ignore *.bak`,
  `chore(openspec): drop duplicate un-archived tier-fanout-tool change`,
  `fix(build): clean dist before packing so stale artifacts cannot ship`,
  `docs(readme): drop stray Plan 041 fragment; fix local-clone install command`,
  `chore(package): drop no-op test:res and prebuild scripts`,
  `docs(reasoning): refresh stale Plan-015 placeholder comment`.

## Steps

### Step 1: Index reconciliation (edits to `plans/README.md`)

1. Row 015 → `DONE (adaptive V2 shipped: adaptive.ts selectAdaptiveLevelV2 + tool-guards wiring; stale policy.ts comment refreshed by plan 054)`.
2. Row 030 → `DONE (test:gate script + vitest thresholds live; verified cycle 7)`.
3. Row 025 → `CLOSED — obsolete: ReScript toolchain fully removed; parity fixtures in .res cannot exist. Do not re-plan.`
4. Row 009 → keep TODO, append note: `P1 open since cycle 1 (2026-06) — re-confirm with operator before executing; UX completion item.`
5. 022-residue note refresh: cite `checker.ts:61` and `sessions.ts:134` as
   still-hardcoded at `c780bf7`; note plan 058 fixes the tier-ladder default
   but NOT these two sites.
6. Add a one-line pointer to `AGENTS.md` (from plan 053) in the index header.

**Verify**: `grep -n "| 015 \| 015 " plans/README.md | head -3` shows DONE;
same for 030/025 rows.

### Step 2: Stray removals (each gated)

1. `diff -q` both openspec file pairs (commands table). If ANY pair differs
   → STOP (the duplicate diverged; needs human reconciliation).
   Then `git rm -r openspec/changes/tier-fanout-tool`.
2. `git rm README.md.bak .opencode/plugins/opencode-model-router.ts.bak`.
3. `git mv sdd-artifacts-plugin-fix.md docs/adr/0003-sdd-artifacts-plugin-fix.md`
   (it opens as a decision record/porting guide — ADRs are its home).
4. Append `*.bak` to `.gitignore`.

**Verify**: `git ls-files | grep -E "\.bak|sdd-artifacts"` returns nothing;
`ls docs/adr/0003-sdd-artifacts-plugin-fix.md` exists.

### Step 3: README fixes

1. Delete lines 994-1000 (the `# Plan 041 migration` block after License).
   The content already lives in `docs/MIGRATION.md`/CONFIG_REFERENCE pointers.
2. Local-clone section (~`:296-300`): `npm install` → `pnpm install` (add
   "(or corepack enable)" once), one sentence: "This repo uses pnpm."

**Verify**: `tail -5 README.md` ends at the License section;
`grep -n "npm install" README.md` returns no local-clone hits (other
occurrences in user-facing snippets may remain — only fix the setup step).

### Step 4: Script cleanup

Remove `test:res` and `prebuild` from `package.json` AFTER:
`grep -rn "test:res\|pnpm run prebuild\|npm run prebuild" README.md docs/ scripts/ .github/ 2>/dev/null`
returns no live references (plan 027's Testing section documented
`pnpm run test:res` historically — if the README mentions it, update that
sentence to remove the reference in the same commit).

**Verify**: `node -e "const s=require('./package.json').scripts; if(s['test:res']||s.prebuild) process.exit(1)"` → exit 0.

### Step 5: Stale policy comment

`src/reasoning/policy.ts:43-48`: replace the "wired in a later PR of Plan
015 … empty placeholder" passage with the truth: signals ARE threaded from
the tool-guards V2 wiring; keep the surrounding contract description intact.
Comment-only change — `pnpm run typecheck` must stay green.

### Step 6: dist clean before build/pack

Read `rolldown.config.js`. If rolldown supports an output-clean option
(check its config surface), enable it. Otherwise change the `build` script
to clean first, e.g. `"build": "npm run build:tiers && npx tsc --project tsconfig.build.json && pnpm exec -- rolldown --config rolldown.config.js build"` →
prepend `rimraf`-free POSIX `rm -rf dist &&` (repo targets Linux/CI; acceptable
here) OR a tiny node -e cleanup. Then run `pnpm run build` and confirm the
stale `.res.mjs` files are gone.

**Verify**: `find dist -name "*.res.mjs" | wc -l` → 0, and
`pnpm run build && pnpm test` → no NEW failures vs post-046 baseline
(packaging test `test/unit/packaging.test.ts` must still pass — if it packs
from `dist/`, it now packs a clean tree).

### Step 7: full gates

`pnpm run typecheck` && `pnpm run lint` && `pnpm test`.

## Test plan

- No new tests; existing suite (esp. packaging test) is the regression net.

## Done criteria

- [ ] Index rows 015/030 DONE, 025 CLOSED with notes; 009/022 annotated
- [ ] `git ls-files | grep -E "\.bak$"` empty; `*.bak` ignored
- [ ] `docs/adr/0003-sdd-artifacts-plugin-fix.md` exists; root stray gone
- [ ] `openspec/changes/` contains only `archive/` (plus any NEWER changes — if a newer active change exists, only remove `tier-fanout-tool`)
- [ ] README ends at License; local clone says pnpm
- [ ] `test:res` and `prebuild` gone; no dangling references
- [ ] `find dist -name "*.res.mjs" | wc -l` = 0 after build
- [ ] `pnpm run typecheck`/`lint` exit 0; `pnpm test` no NEW failures
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any openspec `diff -q` shows divergence (needs human reconciliation).
- Removing `test:res`/`prebuild` breaks a caller you cannot update within
  scope (report the caller).
- The packaging test fails after the dist-clean change in a way that
  requires changing the test's expectations (report; the test asserts
  shipped-file invariants — a deliberate expectation change needs review).
- `policy.ts` comment edit triggers any behavioral test change (it must be
  comment-only).

## Maintenance notes

- The `*.bak` ignore rule prevents recurrence; commit-message hygiene ("add
  README backup file" happened once — don't repeat it).
- 0003-ADR numbering: future ADRs continue at 0004 (plan 060's spike may
  take 0004 — coordinate).
