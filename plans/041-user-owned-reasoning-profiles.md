# Plan 041: Replace the hardcoded reasoning vocabulary with user-owned profiles and per-tier native levels

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 0ea3822..HEAD -- src/reasoning src/escalate src/plugin/delegate.ts src/router/config.types.ts src/router/config-validate.ts src/router/commands src/router/agents.ts config/tiers scripts/build-tiers-config.ts tiers.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED–HIGH (breaking configuration migration; touches the delegate ladder)
- **Depends on**: none (supersedes the approach of Plan 015; see index)
- **Category**: migration / tech-debt (architecture)
- **Planned at**: commit `0ea3822`, 2026-08-30
- **Execution model**: **SDD cycle** — see "SDD execution model" below. This
  plan is the requirements input; the implementation is produced through the
  repo's SDD workflow (explore → propose → spec → design → tasks → apply →
  verify → archive), exactly as Plan 034 was.

## Why this matters

The router currently *knows* a reasoning vocabulary it cannot legitimately
know. It hardcodes a four-grade normalized level set
(`minimal|normal|elevated|max`), hardcodes which provider variant strings are
"positional" or "named" (`POSITIONAL_VARIANTS`/`NAMED_VARIANTS`), and
translates intent to provider values with lossy positional math
(`DISCRETE_RANK` + `Math.round`). Consequences today:

- A model swap to any tier silently invalidates the inferred capability — an
  unknown variant degrades to `kind: "none"` with **no error**
  (`src/reasoning/capability.ts:103-105`), so the tier quietly loses
  reasoning control.
- Providers rename levels over time (e.g. DeepSeek `[low,medium,high,max]` →
  `[low,high,max]`); today that requires a router code change because the
  legal level names live in code, not config.
- The normalized 4-grade set maps lossily onto 3-level ladders
  (`docs/REASONING.md` documents the collapse: `minimal`+`normal` → `low`,
  `elevated`+`max` → `high`).
- Bump enablement is a single global switch
  (`enforcement.escalate.reasoningEscalation.enabled`), so a tier cannot opt
  out independently.

