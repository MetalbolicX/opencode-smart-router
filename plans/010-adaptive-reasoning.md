# Plan 010: Adaptive, provider-agnostic reasoning control

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2a4643d..HEAD -- src/router/config.types.ts src/router/agents.ts src/router/commands.ts src/plugin/context.ts src/plugin/hooks.ts src/index.ts config/tiers/ scripts/build-tiers-config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L (multi-day; chained PRs strongly recommended)
- **Risk**: MED — touches the agent-registration chokepoint; backward-compat must hold
- **Depends on**: none
- **Category**: direction / architecture
- **Planned at**: commit `2a4643d`, 2026-07-01
- **Suggested PR split**: PR 1 = types + capability/translate (pure, tested) → PR 2 = policy + store + command + wiring → PR 3 = tier config declarations + docs

## Why this matters

The router already supports per-tier `variant`, `thinking`, and `reasoning`
fields, but they are applied **once** at agent-registration time from static
config (`src/router/agents.ts:8-29`, `77-86`). There is no way to change
reasoning level per session or per task.

Meanwhile `opencode-adaptive-thinking` proves the value of runtime reasoning
adaptation — but it is single-model and assumes every model exposes a
`variants` ladder. The router serves mixed presets where models have wildly
different reasoning shapes: `mimo-v2.5` has `low/medium/high` (3-level
discrete), `gpt-5.4` has `low/medium/high` via `reasoning.effort`, `MiniMax-M3`
has only `default`/`thinking` (binary), and some models have no reasoning
control at all.

This plan introduces a **provider-agnostic reasoning abstraction** with a
**capability model** (none/binary/discrete/budgeted), a **single translation
layer**, and an optional **session-scoped override** — while keeping current
behavior as the default so nothing breaks.

## Core design decisions (locked)

1. **Normalized internal vocabulary**: `minimal | normal | elevated | max` —
   provider-agnostic, 4 rungs. These are internal only; each tier translates
   them into its own provider options.
2. **Per-tier capability declaration** (config-driven, 4 shapes):
   ```ts
   type ReasoningCapability =
     | { kind: "none" }
     | { kind: "binary"; baseline?: string; elevated: string }
     | { kind: "discrete"; levels: string[] }        // e.g. ["low","medium","high"]
     | { kind: "budgeted"; recommended: Record<string, number> }; // level → tokens
   ```
3. **Capability inference** for backward compat: if a tier declares no
   capability, infer from existing fields — `reasoning.effort` present →
   `discrete`; `thinking.budgetTokens` present → `budgeted`; `variant` present
   → `discrete` with levels inferred from the variant value (positional variants
   like `"medium"` or `"high"` suggest a ladder; named modes like `"thinking"`
   or `"max"` suggest `binary`). Existing configs keep working unchanged.
