# ADR 0006 — Fanout Productization

> **Status:** Proposed — follow-up implementation plans required  
> **Date:** 2026-09-25  
> **Depends on:** ADR 0002 (Independent Acceptance Gate), ADR 0004 (cost/health/pass-rate read surface), ADR 0005 (delegate graduation)  
> **Inputs:** Plans 047 and 048 are **landed-on-branch, merge pending** as of this spike: `advisor/047-fanout-correctness` at `24de201` and `advisor/048-gate-provenance` at `77a31cb`. Their changes are reviewed/gated branch inputs, not yet physically merged to master.  
> **Scope:** decision only; no production behavior or defaults change in this ADR.

## Context and drift

Fanout returns a markdown aggregate of depth-2 worker results. It currently returns worker text without passing those outputs through ADR 0002's `accept()` gate. In addition, breaker/admission state has no operator read surface and fanout has no preset-level configuration. Plan 062 resolves SEC-04 as a product decision and specifies follow-up work; it does not implement that work.

The spike worktree is based on `8bbee69`, before the plan-047/048 branch changes. The required branch diffs were reviewed as inputs. The 047 diff changes fanout admission-abort slot release, batch-deadline aggregation, and abort/timeout classification; the 048 diff hardens verification command validation/execution and acceptance provenance. **No claim is made that these branch changes are present in this ADR branch.** Plan 056 is not represented here as landed; its shared teardown/logging work remains a distinct follow-up dependency where applicable.

Plan 047 semantics used by these decisions:

- A pre-aborted batch exits before taking slots; an abort race after admission releases slots acquired by that batch.
- Caller cancellation returns silently without a partial aggregate. A batch deadline returns settled results and marks unsettled workers `timed_out`, without awaiting stragglers.
- Abort-like failures are distinguished from qualifying create/prompt timeouts; a create timeout qualifies as a systemic breaker failure.

Plan 048 semantics used by these decisions:

- Verification acceptance provenance distinguishes explicit acceptance from embedded annotation; both are honored, while only inferred DoDs on trivial dispatches may bypass verification.
- Deterministic command validation and execution share a quote-aware tokenizer; execution uses `execFile` argv (no shell), malformed input fails closed, and interpreter code-loading/evaluation flags are rejected.
- The default deterministic allowlist no longer includes arbitrary-code runners (`npx`, `yarn`, `bun`, `node`, `tsx`); explicit configured additions are supported. Grader-fence delimiters in untrusted artifact content are neutralized.

These harden the shared gate's inputs and cancellation/failure behavior; they do not themselves wire fanout into `accept()`.

## Decision

### 1. Gate wiring — per-item verification by default, explicit `off` escape hatch

Add `fanout.verification: "perItem" | "aggregate" | "off"` as a future stable policy. Recommend **`perItem` as the default**: every worker result is independently passed through the existing shared `accept()` gate, using that item's acceptance criteria. This preserves ADR 0002's independent acceptance promise and prevents a strong item from masking a weak one. `off` is an explicit, documented operator escape hatch and must never be an implicit consequence of missing acceptance text. Follow ADR 0002's DoD sourcing/fail-closed rules for missing or uncheckable criteria.

`aggregate` is a supported opt-in for workloads whose acceptance criteria genuinely concern the combined artifact, but it is weaker: one aggregate PASS can conceal an individual failed item. Reject making it the default. Per-item verification costs up to N grader sessions for N workers; deterministic checks avoid grader sessions where applicable. The follow-up must account for grader capacity separately from worker admission slots (do not silently consume/release worker slots as if graders were workers); bound and document grader concurrency against the global budget before shipping.

Only after verification, format each item. A failed verification renders as `failed`, with no unaccepted producer text presented as successful output. Include a concise gate-failure reason; do not expose raw secrets or unsanitized grader content. Timed-out workers remain `timed_out`. A caller abort retains plan 047's silent-empty return contract and emits no misleading partial aggregate.

#### Worker failure mock

