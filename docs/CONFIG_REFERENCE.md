# Configuration Reference

Top-level `tiers.json` fields. All blocks are optional and additive; omitting a block (or setting the equivalent no-op value) preserves the pre-Plan-010 behaviour byte-for-byte.

**Cross-references:** [ENFORCEMENT.md](./ENFORCEMENT.md) · [REASONING.md](./REASONING.md) · [VERIFICATION.md](./VERIFICATION.md) · [ESCALATION.md](./ESCALATION.md) · [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md)

---

## Top-level fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"off" \| "advisory" \| "enforced"` | `"off"` | Global enforcement mode. `off` = no-op. `advisory` = log violations, never block. `enforced` = block/escalate on violations. |
| `envGate` | `string` | `"MODEL_ROUTER_ENFORCE"` | Name of the env var that overrides mode at runtime. See env-gate truth table below. |
| `perTier` | `Record<string, "off" \| "advisory" \| "enforced">` | `{}` | Per-tier mode overrides. Keyed by tier name. Overrides base `mode` when the env gate is unset/empty. |
| `guard` | object | see below | Request-level hard guards (caps, script controls, budget). |
| `verify` | object | see below | Verification / grading policy. |
| `escalate` | object | see below | Escalation ladder and cost ceiling. |
| `proportional` | object | see below | Trivial-task bypass logic. |

---

## `guard`

| Field | Type | Default | Notes |
|---|---|---|---|
| `readDraftCap` | `number` | `3` | Max read-only tool calls before an edit must begin. |
| `sameOpRetryCap` | `number` | `1` | Max retries of the identical operation before escalation. |
| `blockSelfScript` | `boolean` | `true` | Block agent-written scripts that target the router's own config files. |
| `deliverableFirst` | `boolean` | `true` | Require a concrete deliverable token before prose commentary. |
| `budget` | `number` | `25` | Soft cost-unit ceiling per attempt. Must be ≥ 1. |
| `blockScriptWrites` | `boolean` | `false` | Block all script-write operations regardless of target. Must be a boolean. |

---

## `verify`

| Field | Type | Default | Notes |
|---|---|---|---|
| `require` | `"never" \| "whenDoDPresent" \| "always"` | `"whenDoDPresent"` | When to run a verification pass after production. |
| `requireExplicitDoD` | `boolean` | `false` | When `true`, a task with no explicit Definition of Done is treated as failing verification. |
| `preferDeterministic` | `boolean` | _(auto)_ | Defaults to `true` whenever the DoD contains runnable checks; omit to let the router decide. |
| `graderPolicy` | `"atLeastProducerTier"` | `"atLeastProducerTier"` | **Only valid value.** Grader tier = `max(producerTier, minGraderTier)` along the ladder; never below the producer. A deterministic check uses no grader. |
| `graderTemperature` | `number` | `0` | Applied via the `chat.params` hook to grader sessions only. |
| `minGraderTier` | `string` | _(none)_ | Optional floor for the grader tier, independent of producer. |
| `allowlist` | `string[]` | `["npm","pnpm","tsc","vitest","jest","eslint","prettier"]` | EXTRA command basenames the deterministic `run` checks may execute, appended to the base list. Entries must be bare command basenames (no paths, backslashes, or whitespace). |

> **Note:** `graderPolicy: "atLeastProducerTier"` ensures a cheap producer is never graded by an even cheaper model. A deterministic DoD check (shell command, test run, lint) skips the grader entirely.

> **Migration (breaking, plan 048):** `npx`, `yarn`, `bun`, `node`, and `tsx` were removed from the default `run`-check allowlist — they are arbitrary-code runners by design. Existing configs using them in `check: run command="…"` now fail closed until you opt back in explicitly:
>
> ```json
> "verify": { "allowlist": ["npx", "node"] }
> ```
>
> Interpreter flags that load code (`-r/--require/--import`, plus `-e/--eval`) are rejected even for allowlisted interpreters.

---

## `escalate`

| Field | Type | Default | Notes |
|---|---|---|---|
| `floorTier` | `string \| null` | `null` | Pin the minimum starting tier; skips cheaper rungs. Must be string or `null`. |
| `ladder` | `string[]` | `["fast","light","medium","focused","heavy"]` | Ordered list of tier names to escalate through. Must be an array of strings. |
| `maxAttemptsPerTier` | `number` | `1` | Retries allowed within a tier after its configured reasoning bumps are exhausted. Worst-case produce attempts per tier = 1 + `reasoningControl.maxBumps` + this value (every attempt also counts toward `maxTotalAttempts`, the hard global bound). Must be integer ≥ 0. |
| `maxTotalAttempts` | `number` | `4` | Hard ceiling across all tiers and retries. Must be integer ≥ 1. |
| `costCeiling.base` | `string` | `"firstAttemptCostUnits"` | Reference point for cost ceiling. `"firstAttemptCostUnits"` = cost of the first producing attempt. |
| `costCeiling.multiple` | `number` | `4` | Ceiling = `base × multiple`. Must be > 0. Escalation halts when cumulative cost would exceed this. |

