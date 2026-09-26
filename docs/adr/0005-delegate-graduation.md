# ADR 0005 — Delegate Tool Graduation

> **Status:** Proposed — operator approval required  
> **Date:** 2026-09-25  
> **Depends on:** ADR 0002 (Layer 2: Independent Acceptance Gate)  
> **Decision scope:** whether and how the plugin-owned `delegate` tool should graduate from its experimental opt-in.

## Context

ADR 0002 makes the authoritative acceptance-gate path explicit, but the shipped delegate registration remains opt-in. This leaves a product-default mismatch: users who do not enable the experimental flag get the advisory-grade native `Task()` path rather than the authoritative plugin-owned path. The question is not whether to change the acceptance gate; it is whether to make the already-designed authoritative entry point the normal tool surface, and how to do so without silently changing Mode A users' orchestration behavior.

## 1. ADR 0002 options and current wiring

ADR 0002 D1 says, verbatim:

> ### D1 — Two-track rollout (Option i first, Option ii is the authoritative end-state)
>
> - **Option (i) — verify-dispatch around raw `Task()` (advisory-grade gate).** When the orchestrator uses the built-in `Task()`, the plugin observes the `task` after-hook, assembles the artefact, runs the gate, **records the verdict**, and (in enforced mode) **appends a forcing note** to the task result when the verdict is FAIL. It **cannot** force a retry on an already-completed `task` call, so by itself Option (i) is *advisory-grade* for acceptance. Ships first because it is low-risk and additive.
> - **Option (ii) — plugin-provided `delegate` tool (authoritative gate + escalation).** A custom `delegate` tool whose `execute` closure uses the captured `client` to: **produce** (`session.create` + `session.prompt` to the producer tier/agent), **assemble** the artefact, **gate** (deterministic and/or checker), and on FAIL **hand to the Layer-3 ladder** (Wave 3) to retry/escalate, finally **returning only an accepted result** (or an honest `status:"unmet"`). This is the robust path that actually realises GA-3. Raw `Task()` continues to work unchanged.
>
> Both tracks **share one gate implementation** (`src/verify/gate.ts`) and one DoD type (`src/verify/dod.ts`) so Mode A (on-the-fly) and Mode B (plan-annotated) converge on a single code path (GA-5).

The premise is confirmed: `delegate` is Option (ii). In the current wiring, `src/index.ts:45-46` enables registration when `ctx.initialConfig.experimental?.verifiedDelegateTool === true` or `MODEL_ROUTER_VERIFIED_DELEGATE === "1"`; `src/router/config.types.ts:320` declares the experimental config key. `src/plugin/runtime.ts:81-84` documents the flag/environment enablement and `assembleRuntimeHooks` receives the resulting enablement boolean. Option (i) remains the native `task` after-hook verification path (`src/verify/dispatch.ts`, `shouldVerifyTask`); both use the shared gate (`src/verify/gate.ts`). Thus D1's wiring distinction remains accurate: registration is opt-in, while the two gate paths are distinct.

## 2. What has changed since ADR 0002

The product has expanded beyond the initial two-track design: the router now has a five-tier model, fanout introduces child-initiated parallel delegation, and reasoning profiles influence dispatch. These additions increase the importance of explicit policy and regression coverage, especially around nested/fanout calls; they do not change the core trade-off D1 weighed. Option (i) still observes a completed native task and cannot itself enforce retry, while Option (ii) still owns production, acceptance, and escalation. The gate remains the source of acceptance authority. Graduation must therefore preserve those contracts rather than reinterpret fanout, tiers, or reasoning profiles as a reason to weaken or bypass the gate.

## 3. Graduation costs and migration design

Graduation has a meaningful configuration and compatibility tail:

1. **Config lifecycle:** introduce a stable top-level `delegateTool` setting (or equivalent explicitly named stable key); retain `experimental.verifiedDelegateTool` as a deprecated alias during a transition. Resolve both in one place, with the stable key taking precedence. In the compatibility release, omission preserves the existing disabled behavior; the next announced major/minor policy boundary flips the default on, and a later major release removes the alias. Do not make both keys contradictory silently: emit a deprecation/configuration warning and document precedence.
2. **Environment lifecycle:** retain `MODEL_ROUTER_VERIFIED_DELEGATE=1` as a temporary compatibility override; announce its deprecation and replacement semantics alongside the config alias. Avoid interpreting unset as an explicit opt-out once the stable default changes. Provide a documented explicit opt-out before flipping the default.
3. **Mode A migration:** users relying on native Task will see a plugin-owned `delegate` tool offered to the orchestrator by default after the flip. This changes the available tool surface and the intended delegation route; it does not remove OpenCode's native `task` tool. Option (i)'s verification remains available as a fallback/compatibility path, but it is advisory-grade and must not be represented as equivalent authoritative acceptance. Users must be told that routing through `delegate` enables the authoritative acceptance/retry contract, while direct native Task remains unchanged.
4. **Docs:** update README's Mode A/Mode B and current hiding rationale, `CONFIG_REFERENCE`, and `FLOW_DIAGRAMS` to describe default, opt-out, precedence, deprecation schedule, and the distinction between authoritative `delegate` and advisory native Task verification.
5. **Tests:** extend config-resolution and registration tests across omitted/stable/legacy/both/conflicting settings and environment override; retain coverage for disabled compatibility and explicit opt-out. Exercise both `modeA-e2e` and `modeB-e2e`, including fanout/nested-delegation interactions where applicable, and preserve `nested-delegation-guard`. No gate acceptance semantics should change. The build follow-up must compare against the post-046 baseline and run the full existing verification matrix after plans 047–052 have landed.

