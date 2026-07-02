# Plan 013: Add an automated CI gate for typecheck, lint, tests, and build

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 0400624..HEAD -- package.json vitest.config.ts biome.jsonc .github/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/011-restore-verification-baseline.md
- **Category**: dx
- **Planned at**: commit `0400624`, 2026-07-01

## Why this matters

The repo has all the right verification commands (`typecheck`, `lint`, `test`,
`build`) but nothing runs them automatically on PRs or pushes. That is why the
broken baseline from Plan 011 persisted undetected — three independent failure
clusters landed and stayed red with no automated signal.

Once Plan 011 restores the green baseline, CI turns that local discipline into
an enforced invariant: a broken test, lint regression, or build failure gets
caught before merge instead of after release. Without CI, the baseline will
decay again the next time someone forgets to run the full suite locally.

## Current state

### Scripts available (already correct — CI should call these, not raw tools)

`package.json:7-19`:
```json
"scripts": {
  "build": "npm run build:tiers && npx tsc --project tsconfig.build.json && pnpm exec -- rolldown --config rolldown.config.js build",
  "build:tiers": "node --experimental-strip-types scripts/build-tiers-config.ts",
  "prebuild": "node --experimental-strip-types scripts/build-tiers-config.ts",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage",
  "smoke": "cross-env RUN_OC_SMOKE=1 vitest run --config vitest.smoke.config.ts test/smoke",
  "typecheck": "tsc --noEmit",
  "lint": "biome check",
  "lint:fix": "biome check --write",
  "format": "biome format --write",
  "format:check": "biome format"
}
```

### Runtime requirements (CI runner must match)

`package.json:21-24`:
```json
"engines": {
  "node": ">=20.0.0"
},
"packageManager": "pnpm@11.9.0+sha512.bd682d5d03fe525ef7c9fd6780c6884d1e756ac4c9c9fe00c538782824310dcf90e3ddc4f53835f06dfaebd5085e41855e0bcbb3b60de2ac5bbab89e5036f03b"
```

### What CI must NOT do

