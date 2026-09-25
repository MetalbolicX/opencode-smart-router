# Verification baseline — cycle 7 (post-046)

> **Maintenance rule (binding for every future plan):** *no NEW failures
> versus this document.* Done criteria that say "no NEW failures vs the
> post-046 baseline" refer to the state recorded here.

- **Date**: 2026-09-25
- **Baseline commits**: landed on branch `advisor/046-verification-baseline`
  (from `c780bf7`); see the commit list below.
- **Runtime**: Node v24.21.0, pnpm v11.12.0 (pinned via `packageManager`),
  vitest 5.0.1, `@opencode-ai/plugin` 1.18.32.

## Final suite status

```
 Test Files  83 passed (83)
      Tests  2656 passed (2656)
```

- `pnpm run typecheck` → exit 0
- `pnpm run build` → exit 0 (and idempotent w.r.t. `tiers.json`, see notes)
- `pnpm test` → exit 0, 83/83 files, 2656/2656 tests
- `pnpm run lint` (biome check) → exit 0
- `pnpm run test:gate` (coverage) → exit 0, thresholds met (table below)

## Per-directory coverage (`pnpm run test:gate`, v8 provider)

| Directory          | Statements | Branch | Functions | Lines |
|--------------------|-----------:|-------:|----------:|------:|
| **All files**      |      94.87 |  89.71 |     96.71 | 95.40 |
| src (index.ts)     |        100 |    100 |       100 |   100 |
| src/cli            |      85.19 |  79.30 |     82.76 | 86.54 |
| src/escalate       |        100 |    100 |       100 |   100 |
| src/guard          |        100 |  97.21 |       100 |   100 |
| src/plugin         |      93.47 |  77.75 |     94.92 | 94.26 |
| src/plugin/hooks   |      96.00 |  86.06 |       100 | 96.15 |
| src/reasoning      |      97.13 |  94.44 |     95.83 | 98.09 |
| src/router         |      96.69 |  93.77 |       100 | 97.00 |
| src/router/commands|      93.96 |  84.91 |       100 | 95.98 |
| src/telemetry      |        100 |    100 |       100 |   100 |
| src/utils          |        100 |  96.00 |       100 |   100 |
| src/verify         |      98.05 |  95.90 |     98.18 | 97.84 |

Threshold check (`vitest.config.ts`): global 80/85/80/80 →
94.87/89.71/96.71/95.4 PASS; per-directory branch gates — guard ≥90 (97.21),
verify ≥90 (95.90), router ≥90 (93.77), escalate ≥95 (100), telemetry ≥95
(100) — **zero breaches, no thresholds lowered**.

> Note: the vitest 5 text reporter omits fully-covered files from the table;
> the numbers above were computed from `coverage-summary.json` (full data) and
> match the printed rows where printed.

## Classification of the original 29 failures (RED inventory at `c780bf7`)

RED state (stable across 6 runs): 7 files / 29 tests / 18 snapshots —
`docs/qa/cycle7-red-inventory.md`.