The exact release cadence and naming of the stable key are implementation details for the follow-up build plan; operator approval of the default change and its compatibility window is required before implementation.

## 4. Cost of staying experimental

Keeping the current default avoids an immediate tool-surface change and preserves existing Mode A orchestration. The cost is ongoing: the default path does not realize ADR 0002's authoritative end-state, the user-facing default and accepted architecture remain contradictory, future audits will continue to rediscover the same decision debt, and operators may infer that the authoritative gate is enabled when it is not. This weakens the practical authority of ADR 0002 unless D1 is amended to declare the current opt-in end-state intentional.

## 5. Decision — staged graduation after baseline work

**Recommend staged graduation, with default-on only after plans 046–052 are complete and their verification baseline is green.** Do not flip the default in this spike. After that prerequisite, ship a compatibility release with the stable setting, legacy aliases, explicit opt-out, migration documentation, and telemetry/diagnostics sufficient to identify which route is active; then flip the default at a clearly announced release boundary, retaining aliases through the announced deprecation window.

This recommendation honors D1's authoritative end-state while avoiding an unannounced Mode A tool-surface change. Its trade-off is a longer period of dual configuration and documentation burden, and the authoritative path remains opt-in until the safety baseline and migration work are ready. The alternative of staying experimental indefinitely is lower short-term migration risk but permanently accepts the architectural/product contradiction; immediate default-on is simpler but imposes a potentially surprising orchestrator behavior change without a compatibility runway.

### User-visible behavior

There is **no user-visible behavior change from this ADR alone**. If approved and implemented after plans 046–052, the transition will first add a stable configuration name while preserving the current default; at the later announced default flip, `delegate` will be offered without opt-in. Native `task` remains available, but direct use remains the advisory-grade verification route. An explicit opt-out will preserve the legacy tool surface for users who need it.

### Follow-up build plan (scope stub only)

- Sequence after plans 046–052 are complete; verify against the documented post-046 baseline.
- Add stable config/env resolution, legacy aliases, warnings, precedence, and explicit opt-out without changing the default in the compatibility step.
- Update README, `CONFIG_REFERENCE`, and `FLOW_DIAGRAMS` with migration and route semantics.
- Expand config, registration, Mode A/Mode B, fanout, and nested-delegation coverage.
- Flip default only at an operator-approved release boundary; document alias removal as a later breaking-change step.

## Current gating-site inventory

The repository search for `verifiedDelegateTool` and `MODEL_ROUTER_VERIFIED_DELEGATE` across `src/`, `README.md`, and `docs/` returned:

- `src/index.ts:45-46` — runtime enablement condition (experimental config or environment variable).
- `src/plugin/runtime.ts:83` — API comment documenting the experimental config and environment enablement; `assembleRuntimeHooks` accepts `enableDelegateTool` at `src/plugin/runtime.ts:81`.
- `src/router/config.types.ts:320` — experimental config type declaration.

No additional references to either gate name were found in README or docs. Relevant test-surface search hits include `test/integration/layer2-wiring.test.ts:9,190,195`, `test/integration/modeA-e2e.test.ts`, `test/integration/modeB-e2e.test.ts`, `test/unit/plugin-runtime.test.ts:174-192`, `test/unit/gate.test.ts:162,170`, and `test/unit/plugin-delegate.test.ts:1497`. These are the suites to assess for the follow-up; this ADR changes no tests or implementation.

## Consequences

- D1's authoritative end-state is retained, while the default transition is explicitly staged and gated on baseline work.
- Operators must approve the compatibility window, stable key naming, and release boundary before implementation.
- The dual-path and alias period has temporary maintenance cost; the build work must preserve native Task compatibility and the authoritative gate's fail-closed behavior.
