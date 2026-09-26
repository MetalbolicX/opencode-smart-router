# ADR 0004: Cost, health, and pass-rate read surface

- **Status:** Accepted (design; implementation deferred to a follow-up plan)
- **Date:** 2026-09-25
- **Related:** Plan 060; follow-up implementation scope proposed for Plan 063

## Context

The README advertises 83–92% token cost savings, but users cannot validate that
claim from the CLI. Trajectory scorecards already capture routing and
verification metrics, while the existing `osr status`/`osr doctor` surfaces
check environment and configuration only. The available scorecard logs are
temporary, append-only, and stored in a shared location with no rotation; that
is a weak foundation for a durable report and a privacy concern on multi-user
hosts.

Evidence re-checked against this worktree:

- `src/telemetry/trajectory.ts:102-121`: `trajectoryMetrics` emits
  `attempts`, `escalations`, `final_tier`, `cost_units`, `verdict`, and
  verification metadata.
- `src/utils/log.ts:42-48`: `writeTrajectoryLog` appends per-session logs in
  the OS temporary directory under `opencode-smart-router-trajectory`.
- `src/cli/status.ts:146-243`: `doctor` performs environment/configuration
  checks, not routing aggregation. `src/cli/main.ts` wires the current status
  command; there is no report surface.
- `config/tiers/*.json`: presets provide tier `costRatio` values and
  `costCeiling` values for comparison.
- Drift check from the plan (`c780bf7..HEAD`) found only a two-line README
  change in scope. It does not invalidate the telemetry or CLI evidence.
- No scorecard files were available in the worktree's temporary trajectory
  directory during this spike; no real records were inspected or copied. The
  schema and privacy recommendations below are based on the writer/metrics
  contract, not sampled user data.

## Decisions

### 1. Aggregation store: versioned state-directory JSONL is authoritative

Write one compact aggregate event per completed delegation to
`$XDG_STATE_HOME/opencode-smart-router/summary.jsonl`, defaulting to
`~/.local/state/opencode-smart-router/summary.jsonl`. Use a zero-runtime-dependency
JSONL append; do not scan the temporary scorecard directory for normal reports.

Set the directory and file permissions to owner-only (0700 and 0600), and
scrub before persistence. Define bounded retention/rotation in the follow-up
implementation: retain at most 90 days and cap the active file at 10 MiB,
rotating older data out rather than allowing unbounded growth. Handle an
unwritable state directory as a report-availability warning; routing must not
fail because metrics could not be recorded.

**Trade-offs:** unlike tmpdir scanning, durable state survives reboot and is
not mixed across users. Unlike a database, JSONL requires no new dependency and
is easy to inspect/recover. It does add state lifecycle, partial-write, and
retention responsibilities. Do not backfill tmpdir records: combining
best-effort historical files with the authoritative stream risks duplicates,
ambiguous windows, and importing data from another user's shared directory.

### 2. Surface: `osr status --report [--since 7d]`

Extend the existing status command with an opt-in report mode. Keep ordinary
`osr status` concise and fast; report is headless-friendly, discoverable, and
does not depend on an active OpenCode session. Do not add a second `osr report`
command or an in-session `/router-report` command in the first release; these
would duplicate UX and/or require a separate data access path.

Output mock (illustrative values; percentages are relative to the preset
ceiling, while savings use the separate baseline defined below):

```text
OpenCode Smart Router — report (last 7 days)
Data: 2026-09-18 00:00 UTC – 2026-09-25 00:00 UTC

Routing
  Dispatches: 128       Completed: 121       Failed: 7
  Escalations: 19       Escalation rate: 15.7%

Verification
  Verdicts: 113         Pass: 104 (92.0%)    Fail: 9

Tier       Dispatches  Pass rate  Escalations  Mean cost  vs ceiling
fast              71      91.5%           2       0.18       18%
focused           36      93.8%           8       0.46       46%
heavy             21      90.0%           9       0.91       91%

Estimated savings vs always-heavy baseline: 76.4%
Baseline: dispatches × heavy costRatio; routed: sum(cost_units)
No task text or session identifiers are included.
```

The CLI must explicitly label an empty window and missing/unknown preset data;
never render `NaN` or imply that absent records are zero-cost successes.

### 3. Schema and metric definitions

Every JSONL line is an independent, versioned aggregate event:

```json
{"schema":1,"at":"2026-09-25T12:00:00.000Z","tier":"focused","dispatches":1,"completed":1,"failed":0,"verification":{"pass":1,"fail":0,"other":0},"escalations":0,"costUnits":0.46,"costCeiling":1.0,"heavyCostRatio":1.0}
```

`at` is the UTC completion timestamp. `tier` is the final tier for the
delegation. `costUnits`, `costCeiling`, and `heavyCostRatio` are finite numeric
snapshots at completion; the heavy ratio is the configured heavy-tier ratio
from the same preset. `verification.other` captures non-pass/non-fail or
missing verdicts; they are excluded from pass-rate denominator. A failed
completion still contributes one dispatch and a failed count; it contributes
verification only when a verdict exists. Escalation count is the number of
escalations attributable to that dispatch. The implementation must define
record creation exactly once at delegation completion and test retry behavior
to prevent duplicate event writes.

