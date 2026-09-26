# Agent Executor Guide

## Project

OpenCode plugin for tiered subagent routing, a hard-block guard, an independent acceptance gate, and fanout.
License: GPL-3.0-only. npm package: `opencode-smart-router`.
Executable: `osr` (`./dist/cli.mjs`).

## Non-negotiables

- Use pnpm only (`pnpm@11.12.0`); Node.js must be `>=22.6.0`.
- Tests belong under `test/{unit,golden,integration,smoke}`, never under `src/` (published package ships `src/`).
- Root `tiers.json` is generated. Never hand-edit it; update its source parts and run `pnpm run build:tiers` (also the first build step).
- Use conventional commits. Do not push or open a PR unless instructed.
- When completing a plan, update its row in `plans/README.md`.

## Verification commands

| Command | When to use |
| --- | --- |
| `pnpm install` | Install dependencies when setting up a worktree; respect the lockfile. |
| `pnpm run typecheck` | Check TypeScript types. |
| `pnpm run lint` | Run Biome checks. |
| `pnpm run build` | Build before testing wired integration paths or when build output is needed. |
| `pnpm test` | Run the Vitest suite; add a filter for focused tests. |
| `pnpm run test:gate` | Run Vitest with coverage thresholds. |
| `pnpm run smoke` | Run smoke tests with `RUN_OC_SMOKE=1`; requires a live OpenCode runtime. |

The verification contract is **no NEW failures** versus [`docs/qa/verification-baseline.md`](docs/qa/verification-baseline.md), which records 2656/2656 tests green. Wired integration tests are skip-guarded unless the build has run first; run `pnpm run build` before those tests.

## Architecture map

- `src/router`: config load/validate/store, sessions, tier ladder, protocol, enforcement, agents, and tools.
- `src/guard`: Layer 1 hard-block guard (enforce, fingerprint, guards, scrub, store, narration).
- `src/verify`: Layer 2 acceptance gate (gate, DoD, deterministic checks, checker, dispatch).
- `src/plugin`: context, delegate and fanout tools, hook wiring, and runtime.
- `src/reasoning`: adaptive profile selection, policy, and store.
- `src/escalate`: escalation-ladder state machine.
- `src/telemetry`: trajectory scorecards.
- `src/cli`: `osr` install, update, status, and config commands.
- `src/utils`: shared utilities.

## Conventions

- Biome is configured in `biome.jsonc`; CI runs the lint gate.
- Behavior changes use strict TDD: RED → GREEN → REFACTOR; keep RED commits separate.
- Emit structured `log.*` events with module prefixes.
- Implement stores as closure factories.
- Put I/O behind test seams; see `src/verify/types.ts` for precedent.

## Where things are documented

- ADRs: [`docs/adr/0000-spike-results.md`](docs/adr/0000-spike-results.md), [`docs/adr/0001-hard-block-guard.md`](docs/adr/0001-hard-block-guard.md), [`docs/adr/0002-acceptance-gate.md`](docs/adr/0002-acceptance-gate.md) (authoritative end-state decision).
- Guides: [`docs/CONFIG_REFERENCE.md`](docs/CONFIG_REFERENCE.md), [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md), [`docs/ENFORCEMENT_PRESETS.md`](docs/ENFORCEMENT_PRESETS.md), [`docs/ESCALATION.md`](docs/ESCALATION.md), [`docs/REASONING.md`](docs/REASONING.md), [`docs/VERIFICATION.md`](docs/VERIFICATION.md), [`docs/FLOW_DIAGRAMS.md`](docs/FLOW_DIAGRAMS.md), [`docs/MIGRATION.md`](docs/MIGRATION.md), [`docs/LINE_REFERENCES.md`](docs/LINE_REFERENCES.md) (symbol index; no line numbers).
- Plan index and executor workflow: [`plans/README.md`](plans/README.md).
