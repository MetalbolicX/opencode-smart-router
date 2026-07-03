# Implementation Plan — Enforced Delegation Architecture for `opencode-agent-router`

> **Status:** Draft **v2** (review-hardened; ready to execute)
> **Owner:** Marco Jardim
> **Scope:** Add a three-layer enforcement-and-verification architecture (hard-block guard → independent acceptance gate → quality escalation ladder) on top of the existing prompt-based router, covering **both** usage modes: (1) on-the-fly delegation by a top-tier orchestrator, and (2) execution that follows `[tier:X]` annotations baked into a plan.
> **Repo facts at planning time:** single-file plugin `src/index.ts` (~1197 lines), `tiers.json` config, `type: module`, `main → ./src/index.ts` (TypeScript run directly by the OpenCode loader; no build step), `package.json` ships `files: ["src/", "tiers.json", "LICENSE", "README.md"]`, peer dep `@opencode-ai/plugin >= 1.0.0`, devDeps `typescript` + `@types/node`. **No tsconfig, no test runner, no test files.** Hooks currently registered: `chat.message` (:934), `tool.execute.after` (:968), `experimental.text.complete` (:999), `config` (:1016), `experimental.chat.system.transform` (:1114), `command.execute.before` (:1144). **`tool.execute.before` is absent** (this is the hook that *might* be able to `throw` to hard-block — to be proven in Phase 0.0).

> ### Review-driven revisions (v2 — what changed vs v1)
> A senior agentic-coding review hardened this plan. Material changes:
> - **C1/C2 — Added `Wave 0 / Phase 0.0`: an Enforcement-Primitives Spike that GATES the whole plan.** Waves 1–3 are now explicitly *conditional* on what the SDK can actually do (before-hook abort, custom tool registration, subagent-return interception). The **artefact contract** the acceptance gate verifies is now a first-class deliverable of the spike.
> - **C3 — Grader strength fixed:** the independent checker must be **≥ the producer tier** (never the cheapest tier), to avoid weak-grader false-PASS that would re-introduce self-policing.
> - **C4 — Packaging fixed:** all tests live in a top-level `test/` directory **outside `src/`**, so `files: ["src/"]` never ships tests.
> - **M1 — Real-OpenCode integration smoke per layer** added alongside the fake harness (offline-green ≠ works-live).
> - **M2 — DoD default is auto-inferred** for on-the-fly Mode A (strict-required is opt-in), so live sessions never stall.
> - **M3 — The checker (LLM-graded) path is treated as the common case** and invested in accordingly (grader prompt, pinned low temperature, robust verdict schema, anti-rubber-stamp calibration).
> - **M4 — Escalation cost base defined + a `floorTier`/skip-ladder option** so predictably-hard tasks don't pay the full escalation tax.
> - **M5 — Honest framing of "deliverable-first":** in general coding it often no-ops; Layer-1's generalizable value is budget + anti-redundancy + anti-self-script.
> - **M6 — GA-7 token budget relaxed & made conditional:** protocol additions are injected **only** when enforcement is on, and the budget is measured, not assumed.
> - **M7 — New §5.6 on concurrency** (parallel subagents + shared-workspace verification races).
> - **Minor:** envGate truth table (m1), trivial-classification timing (m2), assembled-prompt golden snapshots (m3), property-based tests for guard/ladder (m4), preliminary-tuning caveat (m5), grader temperature pinning (m6), QA report instead of an ADR for sign-off (m7).

---

## 0. Why this plan exists (motivation)

A separate, controlled experiment (the AgentCity SWE-test harness) demonstrated a reproducible result: **weak / non-frontier models become reliable when execution is *enforced at the tool loop*, and stay unreliable when they are merely *instructed* and trusted to self-police.**

Empirical signal (model = Kimi `accounts/fireworks/routers/kimi-k2p6-turbo`, live):

- **Enforcement contrast (3 tasks):** `enforced` 3/3 PASS · `guided` 1/3 · `freeform` 1/3.
- **Easy task at N=5:** `freeform` 60% · `guided` 100% · `enforced` 100%.
- **Three failure modes without a hard-block:** `freeform` = *thrash* (flails until the budget cap), `guided` = *false-finish* (declares "done" without producing the deliverable), `enforced` = *correct* (a "deliverable-first" guard pins time-to-first-action = 1).

`opencode-agent-router` today is exactly the *guided* condition: it injects an excellent delegation protocol and appends advisory cap/redundancy/narration banners, but **every control is advisory** and the subagent's `DONE: / NEED MORE: / ESCALATE:` return is **self-reported**. There is **no hard-block, no objective acceptance of a subagent's output before the orchestrator trusts it, and no quality-based escalation** (the only fallback today is provider-level failover on API error).

**Thesis of this plan:** convert the router from *"the weak model says it finished"* into *"the weak model's output was objectively accepted"* — with proportional, opt-in enforcement that does not over-engineer trivial work.

