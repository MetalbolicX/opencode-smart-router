# opencode-smart-router

> **Use the cheapest model that can do the job. Automatically.**

An [OpenCode](https://opencode.ai) plugin that routes every coding task to the right-priced AI tier — automatically, on every message, with ~210 tokens of overhead.

The plugin registers five tiers — `@fast`, `@light`, `@medium`, `@focused`, `@heavy` — each backed by a model you choose. The orchestrator (the model running your session) reads a compressed delegation grammar from its system prompt and dispatches the cheapest tier that can reliably handle each task. Composite tasks are split when the phases are separable: explore cheap, execute smart.

<p align="center">
  <a href="https://github.com/MetalbolicX/opencode-smart-router/releases"><img alt="version" src="https://img.shields.io/github/v/release/MetalbolicX/opencode-smart-router?style=flat-square&logo=github" /></a>
  <a href="https://github.com/MetalbolicX/opencode-smart-router/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/MetalbolicX/opencode-smart-router?style=flat-square&logo=github" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.6-339933?style=flat-square&logo=node.js&logoColor=white" />
  <img alt="platform" src="https://img.shields.io/badge/opencode-%3E%3D1.0-1f6feb?style=flat-square" />
</p>

## Table of Contents

- [Why it's different](#why-its-different)
- [The problem](#the-problem)
- [The solution](#the-solution)
- [Cost simulation](#cost-simulation)
- [How it works](#how-it-works)
- [Why not just use another orchestrator?](#why-not-just-use-another-orchestrator)
- [Recommended setup](#recommended-setup)
- [Installation](#installation)
- [Testing](#testing)
- [Updating](#updating)
- [Configuration](#configuration)
  - [Presets](#presets)
  - [Routing modes](#routing-modes)
  - [Task taxonomy (`taskPatterns`)](#task-taxonomy-taskpatterns)
  - [Cost ratios](#cost-ratios)
  - [Read-only call caps](#read-only-call-caps)
  - [Tier prompts (`tierPrompts`)](#tier-prompts-tierprompts)
  - [Reasoning control](#reasoning-control)
  - [Fallback](#fallback)
  - [Environment variables](#environment-variables)
- [Commands](#commands)
  - [CLI (`osr`)](#cli-osr)
  - [Slash commands](#slash-commands)
  - [The `delegate` tool](#the-delegate-tool)
- [Delegation enforcement](#delegation-enforcement)
- [Child-initiated fan-out (`fanout` tool)](#child-initiated-fan-out-fanout-tool)
- [Deep-dive documentation](#deep-dive-documentation)
- [Plan annotation](#plan-annotation)
- [Token overhead](#token-overhead)
- [Requirements](#requirements)
- [License](#license)

## Why it's different

Most AI coding tools give you one model for everything. You pay Opus prices to run `grep`. opencode-smart-router changes that with a stack of interlocking ideas:

**Five tiers instead of one model.**
`@fast` reads files. `@light` patches one. `@medium` implements. `@focused` investigates a single system. `@heavy` designs across systems. Each tier carries a `costRatio` (1x / 2x / 5x / 10x / 20x) injected into the system prompt, so the orchestrator sees the price before deciding.

**Use a mid-tier model as orchestrator.**
The orchestrator runs on *every* message. Put Sonnet there, not Opus. Sonnet reads the routing protocol and delegates just as well as Opus — at roughly 4x lower cost. Reserve Opus for `@heavy` work via `heavy.opus`.

**Inject a compressed, LLM-optimized routing protocol.**
Instead of verbose instructions, the plugin injects ~210 tokens of dense, machine-readable notation the orchestrator understands perfectly. Same routing intelligence as 870 tokens of prose — 75% smaller. Every message, every session.

**Match task to tier using a configurable taxonomy.**
A keyword routing guide (`@fast→search/grep/read`, `@light→simple-edit/config-tweak`, `@medium→impl/refactor/test`, `@focused→deep-debug/single-system-review`, `@heavy→arch/security/migration`) tells the orchestrator exactly which tier fits each task type. Fully editable in `tiers.json`. No ambiguity.

**Split separable composite tasks: explore cheap, execute smart.**
"Find how auth works and refactor it" shouldn't cost `@medium` for the whole thing. The multi-phase guidance prefers a split when phases are separable: `@fast` reads the files (1x cost), `@medium` does the rewrite (5x cost). ~36% savings on composite tasks, which are ~60-70% of real coding sessions.

**Skip delegation overhead for trivial work.**
Single grep? One file read (or a quick follow-up)? The orchestrator can execute directly — zero delegation cost, zero latency.

**Four routing modes for different budgets.**
`/budget normal` (balanced), `/budget budget` (aggressive savings, defaults to `@fast`), `/budget quality` (liberal use of stronger tiers), `/budget deep` (`@heavy`-first for long architecture/debug). Mode persists across restarts.

**Cost ratios in the prompt.**
Every tier carries its `costRatio` injected into the system prompt. The orchestrator sees the price before deciding. It picks the cheapest tier that can reliably handle the task.

**Orchestrator-awareness.**
If the orchestrator is already running on Opus, the rule `self ∈ opus → never → @heavy` fires — it does the heavy work itself rather than delegating to another Opus instance.

**Multi-provider support with automatic fallback.**
Six presets out of the box: `anthropic`, `openai`, `github-copilot`, `google`, `hybrid`, `multi-provider`. Switch with `/preset`. If a provider fails, the fallback chain tries the next one automatically.

**Plan annotation for long tasks.**
`/annotate-plan` reads a markdown plan and tags each step with `[tier:fast]`, `[tier:medium]`, or `[tier:heavy]` — removing all routing ambiguity from multi-step workflows.

**Fully configurable.**
Tiers, models, cost ratios, rules, task patterns, routing modes, fallback chains, enforcement level — all in `tiers.json`. No code changes needed.

## The problem

Vibe coding is expensive because most AI coding tools default to one model for everything. That model is usually the most capable available — and you pay for that capability even when the task is `grep for a function name`.

A typical coding session breaks down roughly like this:

| Task type | % of session | Example |
| --- | --- | --- |
| Exploration / search | ~40% | Find where X is defined, read a file, check git log |
| Implementation | ~45% | Write a function, fix a bug, add a test |
| Architecture / deep debug | ~15% | Design a new module, debug after 2+ failures |

If you're running Opus (20x cost) for all of it, you're overpaying by **3-10x** on most tasks.

## The solution

opencode-smart-router injects a **delegation protocol** into the system prompt that teaches the orchestrator to:

1. **Match task to tier** using a configurable task taxonomy
2. **Split composite tasks** — explore first with `@fast`, then implement with `@medium`
3. **Skip delegation overhead** for trivial tasks (1-2 tool calls)
4. **Never over-qualify** — use the cheapest tier that can reliably handle the task
5. **Fallback** across providers when one fails

All of this adds ~210 tokens of system prompt overhead per message.

## Cost simulation

**Scenario: 50-message coding session with 30 delegated tasks**

Task distribution: 18 exploration (60%), 8 one-file patches (27%), 8 implementation (27%), 4 deep debug (13%), 2 architecture (7%)

### Without model router (all-Opus)

| Task | Count | Tier | Cost ratio | Total |
| --- | --- | --- | --- | --- |
| Exploration | 18 | Opus | 20x | 360x |
| One-file patch | 8 | Opus | 20x | 160x |
| Implementation | 8 | Opus | 20x | 160x |
| Deep debug | 4 | Opus | 20x | 80x |
| Architecture | 2 | Opus | 20x | 40x |
| **Total** | **40** | | | **800x** |

### With model router (normal mode, Sonnet orchestrator)

| Task | Count | Tier | Cost ratio | Total |
| --- | --- | --- | --- | --- |
| Exploration (delegated) | 10 | `@fast` | 1x | 10x |
| Exploration (direct, trivial) | 8 | self | 0x | 0x |
| One-file patch | 8 | `@light` | 2x | 16x |
| Implementation | 8 | `@medium` | 5x | 40x |
| Deep debug | 4 | `@focused` | 10x | 40x |
| Architecture | 2 | `@heavy` | 20x | 40x |
| **Total** | **40** | | | **146x** |

### With model router (budget mode, Sonnet orchestrator)

| Task | Count | Tier | Cost ratio | Total |
| --- | --- | --- | --- | --- |
| Exploration | 18 | `@fast` | 1x | 18x |
| One-file patch | 8 | `@light` | 2x | 16x |
| Implementation (simple) | 5 | `@light` | 2x | 10x |
| Implementation (complex) | 3 | `@medium` | 5x | 15x |
| Deep debug | 4 | `@medium` | 5x | 20x |
| Architecture | 2 | `@medium` | 5x | 10x |
| **Total** | **40** | | | **89x** |

### Summary

| Setup | Session cost | vs all-Opus |
| --- | --- | --- |
| All-Opus (no router) | 800x | baseline |
| Sonnet orchestrator + router (normal) | 146x | **−82%** |
| Sonnet orchestrator + router (budget) | 89x | **−89%** |

> Cost ratios are relative units. Actual savings depend on your provider pricing and model selection.

## How it works

On every message, the plugin injects ~210 tokens into the system prompt. The notation is intentionally dense and compressed — it's **optimized for LLM comprehension, not human readability**. An agent reads it as a precise routing grammar; a human might squint at it. That's by design: verbose prose would cost 4x more tokens per message with no routing benefit.

What the orchestrator sees (default preset, normal mode):

```text
## Model Delegation Protocol
Preset: multi-provider. Tiers: @fast=opencode-go/qwen-3.8-flash(1x) @light=openai/gpt-5.6-luna(2x) @medium=minimax-coding-plan/MiniMax-M2.7(5x) @focused=minimax-coding-plan/MiniMax-M3(10x) @heavy=openai/gpt-5.6-terra(20x). mode:normal
R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @light→simple-edit/config-tweak/single-file-refactor @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @focused→deep-debug/single-system-review/perf-opt(within one system) @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca
Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable. Cheapest-first when practical.
1.[tier:X] tag in plan→delegate X 2.plan:fast/cheap→@fast | plan:medium→@medium | plan:heavy→@heavy 3.default preference: read-only→@fast | implementation→@medium 4.orchestrate=self,execute=subagent 5.trivial(≤1 tool call,no expected follow-up)→direct,skip-delegate 6.before @heavy: gather context first(usually via @fast); if already sufficient, dispatch directly 7.if self is opus: skip-@heavy(do locally), still route broader read-only exploration to @fast 8.min(cost,adequate-tier)
Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→google→github-copilot | openai→anthropic→google→github-copilot | github-copilot→anthropic→openai→google | google→openai→anthropic→github-copilot | opencode-go→openai→google→github-copilot
Delegate with Task(subagent_type="fast|light|medium|focused|heavy", prompt="...").
Keep orchestration and final synthesis in the primary agent.
```

**What each line means (for humans):**

| Line | What it encodes |
| --- | --- |
| `Tiers: @fast=…(1x) @light=…(2x) @medium=…(5x) @focused=…(10x) @heavy=…(20x)` | Model + cost ratio per tier, all in one compact token |
| `R: @fast→search/grep/… @light→simple-edit/… @medium→impl/…` | Full task taxonomy — keyword triggers for each tier |
| `Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable` | Preferred decomposition for separable composite tasks |
| `1.[tier:X]→… 5.trivial(≤1 tool call)… 6.before @heavy: gather context…` | Numbered routing rules in abbreviated form |
| `Err→retry-alt-tier→fail→direct. Chain: …` | Fallback strategy in one line |

The orchestrator reads this once per message and applies it to every tool call and delegation decision in that turn.

### Multi-phase decomposition (key differentiator)

The most impactful optimization. A composite task like:

> "Find how the auth middleware works and refactor it to use JWT."

Without router → routed entirely to `@medium` (5x for all ~8K tokens)

With router → split:
- **`@fast` (1x)**: grep, read 4-5 files, trace call chain (~4K tokens)
- **`@medium` (5x)**: rewrite auth module (~4K tokens)

**Result: ~36% cost reduction on composite tasks**, which represent ~60-70% of real coding work.

## Why not just use another orchestrator?

| Feature | model-router | Claude native | oh-my-opencode | GSD | ralph-loop |
| --- | :---: | :---: | :---: | :---: | :---: |
| Multi-tier cost routing | yes | no | no | no | no |
| Configurable task taxonomy | yes | no | no | no | no |
| Budget / quality / deep modes | yes | no | no | no | no |
| Multi-phase decomposition | yes | no | no | no | no |
| Cross-provider fallback | yes | no | no | no | no |
| Cost ratio awareness | yes | no | no | no | no |
| Plan annotation with tiers | yes | no | no | no | no |
| ~210 token overhead | yes | — | no | no | no |
| Delegation enforcement (acceptance + escalation) | yes | no | no | no | no |

**Claude native**: single model for everything, no cost routing. If you're using claude.ai or OpenCode without plugins, you're paying the same price for `grep` as for architecture design.

**oh-my-opencode**: focused on workflow personality and prompt style, not cost optimization. No tier routing, no task taxonomy.

**GSD (Get Shit Done)**: prioritizes execution speed and low deliberation overhead. Excellent at pushing through tasks fast, but uses one model — no cost differentiation between search and architecture.

**ralph-loop**: iterative feedback-loop orchestrator. Excellent at self-correction and quality verification. No tier routing — every loop iteration runs on the same model regardless of task complexity.

**The core difference**: the others optimize for *how* the agent works (style, speed, quality loops). model-router optimizes for *what it costs* — with zero compromise on quality, because you can always put Opus in the `@heavy` tier.

## Recommended setup

**Orchestrator**: use `claude-sonnet-4-6` (or equivalent mid-tier) as your primary/default model. Not Opus.

Why: the orchestrator runs on every message, including trivial ones. Sonnet can read the delegation protocol and make routing decisions just as well as Opus. You reserve Opus for when it's genuinely needed — via `@heavy` delegation.

In your `opencode.json`:

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "autoshare": false
}
```

Then install and configure model-router to handle the rest.

## Installation

### Quick install (recommended)

```bash
npx opencode-smart-router install
```

This adds the plugin to your global opencode config. Restart opencode to activate.

Other commands:

```bash
osr install              # Install plugin to global config
osr uninstall            # Remove plugin from global config
osr status               # Check installation status (includes version info)
osr doctor               # Validate config health (includes freshness check)
osr config init          # Create a tiers.json override (global or local)
osr config paths         # Show bundled/global/local/state tier paths
osr update               # Detect stale install and print the fix
```

After `osr install` the CLI prints a tip pointing at `osr config init`. Use that command to create the optional `tiers.json` override file that the router reads on top of the bundled defaults — see [Configuration → Presets](#presets) below.

### From npm

```bash
# Globally
npm install -g opencode-smart-router

# Or as a project dep
npm install opencode-smart-router
```

Add to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-smart-router"]
}
```

### Local clone

```bash
git clone https://github.com/MetalbolicX/opencode-smart-router
cd opencode-smart-router
pnpm install
```

This repo uses pnpm (or run `corepack enable` first).

In `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-smart-router@/absolute/path/to/opencode-smart-router"]
}
```

## Testing

The project has three test layers.

| Script | What it runs |
| --- | --- |
| `pnpm test` | Vitest unit + integration tests |
| `pnpm run test:coverage` | Vitest with v8 coverage |
| `pnpm run test:gate` | Vitest with coverage gates (used by `prepublishOnly`) |
| `pnpm run smoke` | Optional smoke tests against a live opencode instance (requires `RUN_OC_SMOKE=1`) |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run lint` | Biome checks |
| `pnpm run format:check` | Biome format check |

Build before you test the first time:

```bash
pnpm install
pnpm run build      # build:tiers → tsc → rolldown
pnpm test
```

`pnpm run build` chains `build:tiers → tsc → rolldown`. `build:tiers` regenerates the shipped `tiers.json` from `config/tiers/*.json` — skipping it may import a stale or missing config and surface red herrings.

## Updating

```bash
npx opencode-smart-router@latest install
```

This always pulls the latest version from npm and re-registers it — no version pin to maintain, no stale cache to worry about.

### Verify the active version

```bash
osr doctor         # Health check — includes version comparison
osr status         # Show installed vs latest version
```

### `osr update`

```bash
osr update              # Check for stale install and print the fix
osr update --dry-run    # Preview what would be purged, disk untouched
```

`osr update` compares your installed version against the npm registry. If stale, it clears the runtime cache and prints the canonical `npx` update command. It does **not** reinstall the package itself — the stale binary cannot bypass the package manager's own freshness gate, so the instruction is the honest limit.

### pnpm v11 note

pnpm v11 introduced `minimumReleaseAge: 1440` for newly published packages — a 24-hour cooldown before pnpm will install a freshly published version. This means **publishing a fix does NOT make it immediately available** via `pnpm add -g opencode-smart-router` — pnpm silently falls back to the newest version that is at least 24 hours old.

**If you use pnpm:**
- Wait 24 hours after publication, or
- Add `opencode-smart-router` to `minimumReleaseAgeExclude` in your pnpm config (global or workspace):

  ```yaml
  minimumReleaseAgeExclude:
    - opencode-smart-router
  ```

- Or use the `npx` update path above, which bypasses pnpm entirely.

**Republishing a fix does not help** — it resets the 24-hour clock, making the gate worse. Always use `npx opencode-smart-router@latest install` to get the latest version immediately.

## Configuration

The plugin resolves its effective config from up to **four layers**, merged in this precedence (highest → lowest):

```text
state  >  local  >  global  >  bundled
```

| Layer | Path | Required? | Purpose |
| --- | --- | --- | --- |
| **bundled** | `<plugin>/tiers.json` | yes | Shipped defaults. Read on every load. |
| **global** | `~/.config/opencode-smart-router/tiers.json` | no | User-level override that applies across all projects. |
| **local** | `<cwd>/.opencode/tiers.json` | no | Repo-local override. Re-evaluated on every call (changes to `process.cwd()` require `invalidateConfigCache()` to take effect). |
| **state** | `~/.config/opencode/opencode-smart-router.state.json` | no | Runtime state (`activePreset`, `activeMode`, `enforcement.mode`). Written by `/preset`, `/budget`, and `/router enforce`. |

**Manual layers (bundled → global → local)** are deep-merged: plain objects merge by key union; arrays, scalars, and an explicit `null` **replace** the lower value (not delete). The merged result is validated exactly once with `validateConfig()`.

**Runtime state (state)** is the highest-precedence layer but it overlays **only** the three fields it owns — `activePreset`, `activeMode`, and `enforcement.mode`. All other manual fields are preserved. Runtime state is never written back into `tiers.json`.

**Errors are tagged by layer path.** A present layer with malformed JSON, an unreadable bundled file, or a merged manual result that fails schema validation produces a descriptive error that names the offending file or field. Missing optional global/local files are treated as absent, not erroneous.

**Where the shipped `tiers.json` comes from.** `tiers.json` is regenerated at build time from the editable JSON sources in `config/tiers/`:

| Source | Purpose |
| --- | --- |
| `config/tiers/base.json` | `activePreset`, `activeMode`, `tierCaps`, `enforcement`, `reasoningPolicy` |
| `config/tiers/presets.json` | All preset definitions (tiers, models, `costRatio`, `steps`, and optional `reasoningControl`) |
| `config/tiers/prompts.json` | `tierPrompts` and orchestrator prompt fragments |
| `config/tiers/task-patterns.json` | `taskPatterns` and default `rules` |

Edit those files when adding presets, adjusting prompts, or shipping schema changes — then run `pnpm run build:tiers` to regenerate the bundled `tiers.json`.

### Presets

The plugin ships with **six presets** (switch with `/preset <name>`). `multi-provider` is the default.

Each row shows the model and cost ratio for that tier in that preset.

#### `anthropic`

| Tier | Model | Cost ratio |
| --- | --- | --- |
| `@fast` | `anthropic/claude-haiku-4-5` | 1x |
| `@light` | `anthropic/claude-haiku-4-5` | 2x |
| `@medium` | `anthropic/claude-sonnet-4-6` (max) | 5x |
| `@focused` | `anthropic/claude-sonnet-4-6` (max) | 10x |
| `@heavy` | `anthropic/claude-opus-4-8` (max) | 20x |

#### `openai`

| Tier | Model | Cost ratio |
| --- | --- | --- |
| `@fast` | `openai/gpt-5.4-mini-fast` | 1x |
| `@light` | `openai/gpt-5.4-mini-fast` | 2x |
| `@medium` | `openai/gpt-5.5-fast` (high) | 5x |
| `@focused` | `openai/gpt-5.5-fast` (high) | 10x |
| `@heavy` | `openai/gpt-5.5-fast` (xhigh) | 20x |

#### `github-copilot`

| Tier | Model | Cost ratio |
| --- | --- | --- |
| `@fast` | `github-copilot/claude-haiku-4-5` | 1x |
| `@light` | `github-copilot/claude-haiku-4-5` | 2x |
| `@medium` | `github-copilot/claude-sonnet-4-6` | 5x |
| `@focused` | `github-copilot/claude-sonnet-4-6` | 10x |
| `@heavy` | `github-copilot/claude-opus-4-6` (thinking) | 20x |

#### `google`

| Tier | Model | Cost ratio |
| --- | --- | --- |
| `@fast` | `google/gemini-2.5-flash` | 1x |
| `@light` | `google/gemini-2.5-flash` | 2x |
| `@medium` | `google/gemini-2.5-pro` | 5x |
| `@focused` | `google/gemini-2.5-pro` | 10x |
| `@heavy` | `google/gemini-3-pro-preview` | 20x |

#### `hybrid`

| Tier | Model | Cost ratio |
| --- | --- | --- |
| `@fast` | `anthropic/claude-haiku-4-5` | 1x |
| `@light` | `anthropic/claude-haiku-4-5` | 2x |
| `@medium` | `openai/gpt-5.5-fast` (high) | 5x |
| `@focused` | `openai/gpt-5.5-fast` (high) | 10x |
| `@heavy` | `anthropic/claude-opus-4-8` (max) | 20x |

#### `multi-provider` (default)

| Tier | Model | Cost ratio |
| --- | --- | --- |
| `@fast` | `opencode-go/qwen-3.8-flash` | 1x |
| `@light` | `openai/gpt-5.6-luna` | 2x |
| `@medium` | `minimax-coding-plan/MiniMax-M2.7` | 5x |
| `@focused` | `minimax-coding-plan/MiniMax-M3` | 10x |
| `@heavy` | `openai/gpt-5.6-terra` | 20x |

### Routing modes

Switch with `/budget <mode>`. Mode is persisted across restarts.

| Mode | Default tier | Behavior |
| --- | --- | --- |
| `normal` | `@medium` | Balanced — routes by task complexity |
| `budget` | `@fast` | Aggressive savings — defaults cheap, escalates only when necessary |
| `quality` | `@medium` | Quality-first — liberal use of `@medium`/`@focused`/`@heavy` |
| `deep` | `@heavy` | Deep-analysis mode — heavy-first for architecture/debug/security with longer heavy runs |

```json
{
  "modes": {
    "budget": {
      "defaultTier": "fast",
      "description": "Aggressive cost savings",
      "overrideRules": [
        "default→@fast unless edits/complex-reasoning needed",
        "@light ONLY: multi-file-edit/refactor/test-suite/build-fix",
        "@medium ONLY: multi-file-edit/refactor/test-suite/build-fix",
        "@heavy ONLY: user-requested OR ≥2 @medium failures"
      ]
    },
    "deep": {
      "defaultTier": "heavy",
      "description": "Deep analysis mode — prioritizes thorough architecture/debug work with long heavy runs",
      "overrideRules": [
        "default→@medium for implementation and multi-file changes",
        "@heavy for architecture/debug/security/tradeoff-analysis by default",
        "allow long heavy runs before fallback; avoid premature downshift",
        "trivial(grep/read/glob)→direct,no-delegate",
        "if task is composite and phases are separable: prefer explore@fast then execute@heavy"
      ]
    }
  }
}
```

**Heavy tool-call budget:** `@heavy.steps=120` by default across presets (raised from 60) to reduce premature cutoffs on long architecture/debug tasks.

### Task taxonomy (`taskPatterns`)

Keyword routing guide injected into the system prompt. Customize to match your workflow:

```json
{
  "taskPatterns": {
    "fast": ["search/grep/read", "git-info/ls", "lookup-docs/types", "count/exists-check/rename"],
    "light": ["simple-edit/config-tweak", "single-file-refactor/typo-fix", "parameter-change"],
    "medium": ["impl-feature/refactor", "write-tests/bugfix(≤2)", "build-fix/create-file"],
    "focused": ["deep-debug/single-system-review", "perf-opt(within one system)", "single-pkg-complex-bug"],
    "heavy": ["arch-design/debug(≥3fail)", "sec-audit/perf-opt", "migrate-strategy/rca"]
  }
}
```

### Cost ratios

Set `costRatio` on each tier to reflect your real provider pricing. These are injected into the system prompt so the orchestrator makes cost-aware decisions:

```json
{
  "fast":    { "costRatio": 1  },
  "light":   { "costRatio": 2  },
  "medium":  { "costRatio": 5  },
  "focused": { "costRatio": 10 },
  "heavy":   { "costRatio": 20 }
}
```

Adjust to actual prices. Exact values don't matter — directional signals are enough.

### Read-only call caps

Subagents carry a cap on their own read-only tool calls (grep/read/glob/ls) per dispatch. Enforcement is **two-layered**: prompt-level stop rules + runtime banners injected into tool results. Baselines (configurable via `tierCaps` — see below):

| Tier | Baseline cap |
| --- | ---: |
| `@fast` | 8 |
| `@light` | 7 |
| `@medium` | 5 |
| `@focused` | 4 |
| `@heavy` | 3 |
| Orchestrator (direct tools) | 2 per turn (prompt-level only) |

The orchestrator can override any subagent's cap per dispatch by including a directive in the `Task` prompt:

- `CAP:N` — tighten or loosen to N calls (e.g., `CAP:3` for a focused lookup).
- `CAP:none` — disable the numeric cap entirely (used in `quality` mode and for `@heavy` in `deep` mode).

Omitting the directive falls back to the tier baseline. Subagents may **exceed** their cap with a 1-line `reason:` in the return (target, not hard block).

#### Runtime enforcement (subagents only)

Prompt-level rules alone are unreliable: many models (including strong ones like Opus 4.7) ignore "please stop at N reads" and loop on reconnaissance for tens of minutes. To address this, the plugin tracks read-only tool calls per subagent session and **appends a banner to every read-only tool result** via the `tool.execute.after` hook. The subagent sees this banner inside the tool's own response text — not as advisory system prompt noise — which makes it very hard to ignore.

What the subagent sees inside each `grep`/`read`/`glob`/`ls` result:

```text
...normal tool output...

[cap: 3/5]
```

Approaching or hitting the cap:

```text
[cap: 4/5]
[⚠ CAP WARNING: 1 read-only call(s) remaining before forced return]
```

```text
[cap: 5/5]
[⚠ CAP REACHED (5/5): your NEXT response MUST be a return — do NOT make another read-only call. Start the response with DONE:, NEED MORE:, NEED CONTEXT:, SCOPE GROWTH:, or ESCALATE:.]
```

Redundancy (same file re-read, same `grep` pattern re-run):

```text
[cap: 3/5]
[⚠ REDUNDANT: this is the same grep you ran at call #1. STOP now — repeated reads add no information. Return with DONE/NEED MORE/NEED CONTEXT/SCOPE GROWTH/ESCALATE.]
```

The orchestrator session is **not tracked** — its self-cap of 2 direct reads per turn is prompt-only. Tool counting applies only to sessions whose `agent` matches a registered tier name.

#### Configuring caps (`tierCaps`)

```json
{
  "tierCaps": {
    "fast":    8,
    "light":   7,
    "medium":  5,
    "focused": 4,
    "heavy":   3
  }
}
```

Values are positive integers. Missing tier → falls back to the hardcoded default (same numbers). Change these to tighten/loosen the baseline without editing any prompt.

#### Return protocol

Independent of the numeric cap, every subagent runs a redundancy check before each new tool call. On stop (cap reached, redundancy detected, scope satisfied, or runtime banner), the subagent returns with exactly one of:

| Return prefix | Meaning |
| --- | --- |
| `DONE: …` | Dispatch request fully satisfied — synthesize into final answer. |
| `NEED MORE: …` (or `NEED CONTEXT:` for `@medium`, `SCOPE GROWTH:` for `@heavy`) | Subagent needs another targeted round — orchestrator decides what to dispatch. |
| `ESCALATE: …` | Scope grew beyond the subagent's role — orchestrator re-routes. |

This keeps subagents from burning tokens on repeated lookups when they already have enough context. `CAP:none` lifts the numeric cap but **does not** disable the redundancy check — the runtime still injects `[⚠ REDUNDANT]` banners regardless of cap setting.

**Mode interactions:**

| Mode | Dispatch directive | Orchestrator self-cap |
| --- | --- | --- |
| `normal` | baselines (omit directive) | ≤2 direct reads |
| `budget` | `CAP:5` `@fast`, `CAP:2` `@medium`, `CAP:2` `@heavy` | ≤1 direct read |
| `quality` | `CAP:none` on all dispatches | ≤2 direct reads |
| `deep` | `CAP:none` on `@heavy` only; baselines elsewhere | ≤2 direct reads |

### Tier prompts (`tierPrompts`)

Each tier has a system prompt that describes its role, scope, call cap, and return protocol. To avoid duplicating the same string across every preset, the router uses a **global default with per-tier override**:

```json
{
  "tierPrompts": {
    "fast":    "You are @fast — … (full global prompt)",
    "light":   "You are @light — …",
    "medium":  "You are @medium — …",
    "focused": "You are @focused — …",
    "heavy":   "You are @heavy — …"
  },
  "presets": {
    "anthropic": {
      "fast":   { "model": "anthropic/claude-haiku-4-5", … },
      "medium": { "model": "anthropic/claude-sonnet-4-6", … },
      "heavy":  { "model": "anthropic/claude-opus-4-8", … }
    }
  }
}
```

**Resolution order per tier:**

1. If the preset's tier defines `"prompt": "..."` inline → use it (per-tier override).
2. Otherwise → fall back to `tierPrompts[<tierName>]`.
3. If neither is set → the tier registers without a system prompt.

**When to customize:** if a specific provider/model in a preset needs different instructions (e.g. Gemini-specific tool format, tighter/looser caps for a weaker local model), add `"prompt": "..."` on that tier only. All other presets keep using the global.

```json
{
  "presets": {
    "google": {
      "fast": {
        "model": "google/gemini-2.5-flash",
        "prompt": "You are @fast (Gemini-tuned variant) — …",
        …
      }
    }
  }
}
```

### Claude-model adversarial prefixes (automatic)

Anthropic models (served directly via `anthropic/*` or routed through other providers as `*/claude-*`) ship with a large cached system prompt that primes them toward broad exploratory Read/Grep/Glob behavior. When such a prompt sits in front of your router instructions, primacy bias and prompt caching weaken the router's authority — subagents ignore caps, orchestrators run read-only work themselves instead of dispatching.

To counteract this, the router **automatically prepends an adversarial opener** to:

- The tier prompt for any tier whose `model` matches a Claude identifier
- The orchestrator delegation protocol when the session model is a Claude identifier

Detection is by model string, not preset. A `hybrid` preset that mixes providers (e.g. `openai/*` for `@fast`, `anthropic/*` for `@medium` and `@heavy`) gets the override only on its Claude-backed tiers.

**Tone assignment:**

| Target | Tone | Opener label |
| --- | --- | --- |
| `@fast` (Claude) | Scoping — conversational | `SCOPE NOTE` |
| `@medium` (Claude) | Scoping — conversational | `SCOPE NOTE` |
| `@heavy` (Claude) | Override — firm | `AUTHORITY OVERRIDE` |
| Orchestrator (Claude) | Override — firm | `AUTHORITY OVERRIDE` |

`@heavy` and the orchestrator use the firmer tone because that's where reconnaissance loops were worst in observed sessions. `@fast` and `@medium` use a softer scoping note to avoid over-correcting legitimate multi-read tasks.

**Detection rules:**

- `anthropic/<anything>` → Claude
- `<provider>/claude-<anything>` (e.g. `github-copilot/claude-sonnet-4-6`) → Claude
- `<provider>/<namespace>.claude-<anything>` (e.g. `bedrock/us.anthropic.claude-3-5-sonnet-...`) → Claude
- Everything else → untouched

No configuration is needed — the prefixes are always applied for Claude-backed tiers. If you want to disable them, override the tier's `prompt` field (per-tier overrides replace the whole prompt, including the prefix).

### Anti-narration guardrail (Claude models)

Thinking-enabled Claude models (especially Sonnet with the `max` variant) sometimes produce progress narration instead of actual work — phrasings like *"Still writing the X function..."*, *"Now I'll implement Y..."*, *"Let me add Z..."* — without the X/Y/Z ever appearing. This is a known thinking-mode failure pattern.

The router counters this on two layers:

**1. Prompt-level clause (prevention).** A dedicated `ANTI-NARRATION` block is appended to every Claude-backed tier prompt and to the Claude-backed orchestrator delegation protocol. It names the forbidden phrasings explicitly and requires concrete output to follow any such phrase. A carve-out preserves legitimate explanation/plan requests from the user.

**2. Post-hoc detector (telemetry).** An `experimental.text.complete` hook scans completed text for narration regex patterns. On match, it:

- Logs a warning to the plugin console:

  ```text
  [model-router] narration detected (session abc123): "Still writing the auth", "Now I'll add the tests"
  ```

- Appends a visible banner to the text as it's rendered to the user:

  ```text
  [⚠ narration detected: "Still writing the auth", "Now I'll add the tests"]
  ```

The detector is not blocking — plugin hooks cannot modify tokens mid-stream. It signals post-hoc so you can spot the pattern in the UI and in logs, and judge whether the prompt-level clause is holding up.

Detected patterns (conservative set to minimize false positives):

- `Still (writing|implementing|working on|...) the X`
- `Now (I'll)? (write|implement|add|...) the X`
- `Let me (write|implement|add|...) (the )? X`
- `I'll (now)? (write|implement|...) the X`
- `Going to (write|implement|...) the X`
- `Continuing (with|by ...ing) (the )? X`

Applies to all models, not only Claude — but the prompt-level clause is Claude-only, so non-Claude models get detector-only.

### Reasoning control

Per-tier reasoning is configurable at runtime via the `/model-router-reasoning` command and an optional `reasoningPolicy` block in `tiers.json`. See [docs/REASONING.md](./docs/REASONING.md) for the native-level control model, profile registry, and translation rules.

Minimal example:

```jsonc
{
  "reasoningPolicy": {
    "mode": "manual",        // "static" | "manual" | "adaptive". Default: "static" when the block is absent.
    "surfaceLimits": false   // Set true to log + chat-advisory when a tier can't satisfy a requested level.
  },
  "presets": {
    "multi-provider": {
      "light": {
        "model": "openai/gpt-5.6-luna",
        "reasoning": { "effort": "medium" },
        "reasoningControl": {
          "channel": "reasoning.effort",
          "levels": ["low", "medium", "high", "xhigh", "max"],
          "profileMap": { "p1": "low", "p2": "medium", "p3": "high" },
          "maxBumps": 2
        }
      }
    }
  }
}
```

All fields are optional. A config without `reasoningPolicy` is byte-identical to behaviour before reasoning control shipped.

### Fallback

Defines provider fallback order when a delegated task fails:

```json
{
  "fallback": {
    "global": {
      "anthropic": ["openai", "google", "github-copilot"],
      "openai": ["anthropic", "google", "github-copilot"]
    }
  }
}
```

### Environment variables

All variables are optional. They override corresponding `tiers.json` settings at runtime.

| Variable | Purpose | Where |
| --- | --- | --- |
| `MODEL_ROUTER_ENFORCE` | Force enforcement mode (`1` = `enforced`, `0` = `off`). Overrides `tiers.json`. | `src/router/enforcement.ts`, `src/router/commands/builders.ts` |
| `MODEL_ROUTER_VERIFIED_DELEGATE` | Enable the verified `delegate` tool (`1` enables; default hidden). | `src/index.ts` |
| `MODEL_ROUTER_LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error`. | `src/utils/observability.ts` |
| `MODEL_ROUTER_LOG` | Toggle router logging on/off. | `src/router/config-store.ts` |
| `MODEL_ROUTER_TRAJECTORY_DEBUG` | Enable trajectory scorecard debugging. | `src/plugin/hooks/session.ts` |

### Full field reference

Every field accepted by `tiers.json` — the full schema, validation rules, presets block structure, and tier field reference — lives in:

[docs/CONFIG_REFERENCE.md](./docs/CONFIG_REFERENCE.md)

For migration notes when upgrading from earlier versions, see [docs/MIGRATION.md](./docs/MIGRATION.md).

## Commands

### CLI (`osr`)

The `osr` binary is installed with the npm install (or run directly via `npx opencode-smart-router …`). Run `osr --help` to print this list at any time.

| Command | Description |
| --- | --- |
| `osr install` | Register the plugin in `~/.config/opencode/opencode.json`. Flags: `--version <v>`, `--latest`, `--dry-run`, `--yes`. |
| `osr uninstall` | Remove the plugin. Flags: `--purge` (also removes cache + `~/.config/opencode-smart-router/`), `--dry-run`, `--yes`. |
| `osr status` | Show installation status, including the active version. |
| `osr doctor` | Run health checks against the global config; exits non-zero on failure. |
| `osr update` | Detect stale install and purge cache. Flags: `--dry-run`. |
| `osr config init` | Create a `tiers.json` override. Flags: `--target global\|local`, `--preset <name>`, `--from-bundled`, `--force`, `--dry-run`. |
| `osr config paths` | Print bundled, global, local, and state paths and whether each file exists. |

### Slash commands

Slash commands are dispatched in-session via the `command.execute.before` hook. They operate on the runtime state — preset, mode, enforcement level, reasoning mode.

| Command | Description |
| --- | --- |
| `/tiers` | Show the active tier configuration, models, and rules |
| `/preset` | List available presets |
| `/preset <name>` | Switch preset (e.g., `/preset openai`) |
| `/budget` | Show available modes and which is active |
| `/budget <mode>` | Switch routing mode (`normal`, `budget`, `quality`, `deep`) |
| `/bypass` | Toggle model-router bypass (disables delegation for the session) |
| `/router` | Model-router controls |
| `/router enforce <off\|advisory\|enforced>` | Switch enforcement mode at runtime |
| `/annotate-plan [path]` | Annotate a plan file with `[tier:X]` tags for each step |
| `/model-router-reasoning` | Reasoning control (mode/policy, per-session overrides) |

### The `delegate` tool

By default the orchestrator dispatches via the native `Task()` tool — that path stays visible in the TUI and is verified automatically by the enforcement pipeline (in `advisory` / `enforced` modes).

An **independently-verified `delegate` tool** is also available — it requires an explicit `[acceptance]` block per dispatch and is hidden by default. Enable it in `tiers.json`:

```json
{
  "experimental": {
    "verifiedDelegateTool": true
  }
}
```

Or via environment variable:

```bash
MODEL_ROUTER_VERIFIED_DELEGATE=1 osr install
```

When enabled, the tool signature is:

```text
delegate(task: string, tier: "fast"|"light"|"medium"|"focused"|"heavy", acceptance: AcceptanceBlock): result
```

The `acceptance` block is a structured Definition-of-Done (DoD) — see [docs/VERIFICATION.md](./docs/VERIFICATION.md) for the schema and [docs/CONFIG_REFERENCE.md](./docs/CONFIG_REFERENCE.md) for the `experimental` block.

## Delegation enforcement

The read-only cap banners are advisory: a well-behaved subagent will respect them, but nothing prevents a model from making one more read after the `[⚠ CAP REACHED]` banner. The **enforcement layer** turns delegation into a produce → verify → accept/escalate loop with independent acceptance and quality escalation. As of v1.3.0 it runs in **`advisory` mode by default**: every non-trivial delegation is verified and any miss surfaces a forcing-note, but nothing is ever hard-blocked (the orchestrator system prompt grows by ~200 tokens for the DoD/acceptance section, and subagents may receive non-blocking guard banners). Set `"mode": "off"` — or run `/router enforce off` — to restore byte-for-byte-unchanged routing with zero added prompt tokens and zero new latency. Hard-blocks only activate in `"mode": "enforced"`.

### The three enforcement layers

- **Layer 1 — hard-block guard.** A `tool.execute.before` hook throws before a disallowed tool call executes, stopping budget overruns, redundant reads, and throwaway-script sidesteps in subagent sessions.
- **Layer 2 — independent acceptance gate.** Every non-trivial delegation carries a Definition-of-Done (DoD) that is checked — deterministically or by an independent grader at ≥ the producer's tier — before the result is trusted. The producer never grades its own output.
- **Layer 3 — quality-escalation ladder.** On a failed check: retry once, then escalate `@fast → @light → @medium → @focused → @heavy`, bounded by attempt and cost ceilings. The loop ends in an honest `status: unmet` rather than a fabricated pass.

### Two operating modes

- **Mode A — on-the-fly.** The orchestrator delegates through the native `Task()` tool — observed and verified automatically by the enforcement pipeline, and rendered inline in the TUI. (An optional, independently-verified `delegate` tool can be enabled via `experimental.verifiedDelegateTool` in `tiers.json` or `MODEL_ROUTER_VERIFIED_DELEGATE=1`; it is hidden by default so delegation stays visible.)
- **Mode B — plan-annotated.** `/annotate-plan` emits `[tier:X]` plus an `[acceptance]` block per task; the enforcement loop is wired up at execution time based on those annotations.

### Tuning enforcement

Advisory is the default. To change the level:

1. Add or edit the `enforcement` block in `tiers.json` — `"mode": "off"`, `"advisory"`, or `"enforced"` (see [docs/CONFIG_REFERENCE.md](./docs/CONFIG_REFERENCE.md)).
2. Set `MODEL_ROUTER_ENFORCE=1` to force `enforced` for a session, or `MODEL_ROUTER_ENFORCE=0` to force `off`.
3. Run `/router enforce <off|advisory|enforced>` from the chat to toggle at runtime.

**Modes:** `off` — no-op, byte-for-byte-unchanged routing; `advisory` (default) — evaluates and surfaces guidance, never blocks; `enforced` — hard-blocks active, full produce → verify → accept/escalate pipeline.

> Enforcement applies to subagent/delegate sessions only. The orchestrator session is never hard-blocked.

## Child-initiated fan-out (`fanout` tool)

The `fanout` tool lets a medium, focused, or heavy tier spawn multiple **parallel worker sessions as its own depth-2 children** — without escalating to the orchestrator. Workers are terminal leaves that cannot invoke `task`, `delegate`, or `fanout`. They run in parallel, each completing a bounded read-only task independently.

**Purpose:** offload lower-value work (parallel searches, fact-checking, sub-task parallelization) from medium/focused/heavy to cheaper tiers, at lower total cost than sequential dispatches.

### Policy matrix

| Caller tier | Can fan out? | Allowed worker tiers |
|---|---|---|
| `@medium` | Yes | `@fast` |
| `@focused` | Yes | `@fast`, `@light`, `@medium` |
| `@heavy` | Yes | `@fast`, `@light`, `@medium` |
| `@fast` | No | — |
| `@light` | No | — |

**Additional constraints:** fanout is blocked for fanout workers (prevents nested fanout), producer sessions (delegate-origin), grader sessions, and the orchestrator (depth-0 uses task/delegate instead).

**Example call:**

```text
fanout(items: [
  { tier: "fast", prompt: "grep for auth middleware in src/" },
  { tier: "fast", prompt: "git log --oneline -20 src/auth" }
])
```

Workers run in parallel. Results are aggregated as `## [n] tier=<t> status=<s>` in the caller's response. Workers are parented to the **caller** (depth 2), not the orchestrator/root — they are terminal leaves and cannot spawn further sessions.

### Configuration

The `fanout` block in `tiers.json` controls capacity, timeouts, and the circuit breaker. See [docs/CONFIG_REFERENCE.md](./docs/CONFIG_REFERENCE.md) for the full reference.

### Limitations

Fanout provides **bounded response** — the batch has a `batchTimeoutMs` cap and individual workers have a `workerTimeoutMs` cap. A stuck SDK call may linger after the timeout; the worker is marked `timed_out` but the underlying process is not hard-killed. Hard process-isolated termination is a future plan.

## Deep-dive documentation

Repository-only docs (not bundled in the npm tarball). Contributors and advanced users should consult them directly:

- [docs/CONFIG_REFERENCE.md](./docs/CONFIG_REFERENCE.md) — full `tiers.json` schema (top-level, `presets`, `tiers`, `modes`, `enforcement`, `experimental`, validation rules).
- [docs/COMMAND_REFERENCE_INDEX.md](./docs/COMMAND_REFERENCE_INDEX.md) — exhaustive CLI command reference.
- [docs/ENFORCEMENT.md](./docs/ENFORCEMENT.md) — architecture, hook wiring, session lifecycle.
- [docs/VERIFICATION.md](./docs/VERIFICATION.md) — DoD schema, deterministic checks, grader dispatch.
- [docs/ESCALATION.md](./docs/ESCALATION.md) — escalation ladder configuration and cost ceilings.
- [docs/REASONING.md](./docs/REASONING.md) — reasoning control, profile registry, and native-level translation.
- [docs/ENFORCEMENT_PRESETS.md](./docs/ENFORCEMENT_PRESETS.md) — ready-to-paste enforcement presets.
- [docs/MIGRATION.md](./docs/MIGRATION.md) — upgrade notes between versions.
- [docs/CAPS_DECISION.md](./docs/CAPS_DECISION.md) — tool-call caps per tier, language hardness, exceptions.
- [docs/COMMAND_PATTERNS.md](./docs/COMMAND_PATTERNS.md) — slash-command registration & execution patterns.
- [CHANGELOG.md](./CHANGELOG.md) — release history.

## Plan annotation

For complex tasks, write a plan file and annotate each step with the correct tier. The `/annotate-plan` command reads the plan and adds `[tier:fast]`, `[tier:light]`, `[tier:medium]`, `[tier:focused]`, or `[tier:heavy]` tags to each step based on the task taxonomy.

The orchestrator reads these tags and delegates accordingly — eliminating routing decisions on multi-step tasks.

Example plan (before annotation):

```markdown
1. Find all API endpoints in the codebase
2. Add rate limiting middleware to each endpoint
3. Write integration tests for rate limiting
4. Design a token bucket algorithm for advanced rate limiting
```

After `/annotate-plan`:

```markdown
1. [tier:fast] Find all API endpoints in the codebase
2. [tier:medium] Add rate limiting middleware to each endpoint
3. [tier:medium] Write integration tests for rate limiting
4. [tier:heavy] Design a token bucket algorithm for advanced rate limiting
```

## Token overhead

The system prompt injection is ~210 tokens per message — roughly the same as v1.0 (before cost-aware features were added). Dense notation keeps overhead flat while adding full routing intelligence.

The exact overhead has tracked release-over-release; for the current value, see [CHANGELOG.md](./CHANGELOG.md) (`pnpm run build:tiers` prints it during build, and `/tiers` reports it in-session).

## Requirements

- [OpenCode](https://opencode.ai) v1.0 or later (`>=1.0.0` peer)
- Node.js 22.6+
- Provider API keys configured in OpenCode

## License

GPL-3.0 — see [LICENSE](./LICENSE).

Reasoning configuration uses v2 `reasoningControl` objects. Migrate legacy
`capability` tier fields and the global `reasoningEscalation` block to ordered
native levels, an exact profile map, and per-tier `maxBumps`. Legacy keys are
rejected during validation; see `docs/CONFIG_REFERENCE.md` for the migration
contract.