Aggregate per tier and for the requested time window:

- **Dispatches:** sum `dispatches`.
- **Verify pass rate:** `pass / (pass + fail)`; show `n/a` when denominator is
  zero. Report `other` separately rather than counting it as a pass or failure.
- **Escalations:** sum the recorded escalation count; escalation rate is
  escalations / completed dispatches, or `n/a` when there are none.
- **Mean cost units:** sum `costUnits` / dispatches with valid cost data; show
  `n/a` when none are valid.
- **Vs preset ceiling:** mean `costUnits / costCeiling × 100`; omit the
  percentage if ceiling is absent, non-finite, or non-positive. Values above
  100% are valid and must not be clamped.

The schema version is required (`schema: 1`). Unknown schema versions are
skipped with a warning, not interpreted as version 1. There is no migration
for this initial format; future incompatible formats require a new schema
version and explicit reader behavior. The event snapshots keep historical
comparisons stable if preset configuration changes.

### 4. Savings baseline

Define the displayed **estimated savings vs always-heavy baseline** over the
same window and the same set of events with valid `costUnits` and
`heavyCostRatio`:

`100 × (1 - sum(routed costUnits) / sum(heavyCostRatio))`.

Each dispatch represents one hypothetical heavy-tier dispatch, so its
counterfactual cost is that event's snapshot of the preset heavy-tier
`costRatio`. The routed numerator is observed `costUnits`; do not substitute
the tier ceiling or infer cost from tier names. If the baseline denominator is
zero or any required quantity is invalid, render `n/a` and state that data was
insufficient. Do not clamp negative savings or values above 100%; surface the
computed estimate faithfully. This is an estimate from the telemetry cost
model, not a claim about provider-billed currency. The README's 83–92% claim
should cite this formula and its measurement window before being described as
verified.

### 5. Privacy and rollout

Persist only the versioned numeric aggregate event fields shown above. Never
persist task summaries, prompts, raw scorecards, or session IDs in the summary
stream. Render aggregates only; pass any user-facing dynamic strings through
`scrubText` as defense in depth, even though the intended report contains no
raw task text. Do not expose existing raw scorecard logs through this command.

The state directory/file must be owner-only (0700/0600), created safely, and
opened without following symlinks where supported. The SEC-05 temporary-log
permission/rotation hardening remains a companion security item; this ADR does
not claim to fix existing raw logs. The summary stream's independent
90-day/10-MiB retention is part of the feature, not a reason to expose tmpdir
backfill. If secure permissions cannot be established, disable persistence
with an actionable warning rather than writing sensitive data insecurely.

## Rejected alternatives

- **Scan tmpdir on demand:** zero new persistent state, but volatile, shared,
  potentially world-readable, unbounded, and semantically fragile for time
  windows. Rejected as the source of truth and as a backfill source.
- **Standalone `osr report`:** discoverability does not justify another
  top-level command for one read-only view; `status --report` keeps the feature
  alongside current status diagnostics.
- **In-session command:** session-bound and duplicates the CLI, which is the
  useful headless interface for a report.
- **Database/runtime dependency:** unnecessary for append-only aggregate
  events; JSONL meets the initial query needs with no new runtime dependency.
- **Both persistent summary and tmpdir backfill:** duplicates and privacy
  boundaries cannot be reliably resolved from shared, unversioned raw logs.

## Risks and prerequisites

- Summary appends may be interrupted or concurrent. The build plan must use
  safe append semantics, tolerate malformed/truncated lines, and test multiple
  writers; lost metrics must never affect routing.
- The event schema depends on accurate completion semantics and stable
  `costUnits`/preset ratios. Verify fields at the write boundary and cover
  missing values explicitly.
- SEC-05 hardening of existing trajectory logs is still warranted and should
  be sequenced with or before the feature if that writer remains enabled.
- Run the feature after Plan 055 trajectory eviction and after Plan 046's
  verification baseline; the status index already records 055 as pending.

## Follow-up build-plan scope (candidate Plan 063)

- Add a pure, versioned summary-event serializer/validator and durable
  owner-only JSONL store under the XDG state directory.
- Emit exactly one privacy-scrubbed event per completed delegation without
  making routing depend on persistence success.
- Implement retention, bounded parsing, malformed/unknown-version handling,
  and safe concurrent appends.
- Add `osr status --report` and `--since` parsing, aggregation, empty-data and
  unavailable-store behavior, and the output defined here.
- Test formulas, time boundaries, invalid/missing metrics, retries, privacy,
  permissions, and failure isolation; document the savings formula in the
  live README.
- Sequence against Plan 055 and coordinate SEC-05 log hardening; no
  tmpdir-backfill behavior is authorized by this ADR.