The proven reference implementation to port from lives at
`D:\git\agent-city-frontend\scripts\agent-city\agent-test\` →
`guards.mjs` (266 lines, the **pure** rule engine) and `opencode-plugin.mjs` (317 lines, the **enforcement point**: a `tool.execute.before` hook that `throw`s to hard-block). A Python mirror exists at `hermes_crew/guards.py`. These are templates, not dependencies.

**Honest scope note (M5):** in the harness the "deliverable" was a single known GIVEN op, which made "deliverable-first" trivially enforceable. Generalised to arbitrary coding tasks the deliverable is fuzzy, so deliverable-first frequently no-ops. The **generalisable** value of the hard-block layer is therefore: **budget ceiling + anti-redundancy + anti-self-script**; deliverable-first is a bonus that fires only when a deliverable signal exists.

---

## 1. How to execute this plan (read first)

### 1.1 Standing directives (NON-NEGOTIABLE)

- **DIRECTIVE A — Iterate continuously.** Execute the plan wave by wave, phase by phase, **without stopping for confirmation between phases**. Only halt and ask the human when you hit one of:
  1. an **ambiguous** decision that materially changes scope/behaviour and has no clearly-correct default (see *Open Questions*, §13);
  2. a **critical** defect (data loss, broken plugin load, regression that breaks normal routing);
  3. a **blocking** external dependency (missing API access, **or an OpenCode SDK capability that Phase 0.0 proves does not exist**).
- **DIRECTIVE B — Commit often.** Commit at the end of every **task** (not just every phase), using Conventional Commits (`feat(router): …`, `test(router): …`, `refactor(router): …`, `docs(router): …`, `chore(router): …`). Never `git add -A`; stage only the files you changed. **Do not stage the pre-existing dirty files** (`package.json`, `tiers.json` were already modified on `master` before this plan — leave them to their owner unless a task explicitly edits them, and if so, stage only your intended hunks).
- **DIRECTIVE C — Pre-flight before every phase, Senior-QA review after every phase, fix-all before moving on.** No phase is "done" until its QA review findings are all resolved and its DoD is green.
- **DIRECTIVE D — Behaviour-preserving by default.** Normal (non-enforced) routing must remain **byte-for-byte unchanged** unless a task explicitly changes it. All new behaviour ships **opt-in behind a flag** (see §5.4) and **off by default** until Wave 5 decides otherwise.
- **DIRECTIVE E — The plan is conditional on Phase 0.0.** The chosen architecture (plugin-owned vs protocol-enforced) and the exact wiring of Layers 1–3 are **selected by the Phase 0.0 spike results**. Do not pre-build a layer whose required SDK primitive the spike has not confirmed.

### 1.2 Model-router self-annotation (this plan is itself routable)

Every task/subtask below is tagged with `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` so that an orchestrator running *this very plugin* can route execution (per `tiers.json` rule 1: `[tier:X] tag in plan → delegate X`). Legend:

| Tag | Use for | Typical work in this plan |
|-----|---------|---------------------------|
| `[tier:fast]` | read-only recon, grep/read, locating code, verifying current behaviour, doc lookups | pre-flight checks, "find where X is wired", reading SDK typings |
| `[tier:medium]` | implementation, refactors, writing tests, wiring hooks, config edits, fixing build/test failures | the bulk of each phase |
| `[tier:heavy]` | architecture/design decisions, the spike analysis, the verification-gate & escalation design, security review, **every Senior-QA review**, resolving ambiguous cross-cutting calls | Phase 0.0 analysis, ADRs + per-phase QA |

> When this plan is executed under model-router itself, the orchestrator should **gather context with `[tier:fast]` before dispatching a `[tier:heavy]` design task** (heavy has no Task tool of its own).

### 1.3 The per-phase ritual (applies to EVERY phase)

1. **Pre-flight check** `[tier:fast]` — confirm the repo is in the expected state, the previous phase's artefacts exist, tests are green, and the inputs this phase needs are present. Abort the phase if pre-flight fails.
2. **Tasks & subtasks** — implement, committing often (Directive B).
3. **New tests** — added/extended this phase, with explicit coverage targets and the enumerated edge cases. **For Waves 1–4, this includes at least one real-OpenCode integration smoke for the layer (M1), not only fake-harness tests.** Tests must pass before QA.
4. **Acceptance criteria** — objective, checkable statements that define "this phase delivered its value".
5. **Definition of Done (DoD)** — the checklist that must be fully green.
6. **Senior-QA review** `[tier:heavy]` — an independent, adversarial review against the acceptance criteria + DoD + the global invariants (§6). **Produce a written findings list; fix every finding; re-run tests; only then proceed.**

---

## 2. Current architecture (baseline, do not break)

- **Routing = prompt injection.** `experimental.chat.system.transform` (:1114) injects `buildDelegationProtocol()` (:456, ~210 tokens) into the **orchestrator** system prompt; subagent sessions are skipped. For Claude models it prepends `CLAUDE_ORCHESTRATOR_PREFIX` (:809) + an anti-narration clause.
- **Delegation = OpenCode built-in `Task(subagent_type="fast"|"medium"|"heavy", prompt=…)`.** There is **no** custom delegate tool today. Tier agents are registered in the `config` hook (:1016) from the active `tiers.json` preset.
- **Subagent detection.** `chat.message` (:934) matches `input.agent` to a tier name → records `sessionID` in a `subagentSessionIDs` Set and initialises per-session cap state; `parseCapDirective` reads `CAP:N` from the dispatch text.
- **Advisory controls (the part we will harden).** `tool.execute.after` (:968) appends `[cap: N/MAX]`, `[⚠ REDUNDANT]`, `[⚠ CAP REACHED]` banners to read-only tool results (grep/read/glob/ls), using `fingerprintToolCall`. `experimental.text.complete` (:999) appends a narration-detected banner. **All observe-after-the-fact; none can block.**
- **Config.** `tiers.json`: `tierCaps {fast:8, medium:5, heavy:3}`, presets (`anthropic`, `openai`, `github-copilot`, `google`, `hybrid`), modes (`normal`, `budget`, `quality`, `deep`), `taskPatterns`, `rules`, `tierPrompts`, provider-only `fallback`. State persisted at `~/.config/opencode/opencode-agent-router.state.json`.

**Invariant:** none of the above changes semantics for a *normal* (non-subagent, non-enforced) session unless a task explicitly says so.

---

## 3. Target architecture (the three layers + two modes)

```
                       ┌─────────────────────────────────────────────────────────┐
                       │  ORCHESTRATOR (top tier) — on-the-fly OR plan-driven      │
                       │  dispatches work to a tier subagent                        │
                       └───────────────┬─────────────────────────────────────────┘
                                       │  delegation (Task()  OR  plugin `delegate` tool)
                                       ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ LAYER 1  HARD-BLOCK GUARD  (tool.execute.before → throw)        [needs Spike cap. A] │
   │   budget ceiling · anti-redundancy · anti-self-script  (+ deliverable-first if signal)│
   │   forcing message injected on block ; trajectory recorded                           │
   └───────────────┬───────────────────────────────────────────────────────────────────┘
                   │ subagent produces an ARTEFACT (see contract §3.3) + self-reported status
                   ▼
   ┌───────────────────────────────────────────────────────────────────────────────────┐
   │ LAYER 2  INDEPENDENT ACCEPTANCE GATE  (producer ≠ grader)  [needs Spike cap. B or C] │
   │   DoD attached to the delegation (dispatch / auto-inferred / plan annotation)        │
   │   verify via (a) deterministic check (tests/build/lint/file/schema)                 │
   │            or (b) an independent checker tier ≥ producer → PASS / FAIL + reasons      │
   └───────────────┬───────────────────────────────────────────────────────────────────┘
              PASS │ │ FAIL
                   │ ▼
                   │ ┌─────────────────────────────────────────────────────────────────┐
                   │ │ LAYER 3  ESCALATION LADDER                                         │
                   │ │   retry same tier (failure reasons injected) → escalate           │
                   │ │   floorTier..heavy ; bounded attempts ; cost ceiling (defined §5.4)│
                   │ │   never silently returns a FAIL                                    │
                   │ └─────────────────────────────────────────────────────────────────┘
                   ▼
            accepted result returned to the orchestrator (+ trajectory scorecard)
```

### 3.1 Two usage modes (both first-class)

- **Mode A — On-the-fly.** The orchestrator dispatches ad-hoc during a live session. **The DoD is auto-inferred from task type by default (M2)** so the session never stalls; the orchestrator may override with an explicit DoD; `enforcement.verify.requireExplicitDoD` (opt-in) makes a missing/explicit DoD a hard requirement instead.
- **Mode B — Plan-annotated.** Execution follows a plan whose tasks carry `[tier:X]` **and** an acceptance block. The plugin reads the plan annotation as the DoD source. The existing `/annotate-plan` command (registered in the `config` hook) is extended to emit acceptance criteria alongside tier tags. Mode B may be **strict by default** (a non-trivial task lacking an acceptance block is a plan-authoring error surfaced clearly).

### 3.2 The "delegate tool" decision (selected by Phase 0.0)

Two ways to make the plugin **own** the produce→verify→accept/escalate loop:

- **Option (i) Protocol-enforced verify-dispatch** — strengthen the injected protocol so the orchestrator runs a verify step; the plugin enforces presence of a DoD and records verdicts. *Lower effort; still partly relies on orchestrator compliance → Layer 2 is effectively advisory.*
- **Option (ii) Plugin-provided `delegate` tool** — the plugin registers a custom `delegate` tool that wraps `Task()`; the plugin fully owns produce→verify→accept/escalate and returns only an accepted result. *Most robust; the recommended end-state.*

**Decision rule (DIRECTIVE E):** Phase 0.0 determines feasibility. If capability **B** (register a usable custom tool) **or** capability **C** (intercept a subagent's final return) exists → build Option (ii) as the robust path while keeping raw `Task()` working via Option (i). If **neither** exists → Layer 2 ships as **Option (i) only and is documented as advisory-grade**, and this limitation is escalated to the owner as a scope decision (it materially weakens the core thesis — see Open Q1).

### 3.3 The artefact contract (C2 — what the gate actually verifies)

The acceptance gate is meaningless without a precise definition of *what* it receives and *where* it checks. Phase 0.0 must pin this down empirically; the **target contract** is:

- **Artefact = the concrete, inspectable result of the delegation**, one of: (a) the set of workspace files the subagent created/modified (preferred — discovered via the shared workspace + the subagent's own edit tool calls observed in `tool.execute.after`), plus (b) the subagent's final text return (summary/answer), plus (c) any explicit output path declared in the DoD.
- **Verification locus = the single shared OpenCode workspace** (producer and verifier share the same working tree in one session). Deterministic checks run there via an injected `exec`/`fs` seam (timeouts + command allowlist).
- **If the SDK cannot expose the subagent's changed-file set or final return** (Phase 0.0 capability C = false), the gate falls back to verifying only what the DoD names explicitly (declared output paths / declared check commands), and "free-form text-only" deliverables can only be checker-graded on the returned text — documented as a known limitation.

---

## 4. Waves overview

| Wave | Theme | Outcome |
|------|-------|---------|
| **0** | **Spike + Foundations** | **Phase 0.0 capability spike (GATES everything)**; then test infra + tsconfig; pure logic extracted from the monolith under characterization tests; opt-in config + per-session state + trajectory scaffolding. **No behaviour change.** |
| **1** | Layer 1 — Hard-block guard | `tool.execute.before` that throws (if Spike cap. A); ported guard engine; advisory→enforced; proportional + opt-in. |
| **2** | Layer 2 — Acceptance gate | DoD schema + delegation contract (both modes, auto-inferred default); deterministic + **checker (grader ≥ producer)** verifiers; the `delegate` tool / verify-dispatch per Phase 0.0. Producer ≠ grader. |
| **3** | Layer 3 — Escalation | Retry-then-escalate ladder (floorTier..heavy), bounded + cost-capped (defined base); composes with provider failover. |
| **4** | Modes + nuance + E2E | On-the-fly E2E, plan-annotation E2E, proportional tuning (preliminary), docs. |
| **5** | Hardening + release | Regression, coverage gate, overhead budget, global QA, release decision (default on/off). |

---

## 5. Cross-cutting design decisions (apply to all waves)

### 5.1 Testability requires de-monolithing (non-negotiable)
You cannot unit-test a 1197-line hook closure. Wave 0 extracts **pure** logic into importable modules under `src/`:

```
src/
  index.ts                 # plugin wiring only (hooks call into modules)
  router/
    config.ts              # load/validate tiers.json + enforcement block, schema, defaults
    sessions.ts            # subagent session detection + per-session state + concurrency
    protocol.ts            # buildDelegationProtocol + prompt prefixes
  guard/
    guards.ts              # PURE evaluateGuards, classify, isSelfScript, state, forcingMessage
    fingerprint.ts         # redundancy fingerprinting (moved from after-hook)
  verify/
    dod.ts                 # DoD schema + parser + auto-inference (dispatch + plan annotation)
    deterministic.ts       # check runners (tests/build/lint/file/schema)
    checker.ts             # independent checker-tier dispatch (grader ≥ producer) + verdict parse
    gate.ts                # acceptance-gate orchestration + artefact assembly
  escalate/
    ladder.ts              # PURE escalation policy (floorTier..heavy, bounded, cost-capped)
  telemetry/
    trajectory.ts          # per-delegation scorecard