After this plan: the operator owns two separate vocabularies in `tiers.json` —
opaque **profile IDs** (what the router/user mean by "how much reasoning") and
**native levels** (the exact values each tier's current model accepts) — plus
a per-tier `profileMap` bridge and a per-tier `maxBumps`. No level name,
profile name, or capability inference exists in code. Bumping advances one
array index; order is the only semantics.

## Current state

Verified verbatim at commit `0ea3822`. Files and roles:

- `src/reasoning/capability.ts` — normalized vocabulary + capability union + inference (DELETED by this plan)
- `src/reasoning/translate.ts` — level→patch translation incl. `DISCRETE_RANK` rank math (rewritten)
- `src/reasoning/policy.ts` — mode resolver (`static`/`manual`/`adaptive`) (vocabulary swap)
- `src/reasoning/adaptive.ts` — deterministic adaptive selector (vocabulary swap)
- `src/reasoning/store.ts` — per-session override store typed `ReasoningLevel` (loosened to `string`)
- `src/router/config.types.ts` — `ReasoningPolicyConfig`, `AdaptivePolicyConfig`, `TierConfig.capability?`, `ReasoningEscalationConfig` (rewritten)
- `src/router/config-validate.ts` — hardcoded level-list validation + global reasoningEscalation validation (rewritten)
- `src/escalate/ladder.ts` — bump eligibility + policy carry global reasoningEscalation (reworked)
- `src/plugin/delegate.ts` — `enterTier` seeds `levelIndex` from configured variant/effort via `inferCapability` (reseeded from `profileMap`)
- `src/router/agents.ts` — `applyReasoningPatch`/`restoreAgentBaseline`/`registerTierAgents` (UNCHANGED — patch applier is already channel-generic)
- `src/router/commands/builders.ts` + `dispatch.ts` — `/model-router-reasoning` UI hardcodes level names (rewritten)
- `config/tiers/base.json`, `config/tiers/presets.json`, `scripts/build-tiers-config.ts`, `tiers.json` — config sources + generator (migrated)

Key excerpts:

`src/reasoning/capability.ts:17` — the hardcoded vocabulary this plan deletes:

```ts
export type ReasoningLevel = "minimal" | "normal" | "elevated" | "max";
```

`src/reasoning/capability.ts:55-58,81-108` — hardcoded provider-name knowledge:

```ts
const POSITIONAL_VARIANTS = new Set<string>(["low", "medium", "high", "xhigh"]);
const NAMED_VARIANTS = new Set<string>(["thinking", "max"]);
// inferCapability: variant not in either set → falls through to `none` (silent)
```

`src/reasoning/translate.ts:27-32` — rank math that collapses levels:

```ts
const DISCRETE_RANK: Record<ReasoningLevel, number> = {
  minimal: 0, normal: 1, elevated: 2, max: 3,
};
```

`src/router/config.types.ts:209-215` — current policy shape:

```ts
export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";
  defaultLevel?: import("../reasoning/capability.js").ReasoningLevel;
  surfaceLimits?: boolean;
  adaptive?: AdaptivePolicyConfig;
}
```

`src/router/config-validate.ts:48-53` — the validator twin of the vocabulary:

```ts
const REASONING_LEVELS = ["minimal", "normal", "elevated", "max"] as const;
const isReasoningLevel = (v: unknown): v is ReasoningLevel =>
  typeof v === "string" && (REASONING_LEVELS as readonly string[]).includes(v);
```

(Level-membership checks: `validateLevelOrNull` `:458-465`, keyword-rule
`level` `:493-497`, `tierDefaults` `:534-546`. The same set is duplicated in
`src/router/commands/builders.ts:29-34`.)

`src/escalate/ladder.ts:118-130` — bump eligibility reads the GLOBAL switch:

```ts
export const canBumpReasoning = (state, policy, verdict) => {
  const re = policy.reasoningEscalation;
  if (!re?.enabled) return false;
  if (state.reasoningLadderLen <= 0) return false;
  const bumpsLeft = (re.maxLevelBumpsPerTier ?? 2) - state.bumpsThisTier;
  if (bumpsLeft <= 0) return false;
  if (verdict?.cause !== "verification_fail") return false;
  return true;
};
```

`src/escalate/ladder.ts:259-269` — policy construction carries the global block
(`reasoningEscalation: esc?.reasoningEscalation ?? { enabled: false, maxLevelBumpsPerTier: 2 }`).

`src/plugin/delegate.ts:188-206` — `enterTier` seeds the start index from the
tier's configured `reasoning.effort`/`variant` through `inferCapability` +
`levelIndexForVariant`; `src/plugin/delegate.ts:570-579` builds the verdict
with `cause: gateRes.accepted ? undefined : (promptCause ?? "verification_fail")`.

`src/reasoning/policy.ts:76-112` — mode semantics to PRESERVE verbatim in
meaning: `static` → hard no-op; `manual` → `sessionOverride ?? defaultLevel`;
`adaptive` → override wins, then selector, then default. Only the vocabulary
changes.

`src/reasoning/adaptive.ts:100-172` — selector decision order to PRESERVE:
(1) `isTrivial` → `trivialLevel ?? null`; (2) `tierDefaults[tierName]`;
(3) keyword rules, first match wins (`match` modes `word|stem|substring|regex`
via `src/reasoning/match.ts`); (4) `defaultLevel ?? null`.

`src/reasoning/store.ts:38,46-54` — `overrides = new Map<string, ReasoningLevel>()`.

Runtime patch channels (UNCHANGED, verified in `src/router/agents.ts:59-76`
`applyReasoningPatch`): `variant` → `agentDef.variant`;
`reasoning.effort` → `agentDef.options.reasoning_effort`;
`thinking.budgetTokens` → `agentDef.options.budget_tokens`.

Config generator note: `scripts/build-tiers-config.ts` MERGE_PLAN allow-lists
base keys — when `enforcement.escalate.reasoningEscalation` is removed from
`config/tiers/base.json`, the merge plan and
`test/unit/tiers-assembly.test.ts` + `test/unit/router-config.test.ts` +
`test/golden/__snapshots__/protocol.golden.test.ts.snap` expectations must be
updated in the same change (this exact coupling was hit before; see engram
obs #4141).

Repo conventions: ESM + `.js` import suffixes; pure-function modules with
narrative header comments (`src/reasoning/*.ts` are the exemplars); vitest
unit tests mirror `src/` layout under `test/unit/`; Biome formatting;
conventional commits.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Build tiers.json | `pnpm run build:tiers` | exit 0, `tiers.json` regenerated |
| Typecheck | `pnpm run typecheck` | exit 0 |
| Tests (TS) | `pnpm test` | all pass (see baseline note) |
| Tests (RS parity) | `pnpm run test:res` | all pass |
| Lint | `pnpm run lint` | exit 0 |
| Build | `pnpm run build` | exit 0 |

Baseline note (from cycle-6 verifier experience): if `pnpm test` /
`pnpm run typecheck` show failures at the `0ea3822` baseline BEFORE you start,
record them (`git stash` + run) and phrase your gates as "no NEW failures
versus baseline". At `0ea3822` (v1.9.2, published through `prepublishOnly` →
`test:gate`) the suite is expected green.

## SDD execution model

This plan is executed as one SDD change, following the Plan 034 precedent:

1. Orchestrator bootstraps the change `user-owned-reasoning-profiles`
   (artifact store: engram; topic keys
   `sdd/user-owned-reasoning-profiles/{explore,propose,spec,design,tasks,verify,archive}`).
   This plan file is the requirements input to `propose` — the proposal must
   not re-litigate decisions marked **DECIDED** below.
2. `spec` turns the "Target design" section into requirements/scenarios;
   `design` resolves the flagged design decisions (D-1…D-4) and produces the
   module-level plan; `tasks` slices it into PR-sized work units.
3. `apply` executes the steps below as stacked PRs on branch
   `advisor/041-user-owned-reasoning-profiles`; `verify` re-runs the Done
   criteria; `archive` syncs delta specs and closes the cycle.

## Target design

### DECIDED (binding — do not re-open in propose/spec)

1. **Two opaque vocabularies.** Profile IDs and native levels are arbitrary
   strings/integers owned by `tiers.json`. Code never interprets their names.
   Array order (ascending reasoning effort) is the ONLY semantics.
2. **Per-tier `reasoningControl`** replaces `TierConfig.capability`,
   `inferCapability`, and all normalized translation. A tier without
   `reasoningControl` has no reasoning control, cannot bump, and is valid.
3. **`maxBumps` is the sole bump switch.** No `enableBump` boolean.
   `maxBumps: 0` = bumping disabled. Required on every `reasoningControl`.
   No implicit default.
4. **Bump exhaustion (cap or top reached) on a `verification_fail` → escalate
   tier directly**, no additional same-level verification retry. A
   `maxBumps: 0` tier keeps the ordinary retry/escalation policy.
   Retryable provider errors never consume bumps. Bumped requests still count
   toward `maxTotalAttempts`.
5. **Breaking migration.** No runtime compatibility inference of old
   capability/level shapes. Invalid reloads keep the previous config active
   (existing config-store behavior). Persisted session overrides that are not
   registered profile IDs are ignored (reset to policy) with a
   `reasoning.override_unknown_profile` log event.
6. **Mode semantics preserved**: `static` = hard no-op (no runtime patch);
   `manual` = override ?? default; `adaptive` = override wins → selector →
   default. `/model-router-reasoning off` clears the session override and
   returns control to the configured policy (unchanged meaning).
7. **Static baseline passthrough stays**: `tier.variant`, `tier.reasoning`
   (`effort`/`summary`), `tier.thinking` remain legal STATIC agent-def
   options consumed by `registerTierAgents`/`buildAgentOptions`
   (`src/router/agents.ts:9-30,112-157`) and are NOT interpreted as
   capability. Runtime patches from `reasoningControl` override them per
   request via the existing `applyReasoningPatch`/`restoreAgentBaseline`
   cycle. `src/router/agents.ts` requires no behavioral change.

### New types (`src/router/config.types.ts`)

```ts
/** Opaque, user-owned reasoning intent ID. Membership in
 *  `ReasoningPolicyConfig.profiles` is the only validity criterion. */
export type ReasoningProfileId = string;

export type ReasoningControlChannel =
  | "variant"              // writes agentDef.variant
  | "reasoning.effort"     // writes agentDef.options.reasoning_effort
  | "thinking.budgetTokens"; // writes agentDef.options.budget_tokens

export interface StringReasoningControl {
  channel: "variant" | "reasoning.effort";
  /** Ordered low→high. Unique non-empty strings. */
  levels: [string, ...string[]];
  /** EVERY registered profile ID → a member of levels. No extras. */
  profileMap: Record<ReasoningProfileId, string>;
  /** 0 = bumping disabled. Integer, 0 ≤ maxBumps ≤ levels.length - 1. */
  maxBumps: number;
}

export interface BudgetReasoningControl {
  channel: "thinking.budgetTokens";
  /** Ordered low→high. Unique, ascending, non-negative integers. */
  levels: [number, ...number[]];
  profileMap: Record<ReasoningProfileId, number>;
  maxBumps: number;
}

export type ReasoningControl = StringReasoningControl | BudgetReasoningControl;

/** Keyword rule: same matching grammar as today (match.ts), but the
 *  consequence is a profile ID, not a normalized level. */
export interface AdaptiveProfileRule {
  keywords: string[];
  excludeKeywords?: string[];
  match?: "word" | "stem" | "substring" | "regex";
  profile: ReasoningProfileId;
}

export interface ReasoningPolicyConfig {
  mode?: "static" | "manual" | "adaptive";       // default "static"
  /** Closed registry. Unique, non-empty. REQUIRED once any tier has
   *  reasoningControl or mode != "static". */
  profiles?: ReasoningProfileId[];
  /** Fallback + manual/implicit default. Must be a registered profile.
   *  REQUIRED when mode is "manual" or "adaptive". */
  defaultProfile?: ReasoningProfileId;
  surfaceLimits?: boolean;
  adaptive?: {
    trivialProfile?: ReasoningProfileId | null;
    tierProfileDefaults?: Record<string, ReasoningProfileId>;
    rules?: AdaptiveProfileRule[];
    surfaceDecision?: boolean;
  };
}

// TierConfig: ADD  reasoningControl?: ReasoningControl;
// TierConfig: REMOVE  capability?: ... (line 44)
// EnforcementConfig.escalate: REMOVE reasoningEscalation block
//   (ReasoningEscalationConfig interface deleted)
```

### Config examples

No reasoning (model swap to a non-reasoning model — just omit the control):

```json
{ "model": "minimax-coding-plan/MiniMax-M2.7" }
```

String levels, bumping initially OFF (shipped default), provider renames are
a config edit:

```json
{
  "model": "deepseek/DeepSeek-V4-Flash",
  "reasoningControl": {
    "channel": "reasoning.effort",
    "levels": ["low", "high", "max"],
    "profileMap": { "light": "low", "standard": "high", "deep": "max" },
    "maxBumps": 0
  }
}
```

Numeric budgets:

```json
{
  "reasoningControl": {
    "channel": "thinking.budgetTokens",
    "levels": [1024, 4096, 16384],
    "profileMap": { "light": 1024, "standard": 4096, "deep": 16384 },
    "maxBumps": 1
  }
}
```

`"light" | "standard" | "deep"` are ILLUSTRATIVE bundled-config values, not
code constants. Effective bump room is always
`min(maxBumps, levels.length - 1 - startIndex)`.

### Runtime algorithm (normative)

```text
selected = manual: override ?? defaultProfile
        | adaptive: override ?? selector(signals) ?? defaultProfile
        | static: null (no patch; static baseline serves)

per tier entered:
  control = tier.reasoningControl
  if selected is null OR control is absent → dispatch with NO reasoning patch
  else:
    native = control.profileMap[selected]        (validator guarantees presence)
    levelIndex = control.levels.indexOf(native)
    patch(control.channel, native)               (existing applyReasoningPatch)

on verification_fail:
  eligible = control exists AND selected != null AND control.maxBumps > 0
             AND levelIndex < levels.length - 1
             AND bumpsThisTier < control.maxBumps
  eligible  → levelIndex += 1; bumpsThisTier += 1; new request, same tier
  else      → escalate tier (no same-level verification retry)
on retryable_error: ordinary retry path (unchanged); bumps not consumed
```

### Validation invariants (fail-fast, `config-validate.ts`)

- `profiles`: when present — non-empty array, unique, non-empty strings.
- `defaultProfile`, `adaptive.trivialProfile` (non-null),
  `tierProfileDefaults.*`, every `rules[].profile` — must be registered.
- `mode` `manual`/`adaptive` ⇒ `profiles` and `defaultProfile` required.
- Every `reasoningControl`: `channel` ∈ the three literals; `levels` non-empty;
  strings unique/non-empty; budgets unique/ascending/non-negative integers;
  `profileMap` keys EXACTLY equal the registry (missing AND extra are errors);
  every mapped value ∈ `levels` (strict `===` / number equality);
  `maxBumps` integer, `0 ≤ maxBumps ≤ levels.length - 1`.
- `reasoningControl` absent ⇒ no bump fields may appear anywhere for that tier.
- `enforcement.escalate.reasoningEscalation` ⇒ now a validation ERROR
  (removed key; message points at the migration note in docs).
- Keyword grammar validation (keywords non-empty string array, `match` modes,
  regex fail-fast compile) carries over unchanged, with `profile` in place of
  `level` (`config-validate.ts:477-532` is the pattern to keep).

### Design decisions for the SDD design phase (pre-scoped)

- **D-1**: How the delegate path obtains `selected` (delegate has
  `args.task` text + parent sessionID): reuse `resolveReasoningProfile` with
  store override from the parent session and adaptive signals from the task
  text. Constraint: the SAME resolution helper serves the `task`-tool hook
  path and the delegate path — one function, two callers.
- **D-2**: Where per-tier bump state lives: keep
  `LadderState.levelIndex/bumpsThisTier/reasoningLadderLen` and ADD the
  tier's `maxBumps` (seeded by `enterTier`); `EscalatePolicy` loses
  `reasoningEscalation`. `canBumpReasoning` stays a pure function.
- **D-3**: Exhaustion branch shape in `nextAction`: verification_fail +
  control present + bumps exhausted → escalate; control present +
  `maxBumps: 0` → existing retry branch; no control → existing retry branch.
  Property tests must pin all three.
- **D-4**: Whether `src/reasoning/capability.ts` survives as a channel-only
  module or its channel constants move into `config.types.ts` (prefer: keep
  the file with ONLY `ReasoningControlChannel` + patch-application helpers;
  delete everything else).

## Scope

**In scope** (the only files to modify):

- `src/reasoning/capability.ts`, `translate.ts`, `policy.ts`, `adaptive.ts`, `store.ts`
- `src/router/config.types.ts`, `config-validate.ts`
- `src/escalate/ladder.ts`, `src/plugin/delegate.ts`
- `src/router/commands/builders.ts`, `dispatch.ts`
- `src/plugin/hooks/tool-guards.ts` (resolver call-site type updates ONLY — no hook logic changes)
- `config/tiers/base.json`, `config/tiers/presets.json`, `scripts/build-tiers-config.ts`, `tiers.json` (regenerated)
- `docs/REASONING.md`, `docs/CONFIG_REFERENCE.md`, `docs/ESCALATION.md`, `README.md` (reasoning sections only)
- Tests: `test/unit/reasoning-*.test.ts`, `adaptive-selector.test.ts`, `ladder.test.ts`, `plugin-delegate.test.ts`, `config-validate-sections.test.ts`, `tiers-assembly.test.ts`, `router-config.test.ts`, `router-commands.test.ts`, `tool-guards.test.ts`, `router-agents.test.ts`, `test/golden/__snapshots__/protocol.golden.test.ts.snap`, `test/integration/reasoning-runtime.test.ts` + a NEW anti-hardcoding test (Step 11)

**Out of scope** (do NOT touch):

- `src/verify/**`, `src/guard/**` — grader, DoD gate, guard engine (Plan 037/029 territory).
- Tier-selection routing (`checker.ts`, `sessions.ts`, `TierLadder.res`), cost
  ceiling, `maxAttemptsPerTier`/`maxTotalAttempts` semantics, abort handling.
- `src/router/agents.ts` behavior (baseline registration / patch applier stay byte-compatible; only its `describeCapability`-style imports if any move).
- ReScript `Guard.res`/`TierLadder.res` logic. (Check parity exposure — see Step 2 — but the reasoning/bump path is TypeScript-only at `0ea3822`.)

## Git workflow

- Branch: `advisor/041-user-owned-reasoning-profiles` (worktree per repo SDD convention, e.g. `/tmp/opencode/smart-router-041`).
- Conventional commits, e.g. `feat(reasoning): replace normalized levels with user-owned profile registry`, `refactor(escalate): move bump cap into per-tier reasoningControl`, `test(reasoning): pin maxBumps exhaustion semantics`.
- Do NOT push or open PRs unless the operator instructed it.

## Steps

### Step 0: SDD bootstrap

Orchestrator creates the SDD change `user-owned-reasoning-profiles` with this
plan as the requirements input; run `explore` ONLY to confirm the excerpts
above (they were verified at `0ea3822`; explore must not re-open DECIDED items).

**Verify**: SDD artifacts exist under
`sdd/user-owned-reasoning-profiles/{propose,spec}`; proposal cites this plan.

### Step 1: Parity exposure check

```bash
rg -l "reasoningEscalation|bumpsThisTier|ReasoningLevel|inferCapability" src/ --glob '*.res*' ; rg -n "reasoning" src/guard src/verify --glob '*.res*'
```

**Verify**: no `.res`/`.resi` hits for the reasoning/bump identifiers (expected
at `0ea3822`). If hits exist, STOP and report — ReScript parity ports must be
scoped into the plan before proceeding.

### Step 2: Types (`src/router/config.types.ts`)

Introduce `ReasoningProfileId`, `ReasoningControlChannel`,
`StringReasoningControl`, `BudgetReasoningControl`, `ReasoningControl`,
`AdaptiveProfileRule`, and the v2 `ReasoningPolicyConfig` from "Target
design". Delete `ReasoningEscalationConfig`, the `escalate.reasoningEscalation`
slot, and `TierConfig.capability`. Update the `src/router/config.ts` barrel
exports.

**Verify**: `pnpm run typecheck` → errors ONLY in files not yet migrated
(capability/translate/policy/adaptive/store/validate/ladder/delegate/
builders/dispatch/tool-guards + their tests). No errors elsewhere.

### Step 3: Validation (`src/router/config-validate.ts`)

Replace `REASONING_LEVELS`/`isReasoningLevel`/`validateLevelOrNull` with
registry-membership validation; add `validateReasoningControl` (all invariants
above); rewrite `validateAdaptivePolicy` for `trivialProfile`/
`tierProfileDefaults`/`rules[].profile`; delete the global
`reasoningEscalation` validation and make its presence an error with a
migration pointer. Keep the permissive-skip + `tiers.json:` error-prefix
conventions (`config-validate.ts:440-451` pattern).

**Verify**: `pnpm test -- config-validate` → new validation cases pass (write
them first, TDD per repo convention).

### Step 4: Resolution core (`policy.ts`, `adaptive.ts`, `store.ts`)

- `policy.ts`: `resolveReasoningProfile(policy, sessionOverride, signals)` →
  `{ profile: ReasoningProfileId } | null`. Preserve mode semantics EXACTLY
  (policy.ts:76-112 meaning; `static` → null; unknown mode → null fail-soft).
- `adaptive.ts`: selector returns profile IDs; same decision order, same
  `matchSignal` grammar, same fail-soft guards; `null` ⇒ fall through.
- `store.ts`: override type `string`; add nothing else.

**Verify**: `pnpm test -- reasoning-policy adaptive-selector` → green.

### Step 5: Translation (`translate.ts`, `capability.ts`)

- `translate.ts`: delete `DISCRETE_RANK`, `translateLevel`,
  `resolveLevelIndex`, `levelIndexForVariant`, `capabilityLadderLength`.
  Add pure `resolveControlPatch(control, profileId)` (profileMap lookup →
  channel patch, `null` when control absent) and rework `translateAtIndex`
  into `patchAtIndex(control, idx)` (index → channel patch, clamped).
- `capability.ts`: per D-4 keep only channel constants/helpers; delete
  `ReasoningLevel`, `ReasoningCapability`, `POSITIONAL_VARIANTS`,
  `NAMED_VARIANTS`, `inferCapability`.

**Verify**: `pnpm test -- reasoning-translate reasoning-capability` → rewritten
suites green; `rg -n "DISCRETE_RANK|translateLevel|inferCapability" src/` → no matches.

### Step 6: Ladder + delegate (`ladder.ts`, `delegate.ts`)

- `ladder.ts`: per D-2/D-3 — `EscalatePolicy` drops `reasoningEscalation`;
  `LadderState` gains the seeded tier `maxBumps`; `canBumpReasoning` reads it;
  `nextAction` branch (5.5) implements the three exhaustion cases; `advance`
  bump/escalate transitions unchanged in shape.
- `delegate.ts`: `enterTier` reads `tier.reasoningControl` (no
  `inferCapability`); seeds `levelIndex` from
  `control.levels.indexOf(control.profileMap[selected])` (D-1 resolution),
  `reasoningLadderLen = control.levels.length`, tier `maxBumps`; per-attempt
  patch via `patchAtIndex(control, state.levelIndex)`; baseline
  snapshot/restore cycle (`tierBaselines` map + outer `finally`) unchanged.

**Verify**: `pnpm test -- ladder plugin-delegate` → rewritten suites green,
including the three D-3 property cases and bump→bump→escalate flows.

### Step 7: Commands (`builders.ts`, `dispatch.ts`)

`/model-router-reasoning` lists and accepts ONLY registered profile IDs or
`off`; `describeCapability` rewritten from `reasoningControl` (channel,
ordered levels, maxBumps); delete the local `REASONING_LEVELS` set
(builders.ts:29-34). `off` keeps its exact current meaning (clear override —
dispatch.ts:243-247 behavior).

**Verify**: `pnpm test -- router-commands` → green.

### Step 8: Bundled config migration

- `config/tiers/base.json`: remove `enforcement.escalate.reasoningEscalation`;
  write v2 `reasoningPolicy` (suggest profiles `["light","standard","deep"]`,
  `defaultProfile: "standard"`, keep the current keyword-rule grammar with
  `profile` targets, `trivialProfile`/`tierProfileDefaults` ported from the
  current adaptive block).
- `config/tiers/presets.json` (multi-provider): `fast`/`medium` → no control;
  `light` (gpt-5.6-luna) → effort channel, levels
  `["low","medium","high","xhigh","max"]`; `focused` (MiniMax-M3) → variant
  channel, levels `["none","thinking"]`; `heavy` (gpt-5.6-terra) → effort
  channel, levels `["low","medium","high","xhigh"]`. ALL tiers ship
  `"maxBumps": 0` (operator opts into bumping per tier afterwards).
- Update `scripts/build-tiers-config.ts` MERGE_PLAN if the removed/renamed
  base keys require it (remember obs #4141: base keys are allow-listed);
  regenerate: `pnpm run build:tiers`.

**Verify**: `pnpm test -- tiers-assembly router-config` green; golden snapshot
updated intentionally (`git diff tiers.json` shows ONLY the expected v2
reasoning shape).

### Step 9: Hooks + integration

`src/plugin/hooks/tool-guards.ts` call-sites: swap
`resolveReasoningOverride` → `resolveReasoningProfile` +
`resolveControlPatch`; no logic changes. Update
`test/integration/reasoning-runtime.test.ts` end-to-end expectations
(patch seam: spy on `session.prompt` reading the LIVE agent def, per the
Plan 034 wiring-test pattern — if the spy observes an UNPATCHED baseline at
prompt time, STOP and report; do not switch patch mechanisms).

**Verify**: `pnpm test` → full suite green (or no NEW failures vs recorded baseline).

### Step 10: Docs

`docs/REASONING.md` (rewrite around profiles/controls; delete normalized
vocabulary + collapse caveat), `docs/CONFIG_REFERENCE.md` (v2 schema +
invariants), `docs/ESCALATION.md` (per-tier maxBumps; exhaustion → escalate),
`README.md` reasoning sections. Include the DeepSeek rename and model-swap
worked examples from this plan.

**Verify**: `rg -n "minimal|normal|elevated" docs/ README.md` → only
historical/changelog mentions remain, no live instructions.

### Step 11: Anti-hardcoding regression test

New `test/unit/no-hardcoded-reasoning-vocabulary.test.ts`: reads every file in
`src/` and asserts NONE of these identifiers/strings appear:
`ReasoningLevel`, `DISCRETE_RANK`, `inferCapability`, `POSITIONAL_VARIANTS`,
`NAMED_VARIANTS`, `reasoningEscalation`, `maxLevelBumpsPerTier`,
`REASONING_LEVELS`, and the literal `"minimal"`/`"elevated"` in
`src/reasoning/` + `src/router/`. This turns "nothing is hardcoded" into an
enforced invariant.

**Verify**: `pnpm test -- no-hardcoded` → green.

### Step 12: SDD verify + archive

Run the SDD verify phase re-executing the Done criteria below; archive delta
specs; update `plans/README.md` row 041 → DONE (and 015 → REJECTED/superseded
note if not already updated).

## Test plan

Rewrite (vocabulary swap, keep structural patterns):
`reasoning-capability.test.ts` → control-parsing tests; `reasoning-translate.test.ts`
→ `resolveControlPatch`/`patchAtIndex` across all three channels;
`reasoning-policy.test.ts` → profile resolution per mode + unknown-mode
fail-soft + unknown-override ignored; `adaptive-selector.test.ts` → profile
targets, decision order, match modes.

New coverage (model after `test/unit/ladder.test.ts` T-1…T-6 style):
- maxBumps 0/1/2 × rungs remaining; start-at-top; cap-at-top distinction.
- Exhaustion matrix (D-3): bump-cap-exhausted → escalate; maxBumps:0 → retry;
  no control → retry; retryable error → retry (never consumes bumps).
- profileMap coverage errors (missing profile, extra profile, value not in
  levels); budget levels non-ascending; maxBumps out of range.
- Model-swap cases: control removed (no patch, no bump); control added;
  renamed levels (config-only fix, no code change — assert via fixtures).
- Integration: profile→patch seam per channel; override→policy fallback;
  bump sequence `levels[i] → levels[i+1]` observed at the prompt seam.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0 (or no NEW failures vs recorded baseline)
- [ ] `pnpm test` exits 0 incl. the anti-hardcoding test and rewritten suites
- [ ] `pnpm run test:res` exits 0 (parity unaffected)
- [ ] `pnpm run build && pnpm run build:tiers` exit 0
- [ ] `rg -n "ReasoningLevel|DISCRETE_RANK|inferCapability|POSITIONAL_VARIANTS|NAMED_VARIANTS|reasoningEscalation|maxLevelBumpsPerTier|REASONING_LEVELS" src/` → no matches
- [ ] `rg -n "reasoningEscalation" tiers.json config/` → no matches
- [ ] `jq '.presets["multi-provider"] | to_entries | all(.value.reasoningControl == null or .value.reasoningControl.maxBumps == 0)' tiers.json` → `true`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] SDD verify report PASS; `plans/README.md` row 041 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt mismatches live code (drift since `0ea3822`).
- Step 1 finds ReScript parity ports of the bump/reasoning logic.
- The prompt-seam spy (Step 9) observes an unpatched baseline at prompt time.
- Removing `enforcement.escalate.reasoningEscalation` from `base.json`
  requires MERGE_PLAN changes beyond allow-list key removal.
- Any DECIDED item appears to conflict with discovered code behavior.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Bundled profile IDs (`light/standard/deep`) are CONFIG DATA. Never reference
  them from code, tests of runtime logic, or docs as canonical — tests must
  use their own fixture IDs.
- Future channel additions (e.g. a boolean-style provider switch) require: new
  channel literal + control variant + validator arm + `patchAtIndex` arm +
  docs — one checklist, no inference.
- Plan 015's "adaptive engine" is superseded: the engine shipped; only its
  vocabulary changed. Future adaptivity work (LLM-driven reassessment,
  down-tier-on-PASS) builds on profile IDs.
- Reviewer focus for the PR chain: exhaustion semantics (D-3) and the
  config-store atomic-reload behavior on invalid v2 documents.
