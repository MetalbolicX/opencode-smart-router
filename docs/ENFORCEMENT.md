# Layer 1: Hard-block execution guard

Converts advisory read-only caps into real hard-blocks for subagent sessions. Opt-in; orchestrator sessions and `mode:"off"` are byte-identical to pre-enforcement routing (GA-1).

## Mechanism

A `tool.execute.before` hook. In `enforced` mode, when the guard denies a call it **throws**; opencode aborts the tool call and the thrown message reaches the model as that tool's error text (empirically confirmed).

Applies **only** to subagent sessions — sessions whose agent matches a tier name, or plugin-created delegate producer sessions. Orchestrator sessions and `mode:"off"` are early-return no-ops.

## Modes (`enforcement.mode`)

| mode | effect |
|------|--------|
| `off` | Hook is a no-op. Zero added tokens. Byte-identical to pre-enforcement (GA-1). |
| `advisory` | Guard is evaluated; a `[⚠ GUARD:<name>] <forcing message>` banner is appended to the tool result via the after-hook. Never throws. |
| `enforced` | Deny ⇒ throw `<observation>\n<forcing message>`. |

## Guard evaluation (`evaluateGuards`)

Pure / non-mutating. First match wins.

| # | condition | verdict | guard name |
|---|-----------|---------|------------|
| 1 | call is a finish / return / task_complete signal | ALLOW | — |
| 2 | call matches self-script pattern | DENY | `anti_self_script` |
| 3 | `toolCallCount >= budget` | DENY | `iteration_cap` |
| 4 | read whose fingerprint was seen `>= sameOpRetryCap` times | DENY | `redundant_read` |
| 5 | read while `consecutiveNonProducing >= readDraftCap` | DENY | `read_budget` |
| 6 | `deliverableFirst` enabled AND deliverable signal exists AND not yet executed AND call is read/other | DENY | `deliverable_first` |
| 7 | — | ALLOW | — |

## Self-script detection (`isSelfScript`)

Writing source files (`.ts`, `.js`, `.py`, `.mjs`, etc.) is the normal coding deliverable and is **not** blocked by default. Extension-based write blocking is opt-in via `blockScriptWrites` (default `false`).

Note the two settings are independent: `blockSelfScript` (default `true`) keeps the self-script guard *active*, but with `blockScriptWrites` left at `false` that guard's default scope is **bash ad-hoc execution only** — it does not touch `write`/`edit` of source files. Setting `blockScriptWrites: true` additionally blocks writes to script extensions; setting `blockSelfScript: false` disables the guard entirely.

The always-on self-script signal catches **bash ad-hoc execution only**:

```
heredocs  ·  node|python|deno|bun -e/-c  ·  cat > file  ·  bash -c  ·  redirect-to-script
```

**Intent exemptions**: if the DoD's declared deliverable is a script (`deliverableIsScript`), or the write target equals the declared deliverable path, the call is allowed.

## Policy defaults (`buildGuardPolicy`)

| field | default |
|-------|---------|
| `budget` | `25` (`DEFAULT_GUARD_BUDGET`) |
| `readDraftCap` | `3` |
| `sameOpRetryCap` | `1` |
| `blockSelfScript` | `true` |
| `deliverableFirst` | `true` |
| `blockScriptWrites` | `false` |
| `deliverableSignal` | `null` (deliverable-first effectively disabled until wired) |

## Forcing message format

```
[budget N/B | deliverable=n/a|ran|NOT RUN | reads_since_produce=K] NEXT: <instruction>
```

## Proportional enforcement (GA-6)

`trivial` is classified **at dispatch**, not from realized tool counts. `classifyTrivial` is tier-gated to the `fast` tier and requires a fast `taskPattern` keyword match with no medium/heavy signal — conservative, biased toward non-trivial so real work is never mis-classified.

A trivial `fast` dispatch downgrades `enforced` → `advisory` when `enforcement.proportional.trivialBypass !== false` (default `true`). `medium` / `heavy` work is always fully enforced.

## Security

Thrown messages and banners pass through `scrubText` (redacts API keys / bearer tokens / `key=value` secrets). No secrets leak into observations.

## Enabling enforcement

```jsonc
// tiers.json
"enforcement": { "mode": "enforced" }
```

```sh
# environment variable
MODEL_ROUTER_ENFORCE=1
```

```
# slash command
/router enforce <off|advisory|enforced>
```

See [CONFIG_REFERENCE.md](./CONFIG_REFERENCE.md) for the full schema and [ENFORCEMENT_PRESETS.md](./ENFORCEMENT_PRESETS.md) for per-mode example blocks.