test/                      # ALL tests live HERE, OUTSIDE src/  (C4: never shipped via files:["src/"])
  unit/ … integration/ … golden/ … smoke/
```
**Rule:** every module under `guard/`, `verify/`, `escalate/`, `telemetry/` exposes **pure, dependency-injected** functions (no direct SDK/network/fs inside the pure core; side effects live in `index.ts` adapters and injected seams). This mirrors `guards.mjs` (pure) vs `opencode-plugin.mjs` (wiring) in the reference.

### 5.2 Testing strategy
- **Runner:** **Vitest** (zero-config TS + ESM, watch + coverage via `@vitest/coverage-v8`). Rationale: project is `type: module` TS run directly; Vitest needs no build and matches the sibling `mcp-server` choice. *Alternative considered:* `node:test` + `tsx` loader — rejected as more wiring for less ergonomics. Dev-only; **never shipped** — tests live in top-level `test/`, and `files` already restricts the npm package to `src/`, `tiers.json`, `LICENSE`, `README.md` (C4).
- **Test kinds:**
  1. **characterization/golden** — snapshot *current* behaviour before any refactor (Wave 0), including the **fully-assembled injected system prompt and the after-hook banner output for several real scenarios** (m3), not just per-helper outputs.
  2. **unit** — every pure function; **branch coverage ≥ 90%** on new pure modules.
  3. **property-based** (m4) — for the guard counters and the escalation ladder: assert **termination** (no infinite escalation), monotonic counters, and "never silent FAIL" across randomized inputs.
  4. **integration (fake hook harness)** — an in-repo simulation of `tool.execute.before/after`, `chat.message`, session lifecycle, so we never need a live model for logic coverage.
  5. **real-OpenCode integration smoke (M1)** — a thin, opt-in smoke per layer that runs the plugin **inside a real OpenCode invocation** (faked/cheap model where possible) to confirm the SDK actually invokes hooks as assumed (order, subagent-session firing, throw-aborts). Lives in `test/smoke/`, documented run command, **not** part of the default `npm test` (gated behind `RUN_OC_SMOKE=1`). Rationale: the reference harness's worst bugs were live-only (config schema, stdin hang, plugin/zod resolution); offline-green is necessary but not sufficient.
- **No live-model calls in default CI.** Checker-tier and provider calls are behind injected seams and faked.

### 5.3 Telemetry / trajectory scorecard
Per delegation, record (snake_case, matching the reference): `ttfa`, `read_exec_ratio`, `self_script_count`, `deliverable_executed`, `tool_call_count`, `stop_reason`, plus Layer-2/3 fields: `dod_source` (`explicit|inferred|annotation`), `verdict` (`PASS|FAIL|SKIPPED`), `verify_method` (`deterministic|checker|none`), `grader_tier`, `attempts`, `escalations`, `final_tier`, `cost_units`. Used for tuning and the proportional policy.

### 5.4 Configuration & opt-in gating
Extend `tiers.json` with an additive `enforcement` block (validated, fully optional, defaults = current behaviour):

```jsonc
"enforcement": {
  "mode": "off",            // "off" | "advisory" | "enforced"   (default "off")
  "envGate": "MODEL_ROUTER_ENFORCE",  // see truth table below
  "perTier": {              // optional per-tier override of mode
    "fast": "advisory", "medium": "enforced", "heavy": "enforced"
  },
  "guard": { "readDraftCap": 3, "sameOpRetryCap": 1, "blockSelfScript": true, "deliverableFirst": true },
  "verify": {
    "require": "whenDoDPresent",   // "never" | "whenDoDPresent" | "always"
    "requireExplicitDoD": false,   // Mode A: false ⇒ auto-infer (default); true ⇒ demand explicit DoD
    "preferDeterministic": true,
    "graderPolicy": "atLeastProducerTier",  // grader tier ≥ producer tier (C3); never below
    "graderTemperature": 0          // pin low for verdict stability (m6)
  },
  "escalate": {
    "floorTier": null,        // optional: start no lower than this tier (skip-ladder for hard tasks, M4)
    "ladder": ["fast","medium","heavy"],
    "maxAttemptsPerTier": 1,
    "maxTotalAttempts": 4,
    "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 4 }  // M4: base defined
  },
  "proportional": { "trivialBypass": true, "trivialClassifier": "dispatchIntent" } // m2: classified at dispatch
}
```

- **Default `mode: "off"`** ⇒ plugin behaves exactly as today. `"advisory"` ⇒ Layer-1 conditions are evaluated and surfaced as banners (current style) but do not throw; Layer-2 verdicts are recorded but not enforced. `"enforced"` ⇒ Layer 1 throws and Layer 2 gates per `verify.require`.
- **`envGate` truth table (m1):** env var **unset** ⇒ use `mode`/`perTier` from config. env var = `"1"` ⇒ force **enforced** (overrides config). env var = `"0"` ⇒ force **off** (overrides config). Any other value ⇒ treated as unset (use config) + a one-time warning.
- **Grader policy (C3):** `graderPolicy: "atLeastProducerTier"` means the checker tier is `max(producerTier, verify.minGraderTier?)` along the ladder; it must **never** be below the producer tier and must **never** be the same model instance/session that produced the artefact (producer ≠ grader). For deterministic checks no grader model is used.
- **Cost ceiling (M4):** `base = firstAttemptCostUnits` (the cost units of the first producing attempt, captured in telemetry); escalation stops once cumulative cost exceeds `base × multiple`. `floorTier` lets the orchestrator/plan pin a starting tier so predictably-hard work skips the cheap rungs.
- **Trivial classification timing (m2):** "trivial" is decided **at dispatch** from the dispatch intent / `taskPatterns` / chosen tier (NOT from realized tool-call counts, which are unknown up front). `trivialMaxToolCalls` is retained only as a post-hoc telemetry sanity check, not a gating input.
- All keys optional; a missing `enforcement` block = `mode:"off"`.

### 5.5 Security & safety
- Never echo secrets/tokens into observations, forcing messages, trajectory records, logs, or grader prompts (scrub like the reference's `scrubObj`/`scrubText`).
- Anti-self-script must detect *intent* from the DoD/task, not just the file extension — a task whose declared deliverable **is** a script (`build.sh`, a codegen `*.mjs`) must be allowed.
- The checker must be **independent** of the producer for the same delegation (different tier-instance/session, grader ≥ producer); never let a subagent grade its own output.

### 5.6 Concurrency (M7 — NEW)
OpenCode may run multiple `Task()` dispatches in parallel.
- **State isolation:** all guard/trajectory/gate state is keyed by `sessionID`; `sessions.ts` must be safe under interleaved hook callbacks (no shared mutable singletons beyond per-session maps).
- **Shared-workspace verification races:** deterministic checks (e.g. `npm test`, build) run against the single shared working tree; **concurrent** verifications can race or see each other's edits. Mitigations: (a) serialize deterministic check-runs with a per-workspace mutex; (b) prefer artefact-scoped checks (file/schema on the delegation's declared paths) over whole-repo checks when concurrency is detected; (c) attribute changed files to a delegation via that session's observed edit calls, not a global `git diff`. Document the residual risk; add an integration test with two interleaved subagent sessions.

---

## 6. GLOBAL acceptance criteria & GLOBAL Definition of Done

### 6.1 Global acceptance criteria
- **GA-1 (no regression):** with `enforcement.mode:"off"` (default), behaviour is byte-for-byte identical to the pre-plan plugin for orchestrator and subagent sessions (proven by golden/contract tests + a manual diff of the assembled injected prompt).
- **GA-2 (hard-block works):** under `"enforced"`, a subagent that (a) exceeds its budget, (b) repeats an identical read, (c) authors a throwaway script instead of doing the task, **or** (d) explores before a *declared* deliverable, is **blocked** — proven on the fake harness **and** the real-OpenCode smoke.
- **GA-3 (independent acceptance):** a delegation carrying a checkable DoD is **not accepted** until an **independent grader ≥ producer tier** (or a deterministic check) returns PASS; a wrong-but-confident output that fails its DoD is rejected — proven by tests where the producer "lies" (`DONE:` but artefact fails).
- **GA-4 (escalation):** a FAILed delegation retries once on the same tier with reasons injected, then escalates up to `heavy`, and **never silently returns a FAIL**; escalation is bounded by `maxTotalAttempts` and the cost ceiling; `floorTier` is honoured — proven by tests incl. property-based termination.
- **GA-5 (both modes):** the full loop works for on-the-fly dispatch **and** plan-annotation-driven execution, sharing one gate/ladder code path — proven by two E2E tests.
- **GA-6 (proportional):** trivial dispatches (classified at dispatch) bypass verification/escalation overhead — proven by tests.
- **GA-7 (overhead budget):** with enforcement **off**, the guard hook adds no measurable work (early return) and the injected prompt is unchanged (0 added tokens). With enforcement **on**, the *additional* protocol injected (DoD syntax + delegate-tool docs) is **measured** and kept to a documented budget (target ≤ +200 tokens; revisit with the real number); protocol additions are injected **only** when enforcement is on (M6).
- **GA-8 (SDK reality):** every enforcement primitive used (before-hook abort / custom tool / subagent-return interception) is **confirmed by the Phase 0.0 spike** and re-confirmed by the per-layer real-OpenCode smoke.

### 6.2 Global Definition of Done
- [ ] Phase 0.0 spike report committed; chosen architecture (Option i/ii) recorded; GA-8 satisfied.
- [ ] All wave/phase DoDs green.
- [ ] Test suite: **≥ 90% branch coverage** on `guard/`, `verify/`, `escalate/`, `telemetry/`, `verify/dod.ts`; **≥ 80% lines** overall on extracted modules; characterization + property + real-smoke suites green.
- [ ] `enforcement.mode:"off"` regression suite green (GA-1).
- [ ] All enforcement scenarios (GA-2..GA-6) have passing fake-harness tests **and** a real-OpenCode smoke per layer.
- [ ] No secret leakage in any emitted string incl. grader prompts (security test).
- [ ] Docs updated: README section, `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`, `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, migration note.
- [ ] `tsconfig.json` present; `npm run typecheck` and `npm test` green; tests confirmed **excluded** from the published package.
- [ ] Global Senior-QA review completed and **all findings resolved**; QA report committed (`docs/qa/global-qa-report.md`).
- [ ] Version bumped; CHANGELOG entry; opt-in default decision recorded.
- [ ] Every task committed (Conventional Commits); working tree clean except intentional artefacts.