4. **Policy modes**: `static` (default = today's behavior) | `manual`
   (`/reasoning` command) | `adaptive` (future orchestrator-guided; stubbed
   here, full logic out of scope).
5. **Unsupported-level handling**: **silent no-op by default**, with an opt-in
   `reasoningPolicy.surfaceLimits: true` flag that emits a debug log + TUI
   annotation when a requested level can't be satisfied by the tier's
   capability. A model with `none` capability is never mutated.

## Current state (executor must confirm these match before starting)

### Reasoning fields in the config schema

**`src/router/config.types.ts:7-27`** — existing reasoning fields:
```ts
export interface ThinkingConfig { budgetTokens?: number; }            // Anthropic
export interface ReasoningConfig {                                    // OpenAI
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}
export interface TierConfig {
  model: string;
  variant?: string;           // free-form string, e.g. "thinking", "max"
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
}
```

**`src/router/config.types.ts:90-94`** — `RouterState` only carries
preset/mode/enforcement (NOT reasoning overrides):
```ts
export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
}
```

**`src/router/config.types.ts:72-85`** — `RouterConfig` top-level shape (add
`reasoningPolicy` here):
```ts
export interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
  tierPrompts?: Record<string, string>;
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  experimental?: { verifiedDelegateTool?: boolean };
}
```

### The single chokepoint where reasoning becomes SDK options

**`src/router/agents.ts:8-29`** — `buildAgentOptions()`:
```ts
export const buildAgentOptions = (tier: TierConfig): Record<string, unknown> => {
  const opts: Record<string, unknown> = {};
  // Anthropic thinking config
  if (tier.thinking?.budgetTokens) opts.budget_tokens = tier.thinking.budgetTokens;
  // OpenAI reasoning config
  if (tier.reasoning?.effort) opts.reasoning_effort = tier.reasoning.effort;
  if (tier.reasoning?.summary) opts.reasoning_summary = tier.reasoning.summary;
  return Object.keys(opts).length > 0 ? opts : {};
};
```

**`src/router/agents.ts:68-88`** — `variant` and `options` applied to `agentDef`:
```ts
const agentDef: Record<string, unknown> = {
  model: tier.model,
  mode: "subagent",
  description: tier.description,
  maxSteps: tier.steps,
  prompt: finalPrompt,
  color: tier.color,
};
if (tier.variant) { agentDef.variant = tier.variant; }
const opts = buildAgentOptions(tier);
if (Object.keys(opts).length > 0) { agentDef.options = opts; }
opencodeConfig.agent[name] = agentDef;
```

### Command + store patterns to mirror

**`src/router/commands.ts:192-195`** — `/budget` command registration:
```ts
opencodeConfig.command["budget"] = {
  template: "$ARGUMENTS",
  description: "Show or switch routing mode (e.g., /budget, /budget budget, /budget quality)",
};
```

**`src/router/commands.ts:299-305`** — `/budget` handler in `handleCommandBefore`:
```ts
if (input.command === "budget") {
  const cfg = await ctx.getFreshConfig();
  output.parts.push({
    type: "text" as const,
    text: await buildBudgetOutput(cfg, input.arguments ?? ""),
  });
}
```

**`src/guard/store.ts:11-39`** — `createGuardStore()` closure-factory pattern
(`Map<string, T>` keyed by sessionID). Mirror exactly for a reasoning override
store. Returns `{ ensure, get, setPendingNote, takePendingNote, clear }`.

**`src/plugin/context.ts:71-126`** — `PluginContext` interface. Stores are
declared as `ReturnType<typeof create...Store>` fields (`sessionStore`,
`guardStore`, `changedFileStore`). Add `reasoningStore` the same way. There is
also a `state: PluginState` mutable bag (currently only the bypass flag).

### Test pattern to mirror

**`test/unit/router-agents.test.ts:1-25`** — vitest `describe/it`,
`beforeEach/afterEach` tmpdir isolation, imports from `../../src/router/...`,
type-only imports for `TierConfig`, `Preset`, `RouterConfig`. Mirror this for
new reasoning test files.

### Tier reality today

Source of truth: `scripts/build-tiers-config.ts` assembles `tiers.json` from
`config/tiers/{base,presets,prompts,task-patterns}.json`.

Current reasoning fields across `config/tiers/presets.json` (`multi-provider`):

| Tier | Model | `variant` | `thinking` | `reasoning` | Inferred capability |
|------|-------|-----------|------------|-------------|---------------------|
| `fast` | `opencode-go/mimo-v2.5` | `"medium"` | — | — | `discrete` (levels: `low`, `medium`, `high`) |
| `medium` | `minimax/MiniMax-M3` | `"thinking"` | — | — | `binary` (elevated: `thinking`) |
| `heavy` | `openai/gpt-5.4` | — | — | `effort:"high"` | `discrete` (levels: `low`, `medium`, `high`) |

Other presets add variant-capable tiers:
- `openai.medium`: `gpt-5.5-fast` with `variant: "high"` (likely `discrete`: `low`, `medium`, `high`, `xhigh`)
- `openai.heavy`: `gpt-5.5-fast` with `variant: "xhigh"`
- `anthropic.heavy`: `claude-opus-4-8` with `variant: "max"` (`binary`)
- `github-copilot.heavy`: `claude-opus-4-6` with `variant: "thinking"` (`binary`)

Only one tier (`heavy` in `multi-provider`) carries an explicit `reasoning` block.
No tier carries `thinking`. `variant` is set on most non-fast tiers.

### Repo conventions

- TypeScript, ESM (`"type": "module"`), Node ≥ 20, pnpm
- Biome for lint/format
- Vitest for tests
- Conventional commits: `feat(reasoning): ...`, `feat(router): ...`

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0, no errors |
| Tests | `pnpm test` (or `pnpm test -- <filter>`) | all pass |
| Lint | `pnpm run lint` | exit 0 |
| Build (regenerates `tiers.json`) | `pnpm run build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/reasoning/capability.ts` (create) — capability union + `inferCapability`
- `src/reasoning/translate.ts` (create) — `translateLevel`
- `src/reasoning/policy.ts` (create) — `resolveReasoningOverride`
- `src/reasoning/store.ts` (create) — per-session override store (mirror `createGuardStore`)
- `test/unit/reasoning-capability.test.ts` (create)
- `test/unit/reasoning-translate.test.ts` (create)
- `test/unit/reasoning-policy.test.ts` (create)
- `src/router/config.types.ts` (edit) — add `ReasoningCapability`, `ReasoningPolicyConfig`, extend `TierConfig` + `RouterConfig`
- `src/router/agents.ts` (edit) — consume `resolveReasoningOverride`
- `src/router/commands.ts` (edit) — add `/reasoning` command + handler
- `src/plugin/context.ts` (edit) — add `reasoningStore` to `PluginContext`
- `src/plugin/hooks.ts` (edit) — wire `/reasoning` handler
- `src/index.ts` (edit) — construct `reasoningStore`
- `config/tiers/presets.json` (edit) — add explicit `capability` blocks
- `config/tiers/base.json` (edit) — add `reasoningPolicy`
- `tiers.json` (regenerate via build)
- `docs/REASONING.md` (create)
- `README.md` (edit) — config reference row
- `docs/CONFIG_REFERENCE.md` (edit) — reasoning block schema

**Out of scope** (do NOT touch, even though they look related):
- Adaptive orchestrator prompt injection (the `system.transform` reassessment
  from `opencode-adaptive-thinking`). That is a follow-up plan once the
  override + translation layer is proven.
- Cross-session persistent reasoning state (state file on disk).
- Any change to the `opencode-adaptive-thinking` plugin source.
- Changing the default `reasoningPolicy.mode` away from `static`.
- `src/router/protocol.ts` — protocol prompt stays as-is this plan.

## Git workflow

- Branch: `advisor/010-adaptive-reasoning`
- Conventional commits, one per logical unit. Example: `feat(reasoning): add provider-agnostic capability model`
- Chained PRs recommended (see Status). Use the `chained-pr` skill if available.
- Do NOT push or open a PR unless explicitly instructed.

## Steps

### Phase A — Pure translation layer (PR 1, no behavior change)

#### Step A1: Create the capability module

Create `src/reasoning/capability.ts`:

```ts
import type { TierConfig } from "../router/config.types.js";

export type ReasoningLevel = "minimal" | "normal" | "elevated" | "max";

export type ReasoningCapability =
  | { kind: "none" }
  | { kind: "binary"; baseline?: string; elevated: string }
  | { kind: "discrete"; levels: string[] }
  | { kind: "budgeted"; recommended: Record<string, number> };

/**
 * Backward-compat inference: derive a capability from existing tier fields
 * when no explicit `capability` is declared. Keeps pre-010 configs working.
 */
export const inferCapability = (tier: TierConfig): ReasoningCapability => {
  if (tier.reasoning?.effort) {
    return { kind: "discrete", levels: ["low", "medium", "high"] };
  }
  if (tier.thinking?.budgetTokens) {
    return { kind: "budgeted", recommended: { minimal: 1024, normal: 4096, elevated: 8192, max: 16000 } };
  }
  if (tier.variant) {
    return { kind: "binary", elevated: tier.variant };
  }
  return { kind: "none" };
};
```

**Verify**: `pnpm run typecheck` → exit 0.

#### Step A2: Create the translation module

Create `src/reasoning/translate.ts`:

```ts
import type { ReasoningCapability, ReasoningLevel } from "./capability.js";

export type ResolvedReasoning = {
  variant?: string;
  options?: Record<string, unknown>;
} | null; // null = no-op (capability can't satisfy the level)

const DISCRETE_RANK: Record<ReasoningLevel, number> = {
  minimal: 0,
  normal: 1,
  elevated: 2,
  max: 3,
};

/**
 * Translate a normalized reasoning level into provider-specific agent options.
 * Returns null when the capability cannot satisfy the request (silent no-op).
 */
export const translateLevel = (
  cap: ReasoningCapability,
  level: ReasoningLevel,
): ResolvedReasoning => {
  switch (cap.kind) {
    case "none":
      return null;

    case "binary": {
      // minimal/normal → baseline (or no variant); elevated/max → elevated
      if (level === "elevated" || level === "max") {
        return { variant: cap.elevated };
      }
      return cap.baseline ? { variant: cap.baseline } : null;
    }

    case "discrete": {
      // Map normalized rank onto the nearest available discrete level.
      const target = DISCRETE_RANK[level];
      const idx = Math.round((target / 3) * (cap.levels.length - 1));
      const clamped = cap.levels[Math.min(idx, cap.levels.length - 1)]!;
      return { options: { reasoning_effort: clamped } };
    }

    case "budgeted": {
      const tokens = cap.recommended[level] ?? cap.recommended["normal"];
      return tokens ? { options: { budget_tokens: tokens } } : null;
    }
  }
};
```

**Verify**: `pnpm run typecheck` → exit 0.

#### Step A3: Write capability + translate unit tests

Create `test/unit/reasoning-capability.test.ts` — cover `inferCapability` for
all 4 shapes: none (bare tier), binary (from `variant`), discrete (from
`reasoning.effort`), budgeted (from `thinking.budgetTokens`).

Create `test/unit/reasoning-translate.test.ts` — cover each capability × each
normalized level, including:
- `none` → always `null`
- `binary`: `minimal`/`normal` → baseline (or null if no baseline),
  `elevated`/`max` → elevated variant
- `discrete` with 2 levels `[low, high]`: `max` → `high`, `minimal` → `low`,
  nearest-level clamping
- `budgeted`: returns `budget_tokens`, unknown level falls back to `normal`

Mirror `test/unit/router-agents.test.ts` structure (vitest `describe/it`).

**Verify**: `pnpm test -- reasoning` → all pass.

### Phase B — Policy + store + command + wiring (PR 2)

#### Step B1: Extend config types

Edit `src/router/config.types.ts`:
- Add the `ReasoningCapability` and `ReasoningLevel` types (re-export from
  `src/reasoning/capability.ts` or define here and import there — pick one
  canonical home; prefer defining in `capability.ts` and re-exporting).
- Add to `TierConfig`:
  ```ts
  capability?: ReasoningCapability;  // explicit; falls back to inferCapability
  ```
- Add new interface:
  ```ts
  export interface ReasoningPolicyConfig {
    mode?: "static" | "manual" | "adaptive";   // default: "static"
    surfaceLimits?: boolean;                     // default: false (silent no-op)
    defaultLevel?: ReasoningLevel;               // default: "normal"
  }
  ```
- Add to `RouterConfig`:
  ```ts
  reasoningPolicy?: ReasoningPolicyConfig;
  ```

All new fields are optional → backward compatible.

**Verify**: `pnpm run typecheck` → exit 0.

#### Step B2: Create the policy module

Create `src/reasoning/policy.ts`:

```ts
import type { TierConfig } from "../router/config.types.js";
import type { ReasoningPolicyConfig } from "../router/config.types.js";
import { inferCapability, type ReasoningLevel } from "./capability.js";
import { translateLevel, type ResolvedReasoning } from "./translate.js";

/**
 * Resolve the effective reasoning options for a tier, honoring policy mode
 * and any per-session override.
 *
 * - static  → null (current behavior preserved; buildAgentOptions stays as-is)
 * - manual  → translate the session override (if any)
 * - adaptive → stub (falls back to static for now)
 */
export const resolveReasoningOverride = (
  tier: TierConfig,
  policy: ReasoningPolicyConfig | undefined,
  sessionOverride?: ReasoningLevel,
): ResolvedReasoning => {
  const mode = policy?.mode ?? "static";
  if (mode === "static") return null;

  const level = sessionOverride ?? policy?.defaultLevel;
  if (!level) return null;

  const cap = tier.capability ?? inferCapability(tier);
  return translateLevel(cap, level);
};
```

**Verify**: `pnpm run typecheck` → exit 0; `pnpm test` → no regressions.

#### Step B3: Create the per-session override store

Create `src/reasoning/store.ts` — mirror `src/guard/store.ts:11-39` exactly:

```ts
import type { ReasoningLevel } from "./capability.js";

export const createReasoningStore = () => {
  const overrides = new Map<string, ReasoningLevel>();
  return {
    get(sessionID: string): ReasoningLevel | undefined {
      return overrides.get(sessionID);
    },
    set(sessionID: string, level: ReasoningLevel): void {
      overrides.set(sessionID, level);
    },
    clear(sessionID: string): void {
      overrides.delete(sessionID);
    },
  };
};
```

**Verify**: `pnpm run typecheck` → exit 0.

#### Step B4: Consume the override in agent registration

Edit `src/router/agents.ts`:

In `registerTierAgents`, after the existing `buildAgentOptions` + `variant`
application, resolve the override and **merge** it (override wins):

```ts
// After existing variant/options block:
const reasoningOverride = resolveReasoningOverride(tier, cfg.reasoningPolicy, sessionOverride);
if (reasoningOverride?.variant) agentDef.variant = reasoningOverride.variant;
if (reasoningOverride?.options) {
  agentDef.options = { ...(agentDef.options ?? {}), ...reasoningOverride.options };
}
```

`sessionOverride` comes from the reasoning store (passed in by the caller;
`registerTierAgents` may need an extra optional param, or the caller resolves
it before calling — pick whichever matches how `sessionStore` is threaded
today). Keep the existing path fully intact for `static` mode.

**Verify**: `pnpm test -- router-agents` → all existing tests still pass
(default mode = static = unchanged output).

#### Step B5: Add the `/reasoning` command

Edit `src/router/commands.ts` — mirror `/budget`:

- Registration (near line 192):
  ```ts
  opencodeConfig.command["reasoning"] = {
    template: "$ARGUMENTS",
    description: "Set reasoning level: /reasoning minimal|normal|elevated|max|off",
  };
  ```
- Handler in `handleCommandBefore` (near line 299):
  ```ts
  if (input.command === "reasoning") {
    const cfg = await ctx.getFreshConfig();
    output.parts.push({
      type: "text" as const,
      text: buildReasoningOutput(cfg, input.arguments ?? "", ctx),
    });
  }
  ```
- `buildReasoningOutput` validates the arg against `ReasoningLevel` (or `off`
  to clear), sets/clears `ctx.reasoningStore`, and returns a confirmation
  that names the tier's capability and whether the level applies or is a
  no-op (respects `surfaceLimits`).

Edit `src/plugin/hooks.ts` — add the `if (input.command === "reasoning")`
branch (mirror the budget branch).

**Verify**: `pnpm run typecheck` → 0; `pnpm test` → all pass.

#### Step B6: Wire the store into PluginContext

Edit `src/plugin/context.ts` — add to the `PluginContext` interface:
```ts
reasoningStore: ReturnType<typeof createReasoningStore>;
```
Edit `src/index.ts` — construct `reasoningStore: createReasoningStore()`
alongside the other stores in the `PluginContext` factory.

**Verify**: `pnpm run typecheck` → 0; `pnpm test` → all pass.

### Phase C — Tier config declarations + docs (PR 3)

#### Step C1: Add explicit capability blocks

Edit `config/tiers/presets.json` — add `capability` to each `multi-provider`
tier (inference becomes a safety net, not the primary path):

```json
"fast":  { ..., "capability": { "kind": "discrete", "levels": ["low", "medium", "high"] } }
"medium":{ ..., "capability": { "kind": "binary", "elevated": "thinking" } }
"heavy": { ..., "capability": { "kind": "discrete", "levels": ["low", "medium", "high"] } }
```

Edit `config/tiers/base.json` — add:
```json
"reasoningPolicy": { "mode": "manual", "surfaceLimits": false }
```

#### Step C2: Regenerate tiers.json

Run `pnpm run build` and commit the regenerated `tiers.json`.

**Verify**: `pnpm run build` → exit 0; confirm `tiers.json` contains the new
`capability` and `reasoningPolicy` keys.

#### Step C3: Write docs

Create `docs/REASONING.md` — cover: capability model, normalized levels,
translation rules table, `/reasoning` command usage, backward-compat story,
the `surfaceLimits` default.

Add a config-reference row to `README.md` and a reasoning block schema to
`docs/CONFIG_REFERENCE.md`.

**Verify**: `pnpm run build` → 0; `pnpm test` → all pass; `pnpm run lint` → 0.

## Test plan

- `reasoning-capability.test.ts`: `inferCapability` for all 4 shapes from real
  tier configs; inference falls back correctly when `capability` absent.
- `reasoning-translate.test.ts`: each capability × each level; nearest-level
  clamping (e.g. `discrete ["low","high"]` + `elevated` → `high`); `none`
  always `null`; binary boundary (`normal`→baseline/null, `elevated`→elevated).
- `reasoning-policy.test.ts`: `static` mode always returns null (backward
  compat — the most important regression guard); `manual` + override applies;
  `manual` + no override = null; `surfaceLimits` logging toggle.
- Extend `test/unit/router-agents.test.ts`: static config still emits original
  options; override merges correctly; override is no-op on `none`-capability
  tier.
- `/reasoning` command handler: valid level sets store; `off` clears; invalid
  level rejected with helpful message.

## Done criteria (ALL must hold)

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm test` exits 0; new reasoning tests exist and pass
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run build` regenerates `tiers.json` cleanly
- [ ] With no `reasoningPolicy` in config, behavior is **identical** to today
      (static default — existing router-agents tests pass unmodified)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:
- The excerpts in "Current state" don't match live code (drift since this plan
  was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- You find a tier in `presets.json` whose reasoning shape doesn't fit any of
  the 4 capability kinds (escalate — the model may need a 5th shape).
- `resolveReasoningOverride` with `mode: "static"` ever returns non-null
  (backward-compat invariant violated).

## Maintenance notes

- The `adaptive` mode is a stub (no auto-trigger yet). The follow-up plan will
  add `system.transform` guidance like `opencode-adaptive-thinking` uses, plus
  task-class/risk signals to pick a level automatically.
- If a new provider/model is added, add a `capability` block to its tier in
  `presets.json`; inference is only a fallback for configs that predate this
  plan.
- `translateLevel` is the single place vendor mapping lives — any new
  reasoning API (e.g. a future `reasoning_depth`) gets added there, nowhere
  else.
- A reviewer should scrutinize that `static` mode never changes existing agent
  output (the primary regression risk).