`vitest.config.ts:6-9`:
```ts
// - The default run excludes `test/smoke/**`: those are opt-in real-OpenCode
//   smokes gated behind RUN_OC_SMOKE=1 (run via `npm run smoke`).
// - Coverage source is `src/`. Thresholds are wired but intentionally left
//   non-failing in Wave 0; they are turned on in Phase 5.1.
```

- Do NOT run `test/smoke` — requires a live OpenCode instance.
- Do NOT enforce coverage thresholds — they are documented as non-failing.
- Do NOT run mutating commands (`lint:fix`, `format`, `lint --write`).

### CI directory

No `.github/workflows/` directory exists. CI must be added from scratch.

### Repo conventions to match

- Node 20+ and pnpm are pinned in `package.json`.
- Verification commands are repo scripts; CI should call `pnpm run <script>`,
  not raw `tsc` / `vitest` / `biome` invocations.
- The repo uses ESM (`"type": "module"`); no transpilation step needed for CI.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0 |
| Lint | `pnpm run lint` | exit 0 |
| Tests | `pnpm test` | exit 0 |
| Build | `pnpm run build` | exit 0 |

## Scope

**In scope** (the only files you should modify or create):
- `.github/workflows/ci.yml` (create)

**Out of scope** (do NOT touch):
- `package.json` scripts — already correct.
- `vitest.config.ts` — coverage thresholds stay non-failing.
- Smoke-test workflows — separate concern.
- Release/publish workflows — separate concern.
- README badges — cosmetic, not load-bearing.
- Any source code.

## Git workflow

- Branch: `advisor/013-add-ci-verification-gate`
- Conventional commit:
  - `ci: add verification workflow for typecheck lint test and build`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create `.github/workflows/ci.yml`

Create the file with this structure:

```yaml
name: CI

on:
  push:
    branches: [master, main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.9.0

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm run typecheck

      - run: pnpm run lint

      - run: pnpm run build

      - run: pnpm test
```

Design decisions baked into this workflow:

1. **`pnpm/action-setup@v4` before `actions/setup-node@v4`**: the pnpm action
   reads the `packageManager` field from `package.json`, so pinning `version:
   11.9.0` is redundant but explicit. If the `packageManager` sha512 hash
   causes issues, remove the `version` line and let the action auto-detect.

2. **`cache: pnpm` on `setup-node`**: this enables built-in pnpm store
   caching without a separate cache step. Requires `pnpm/action-setup` to
   run first so Node knows where the pnpm binary is.

3. **`--frozen-lockfile`**: ensures CI fails if `pnpm-lock.yaml` is out of
   sync with `package.json`. This catches "forgot to commit the lockfile"
   PRs.

4. **`build` before `test`**: the `build` step runs `prebuild` which
   regenerates `tiers.json`. Running it before tests ensures the test suite
   reads a freshly generated file (relevant after Plan 011's race fix).

5. **No matrix**: the repo is a Node CLI/plugin, not a multi-platform
   library. A single Linux runner is sufficient. Add matrix jobs only if
   platform-specific issues emerge later.

6. **Step ordering**: `typecheck` → `lint` → `build` → `test`. The cheapest
   gates run first; if typecheck fails, the job stops before spending time
   on the full test suite.

**Verify**: read `.github/workflows/ci.yml` and confirm:
- Triggers on `push` (master/main) and `pull_request`
- Uses Node 20 and pnpm
- Runs exactly: `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm test`
- Does NOT run smoke tests, coverage enforcement, or mutating commands
- File is valid YAML (no tabs, consistent indentation)

### Step 2: Verify local gates match what CI will run

Before marking this plan done, confirm the local baseline is green with the
exact same commands CI uses, in the same order.

**Verify** (run each sequentially):
- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm run build` → exit 0
- `pnpm test` → exit 0

If any of these fail, Plan 011 has not landed yet or a new regression was
introduced. Do NOT proceed — this plan depends on a green baseline.

## Test plan

- No unit tests needed — this plan adds infrastructure, not product code.
- Verification is by:
  - Local commands passing (the same commands CI will run).
  - Workflow file inspection confirming it runs the intended repo scripts.
  - YAML validity (GitHub will reject invalid YAML on first push).
- If GitHub Actions is available, push to a branch and confirm the workflow
  runs green. If not, local verification is sufficient for this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/ci.yml` exists
- [ ] The workflow triggers on `push` (master/main) and `pull_request`
- [ ] The workflow uses Node 20 and pnpm
- [ ] The workflow runs `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm test` in that order
- [ ] The workflow does NOT run smoke tests, coverage enforcement, or mutating commands (`lint:fix`, `format`)
- [ ] Local `pnpm run typecheck` exits 0
- [ ] Local `pnpm run lint` exits 0
- [ ] Local `pnpm run build` exits 0
- [ ] Local `pnpm test` exits 0
- [ ] No files outside `.github/workflows/ci.yml` are modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 011 is not complete and the local baseline is still red. CI must not
  codify a known-failing suite.
- A `.github/workflows/` directory already exists with conflicting workflows
  (do not overwrite — report and ask).
- The `pnpm-lock.yaml` file does not exist (the `--frozen-lockfile` flag would
  fail). Report so the lockfile can be generated first.
- The `packageManager` sha512 hash in `package.json:24` causes the pnpm action
  to reject the version. Report so the pinning approach can be adjusted.

## Maintenance notes

- **Reviewer focus**: verify the workflow calls repo scripts (`pnpm run X`),
  not raw tool invocations. This ensures CI inherits any future script changes
  automatically.
- Once this lands, any future verification change should update `package.json`
  scripts first and let CI inherit — not edit the workflow YAML.
- Coverage gating (`vitest.config.ts:33-42`) is intentionally deferred to a
  future plan. The thresholds are documented as "turned on in Phase 5.1."
- Smoke tests (`test/smoke/`) require a live OpenCode instance and are
  intentionally excluded from CI. A separate smoke workflow could be added
  later with a manual trigger (`workflow_dispatch`).