---

## WAVE 0 — Spike + Foundations

**Goal:** prove the SDK can support the architecture (Phase 0.0), then make the monolith testable/observable and add opt-in plumbing — **without changing routing behaviour.**

### Phase 0.0 — Enforcement-primitives spike (GATES THE WHOLE PLAN) `[tier:heavy]` analysis, `[tier:fast]` recon, `[tier:medium]` throwaway prototype
**Pre-flight** `[tier:fast]`: locate the installed `@opencode-ai/plugin` typings/version; list the hook signatures it actually exposes; find any official docs/examples for custom tools and `tool.execute.before`.

**Tasks**
- T0.0.1 `[tier:fast]` Read the SDK typings: does `tool.execute.before(input, output)` exist, and is throwing inside it documented/observed to **abort** the tool call? Capture the exact signature + `output.args` mutability.
- T0.0.2 `[tier:medium]` Build a **throwaway** probe plugin (in a scratch dir, not committed to `src/`) that: (A) registers `tool.execute.before` and throws on a marked tool call → observe whether the call is aborted and whether the error text reaches the model; (B) registers a custom tool via the plugin `tool` map → observe whether the orchestrator can call it and receive its return; (C) attempts to observe a subagent `Task()` session's tool calls **and** its final return from the plugin → record what is/ isn't visible.
- T0.0.3 `[tier:fast]` Confirm how a subagent's **changed-file set** can be obtained (observed edit/write tool calls on that session vs a workspace diff) — input to the §3.3 artefact contract.
- T0.0.4 `[tier:heavy]` Write `docs/adr/0000-spike-results.md`: record capabilities **A** (before-hook abort), **B** (custom tool), **C** (subagent-return interception), and the **artefact contract** that is actually achievable. **Select the architecture** (Option ii if B or C; else Option i advisory-grade) and mark which layers are buildable as designed vs degraded. If a capability needed for the core thesis (B and C both absent) is missing, **STOP and escalate to the owner** (Directive A — blocking) with the degraded-scope proposal.

**New tests:** none (spike); the probe is throwaway and deleted/kept under `test/smoke/probe/` clearly marked non-shipping.

**Acceptance criteria:** capabilities A/B/C empirically answered with evidence; artefact contract pinned; architecture selected and recorded.

**DoD:** `0000-spike-results.md` committed; the rest of the plan's "[needs Spike cap. X]" markers resolved to buildable/degraded; any blocking gap escalated.

**Senior-QA review** `[tier:heavy]`: challenge the evidence (was the abort real or swallowed? did the custom tool actually get called by the model, not just registered?). Re-run the probe if a claim is thin. Fix all / re-spike.

### Phase 0.1 — Project tooling & test infrastructure
**Pre-flight** `[tier:fast]`: confirm `master` branch, capture `git status` (note pre-existing dirty `package.json`/`tiers.json`), confirm Node version, confirm `src/index.ts` imports cleanly.

**Tasks**
- T0.1.1 `[tier:medium]` Add `tsconfig.json` (module `ESNext`, target `ES2022`, `moduleResolution` `Bundler`/`NodeNext`, `strict: true`, `noEmit: true`, `types: ["node"]`). Do **not** change `main`.
- T0.1.2 `[tier:medium]` Add Vitest + coverage devDeps and `scripts`: `"test"`, `"test:watch"`, `"test:coverage"`, `"smoke": "RUN_OC_SMOKE=1 vitest run test/smoke"`, `"typecheck": "tsc --noEmit"`. Stage **only** your `package.json` hunks (do not clobber the pre-existing dirty changes).
- T0.1.3 `[tier:medium]` Create `vitest.config.ts` (node env; **`test/` as test root**, `src/` as coverage source; coverage thresholds wired but initially non-failing; exclude `test/smoke` from default run). Add `test/unit/_smoke.test.ts` proving the runner works.
- T0.1.4 `[tier:medium]` Confirm packaging: assert (a test or a `prepack` check) that the published tarball (`npm pack --dry-run`) contains **no** `test/` and no config files — only `files:["src/", …]`. (C4)
- T0.1.5 `[tier:fast]` Add `docs/plans/README.md` index pointing at this plan.

**New tests:** runner smoke (1) green; `npm run typecheck` green on the untouched monolith (fix only compilation-blocking type errors, no behaviour change); packaging assertion green.

**Acceptance criteria:** `npm test` + `npm run typecheck` green locally; coverage report produced; `npm pack --dry-run` excludes tests/config.

**DoD:** tooling committed; no source-behaviour change.

**Senior-QA review** `[tier:heavy]`: verify tests cannot ship (C4), `tsconfig` is `noEmit`, pre-existing dirty files untouched. Fix all.