```markdown
## Fanout results

### Item 1 — heavy — failed
Verification: FAIL — required output `src/auth.ts` was not changed.

### Item 2 — medium — completed
<verified worker text>

### Item 3 — fast — timed_out
Reason: batch deadline exceeded.
```

`failed` means the worker produced output but acceptance rejected it; it is not a transport error. Do not include the raw rejected text by default. If a future diagnostic mode exposes it, that requires an explicit security review and clear untrusted-data labeling.

#### Gate option / invariant audit

| Invariant | Per-item (recommended) | Aggregate | `off` |
|---|---|---|---|
| Plan 044: admission limits, per-tier caps, breaker qualification, and slot release | Preserved; verification capacity must be bounded independently; worker slots release under 047 semantics | Preserved; one gate after workers | Preserved; no verifier work |
| Plan 044: abort only cancels workers on caller cancellation; no destructive session deletion | Preserved; abort returns silently and does not convert cancellation into gate failure | Preserved | Preserved |
| Plan 045: workers remain depth-2 children of the caller; no depth 3 | Preserved; graders are separate gate-owned sessions and must not be parented as worker descendants or alter worker parentage | Preserved | Preserved |
| Plan 047: pre-abort takes no slots; raced abort releases acquired slots; batch deadline aggregates settled results and times out the rest | Preserved; do not block cancellation/deadline on graders or leak worker slots | Preserved; gate the settled aggregate only | Preserved |
| Plan 047: abort-like errors do not qualify as breaker failures; systemic create timeout does | Preserved; verifier outcomes are separate from worker breaker qualification | Preserved | Preserved |
| ADR 0002: independently accept output; fail closed; grader differs from producer and is not below producer tier | Preserved per item | Weaker granularity: aggregate pass can hide a failed item | Explicitly disabled; this is a documented weakening, never silent acceptance |

No option requires relaxing depth, deletion, abort, slot-release, or breaker invariants. `off` intentionally opts out of ADR 0002 acceptance for fanout and must be visible in configuration and telemetry. Plan 048's safe command execution and provenance rules apply unchanged to each gate invocation.

### 2. Telemetry and operator read surface — per-worker attribution, shared `osr status --report`

Record a trajectory entry for every worker with its worker session ID, parent caller/batch correlation ID, tier, terminal status, and `cost_units` when available. The worker session's cost is attributable to its own session; associate it with the batch through the recorded parent/correlation ID, not by guessing from aggregate totals. Grader usage is separately attributable and must not be counted as worker cost.

Enrich `fanout.batch_completed` with requested/completed/failed/timed-out counts, verification mode and pass/fail counts, worker and grader cost-unit subtotals (unknown stays unknown; never fabricate zero), duration, and breaker state before/after the batch. Do not log prompts or raw worker output.

Expose breaker state and fanout admission limits in the `osr status --report` read surface designed by ADR 0004, rather than creating a competing status command or relying on log-only visibility. Include per-tier breaker state/cooldown and current configured limits, with unavailable state clearly distinguished from closed. This pairs fanout diagnostics with cost/health/pass-rate reporting. The report is observational and must not mutate/reset breaker state.

Trade-off: richer correlated records and report fields add telemetry schema and privacy/retention obligations. A log-only design is cheaper initially but cannot answer whether a batch is being rejected by an open breaker; it is rejected.

### 3. Presets — optional fanout overrides merged preset-over-global

Add an optional preset-level `fanout` object. Omitted fields inherit the global fanout configuration; explicitly supplied preset fields override the corresponding global fields. Omission must preserve current global/default behavior.

```json
{
  "presets": {
    "balanced": {
      "fanout": {
        "enabled": true,
        "maxWorkersPerBatch": 3,
        "verification": "perItem",
        "breaker": { "failureThreshold": 3, "cooldownMs": 60000 }
      }
    }
  }
}
```

