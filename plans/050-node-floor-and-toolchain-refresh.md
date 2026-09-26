# Plan 050: Raise the Node engines floor to >=22.6 and refresh the dev toolchain audit

> **Executor instructions**: Follow step by step; verify each gate. Honor
> STOP conditions. Update your row in `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- package.json pnpm-lock.yaml README.md`
> **SPECIAL NOTE**: at plan-writing time the working tree ALREADY carried
> uncommitted bumps to `package.json`/`pnpm-lock.yaml`:
  `@biomejs/biome ^2.5.14`, `@opencode-ai/plugin 1.18.32`,
  `@types/node ^26.6.2`, `@vitest/coverage-v8 ^5.0.1`, `rolldown ^1.2.10`,
  `vitest ^5.0.1`. Check `git status`/`git log` first: if they have since
  been committed, skip the redundant bump steps; if still uncommitted,
  adopt/commit them as Step 1 (they may be exactly what this plan needs).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (engines raise affects install-time warnings only; `dist/`
  output is ES2022 and unchanged)
- **Depends on**: none (but run before plan 052 so CI targets the true floor)
- **Category**: migration
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`package.json` declares `"engines": { "node": ">=20.0.0" }` and the README
says "Node.js 20+" — but the repo's own build scripts run
`node --experimental-strip-types scripts/build-tiers-config.ts`
(`package.json:9,10`), a flag that does not exist until Node 22.6. A
contributor following the README gets `node: bad option` on `pnpm build`.
Node 20 reached end-of-life 2026-04-30, so the declared floor names an
unmaintained runtime as supported. Separately, `pnpm audit` reports 5 HIGH
advisories — all dev-only (zero runtime dependencies), reachable via
vitest→vite→postcss/nanoid and via `@opencode-ai/plugin`→effect→toml —
fixable by the toolchain bumps already staged in the working tree.

## Current state

- `package.json:9-10`: `build:tiers` and `prebuild` run
  `node --experimental-strip-types scripts/build-tiers-config.ts`.
  `--experimental-strip-types` first ships in Node v22.6.0 (absent from all
  v20.x CLI docs — verified during audit).
- `package.json:24-26`: `"engines": { "node": ">=20.0.0" }`.
- `README.md:12` badge claims `node >= 20`; `README.md:988` says "Node.js 20+".
- `pnpm audit` at `c780bf7` (observed): 5 high — nanoid <3.3.16
  (GHSA-28wg-ghj8-5hjv) and <3.3.18 (GHSA-2v37-7h3g-55p8), postcss ≤8.5.17
  (GHSA-r28c-9q8g-f849) via `.>vitest|@vitest/coverage-v8>…>vite`;
  toml <4.2.0 (GHSA-82x6-q7mm-w9cf) and <4.1.2 (GHSA-v5mp-jgw5-2x6j) via
  `.>@opencode-ai/plugin>effect>toml`. All `dev: true`; package has NO
  `dependencies` block (peer: `@opencode-ai/plugin >=1.0.0`).
- `@types/node ^26` stays — types-ahead-of-runtime is intentional (see
  Maintenance); do not downgrade it in this plan.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0 |
| Build | `pnpm run build` | exit 0 (on Node ≥22.6) |
| Tests | `pnpm test` | no NEW failures vs post-046 baseline |
| Audit | `pnpm audit` | no high advisories, or residuals documented |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `package.json` (engines, possibly adopting staged devDep bumps)
- `pnpm-lock.yaml` (via pnpm)
- `README.md` (badge line 12 + requirements line 988)
- `plans/README.md` (audit-residual note, if any)

**Out of scope**:
- Any `src/` change (if a toolchain bump breaks typecheck, report — likely
  vitest 5 API churn — and fix ONLY test/config files, minimally)
- `@types/node` version policy
- CI workflow (plan 052)

## Git workflow

- Branch: `advisor/050-node-floor-toolchain`
- Commits: `chore(deps): adopt toolchain bumps clearing high advisories`,
  `fix(package): raise engines floor to >=22.6.0`, `docs(readme): align Node requirement`.

## Steps

### Step 1: Resolve the staged-bump state

Run `git status --porcelain package.json pnpm-lock.yaml` and
`git diff package.json`. If the audit-era bumps (list in drift note) are
present but uncommitted: `pnpm install`, then verify the tree is coherent
(typecheck+build+test), then commit them as one `chore(deps):` commit. If
they are already committed, note the commit in your report and continue.

**Verify**: `pnpm ls vitest @opencode-ai/plugin` shows the bumped versions;
`git status` clean for those files.

### Step 2: Raise the engines floor (TDD exception: config, no test-first)

Set `"engines": { "node": ">=22.6.0" }`. Update `README.md:12` badge to
`node >= 22.6` and `README.md:988` to "Node.js 22.6+".

**Verify**: `node -e "const e=require('./package.json').engines.node; if(!(e.includes('22.6'))) process.exit(1)"`
→ exit 0.

### Step 3: Re-run the audit and classify residuals

`pnpm audit` (read-only). Expected: nanoid/postcss highs resolved by the
vitest 5/vite chain. If `@opencode-ai/plugin>effect>toml` highs persist at
1.18.32: record them in `plans/README.md` cycle-7 verifier note as
**upstream-blocked** (the lever is the OpenCode SDK, not this repo) — do NOT
add `pnpm.overrides` for a dev-only advisory chain without operator
instruction.

**Verify**: audit output captured; residual count matches what
`plans/README.md` documents (zero unexplained).

### Step 4: Full gate

`pnpm run typecheck` && `pnpm run build` && `pnpm test` && `pnpm run lint`.

If vitest 5 changed test APIs used by this repo (e.g. `--sequence.shuffle`
flags, coverage provider options in `vitest.config.ts`), fix the test
config/files minimally. If the fix exceeds test config files, STOP and
report.

**Verify**: all four commands pass / no NEW failures.

## Test plan

- No new tests (config/toolchain plan). Existing suite is the regression net.

## Done criteria

- [ ] `package.json` engines is `>=22.6.0`
- [ ] `README.md` badge and requirements line say 22.6+
- [ ] `pnpm audit` reports no high advisories, OR every residual is recorded as upstream-blocked in `plans/README.md`
- [ ] `pnpm run typecheck`, `pnpm run build`, `pnpm run lint` exit 0
- [ ] `pnpm test` no NEW failures vs post-046 baseline
- [ ] `plans/README.md` status row updated

## STOP conditions

- The vitest 4→5 (or plugin 1.18.x) bump requires changes beyond test
  config/test files — report the concrete breakage.
- `pnpm run build` fails on the executor's own Node (check `node -v` first;
  the executor must run Node ≥22.6 for this plan).
- `pnpm audit` still reports a HIGH reachable from the BUILD path (not just
  dev/test) — that changes the risk calculus; report.

## Maintenance notes

- CI (plan 052) matrixes over [22, 24]; the floor and the matrix must move
  together in the future.
- `@types/node ^26` vs engines 22.6: intentional (types-ahead surfaces new
  APIs at compile time). The guard against accidentally USING post-floor
  APIs is the CI matrix's floor job — if a floor-node CI leg fails typecheck
  for that reason, align types to the floor major at that point.
- When Node 22 EOLs (2027-04), repeat this plan's shape.