### Phase 0.2 — Extract pure logic under characterization tests
**Pre-flight** `[tier:fast]`: re-map every pure helper (`buildDelegationProtocol` :456, `parseCapDirective` :672, `fingerprintToolCall` :682, `detectNarration` :875, cap-state init :934, config validation :114–260). Confirm 0.1 green.

**Tasks**
- T0.2.1 `[tier:medium]` **Characterization tests FIRST** — golden snapshots of current outputs for `buildDelegationProtocol`, `parseCapDirective`, `fingerprintToolCall`, `detectNarration`, config validation, **and the fully-assembled injected system prompt + after-hook banner output** for representative scenarios across each preset/mode and Claude vs non-Claude (m3).
- T0.2.2 `[tier:medium]` Extract helpers into `src/router/*.ts` + `src/guard/fingerprint.ts` as **pure functions**, re-imported by `index.ts`. No logic change; golden stays green.
- T0.2.3 `[tier:medium]` Extract config load/validate into `src/router/config.ts` with a typed `RouterConfig`; add the optional `enforcement` schema (§5.4) — parse-only, no consumers yet.
- T0.2.4 `[tier:medium]` Extract subagent-session detection + per-session state into `src/router/sessions.ts`, designed **concurrency-safe** (per-session maps; no cross-session singletons) (M7).

**New tests:** golden (per-helper + assembled-prompt); config validator unit tests incl. **edge cases**: missing `enforcement` ⇒ `mode:"off"`; unknown preset; malformed `tierCaps`; `perTier` unknown tier; invalid `mode`; `envGate` = `"1"`/`"0"`/unset/other; `CAP:none`/`CAP:0`/`CAP:-1`/non-numeric; `graderPolicy` invalid; `costCeiling.multiple` ≤ 0.

**Acceptance criteria:** extracted helpers imported (monolith shrinks); golden proves identical behaviour incl. assembled prompt; config validator correct on the full edge table.

**DoD:** ≥90% branch coverage on new pure modules; golden green; bodies removed from `index.ts`; committed.

**Senior-QA review** `[tier:heavy]`: diff golden snapshots for drift; confirm no SDK/network/fs leaked into pure modules; confirm config schema additive/back-compatible. Fix all.

### Phase 0.3 — Per-session state + trajectory scaffolding (record-only)
**Pre-flight** `[tier:fast]`: confirm 0.2 modules import; locate where the after-hook mutates cap state.

**Tasks**
- T0.3.1 `[tier:medium]` Create `src/telemetry/trajectory.ts` (pure state + `record(event)`, fields §5.3); wire it to **observe** existing `tool.execute.after`/`chat.message` (record only; emit nothing new).
- T0.3.2 `[tier:medium]` Add `enforcementMode(session, tier, config)` resolver (off/advisory/enforced incl. env-gate truth table + perTier). Not consumed yet.
- T0.3.3 `[tier:fast]` Add a gated debug dump of a session's trajectory for manual inspection.

**New tests:** trajectory recorder unit tests (event sequencing, `ttfa` set once, ratios); resolver tests for the **full env-gate truth table** + perTier overrides + unknown-tier default + `mode:"off"` short-circuit.

**Acceptance criteria:** trajectory recorded for a simulated session with **no** change to emitted observations; resolver matches the truth table.

**DoD:** scaffolding committed; ≥90% coverage on new modules; GA-1 holds (contract test).

**Senior-QA review** `[tier:heavy]`: confirm record-only; default `off`; env-gate semantics documented. Fix all.

---

## WAVE 1 — Layer 1: Hard-block execution guard *(needs Spike capability A)*

**Goal:** add `tool.execute.before` and convert advisory caps into real hard-blocks for subagent sessions, **opt-in & proportional**. *(If Phase 0.0 found capability A absent, this wave degrades to advisory-only banners + escalates to owner — Directive E.)*

### Phase 1.0 — Guard design ADR
**Pre-flight** `[tier:fast]`: re-read reference `guards.mjs` + `opencode-plugin.mjs`; re-read `0000-spike-results.md` for the confirmed before-hook semantics.

**Tasks**
- T1.0.1 `[tier:heavy]` Write `docs/adr/0001-hard-block-guard.md`: map each reference clause to model-router; define the **deliverable signal** (Mode B: plan's primary action; Mode A: dispatch's declared first action / `first_action` hint; **none ⇒ deliverable-first disabled** for that delegation — honest M5 framing). Fix clause order, throw-message contract, advisory-vs-enforced switch, read-only & self-script taxonomies.

**Acceptance/DoD:** ADR committed; clause order + message contract fixed.

**Senior-QA review** `[tier:heavy]`: stress for false-positives (legit script-authoring; legit re-reads) and the "no deliverable signal" path. Fix all.

### Phase 1.1 — Pure guard engine
**Pre-flight** `[tier:fast]`: confirm ADR + Wave-0 modules + trajectory recorder present.