| File | Failures | Classification |
|------|----------|----------------|
| `test/golden/protocol.golden.test.ts` | 10 | **Goldens regenerated** — every diff hunk was exclusively rotated model ids (`@fast=mimo-v2.6-flash-free`, `@light=glm-5.3-flash`, `@medium=gpt-6-luna`, `@focused=glm-5.3`, `@heavy=gpt-6-sol`) and failover-chain strings (`zai-coding-plan→…`, `opencode→…` added), i.e. exactly the intended content of `c780bf7` (verified against that commit's message and diff). No wording/ordering deltas. |
| `test/golden/assembled-prompt.golden.test.ts` | 8 | **Goldens regenerated** — same classification; chain-line deltas only. |
| `test/integration/ladder-wiring.test.ts` | 3 | **Environment regression fixed** (XDG leak, below) + **stale config-derived expectation updated** (CASE C, below). |
| `test/integration/modeA-e2e.test.ts` | 2 | Same two treatments (T3 expectation updated; env fix). |
| `test/integration/modeB-e2e.test.ts` | 1 | **Environment regression fixed** — passes after the XDG sandbox. |
| `test/integration/layer2-wiring.test.ts` | 3 | **Environment regression fixed** — passes after the XDG sandbox. |
| `test/integration/failover-compose.test.ts` | 2 | **Environment regression fixed** — passes after the XDG sandbox. |

### The 11 integration failures: root cause was NOT dist and NOT src logic

All five files import `ModelRouterPlugin` from `../../src/index` directly —
**none loads `dist/`** (verified by import inspection and by running the
suites with `dist/` removed: no behavioral change). The plan's
"dist-dependent" premise (from stale openspec docs) is obsolete; **no skip
guards were added**.

Actual root cause: the tests sandboxed `HOME`/`USERPROFILE` but not
`XDG_CONFIG_HOME`, while `globalConfigPath()` is XDG-first. On a machine with
a real `~/.config/opencode-smart-router/tiers.json` carrying
`enforcement.verify.require: "never"`, the leaked global layer silently
disabled verification: the gate returned `accepted (method "none")` after one
producer call — escalation never fired, exactly the audit's observed symptom
(`producerCalls.length` 1 vs 4; `[router ✓ accepted: none]` instead of
`[router status: unmet]`). Causality was proven by running the five files
with `XDG_CONFIG_HOME` sandboxed: 18/18 pass with zero code changes.

Fix: `test(integration): sandbox XDG_CONFIG_HOME so operator config cannot
leak into tests` — per-test `XDG_CONFIG_HOME` alongside the existing HOME
sandbox, in all five files.

### Stale config-golden expectations (2 tests)

`ladder-wiring` CASE C and `modeA` T3 pin the give_up tier sequence, which is
derived from per-tier `reasoningControl.maxBumps`. `c780bf7` rotated those
controls (fast: control removed → policy `maxAttemptsPerTier=2` fallback → 3
attempts; light: maxBumps 2→0 → retry branch → 3; medium: control added with
maxBumps=1 → 1 bump + 1 = 2; focused unchanged = 2) without updating the
tests. The intended sequence under the rotated config is
`fast×3, light×3, medium×2, focused×2` (deterministic across runs; the
runtime ladder logic itself is unchanged and its 515 unit tests pass).
Fixed by updating the two expectations + comments (`test(integration):
update ladder give_up expectations to post-rotation tier bumps`).

### Flake status (Step 5)

- `test/unit/config-store.test.ts` — the file **already implements** the
  per-test isolation pattern (own temp dir per test, XDG deleted,
  `__resetPathsForTest()` in both hooks; modeled on `config-store-ttl.test.ts`).
  Verification: **20 shuffled runs, 0 failures**. The historical 1-of-3 flake
  did not reproduce in 8+ full-suite runs this session. No change made.
- Transient `plugin-shutdown` FAIL artifacts seen during RED-capture were
  traced to `test/unit/router-config.test.ts` renaming the real repo
  `tiers.json` (required-bundled ENOENT test) while parallel workers read it.
  Fixed by exercising the exported `readConfigLayer` against a nonexistent
  temp path instead of mutating shared repo state (`test(unit): stop
  renaming repo tiers.json in router-config ENOENT test`).

## Build/config notes for future executors

- **`config/tiers/*.json` are the source of truth for `tiers.json`** (build
  script `scripts/build-tiers-config.ts` regenerates it on every
  `pnpm run build`). `c780bf7` rotated only the generated file; the next
  build silently reverted the rotation. Fixed in
  `fix(config): sync tiers part files with c780bf7 rotation so build is
  idempotent` — `pnpm run build` is now byte-idempotent w.r.t. `tiers.json`.
  Future model rotations MUST update the part files, not only `tiers.json`.
- **vitest 5 flag rename**: `--repeat` → `--repeats` (the plan's
  `--sequence.shuffle --repeat 20` verification becomes
  `--sequence.shuffle --repeats N`; equivalently a shell loop of N runs —
  what was actually done, since vitest 5 reports unique test counts).
- **pnpm audit residuals (050 Step 3)**: recorded in `plans/README.md`
  cycle-7 verifier notes — none reachable from the build path.

## Commit list (branch `advisor/046-verification-baseline`)

| Commit | Subject |
|--------|---------|
| `f87598b` | test(qa): capture cycle-7 red baseline inventory |
| `3774a8b` | chore(deps): adopt toolchain bumps clearing high advisories |
| `fd3bbd2` | fix(package): raise engines floor to >=22.6.0 |
| `3f5cde0` | test(golden): regenerate protocol+prompt snapshots after model rotation |
| `67bfb59` | test(integration): sandbox XDG_CONFIG_HOME so operator config cannot leak into tests |
| `9ff9ab2` | fix(config): sync tiers part files with c780bf7 rotation so build is idempotent |
| `12db122` | test(integration): update ladder give_up expectations to post-rotation tier bumps |
| `c61d04b` | test(unit): stop renaming repo tiers.json in router-config ENOENT test |
