# Plan 060 (SPIKE): Design the cost/health/pass-rate read surface (`osr status --report`)

> **Executor instructions**: this is a DESIGN/SPIKE plan. You investigate,
> decide, and write a decision document. **You do NOT implement the feature
> or change any production code.** Honor STOP conditions. Update your row
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/telemetry/ src/cli/status.ts src/utils/log.ts docs/ENFORCEMENT_PRESETS.md README.md`
> Skim for changes that invalidate the evidence below; on mismatch, note it
> in the decision doc rather than stopping (spikes tolerate drift).

## Status

- **Priority**: P2 (cycle 6 already ranked this "best feature ROI in the cycle")
- **Effort**: M (spike: investigation + design + prototype-in-doc, not build)
- **Risk**: LOW (no production changes); the RESULTING design's risk is assessed in the doc
- **Depends on**: plans/046 (trustworthy suite for any prototype validation)
- **Category**: direction (design/spike)
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

The product's headline claim (83–92% token cost savings) is unverifiable by
users: the data exists (per-session trajectory scorecards record
`cost_units`, `attempts`, `escalations`, `final_tier`, verify verdicts) but
lives in append-only files under the OS temp dir, and the docs literally
instruct users to hand-read them
(`docs/ENFORCEMENT_PRESETS.md:187-190`). The CLI's only read surface,
`osr doctor` (`src/cli/status.ts` doctor body ~`:146-243`), checks Node
version/config shape/dir writability — zero routing/cost/pass-rate output.
Cycle 6 deferred exactly this ("the read path that makes the README's
83-92% cost claim verifiable by users — best feature ROI"); this spike
produces the design a build plan can execute.

## Current state (evidence, verified during audit cycle 7)

- **Data source A (in-memory)**: `src/telemetry/trajectory.ts:102-121` —
  `trajectoryMetrics` emits `ttfa`, `read_exec_ratio`, `attempts`,
  `escalations`, `final_tier`, `cost_units`, `verdict`, `verify_method`,
  `grader_tier`, `dod_source` per session. Store is per-plugin-instance,
  no persistence, no eviction (plan 055 adds eviction).
- **Data source B (on-disk)**: `src/utils/log.ts:42-48` —
  `writeTrajectoryLog` appends `<sid>[.scorecard|.delegate].log` under
  `<tmpdir>/opencode-smart-router-trajectory/`. Volatile (tmp), shared
  location, world-readable by default on multi-user hosts (audit SEC-05),
  no rotation. Callers: per-delegation scorecards + opt-in full dumps +
  delegate scorecards (`src/plugin/hooks/*`, `src/escalate/ladder.ts`).
- **Read surface today**: `src/cli/status.ts` — `osr status`/`osr doctor`
  (environment/config checks only). No aggregation anywhere.
- **The claim**: README cost-savings table (in the current README, and in
  the `README.md.bak` twin at `:110-111` — the .bak is being removed by
  plan 054; the design must keep the claim verifiable in the LIVE README).
- **Per-tier cost model**: `tiers.json` presets carry `costRatio` per tier
  and `costCeiling` per preset — the denominators for any % computation.

## Questions this spike MUST answer (the decision doc's skeleton)

1. **Aggregation store** — options with trade-offs:
   (a) scan the tmpdir scorecard files on demand (zero new state; tmp is
   volatile + reboot-clears + multi-user unsafe → weak);
   (b) append-only summary file under XDG state dir
   (`~/.local/state/opencode-smart-router/summary.jsonl`), updated at
   delegation completion (durable; needs scrub + perms 0600 — pairs with
   the SEC-05 fix direction; needs a retention/rotation policy);
   (c) both: summary file as truth + tmpdir best-effort backfill.
   Recommend one; justify vs. the "no new runtime deps" posture (zero-dep
   JSONL append is fine).
2. **Surface** — `osr status --report [--since 7d]` vs a new
   `osr report` command vs a `/router-report` in-session command. Note the
   in-session command reuses OpenCode's command surface (see
   `registerRouterCommands`); the CLI works headless. Recommend one
   (or a deliberate pair) with UX sketches (exact output block, ~20 lines).
3. **Schema** — per-tier: dispatches, verify pass-rate, escalations,
   mean cost_units, vs-preset-costCeiling %. Aggregate: totals + the
   savings-vs-single-model-heavy baseline the README claims (define the
   baseline formula precisely — today's claim has no formula on record).
4. **Privacy/scrub** — scorecards contain session ids + task summaries?;
   the report renders aggregates only; confirm no raw text leaks; apply
   `scrubText` at render regardless.
5. **Rollout** — does the summary file need a version field + migration
   stance (yes: `schema: 1`)?

## Deliverable

`docs/adr/0004-cost-read-surface.md` (coordinate the ADR number with plan
054, which adds 0003): context, evidence citations (file:line from above,
re-verified), the five decisions with rationale + rejected alternatives, a
mock of the exact `--report` output, and a **stub build-plan section**
(scope bullets suitable for turning into `plans/063-*.md` — do not write
that plan file yourself).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Evidence re-check | `rg -n "cost_units|costUnits" src/ \| head` | hits in telemetry + wiring |
| Scorecard reality | `ls ${TMPDIR:-/tmp}/opencode-smart-router-trajectory/ 2>/dev/null \| head` | files present (or documented absence) |
| Status surface | `rg -n "doctor|report" src/cli/status.ts src/cli/main.ts \| head -20` | current commands |

## Scope

**In scope**:
- `docs/adr/0004-cost-read-surface.md` (create)
- `plans/README.md` (status row)
- Reading/running read-only commands; small THROWAWAY prototype scripts may
  live in `/tmp` — never in the repo

**Out of scope**:
- ANY change under `src/`, `test/`, `docs/` other than the ADR
- Writing `plans/063-*`
- The SEC-05 log-permissions fix itself (orthogonal hardening; the ADR
  should NOTE it as a prerequisite/companion, not implement it)

## Steps

1. Re-verify the evidence citations (commands above); capture 2-3 real
   scorecard files' SHAPES (not contents — scrub/redact anything sensitive;
   never paste secrets or session payloads into the ADR).
2. Draft the five decisions with options/trade-offs/recommendation.
3. Design the exact report output block (mock, ~20 lines) and the summary
   JSONL schema (`schema: 1`).
4. Define the savings-baseline formula precisely enough that two
   implementers would compute identical numbers.
5. Write the ADR + update the index row.

## Done criteria

- [ ] `docs/adr/0004-cost-read-surface.md` exists with all five decisions made (no "TBD")
- [ ] Every evidence citation re-verified against the live tree (list in the report)
- [ ] Report output mock + JSONL schema included
- [ ] No files outside the ADR + index modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The trajectory data turns out NOT to contain what the audit found
  (e.g. `cost_units` never populated) — that is a MATERIAL finding; write
  it into the ADR as a blocking prerequisite and report.
- A second read-surface effort is already in flight (index says so).

## Maintenance notes

- The resulting build plan (063) will touch telemetry, cli, and possibly
  log.ts — sequence it after plans 055 (eviction) and any SEC-05 hardening.
- Keep the ADR's formula section authoritative: the README claim should
  eventually cite it instead of a bare percentage.