**Tasks**
- T1.1.1 `[tier:medium]` Implement `src/guard/guards.ts` — pure `evaluateGuards(state, call, policy)` with clause order: `finish/return → allow`; `self_script → deny`; budget ceiling → deny; redundancy (`≥ sameOpRetryCap`) → deny; read-draft budget (`≥ readDraftCap`) → deny; deliverable-first (only when a signal exists and not yet executed) → deny non-deliverable; else allow.
- T1.1.2 `[tier:medium]` Implement `classify`, `isSelfScript` (intent-aware — allow when the DoD's declared deliverable **is** a script), `newGuardState/updateState` (blocked calls still counted), `forcingMessage`, `trajectoryMetrics`.
- T1.1.3 `[tier:medium]` `policy` derives from `enforcement.guard` + resolved mode (advisory ⇒ evaluate but `allow:true` + banner; enforced ⇒ real deny).

**New tests:** exhaustive unit + **property-based** (m4): counters monotonic; a `finish` always allowed; no input sequence yields a non-terminating block loop. **Edge cases:** budget at cap vs cap+1; identical read twice vs different file; read→read→produce resets counter; self-script blocked **but** script-authoring DoD allowed; deliverable-first with no signal never blocks; advisory never denies; unknown tool ⇒ `other`; obfuscated shell gambiarra (case/whitespace).

**Acceptance/DoD:** reproduces the ported decision table; advisory vs enforced differ only in `allow`; ≥95% branch coverage on `guards.ts`; committed.

**Senior-QA review** `[tier:heavy]`: adversarial inputs (obfuscated self-scripts; redundancy false-positives; multi-tool messages). Fix all.

### Phase 1.2 — Wire `tool.execute.before` (the enforcement point)
**Pre-flight** `[tier:fast]`: re-confirm from `0000-spike-results.md` that throwing aborts; if the installed SDK differs from the spike, **STOP & re-spike** (blocking).

**Tasks**
- T1.2.1 `[tier:medium]` Register `tool.execute.before`. For **subagent sessions only** (reuse `subagentSessionIDs`), build `call`, resolve mode; if enforced and `!evaluateGuards().allow` → `throw new Error(observation + "\n" + forcingMessage(state))`; budget ceiling throws in enforced mode regardless of clause.
- T1.2.2 `[tier:medium]` Migrate advisory logic: advisory mode → before-hook records + after-hook keeps banners; enforced mode → before-hook authoritative (decide in ADR whether to suppress redundant after-hook banners).
- T1.2.3 `[tier:medium]` `updateState` counts blocked calls (no budget spin); trajectory captures `self_script_count`, `ttfa`, etc.
- T1.2.4 `[tier:medium]` Orchestrator sessions and `mode:"off"` are **early-return no-ops** (GA-1).

**New tests (fake harness + real-OpenCode smoke M1):** pre-deliverable read blocked then allowed after deliverable; self-script blocked & not dispatched; duplicate read blocked; budget ceiling throws `iteration_cap`; advisory never throws; **off mode + orchestrator session ⇒ no-op** (GA-1); blocked call still increments; forcing message present. **Real smoke:** the throw actually aborts a tool call inside a real OpenCode subagent session.

**Acceptance/DoD:** GA-2 on harness **and** smoke; GA-1 preserved; coverage maintained; committed.

**Senior-QA review** `[tier:heavy]`: confirm no throw path for normal sessions; thrown message model-useful + secret-free; budget can't be spun. Fix all.

### Phase 1.3 — Proportional enforcement + scorecard
**Pre-flight** `[tier:fast]`: confirm 1.2 green; `proportional` parsed.

**Tasks**
- T1.3.1 `[tier:medium]` Trivial-bypass classified **at dispatch** (intent/`taskPatterns`/tier), per m2 (advisory only for trivial).
- T1.3.2 `[tier:medium]` Emit a compact per-delegation **scorecard** when enforcement is on (`ttfa`, `read:exec`, `self_scripts`, `tool_calls`, `stop_reason`).
- T1.3.3 `[tier:medium]` Add `/router enforce <off|advisory|enforced>` (extend `command.execute.before`); persist to state file robustly (atomic write).

**New tests:** trivial classification at dispatch (DoD present ⇒ not trivial); scorecard formatting; command toggles + persists + reload picks up; atomic write survives a simulated crash.

**Acceptance/DoD:** GA-6; toggling works; scorecard accurate; committed; Wave-1 regression (GA-1/GA-2) green.

**Senior-QA review** `[tier:heavy]`: confirm proportional policy can't silently disable enforcement on real work; state file can't corrupt. Fix all.

---

## WAVE 2 — Layer 2: Independent acceptance gate (the biggest lever) *(needs Spike capability B or C)*

**Goal:** every non-trivial delegation carries a checkable DoD; output is independently verified before acceptance. **Producer ≠ grader; grader ≥ producer tier.** *(If Phase 0.0 found neither B nor C, ship Option (i) advisory-grade and escalate — Directive E.)*

### Phase 2.0 — Acceptance architecture ADR
**Pre-flight** `[tier:fast]`: re-read `0000-spike-results.md` (capabilities B/C + artefact contract §3.3).

**Tasks**
- T2.0.1 `[tier:heavy]` Write `docs/adr/0002-acceptance-gate.md`: confirm rollout (Option i first, Option ii if B/C); specify per-mode DoD sourcing; fix the verdict schema `{pass, method, reasons[], evidence}`; specify **producer ≠ grader** + **grader ≥ producer tier** enforcement; specify the **artefact** the gate receives per §3.3 and the verification locus + concurrency handling (§5.6).

**Acceptance/DoD:** ADR fixes verdict schema, DoD sources, artefact contract, rollout order; committed.

**Senior-QA review** `[tier:heavy]`: pressure-test producer≠grader, grader-strength, and the "no checkable DoD" path. Fix all.

### Phase 2.1 — DoD schema + delegation contract + auto-inference (both modes)
**Pre-flight** `[tier:fast]`: confirm `/annotate-plan` output format; confirm where dispatch text is available.

**Tasks**
- T2.1.1 `[tier:medium]` Implement `src/verify/dod.ts`: schema `{ kind: "deterministic"|"checker"|"none", checks?: Check[], criteria?: string[], deliverable?: string }`, `Check ∈ {run+expect | fileExists | schemaMatch | testsPass | buildPasses | lintClean}`. Parse DoD from (Mode A) a structured dispatch block and (Mode B) the plan annotation.
- T2.1.2 `[tier:medium]` **Auto-inference (M2):** `inferDoD(taskType, tier, dispatch)` produces a minimal checkable DoD when none is supplied (Mode A default). Inference table maps `taskPatterns` → default checks (e.g. impl/bugfix → `buildPasses`+`testsPass` if a test command is discoverable; refactor → `buildPasses`+`lintClean`; write-file → `fileExists`; else → checker on declared criteria). Record `dod_source`.
- T2.1.3 `[tier:medium]` Extend `buildDelegationProtocol` (injected **only when enforcement on**, M6/GA-7) to document the DoD mini-syntax + that a DoD will be auto-inferred if omitted; `requireExplicitDoD:true` flips this to "must supply".
- T2.1.4 `[tier:medium]` Extend `/annotate-plan` to emit an acceptance block per task alongside `[tier:X]`; Mode B may be strict (non-trivial task without acceptance ⇒ clear plan-authoring error).
- T2.1.5 `[tier:medium]` "No checkable DoD" policy: trivial ⇒ skip; non-trivial Mode A ⇒ auto-infer (default) / forcing message if `requireExplicitDoD`; Mode B ⇒ strict error. Never silently accept.

**New tests:** parser per `Check` kind; Mode A dispatch DoD; Mode B annotation DoD; **auto-inference table** per task type incl. "no test command discoverable" fallback to checker; **edge cases:** malformed DoD; empty criteria; deterministic check w/o command; conflicting checks; trivial ⇒ optional; annotate-plan round-trip.

**Acceptance/DoD:** both modes + inference yield a normalized `DoD`; ≥90% branch coverage on `dod.ts`; committed.

**Senior-QA review** `[tier:heavy]`: DoD syntax unambiguous; "missing DoD" can't be bypassed; auto-inference never produces a vacuous always-PASS DoD. Fix all.

### Phase 2.2 — Deterministic verifier
**Pre-flight** `[tier:fast]`: confirm a safe injected `exec`/`fs` seam; confirm concurrency mutex design (§5.6).

**Tasks**
- T2.2.1 `[tier:medium]` Implement `src/verify/deterministic.ts`: runners (`run`/`testsPass`/`buildPasses`/`lintClean`/`fileExists`/`schemaMatch`) behind injected seams → `{pass, reasons[], evidence}`; command allowlist; timeout; per-workspace mutex for whole-repo checks (M7).
- T2.2.2 `[tier:medium]` Map `DoD.checks` → runners; aggregate; **empty checks ⇒ SKIPPED (never PASS)**.

**New tests:** each runner with fake exec/fs; **edge cases:** non-zero exit ⇒ FAIL+reason; timeout ⇒ FAIL; missing file ⇒ FAIL; schema mismatch ⇒ FAIL+diff; one of many fails ⇒ overall FAIL; empty ⇒ SKIPPED; two concurrent check-runs serialize (M7).

**Acceptance/DoD:** correct PASS/FAIL+evidence, zero live-model calls; ≥90% branch coverage; committed.

**Senior-QA review** `[tier:heavy]`: command-injection review; SKIPPED never masquerades as PASS; mutex correct. Fix all.

### Phase 2.3 — Independent checker-tier verifier (the common path — invest here, M3)
**Pre-flight** `[tier:fast]`: confirm how to dispatch a one-shot grading call to a tier **≥ producer** and **different** from the producer session.

**Tasks**
- T2.3.1 `[tier:medium]` Implement `src/verify/checker.ts`: build a **grading prompt** from `DoD.criteria` + the assembled artefact (§3.3); dispatch to `graderTier = atLeastProducerTier(producerTier)` (enforce ≥ producer, never same session) at **pinned low temperature** (`verify.graderTemperature`, m6); parse a strict `{pass, reasons[]}` (unparseable / dispatch error ⇒ FAIL — fail-closed).
- T2.3.2 `[tier:medium]` Selection logic: `preferDeterministic` ⇒ deterministic if any `checks`, else checker; honour `verify.require`.
- T2.3.3 `[tier:medium]` **Anti-rubber-stamp calibration:** the grading prompt must require the grader to cite concrete evidence per criterion and to default to FAIL on uncertainty; add a calibration test set (artefacts that *look* done but violate a criterion) the checker must reject.

**New tests:** verdict parsing (PASS/FAIL/garbage→FAIL); **grader ≥ producer enforced** (fast producer ⇒ grader promoted; same-session grader rejected); selection truth table; **edge cases:** empty criteria ⇒ SKIPPED/forcing (not PASS); dispatch error ⇒ FAIL; calibration set (≥6 "looks-done-but-wrong" artefacts) all correctly FAILed; temperature pinned.

**Acceptance/DoD:** GA-3 — a lying `DONE:` is rejected by an independent, sufficiently-strong grader; calibration set passes; ≥90% branch coverage; committed.

**Senior-QA review** `[tier:heavy]`: fail-closed everywhere; no self-grading; grader strength enforced; grading prompt secret-free; calibration adequate. Fix all.

### Phase 2.4 — The acceptance gate + `delegate` tool / verify-dispatch
**Pre-flight** `[tier:fast]`: confirm the Option (i)/(ii) decision from `0000-spike-results.md` + `0002`.

**Tasks**
- T2.4.1 `[tier:medium]` Implement `src/verify/gate.ts`: assemble the **artefact** (§3.3), `accept(delegation, artefact) → {accepted, verdict, trajectory}` orchestrating deterministic|checker per config; enforce producer≠grader + grader≥producer; record verdict.
- T2.4.2 `[tier:medium]` **Option (i)** wiring: protocol-enforced verify-dispatch; plugin records/enforces DoD presence; gate invoked on the artefact before acceptance.
- T2.4.3 `[tier:medium]` **Option (ii)** wiring (if spike B/C): register a `delegate` tool; plugin runs produce→gate internally and returns only an **accepted** result (or hands to Layer 3). Keep raw `Task()` (Option i) working.
- T2.4.4 `[tier:medium]` Trajectory: `dod_source`, `verdict`, `verify_method`, `grader_tier`.

**New tests (fake harness + real smoke M1):** accept on PASS / reject on FAIL; deterministic vs checker selection; both Mode A & Mode B feed the gate; `delegate` path returns accepted-only; raw `Task()` path still works; producer≠grader + grader≥producer enforced; **edge cases:** no DoD + non-trivial ⇒ not silently accepted; gate error ⇒ fail-closed. **Real smoke:** the gate actually interposes on a real subagent result (per chosen Option).

**Acceptance/DoD:** GA-3 + GA-5; integration + smoke green; ≥90% coverage on `gate.ts`; committed.

**Senior-QA review** `[tier:heavy]`: gate can't be bypassed in `delegate` mode; Option (i) degradation documented; concurrency safe. Fix all.

---

## WAVE 3 — Layer 3: Quality escalation ladder

**Goal:** on FAIL, retry the same tier once (reasons injected) then escalate; never silently return a FAIL; bounded + cost-capped (defined base); honours `floorTier`; composes with provider failover.

### Phase 3.1 — Pure escalation policy
**Pre-flight** `[tier:fast]`: confirm gate emits `{accepted, verdict, reasons, costUnits}`; `escalate` config parsed.

**Tasks**
- T3.1.1 `[tier:medium]` Implement `src/escalate/ladder.ts` — pure `nextAction(state, verdict, policy) → {action: "retry"|"escalate"|"give_up"|"accept", tier?, forcingMessage?}`: PASS→accept; FAIL & attemptsThisTier < `maxAttemptsPerTier` → retry same tier w/ reasons; else escalate to next tier ≥ `floorTier` in `ladder`; past top tier / `maxTotalAttempts` / cost-ceiling exceeded → `give_up` (surface honestly).
- T3.1.2 `[tier:medium]` Cost accounting against `costCeiling.base × multiple` (base = first-attempt cost units, M4); `floorTier` skips cheap rungs.

**New tests:** ladder truth table + **property-based termination (m4)**: no input sequence loops forever; "never silent FAIL" invariant holds. **Edge cases:** FAIL at heavy ⇒ give_up; `maxTotalAttempts` mid-ladder; cost ceiling hit; retry→PASS; `maxAttemptsPerTier:0` ⇒ escalate immediately; single-tier ladder; `floorTier` = heavy ⇒ no cheap attempts.

**Acceptance/DoD:** GA-4 policy correct on all branches; provably terminating; ≥95% branch coverage; committed.

**Senior-QA review** `[tier:heavy]`: prove termination; prove "never silent FAIL"; cost base sane. Fix all.

### Phase 3.2 — Wire escalation into the gate / delegate loop
**Pre-flight** `[tier:fast]`: confirm gate + ladder modules present.

**Tasks**
- T3.2.1 `[tier:medium]` Integrate ladder into `gate.ts`/`delegate` loop: on FAIL build forcing message from `verdict.reasons`, re-dispatch per `nextAction`; thread attempts/escalations/cost into trajectory.
- T3.2.2 `[tier:medium]` On `give_up`, return a structured **honest** result (`status:"unmet"`, best artefact, reasons, attempts) — never a fake PASS.
- T3.2.3 `[tier:medium]` Independent safety net (max wall-clock / max attempts) beside the policy.

**New tests (fake harness + real smoke M1):** FAIL→retry→PASS; FAIL→escalate→PASS; FAIL all the way→honest give_up; reasons appear in the retry dispatch; attempts/escalations/cost recorded; safety net trips; escalated dispatch is **still guarded** (composes with Layer 1). **Edge:** escalation target tier missing in preset ⇒ skip/give_up gracefully.

**Acceptance/DoD:** GA-4 E2E; integration + smoke green; coverage maintained; committed.

**Senior-QA review** `[tier:heavy]`: honest give_up; no silent acceptance; composes with Layer 1. Fix all.

### Phase 3.3 — Compose with provider failover
**Pre-flight** `[tier:fast]`: re-read existing provider `fallback` + its consumer.

**Tasks**
- T3.3.1 `[tier:medium]` Make quality-escalation (tier↑ on bad output) and provider-failover (provider→provider on API error) orthogonal; document precedence (API error → provider failover first; verification FAIL → quality escalation); no double-counted attempts.
- T3.3.2 `[tier:medium]` Interaction tests.

**New tests:** API-error ⇒ provider failover (not quality escalation); verification FAIL ⇒ quality escalation (not provider failover); both in one delegation behave sanely; attempts not double-counted.

**Acceptance/DoD:** compose without conflict/cost blow-up; committed; coverage maintained.

**Senior-QA review** `[tier:heavy]`: no double-counting; cost bounded. Fix all.

---

## WAVE 4 — Both modes, proportional nuance, end-to-end & docs

### Phase 4.1 — On-the-fly (Mode A) E2E
**Pre-flight** `[tier:fast]`: confirm Waves 1–3 wired; build a Mode-A fixture.

**Tasks**
- T4.1.1 `[tier:medium]` E2E (fake harness + faked models): orchestrator dispatches an ad-hoc `[tier:medium]` task with an **auto-inferred** DoD; weak producer false-finishes; gate FAILs; ladder retries→escalates; accepted result returned; assert full trajectory + `dod_source:"inferred"`.
- T4.1.2 `[tier:medium]` E2E: trivial read dispatch bypasses verification/escalation (proportional).
- T4.1.3 `[tier:medium]` Real-OpenCode smoke (M1) of the Mode-A happy path.

**New tests:** the flows above; **edges:** producer succeeds first try (no escalation); producer never produces (deliverable-first/budget block → honest give_up).

**Acceptance/DoD:** GA-5 (A) + GA-6; committed; green.
**Senior-QA** `[tier:heavy]`: realism review; fix all.

### Phase 4.2 — Plan-annotation (Mode B) E2E
**Pre-flight** `[tier:fast]`: confirm `/annotate-plan` emits tier + acceptance; create a small annotated-plan fixture.

**Tasks**
- T4.2.1 `[tier:medium]` E2E: execute the annotated plan; each task's `[tier:X]` routes and its acceptance block becomes the DoD; gate + escalation per task; assert per-task verdicts.
- T4.2.2 `[tier:medium]` Ensure annotation-sourced and dispatch/inferred DoD converge on the **same** `DoD` object + gate/ladder code path (GA-5 single path).
- T4.2.3 `[tier:medium]` Real-OpenCode smoke (M1) of a 2-task annotated plan.

**New tests:** annotated-plan execution; per-task verdicts; **edges:** non-trivial task with no acceptance annotation ⇒ strict error; mixed tiers; a task that escalates mid-plan.

**Acceptance/DoD:** GA-5 (B); committed; green.
**Senior-QA** `[tier:heavy]`: confirm one shared gate/ladder path (no divergence). Fix all.

### Phase 4.3 — Proportional tuning & presets (PRELIMINARY)
**Pre-flight** `[tier:fast]`: gather trajectory data from the E2E fixtures.

**Tasks**
- T4.3.1 `[tier:medium]` Tune defaults (caps, `readDraftCap`, trivial classification, `verify.require`, `costCeiling.multiple`) from fixture trajectories; encode an `enforcement` preset per routing mode (`normal`/`budget`/`quality`/`deep`).
- T4.3.2 `[tier:medium]` Add `enforcement` examples to `tiers.json` (additive; default effectively `off`); stage only intended hunks.
- T4.3.3 `[tier:fast]` **Caveat (m5):** document that this tuning is **preliminary** — derived from fixtures, not field data; real tuning needs live telemetry at adequate N (mirroring the harness's N≥20 caveat). Add a "re-tune with real data" follow-up note.

**New tests:** preset resolution per mode; tuned values respected.
**Acceptance/DoD:** GA-6 refined; presets coherent; no preset silently forces enforcement on; committed.
**Senior-QA** `[tier:heavy]`: confirm default stays effectively off; preliminary caveat present. Fix all.

### Phase 4.4 — Documentation
**Pre-flight** `[tier:fast]`: list existing docs (`CAPS_DECISION.md`, `COMMAND_*`, `FLOW_DIAGRAMS.md`, `LINE_REFERENCES.md`) to match style.

**Tasks**
- T4.4.1 `[tier:medium]` `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`, `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md` (the `enforcement` block incl. envGate truth table + grader policy + cost base + floorTier), README "Enforced delegation — opt-in" section.
- T4.4.2 `[tier:medium]` Migration note + how to enable (`enforcement.mode` / `MODEL_ROUTER_ENFORCE=1` / `/router enforce`) + the Option (i)/(ii) reality from the spike.
- T4.4.3 `[tier:fast]` Update `LINE_REFERENCES.md` for new modules/hooks.

**Acceptance/DoD:** docs match implementation (config reference matches the validator); committed.
**Senior-QA** `[tier:heavy]`: no doc/impl drift. Fix all.

---

## WAVE 5 — Hardening, global QA, release

### Phase 5.1 — Regression, coverage gate, overhead budget
**Pre-flight** `[tier:fast]`: full `git status`; confirm all prior DoDs green.

**Tasks**
- T5.1.1 `[tier:medium]` Turn on coverage thresholds (fail under target); close gaps.
- T5.1.2 `[tier:medium]` Full **regression**: `enforcement.mode:"off"` golden/contract proves GA-1 (incl. assembled-prompt diff).
- T5.1.3 `[tier:medium]` **Overhead measurement (GA-7):** measure the *actual* added tokens when enforcement is on (DoD syntax + delegate docs); record the number; assert it is injected **only** when enforcement on and within the documented budget; assert off-mode adds 0 tokens + no guard work.
- T5.1.4 `[tier:medium]` Security sweep test: no secret in any observation/forcing-message/trajectory/grader-prompt/log.

**New tests:** coverage gate; regression; overhead assertion (with the measured number); security scrub.
**Acceptance/DoD:** GA-1, GA-7, security green; committed.
**Senior-QA** `[tier:heavy]`: independent re-run; fix all.

### Phase 5.2 — GLOBAL Senior-QA review + fix-all
**Pre-flight** `[tier:fast]`: assemble evidence (coverage report, all GA results, spike report, ADRs, docs).

**Tasks**
- T5.2.1 `[tier:heavy]` Adversarial global review vs §6.1 (GA-1..GA-8) + §6.2: try to (a) make off-mode behave differently, (b) get a FAIL silently accepted, (c) get a self-grade or a sub-producer-tier grader, (d) cause infinite escalation / cost blow-up, (e) leak a secret, (f) trigger a false self-script block on a legit script task, (g) stall a live Mode-A session via DoD requirement, (h) race two concurrent subagents through the gate. Document every finding in `docs/qa/global-qa-report.md` (m7 — a QA **report**, not an ADR).
- T5.2.2 `[tier:medium]` Fix **every** finding; re-run the full suite + smokes.

**Acceptance/DoD:** all global acceptance criteria green; zero open findings; QA report committed.
**Senior-QA:** sign-off recorded in the QA report.

### Phase 5.3 — Release
**Pre-flight** `[tier:fast]`: confirm 5.2 sign-off.

**Tasks**
- T5.3.1 `[tier:heavy]` **Decision:** default `enforcement.mode` for release (recommended: ship **`off`** + a one-line opt-in; revisit after field data). Record rationale.
- T5.3.2 `[tier:medium]` Version bump, CHANGELOG, README section; confirm `npm pack --dry-run` ships **no** tests/config (C4).
- T5.3.3 `[tier:fast]` Tag/commit (Conventional Commits); release note.

**Acceptance/DoD:** installs + loads with enforcement off = identical UX; opt-in path verified by a real smoke; global DoD (§6.2) fully green; released.
**Senior-QA** `[tier:heavy]`: final pre-release checklist. Fix all.

---

## 12. Risks & mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | SDK can't throw-to-abort / can't register a `delegate` tool / can't intercept subagent return | Med | High | **Phase 0.0 spike proves each capability FIRST (GA-8).** Architecture is selected from results; if the core thesis can't be supported (B & C both absent) → blocking stop & escalate (Directive A/E). |
| R2 | False-positive self-script block on legit script-authoring tasks | Med | Med | Intent-aware `isSelfScript` (allow when DoD's deliverable is a script); edge-case + adversarial tests (1.1, 5.2). |
| R3 | Verification cost/latency blows up | Med | Med | Prefer deterministic; checker only when needed; proportional bypass; defined cost ceiling + `floorTier`; measured overhead budget (GA-7). |
| R4 | Refactor introduces behaviour drift | Med | High | Characterization/golden **before** extraction incl. assembled-prompt snapshot (0.2); GA-1 regression gate. |
| R5 | Enforcement annoys users / breaks flows | Med | High | Opt-in, default `off`; advisory middle mode; per-tier overrides; `/router enforce`; auto-inferred DoD so Mode A never stalls. |
| R6 | Weak grader rubber-stamps (verification theatre) | **Med** | **High** | **Grader ≥ producer tier (C3)**, producer≠grader, low grader temperature, anti-rubber-stamp calibration set (2.3). |
| R7 | Clobbering pre-existing dirty `package.json`/`tiers.json` | Med | Med | Stage only intended hunks; never `git add -A`. |
| R8 | Infinite escalation / cost loop | Low | High | Pure ladder with **property-based** termination proof + independent safety net + defined cost base (3.1/3.2). |
| R9 | Tests shipped in npm package | Med | Low | Tests in top-level `test/`; `npm pack --dry-run` assertion (0.1.4, 5.3.2). |
| R10 | Offline-green but live-broken | Med | High | Real-OpenCode smoke per layer (M1); re-confirm SDK semantics if version drifts (1.2 pre-flight). |
| R11 | Concurrent subagents corrupt shared-workspace verification | Low | Med | Per-session state; per-workspace mutex; artefact-scoped checks; interleaved-session test (§5.6). |

## 13. Open questions (the ONLY reasons to pause — Directive A)

1. **Core-thesis SDK support:** if Phase 0.0 finds **both** capability B (custom tool) and C (subagent-return interception) absent, Layer 2 can only be advisory — which weakens the central value. → **Stop & ask the owner** whether to proceed advisory-grade or pursue an alternative (e.g. an OpenCode feature request). All other Phase-0.0 outcomes proceed with the documented Option.
2. **Default ship state:** `off` vs `advisory` at release (5.3) — recommended `off`; confirm only if the owner prefers advisory-on.
3. **Auto-inference scope:** the default is auto-infer a minimal DoD for Mode A (M2). Confirm with the owner only if they want `requireExplicitDoD:true` as the shipped default instead.

> For anything **not** in this list: proceed with the documented default and note the assumption in the commit message. Do **not** stop the wave.

## 14. Appendix

### 14.1 Reference implementation (templates, not dependencies)
- `D:\git\agent-city-frontend\scripts\agent-city\agent-test\guards.mjs` — pure rule engine.
- `…\opencode-plugin.mjs` — the `tool.execute.before` enforcement point (throw-to-block; env gate; condition gating; trajectory flush).
- `hermes_crew/guards.py` — Python mirror (proves the rules are runtime-agnostic).

### 14.2 `[tier:X]` annotation legend (for executing THIS plan via model-router)
- `[tier:fast]` — recon/read-only/pre-flight/locating code.
- `[tier:medium]` — implementation, refactor, tests, wiring, config, docs.
- `[tier:heavy]` — spike analysis, ADRs/design, every Senior-QA review, security, ambiguous cross-cutting calls.

### 14.3 Glossary
- **Deliverable-first** — block exploratory/read calls until the delegation's primary action has been attempted; **disabled when no deliverable signal exists** (common in general coding — M5).
- **Producer ≠ grader / grader ≥ producer** — the model that produces an artefact never verifies it, and the verifier is at least as capable as the producer (C3).
- **Artefact** — the inspectable result of a delegation (changed files + final return + declared outputs) the gate verifies (§3.3).
- **Proportional enforcement** — light/none for trivial work; full hard-block + verify + escalate only where the weak model would otherwise thrash or false-finish.
- **Forcing message** — the steering text injected on a block / retry telling the model exactly what to do next.
- **Spike (Phase 0.0)** — the throwaway capability probe whose results gate and shape the whole plan.
