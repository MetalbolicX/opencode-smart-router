# Plan 062 (SPIKE): Fanout productization — gate wiring, telemetry, presets (and settling the gate-bypass finding)

> **Executor instructions**: DESIGN/SPIKE plan — investigate, decide,
> write the decision document. **No production code changes.** Honor STOP
> conditions. Update your row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/plugin/fanout.ts src/plugin/fanout-store.ts src/verify/dispatch.ts src/verify/gate.ts src/plugin/runtime.ts src/router/config-validate.ts`
> Plans 047/048/055/056 touch these files — execute this spike AFTER them
> (their outcomes are inputs). Note drift in the doc.

## Status

- **Priority**: P2
- **Effort**: M (spike)
- **Risk**: LOW for the spike; the decisions it feeds carry MED risk (gate
  wiring changes fanout's cost/latency contract)
- **Depends on**: plans/046, 047, 048 (their landed semantics are inputs)
- **Category**: direction (design/spike)
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

Fanout (plans 044/045, the newest feature) is functionally minimal and
leaks three productization gaps the architecture already supports:

1. **Acceptance-gate bypass (audit SEC-04, MED confidence — this spike is
   its proper resolution)**: N depth-2 worker outputs return to the caller
   raw — `shouldVerifyTask` gates only `tool === "task"`
   (`src/verify/dispatch.ts:174-183`); the only `accept()` callers are the
   delegate path (`delegate.ts:529`) and the task dispatch path
   (`dispatch.ts:387`). Fanout workers are producer sessions
   (`registerProducerSession` at `fanout.ts:390`) whose output escapes the
   "never accept self-reported completion" promise (ADR 0002). A
   lower-privilege child session gets unverified worker text back.
2. **Invisible containment state**: the circuit breaker
   (`fanout-store.ts:213-275`) and admission caps have NO read surface — a
   suddenly-rejected batch (`circuit_open`) is only visible via `log.warn`.
3. **No preset knobs**: fanout config is a single top-level block
   (`config.types.ts:280-303`); the preset UX (budget/quality presets set
   `costCeiling`/tier mixes) has no fanout representation — users hand-edit
   globals inconsistently with how everything else is configured.

## Current state (evidence, verified during audit cycle 7)

- Gate wiring facts: `src/verify/gate.ts:1-9` (one accept path shared by
  both wirings, GA-5); `src/verify/dispatch.ts:174-183`
  (`shouldVerifyTask`); accept callers: `delegate.ts:529`,
  `dispatch.ts:387` only. Fanout aggregate: `fanout.ts:501-579`
  (`formatItemResult` markdown returned raw to caller).
- Worker shape: `FanoutArgs { items: {tier, prompt}[] }`
  (`src/plugin/types.ts:227-229`) — no acceptance field per item.
- Containment: `DEFAULT_FANOUT_CONFIG` (`config.types.ts:295-303`):
  maxWorkersPerBatch 4, maxConcurrentGlobal 6, per-tier caps, timeouts,
  breaker {3, 60s}. Breaker FSM + `breakerState()` accessor
  (`fanout-store.ts:265-275`) — accessor unused outside the store/tests.
- Depth contract (plan 045, binding): workers are depth-2 children of the
  CALLER (`session.create({body:{parentID: callerSid}})` at
  `fanout.ts:339-342`); no depth 3. Any gate wiring must not break this or
  the abort/cleanup invariants (plans 047/056 own those).
- Stale markers to sweep during the spike (documentation truth, not code):
  `src/plugin/types.ts:238` ("stub returns the rejection variant only" —
  stale PR-3a note on a shipped type),
  `openspec/changes/tier-fanout-tool/apply-progress.md:91` ("pre-existing
  errors in fanout.ts (out of scope for PR 5)") — the duplicate un-archived
  openspec dir is removed by plan 054; cite the archive copy.
- Cost context: a grader session per worker multiplies sessions per batch
  (N workers + N graders, against maxConcurrentGlobal) — the trade-off at
  the heart of Question 1.

## Questions this spike MUST answer

1. **Gate wiring for depth-2 workers** — options with trade-offs:
   (a) per-item verification: extend `FanoutArgs.items` with optional
   `acceptance`; each worker's output passes `accept()` with per-item DoD
   (strongest ADR-0002 fidelity; N grader sessions per batch; interacts
   with caps — does a grader consume a global slot?);
   (b) aggregate verification: one `accept()` on the combined artefact
   (cheaper; but "aggregate pass" can hide a weak item);
   (c) config-gated: `fanout.verification: "perItem" | "aggregate" | "off"`
   defaulting to perItem-or-aggregate per the ADR, with `off` as the
   explicit escape hatch (documented, not silent).
   Recommend one default + knob; specify what a worker `FAIL` renders as
   in the markdown aggregate (status vocabulary already has
   `failed`/`timed_out`).
2. **Telemetry** — trajectory record per worker (cost_units attribution —
   can a worker's cost be tied to its parent batch?) + one
   `fanout.batch_completed` enrichment (already logs counts; add
   cost_units sum + breaker states). Decide the read surface for breaker
   state: `osr status` section vs log-only (coordinate with plan 060's
   report design — same surface should carry both).
3. **Presets** — propose the preset-level fanout key
   (`fanout: {enabled?, maxWorkersPerBatch?, breaker?}` merged
   preset-over-global like other preset fields), validation rules for
   `config-validate.ts` (tier-cap keys ∩ preset tiers — reuse the existing
   `maxConcurrentPerTier` rule at config.types.ts:284), and the
   CONFIG_REFERENCE section outline.
4. **Interaction audit** — enumerate every invariant plans 044/045/047
   pinned (depth-2 only, no session.delete, abort-on-failure-only, slot
   release, breaker qualification rules) and confirm each option above
   preserves them; call out ANY option that requires relaxing one.

## Deliverable

`docs/adr/0006-fanout-productization.md` (number coordinated with
054/060/061 → 0003/0004/0005): the four answers, one recommendation each
with rejected alternatives, a worker-FAIL rendering mock, the preset schema
sketch, and a stub build-plan section (scope bullets only — likely 2-3
build plans: gate wiring; telemetry+read surface; presets+validation).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Gate callers | `rg -n "accept\(" src/ \| grep -v test` | exactly the two known call sites |
| Breaker surface | `rg -n "breakerState" src/ test/` | store + tests only (no UI) |
| Fanout config refs | `rg -n "fanout" src/router/config-validate.ts src/router/config.types.ts` | validation + types inventory |

## Scope

**In scope**:
- `docs/adr/0006-fanout-productization.md` (create)
- `plans/README.md` (status row; mark audit finding "fanout bypasses gate" as resolved-by-decision)

**Out of scope**:
- ANY code/test change; writing the build plans; changing fanout defaults

## Steps

1. Re-verify the three command outputs; read plans 044/045 (archive) +
   047/056 outcomes for the invariant list.
2. Answer Q1–Q4 with cited evidence; one recommendation each.
3. Write the worker-FAIL rendering mock + preset schema sketch.
4. ADR + index row (explicitly recording the SEC-04 disposition).

## Done criteria

- [ ] `docs/adr/0006-fanout-productization.md` exists; 4 answers, no TBDs
- [ ] Gate-wiring recommendation names its default AND its escape hatch
- [ ] Invariant audit table complete (every 044/045/047 invariant × option)
- [ ] `git status` shows only the ADR + index
- [ ] `plans/README.md` row updated + SEC-04 disposition recorded

## STOP conditions

- Plan 047/048/056 have not landed (their semantics are inputs — re-check
  the index; if blocked, execute after).
- The gate wiring question cannot be answered without the delegate-
  graduation decision (plan 061) — if they entangle, MERGE the open
  question into 061's ADR and note it here.

## Maintenance notes

- The build plans that follow should sequence: presets (independent) ∥
  telemetry (pairs with 060), gate wiring last (highest risk).
