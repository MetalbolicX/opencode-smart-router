# Plan 061 (SPIKE): Resolve the delegate-tool experimental flag vs ADR 0002's authoritative end-state

> **Executor instructions**: DESIGN/SPIKE plan — investigate, decide,
> write the decision document. **No production code changes.** Honor STOP
> conditions. Update your row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- docs/adr/0002-acceptance-gate.md src/index.ts src/plugin/runtime.ts src/router/config.types.ts README.md`
> Skim for changes; note drift in the doc rather than stopping.

## Status

- **Priority**: P2 (decision debt on the product's flagship architecture)
- **Effort**: S–M (spike: reading + one decision + amendment doc)
- **Risk**: LOW for the spike (the GRADUATION decision it feeds is HIGH
  risk if defaulted on silently — that is exactly why it needs this analysis)
- **Depends on**: none
- **Category**: direction (decision spike)
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

ADR 0002 (`docs/adr/0002-acceptance-gate.md`) decides a two-track rollout:
"D1 — Two-track rollout (Option i first, **Option ii is the authoritative
end-state**)" (line ~`:24`). Option (ii) — the plugin-owned `delegate` tool
— is the end-state the acceptance-gate architecture was designed around.
But the shipped default keeps `delegate` hidden behind
`experimental.verifiedDelegateTool` (or `MODEL_ROUTER_VERIFIED_DELEGATE=1`),
and the README defends hiding it (~`:887`, "hidden by default so delegation
stays visible"). Result: the flagship gate architecture is off the default
path, the decision doc and the product disagree, and cycle 6 explicitly
deferred "graduating the `delegate` tool from `experimental` (contradicts
ADR 0002's 'authoritative end-state')". This spike resolves the
contradiction ONE way or the other with an ADR amendment — either path is
legitimate; leaving it contradictory is not.

## Current state (evidence, verified during audit cycle 7)

- `docs/adr/0002-acceptance-gate.md:24` — D1 two-track decision text
  (READ THE FULL ADR; the spike must quote D1 exactly and map Option i/ii
  to today's wirings).
- `src/router/config.types.ts:320` —
  `experimental?: { verifiedDelegateTool?: boolean }` (config flag).
- `src/index.ts:~45` — delegate registration gated on the flag
  (verify exact line at drift check).
- `src/plugin/runtime.ts:81-88` — `assembleRuntimeHooks(ctx, tiers,
  enableDelegateTool)`; the flag OR `MODEL_ROUTER_VERIFIED_DELEGATE=1`
  enables the tool (see the doc comment at `:81-84`).
- `src/verify/gate.ts:1-9` — the gate is shared by BOTH wirings
  ("Option (i) verify-dispatch around the built-in `task` tool, and
  Option (ii) the plugin-owned `delegate` tool" — one accept path, GA-5).
- `src/verify/dispatch.ts:174-183` — `shouldVerifyTask`: Option (i) gates
  the built-in `task` tool.
- `README.md:~887` — hiding rationale; Mode A (native Task) vs Mode B docs.
- Env override: `MODEL_ROUTER_VERIFIED_DELEGATE=1`
  (`src/plugin/runtime.ts` region; grep it).

## Questions this spike MUST answer

1. **What exactly are Options i and ii per ADR 0002?** Quote D1 + the
   option definitions. Map each to current code paths (verify-dispatch vs
   delegate tool). Confirm the premise: is `delegate` really Option ii?
   (DIR-audit confidence was MED-HIGH here — verify against the ADR body.)
2. **What has changed since the ADR was written** (2026-07-11)? Five-tier
   expansion, fanout tool, reasoning profiles — does any of it change the
   trade-off the ADR weighed (orchestrator UX visibility vs gate authority)?
3. **What would graduation cost?** Enumerate: flag lifecycle
   (`experimental.verifiedDelegateTool` → new top-level key with alias
   compatibility → default flip → eventual removal), env-var deprecation,
   Mode A users' migration story (what changes in their orchestrator's
   tool surface; does native `task` stay gated as fallback?), docs
   (README, CONFIG_REFERENCE, FLOW_DIAGRAMS), test matrix impacts
   (`modeA-e2e`/`modeB-e2e`, `nested-delegation-guard`).
4. **What does staying experimental cost?** The contradiction persists;
   every future audit re-flags it; ADR 0002's authority erodes.
5. **DECISION**: graduate / stay-with-amendment (rewrite D1 to bless the
   current default as the end-state, with rationale) / staged graduation
   (default-on behind a deprecation window). ONE recommendation with
   trade-offs, written so the operator can approve it in a paragraph.

## Deliverable

`docs/adr/0005-delegate-graduation.md` (number coordinated with plans
054/060 — they take 0003/0004): the five answers, the recommendation, the
flag-lifecycle design IF graduating, and an explicit "what would change in
user-visible behavior" section. If the decision is a future BUILD, add a
stub build-plan section (scope bullets only; do not write the plan file).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| ADR text | read `docs/adr/0002-acceptance-gate.md` in full | D1 + options quoted |
| Flag sites | `rg -n "verifiedDelegateTool\|MODEL_ROUTER_VERIFIED_DELEGATE" src/ README.md docs/` | all gating sites enumerated |
| Test surface | `rg -ln "delegate tool\|modeA\|modeB" test/` | impacted suites listed |

## Scope

**In scope**:
- `docs/adr/0005-delegate-graduation.md` (create)
- `plans/README.md` (status row)

**Out of scope**:
- Any `src/`/`test/` change; flipping any flag; writing the build plan

## Steps

1. Read ADR 0002 end-to-end; quote D1 and both options verbatim.
2. Enumerate every flag/env gating site (command above); map to wirings.
3. Answer Q2–Q4 with evidence; keep each to a paragraph.
4. Write the recommendation (Q5) + lifecycle design + user-visible delta.
5. ADR + index row.

## Done criteria

- [ ] `docs/adr/0005-delegate-graduation.md` exists; D1 quoted; all 5 questions answered; ONE recommendation
- [ ] Every flag site enumerated with file:line
- [ ] `git status` shows only the ADR + index
- [ ] `plans/README.md` status row updated (and the cycle-6 deferred-direction note marked resolved-by-061)

## STOP conditions

- ADR 0002's D1 does NOT say what the audit quoted (premise broken) —
  write the correction into the ADR amendment; that IS the deliverable then.
- Graduation analysis requires user research you cannot do — scope the doc
  to the code-level evidence and mark UX questions as operator-input-needed
  (do not invent survey data).

## Maintenance notes

- If the operator approves graduation, the follow-up build plan should
  sequence AFTER plans 046-052 (baseline + CI) — flipping a default needs
  the safety net in place.
