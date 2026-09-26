# Plan 052: Add the CI verification gate and wire lint into the publish path

> **Executor instructions**: Follow step by step; verify each gate. Honor
> STOP conditions. Update your row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- package.json .github/ docs/qa/verification-baseline.md`
> This plan REQUIRES plans 046 (green/documented baseline) and 050 (floor)
> to be DONE first — verify their rows in `plans/README.md` before starting.
> If `.github/` already exists, STOP and reconcile instead of duplicating.

## Status

- **Priority**: P2 (re-raise of the cycle-6-excluded finding; that cycle's
  index says verbatim: "EXCLUDED BY THE USER … not rejected on merit.
  Re-raise in a future cycle")
- **Effort**: S–M
- **Risk**: LOW (additive workflow; MED only if first run exposes
  undocumented redness — which is the gate doing its job)
- **Depends on**: plans/046, plans/050
- **Category**: dx
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

Plan 013 ("Add an automated CI gate") is marked DONE, yet the repo has no
`.github/` directory at all — no workflow has ever run. Nothing verifies the
engines floor (plan 050 exists precisely because a floor slip shipped
unnoticed), nothing enforces typecheck/lint/build/test on PRs, and Biome
runs only when a human remembers (`prepublishOnly` = build + test:gate, no
lint; `format:check` has zero callers; no hooks exist — `.git/hooks`
contains only samples). The cycle-7 audit found the suite 29-failures red
against a stale baseline doc: exactly the condition a CI gate prevents from
recurring.

## Current state

- No `.github/`, no `.gitlab-ci.yml`, no `.circleci/`, no `.travis.yml`
  (verified by directory listing at `c780bf7`).
- `package.json:11`: `"prepublishOnly": "pnpm run build && pnpm run test:gate"`.
- Scripts (verified): `typecheck`, `lint`, `build`, `test`, `test:gate`,
  `smoke`. `packageManager: pnpm@11.12.0` (corepack-compatible).
- Engines floor after plan 050: `>=22.6.0`. Current LTS line: 24.
- Plan 046 added dist-availability skip guards to wired integration tests,
  so `pnpm test` is safe both with and without `dist/` — CI still builds
  BEFORE test so the wired suites actually run there.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| YAML sanity | `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/ci.yml','utf8');if(!s.includes('pnpm run typecheck'))process.exit(1)"` | exit 0 |
| Local gate (simulates CI legs) | `pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run lint && pnpm run build && pnpm test` | all pass |

## Scope

**In scope**:
- `.github/workflows/ci.yml` (create)
- `package.json` (prepublishOnly += lint)
- `plans/README.md` (status row)

**Out of scope**:
- Coverage upload jobs, smoke jobs, release automation, matrix OS (Linux
  only for now), pre-commit hook tooling (a separate decision; do NOT add
  husky/lefthook dependencies in this plan)
- Any `src/` change

## Git workflow

- Branch: `advisor/052-ci-gate`
- Commits: `ci: add typecheck/lint/build/test workflow on node 22+24`, `chore(package): lint before publish`.

## Steps

### Step 1: The workflow file

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node: ["22", "24"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm run build
      - run: pnpm test
```

`corepack enable` honors `packageManager: pnpm@11.12.0` without hardcoding
a pnpm version. Build precedes test so 046's dist-dependent suites run (not
skip) in CI.

### Step 2: Publish path lints

`package.json` → `"prepublishOnly": "pnpm run lint && pnpm run build && pnpm run test:gate"`.

**Verify**: `node -e "const s=require('./package.json').scripts.prepublishOnly; if(!s.startsWith('pnpm run lint')) process.exit(1)"` → exit 0.

### Step 3: Local simulation + structural verification

Run the full local gate from the commands table (the exact CI leg sequence).
Then the YAML sanity check. If `act` (nektos/act) is installed locally, run
`act -j verify` optionally — not required.

**Verify**: local gate passes on the executor's machine; YAML check exits 0.

### Step 4: First green run (operator-assisted)

Do NOT push unless the operator instructed it. Report that the branch is
ready; the operator pushes and watches the first run. If the operator
authorizes push: `git push -u origin advisor/052-ci-gate` and confirm the
workflow triggers (first run may need the branch's PR or
`workflow_dispatch` if push-trigger fails — if so, add `workflow_dispatch:`
to `on:` and report).

## Test plan

- No unit tests (infra). The "test" is the local gate simulation + first CI run.

## Done criteria

- [ ] `.github/workflows/ci.yml` exists and passes the YAML sanity check
- [ ] Local gate sequence passes end-to-end on the executor's machine
- [ ] `prepublishOnly` starts with `pnpm run lint`
- [ ] `pnpm test` matches the post-046 baseline (CI will codify it)
- [ ] `plans/README.md` status row updated (note whether first remote run happened)

## STOP conditions

- Plans 046/050 rows are not DONE (CI would codify a red/moving baseline).
- The suite has undocumented failures at execution time — STOP; do not add
  `continue-on-error` or skip flags to make CI green.
- The local gate fails at any leg for reasons unrelated to this plan —
  report; that's a finding, not something to engineer around.

## Maintenance notes

- When the Node floor moves (see plan 050 maintenance note), move the
  matrix floor leg with it.
- Coverage upload / smoke jobs are explicit non-goals; if wanted later,
  they are separate jobs, not edits to the verify sequence.
- If repo visibility is public: the workflow consumes no secrets; keep it
  that way unless a real need appears.