> **`floorTier`** is useful when a task is known non-trivial: set `floorTier: "medium"` to skip `fast` entirely.  
> **`costCeiling`** is evaluated before each escalation step; the attempt is not started if it would breach the ceiling.

---

## `proportional`

| Field | Type | Default | Notes |
|---|---|---|---|
| `trivialBypass` | `boolean` | `true` | When `true`, tasks classified as trivial skip enforcement and route to `fast` directly. |
| `trivialClassifier` | `string` | `"dispatchIntent"` | Classifier strategy used to detect trivial tasks. |

> **Note:** `trivialBypass` defaults `true` but trivial classification is tier-gated to `fast` and biased toward non-trivial. Real work is never silently downgraded.

---

## `reasoningPolicy`

Optional top-level block in `tiers.json`. Fully additive — omitting the block resolves to `mode: "static"`, which is a hard no-op (the policy resolver returns `null` regardless of any session override, and the agent def is left exactly as `registerTierAgents` produced it). The bundled default since Plan 010 PR 3 is `mode: "manual"`, which lets the `/model-router-reasoning` command apply session-scoped overrides.

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `"static" \| "manual" \| "adaptive"` | `"static"` when the block is absent, `"manual"` in the bundled `base.json` | See [Policy modes](#policy-modes) below. |
| `defaultProfile` | `string` | _(none)_ | Optional registered-profile fallback applied under `manual` mode when the session has no override. |
| `surfaceLimits` | `boolean` | `false` | When `true`, `/model-router-reasoning` output and the runtime log layer flag tiers that cannot satisfy the requested profile. See [REASONING.md → surfaceLimits](./REASONING.md#surfacelimits). |

### Policy modes

| Mode | Behaviour |
|---|---|
| `static` | The policy resolver ALWAYS returns `null`. Even when a session override exists, the agent def is left exactly as `registerTierAgents` produced it. Use this to restore pre-Plan-010 byte-identical behaviour. |
| `manual` | Translates `sessionOverride ?? defaultProfile` through the selected tier's `reasoningControl`. When the tier has no control, or both values are undefined, returns `null`. |
| `adaptive` | Selects a registered profile from deterministic task signals, then resolves it through the selected tier's `reasoningControl`. |

### Per-tier `reasoningControl`

Optional field on each tier (`presets[<name>].<tier>.reasoningControl`). A tier without it remains valid and retains its static baseline; it cannot receive reasoning bumps or patches.

| Field | Type | Meaning |
|---|---|---|
| `channel` | `"variant" \| "reasoning.effort" \| "thinking.budgetTokens"` | Provider-native output channel. |
| `levels` | `string[] \| number[]` | Strictly ordered native values for the tier's channel. |
| `profileMap` | `Record<string, string \| number>` | Exact mapping from every registered `reasoningPolicy.profiles` ID to one value in `levels`. |
| `maxBumps` | `number` | Maximum same-tier bumps; `0` disables bumping. Must not exceed `levels.length - 1`. |

### Minimal example

```jsonc
{
  "reasoningPolicy": {
    "mode": "manual",
    "profiles": ["p1", "p2", "p3"],
    "defaultProfile": "p2",
    "surfaceLimits": false
  },
  "presets": {
    "multi-provider": {
      "fast": {
        "model": "opencode-go/qwen-3.8-flash",
        "reasoning": { "effort": "medium" },
        "reasoningControl": {
          "channel": "reasoning.effort",
          "levels": ["low", "medium", "xhigh"],
          "profileMap": { "p1": "low", "p2": "medium", "p3": "xhigh" },
          "maxBumps": 0
        }
      },
      "medium": {
        "model": "minimax-coding-plan/MiniMax-M3",
        "variant": "thinking",
        "reasoningControl": {
          "channel": "variant",
          "levels": ["default", "thinking"],
          "profileMap": { "p1": "default", "p2": "thinking", "p3": "thinking" },
          "maxBumps": 1
        }
      },
      "heavy": {
        "model": "openai/gpt-5.4",
        "reasoning": { "effort": "high", "summary": "detailed" },
        "reasoningControl": {
          "channel": "reasoning.effort",
          "levels": ["low", "medium", "high"],
          "profileMap": { "p1": "low", "p2": "medium", "p3": "high" },
          "maxBumps": 2
        }
      }
    }
  }
}
```

All fields are optional. A config with no `reasoningPolicy` block and no per-tier `reasoningControl` declarations is byte-identical to its static baseline behaviour. Profile IDs are user-owned strings; the example IDs above are illustrative only. See [REASONING.md](./REASONING.md) for the native-level control model and translation rules.

---

## `fanout`

Optional top-level block enabling the child-initiated fan-out tool (`fanout`). When absent, the tool is hidden from the runtime tool list.

### Policy

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | `boolean` | `false` | Set `true` to activate the fanout tool. |
| `maxConcurrentGlobal` | `number` | `10` | Max parallel workers across all tiers per orchestrator session. |
| `maxConcurrentPerTier` | `Record<string,number>` | `{fast:5,light:5,medium:5}` | Per-tier worker cap. |
| `batchTimeoutMs` | `number` | `30000` | Max time for the entire batch; completed workers are kept. |
| `workerTimeoutMs` | `number` | `15000` | Max time per individual worker. |
| `breaker.failureThreshold` | `number` | `5` | Consecutive qualifying failures (`timed_out` or failed abort) before opening the circuit. |
| `breaker.cooldownMs` | `number` | `60000` | Time before attempting a probe call after opening. |

### Strict `maxConcurrentPerTier` key validation

The `maxConcurrentPerTier` keys are validated against the **active preset's tier set** at config load time. Only keys in `activePreset ∩ {fast, light, medium}` are allowed; unknown keys (e.g. `focused` or `heavy`) produce a typed config-load error. This prevents operator typos from silently falling through to a default.

### Minimal example

```jsonc
{
  "fanout": {
    "enabled": true,
    "maxConcurrentGlobal": 10,
    "maxConcurrentPerTier": { "fast": 5, "light": 5, "medium": 5 },
    "batchTimeoutMs": 30000,
    "workerTimeoutMs": 15000,
    "breaker": { "failureThreshold": 5, "cooldownMs": 60000 }
  }
}
```

All fields are optional. An empty `{}` or omitted block is a no-op (tool hidden).

---

## Env-gate truth table

Env var name: value of `enforcement.envGate` (default `MODEL_ROUTER_ENFORCE`).  
Evaluated by `resolveEnforcementMode` on every dispatch.

| Env var value | Resolved mode | Notes |
|---|---|---|
| `"1"` | `"enforced"` | Hard override. Ignores `mode` **and** `perTier`. |
| `"0"` | `"off"` | Hard override. Ignores `mode`. |
| unset or `""` | config `mode`, with `perTier[tier]` taking precedence when present | Normal path. |
| any other value | config `mode` (fallback) | Emits one-time warning: `<gate>="<value>" is not "1" or "0"; ignoring env gate and using config.` |

---

## Validation rules

`validateConfig` throws on `tiers.json` load if any of these are violated:

| Rule |
|---|
| `mode` must be one of `off \| advisory \| enforced`. |
| `verify.graderPolicy` (when `verify` is an object) must be exactly `"atLeastProducerTier"`. |
| `escalate.costCeiling.multiple` must be a number > 0. |
| `escalate.ladder` must be an array of strings. |
| `escalate.maxAttemptsPerTier` must be an integer ≥ 0. |
| `escalate.maxTotalAttempts` must be an integer ≥ 1. |
| Every `reasoningControl.maxBumps` must be an integer from `0` to `levels.length - 1`. |
| `escalate.floorTier` must be string or `null`. |
| `perTier` values must each be `off \| advisory \| enforced`. |
| `guard.budget` must be a number ≥ 1. |
| `guard.blockScriptWrites` must be a boolean. |
| `fanout.maxConcurrentPerTier` keys must all be in `activePreset ∩ {fast, light, medium}`; unknown keys produce a typed config-load error. |

---

## How to enable

Three independent mechanisms; env gate always wins:

1. **Config** — set `enforcement.mode` in `tiers.json` (persisted, version-controlled).
2. **Env var** — `MODEL_ROUTER_ENFORCE=1` (forces `enforced`) or `=0` (forces `off`). Overrides config and `/router` state.
3. **Runtime command** — `/router enforce <off|advisory|enforced>` (written to the router state file; env gate still overrides).

---

## Minimal example

```jsonc
// tiers.json (enforcement block only; all other tier config omitted)
{
  "enforcement": {
    "mode": "advisory",
    "envGate": "MODEL_ROUTER_ENFORCE",
    "perTier": {
      "fast": "off"
    },
    "guard": {
      "readDraftCap": 5,
      "budget": 50,
      "blockScriptWrites": false
    },
    "verify": {
      "require": "whenDoDPresent",
      "graderPolicy": "atLeastProducerTier",
      "graderTemperature": 0
    },
    "escalate": {
      "floorTier": null,
      "ladder": ["fast", "light", "medium", "focused", "heavy"],
      "maxAttemptsPerTier": 1,
      "maxTotalAttempts": 4,
      "costCeiling": { "base": "firstAttemptCostUnits", "multiple": 4 }
    },
    "proportional": {
      "trivialBypass": true,
      "trivialClassifier": "dispatchIntent"
    }
  }
}
```

All fields are optional. An empty `{}` or omitted block is a no-op.
# Plan 041 migration

Plan 041 removes the legacy `TierConfig.capability` field and
`enforcement.escalate.reasoningEscalation`. Both keys now fail validation with a
migration error. Define `reasoningControl` on each controllable tier instead:
its ordered native `levels`, exact registry-wide `profileMap`, channel, and
required `maxBumps` (`0` disables bumping). Tiers without a control remain
valid and use their static baseline.
