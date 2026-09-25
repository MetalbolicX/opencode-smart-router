# Cycle-7 RED baseline inventory (Plan 046 Step 1)

- **Captured at**: 2026-09-25
- **Commit**: `c780bf7` (clean tree; working-tree toolchain bumps stashed during capture)
- **Runtime**: Node v24.21.0, pnpm v11.12.0, vitest 4.1.10 (committed lockfile)
- **Command**: `pnpm test` (full suite, `vitest run`)

## Verdict: inventory matches plan 046 "Current state" ±0

Summary line (stable across 6 full runs; 2 additional runs showed only the
transient flakes noted below):

```
 Snapshots  18 failed
 Test Files  7 failed | 76 passed (83)
      Tests  29 failed | 2627 passed (2656)
```

## Failure inventory (7 files / 29 tests / 18 failed snapshots)

| File | Failures | Failed snapshots | Matches plan table |
|------|----------|------------------|--------------------|
| `test/golden/protocol.golden.test.ts` | 10 | 10 | yes |
| `test/golden/assembled-prompt.golden.test.ts` | 8 | 8 | yes |
| `test/integration/ladder-wiring.test.ts` | 3 | — | yes (documented dist-dependent) |
| `test/integration/modeA-e2e.test.ts` | 2 | — | yes (documented dist-dependent) |
| `test/integration/modeB-e2e.test.ts` | 1 | — | yes |
| `test/integration/layer2-wiring.test.ts` | 3 | — | yes |
| `test/integration/failover-compose.test.ts` | 2 | — | yes |
| **Total** | **29** | **18** | **±0** |

### Failing test names (verbatim)

- `protocol golden` × 10: `protocol-anthropic`, `protocol-anthropic-mode-budget`,
  `protocol-anthropic-mode-deep`, `protocol-anthropic-mode-normal`,
  `protocol-anthropic-mode-quality`, `protocol-github-copilot`, `protocol-google`,
  `protocol-hybrid`, `protocol-multi-provider`, `protocol-openai`
- `assembled-prompt golden` × 8: `assembled-prompt-anthropic-enforcement-on`,
  `assembled-prompt-anthropic-model-claude`, `assembled-prompt-anthropic-model-openai`,
  `assembled-prompt-anthropic-model-undefined`, `assembled-prompt-openai-enforcement-on`,
  `assembled-prompt-openai-model-claude`, `assembled-prompt-openai-model-openai`,
  `assembled-prompt-openai-model-undefined`
- `Layer-3 escalation ladder wiring`: CASE A (retry-same-tier -> PASS),
  CASE B (escalate -> PASS), CASE C (give_up after maxTotalAttempts)
- `Layer-2 wiring`: Option (i) CASE A (appends forcing note …), Option (ii)
  CASE D (accepted on deterministic PASS), CASE E (honest unmet on FAIL)
- `Mode A end-to-end enforcement loop`: auto-inferred DoD / false-finish escalate,
  producer-never-produces honest give_up
- `Mode B end-to-end (plan-annotation)`: fast retries -> light through 5-tier ladder
- `Phase 3.3 — provider-failover / quality-escalation orthogonality`: CASE A
  (API error folds into exactly one ladder attempt), CASE C (genuine FAIL drives
  quality escalation)

### Characteristic integration symptom (matches the audit's observed candidate)

`producerCalls.length` expected 4, got 1; output contains
`[router ✓ accepted: none]` where `[router status: unmet]` is expected — i.e.
escalation never fires. (Step 3 triage will classify dist-dependence vs real
regression.)

## Transient flake observations (not part of the stable inventory)

- `test/unit/config-store.test.ts` ("read() after refresh() returns the new
  reference") — known order/state flake, per plan (failed 1 of 3 runs at
  plan-writing time). Handled by Step 5.
- During 11 total full-suite runs in this session, two transient anomalies were
  observed under back-to-back parallel load and did NOT reproduce in the 6
  clean verification runs above:
  - one run printed a `FAIL test/unit/plugin-shutdown.test.ts` artifact line
    while file/test totals stayed identical (7 failed files, same 29);
    the file passes in isolation (`pnpm test test/unit/plugin-shutdown.test.ts`
    → 13/13 pass, repeated).
  - one run reported 8 failed files; the extra file was not captured before it
    failed to reproduce in 6 subsequent runs.
  These are recorded here for honesty; they are outside plan 046's scope and
  become follow-up notes if they reproduce after the baseline lands.

## Plan-046 factual cross-checks at `c780bf7`

- `git diff --stat c780bf7..HEAD -- test/ vitest.config.ts package.json` → empty (drift check passed).
- `pnpm run typecheck` → to be re-verified in the final gate (plan records it exits 0 at `c780bf7`).
- `grep -rE 'skipIf|describe\.skip|it\.skip' test/integration/` → to be re-verified in Step 4.