The sketch is additive; exact typed fields should reuse the established global `FanoutConfig` shape rather than fork a second schema. `maxConcurrentGlobal`, timeouts, and per-tier caps can be preset-overridden only if the global config already supports them and validation can preserve its invariants; this ADR's minimum preset surface is `enabled`, `maxWorkersPerBatch`, and `breaker`, plus the verification policy decided above. Do not silently let a preset escape global safety ceilings.

Validation requirements:

- Validate each preset fanout field with the same bounds/type checks as the corresponding global field.
- Validate `maxConcurrentPerTier` keys against the effective tiers available to that preset, reusing the existing tier-cap key rule; reject unknown tiers rather than ignoring them.
- Resolve preset-over-global before cross-field checks so effective limits remain coherent; enforce worker-per-batch/global concurrency and breaker threshold/cooldown constraints.
- Reject unknown fanout/verification values and malformed objects with the existing config validation error style.
- Test omitted, partial override, full override, invalid tier keys, and unsafe combinations.

CONFIG_REFERENCE should add a **Fanout presets** section after the global fanout configuration, showing the preset-over-global precedence, supported keys and bounds, tier-key validation, and an example. It should explain that `verification: "off"` is an explicit acceptance bypass and describe the cost/latency impact of per-item grading.

Trade-off: per-preset control matches other preset UX but multiplies effective config combinations. Restricting the first implementation to a narrow supported subset limits validation and support burden; cloning the entire global schema into presets is rejected.

### 4. Interaction and disposition

The SEC-04 finding (“fanout results bypass the acceptance gate”) is **resolved by this decision, not by a shipped code fix**. Fanout remains ungated until the follow-up gate-wiring plan is implemented; do not describe this ADR alone as runtime remediation. Native `task` verification and the plugin-owned `delegate` remain governed by ADR 0002/0005; this ADR does not decide delegate graduation and adds no fanout-specific conclusion about its default registration.

| Binding contract | Decision interaction |
|---|---|
| Plan 044: admission preconditions, bounded batch size/global and per-tier caps, breaker FSM and qualification rules | Preserve. Gate/grader failures do not become worker breaker failures; worker failures continue to qualify only under existing FSM rules. |
| Plan 044: all worker outcomes represented in deterministic aggregate order | Preserve ordering; add verification outcome without reordering or dropping items. |
| Plan 045: worker sessions are caller-parented depth-2 children; no depth 3 | Preserve worker parentage. Gate sessions are verifier-owned and must not be inserted between caller and worker. |
| Plan 045: no `session.delete`; use abort/cleanup contract | Preserve; no destructive deletion introduced by verification. |
| Plan 047: pre-abort check, abort-race slot release, cancellation silent return | Preserve exactly; never return a misleading partially verified result after caller cancellation. |
| Plan 047: deadline returns settled-so-far and `timed_out` for unsettled workers, without awaiting stragglers | Preserve; gate only available results and ensure verifier latency is separately bounded. |
| Plan 047: abort classification and create-timeout breaker qualification | Preserve; `AbortError` is not a qualifying worker failure; systemic session-create timeout is. Gate FAIL is not a transport timeout. |
| Plan 048: provenance, fail-closed verification, safe deterministic execution | Reuse shared `accept()` and DoD provenance. Do not add a fanout-specific gate implementation or weaken safe command checks. |

## Follow-up build-plan outline (no implementation in this spike)

1. **Presets + validation (independent):** types, merge precedence, validation, config docs, unit coverage; preserve global defaults and safety limits.
2. **Telemetry + `osr status --report`:** per-worker trajectory correlation/cost, batch event enrichment, breaker/admission read view coordinated with ADR 0004; tests for unknown cost and read-only state.
3. **Gate wiring (last; highest risk):** per-item default, explicit `aggregate`/`off`, bounded grader capacity, fail rendering, depth/abort/slot/breaker regression tests, no rejected raw text leakage. Requires focused security and cost review.

These are scope bullets only; follow-up plans must be numbered 063+ and verified against the post-046 baseline. Do not change defaults until the gate/telemetry behavior is implemented and documented.
