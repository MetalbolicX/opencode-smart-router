# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.0] — 2026-09-14

### Changed

- Rotated the fast, medium, and heavy tier models to a multi-provider lineup.
- Raised the minimum supported Node.js version to 22.6.0.

### Fixed

- Fixed package dry-run handling for npm 12 JSON output.

## [1.10.0] — 2026-08-31

### Added

- Added adaptive reasoning profiles and atomic reasoning controls, including per-tier reasoning bump jumps.
- Added child-initiated fanout with configurable admission limits, containment, timeouts, and breaker behavior.
- Added fanout usage guidance and configuration documentation.

### Changed

- Fanout workers run as depth-2 children of the original caller.

## [1.9.2] — 2026-08-16

### Fixed

- Corrected reasoning escalation behavior and profile/config validation.

## [1.9.1] — 2026-08-10

### Fixed

- Corrected adaptive reasoning profile selection and config validation.

## [1.9.0] — 2026-08-10

### Added

- Added reasoning-level escalation on retry before falling back to the next tier.

## [1.8.0] — 2026-08-09

### Added

- Added runtime reasoning mode switching and per-session reasoning control.

## [1.7.0] — 2026-07-15

### Added

- Added the five-tier routing configuration, including light and focused tiers.

## [1.5.10] — 2026-07-13

### Fixed

- Corrected tier and reasoning configuration behavior.

## [1.5.9] — 2026-07-12

### Fixed

- Fixed routing and configuration edge cases.

## [1.5.7] — 2026-07-12

### Changed

- Updated tier routing and preset behavior.

## [1.5.4] — 2026-07-10

### Added

- Added adaptive reasoning configuration and provider-agnostic reasoning controls.

## [1.5.3] — 2026-07-08

### Fixed

- Fixed configuration and routing behavior.

## [1.5.2] — 2026-07-07

### Changed

- Improved model selection and tier configuration.

## [1.5.1] — 2026-07-07

### Fixed

- Fixed release packaging and configuration handling.

## [1.5.0] — 2026-07-06

### Added

- Added additional routing tiers and tier-specific presets.

## [1.4.3] — 2026-07-06

### Fixed

- Fixed routing behavior and configuration validation.

## [1.4.2] — 2026-07-06

### Fixed

- Fixed tier configuration and routing edge cases.

## [1.4.1] — 2026-07-02

### Fixed

- Fixed issues in the 1.4.0 release.

## [1.4.0] — 2026-07-02

### Added

- Added the initial 1.4 release features for tiered routing and configuration.

## [1.3.0]

### Changed — advisory enforcement is now the default

- **Default enforcement mode flipped `off` → `advisory`.** With `enforcement.mode`
  unset, every non-trivial delegation is now verified and any miss surfaces a
  non-blocking forcing-note; the orchestrator system prompt grows by ~200 tokens for
  the DoD/acceptance section, and subagents may receive non-blocking guard banners.
  Nothing is ever hard-blocked in `advisory`. To restore the previous byte-identical
  behaviour (zero added tokens, zero new latency), set `"mode": "off"` explicitly, run
  `/router enforce off`, or set `MODEL_ROUTER_ENFORCE=0`.
- **The custom `delegate` tool is now hidden by default.** Delegation routes through the
  native `Task()` tool so subagents render inline in the TUI instead of running in an
  invisible orphan session (fixes the `delegate [tier=…, task=…]` stall). The
  independently-verified `delegate` tool remains available behind an opt-in flag.
- The acceptance forcing-note now includes tier-escalation guidance
  (`Task(subagent_type="<nextTier>")`) when a delegated result is not accepted.

### Added

- `experimental.verifiedDelegateTool` config flag in `tiers.json`, and the
  `MODEL_ROUTER_VERIFIED_DELEGATE=1` environment variable, to opt back into the
  authoritative `delegate` tool.

## [1.2.0]

### Added — Enforced delegation (opt-in, default OFF)

A three-layer enforcement system that makes tiered delegation *reliable* instead of
advisory. **It is opt-in and disabled by default**: with `enforcement.mode` unset (or
`"off"`), behaviour is byte-identical to previous releases — no added prompt tokens, no
new runtime behaviour. Enable per repo via `enforcement.mode` in `tiers.json`, per run
via the `MODEL_ROUTER_ENFORCE=1` environment variable, or per session via
`/router enforce <off|advisory|enforced>`. Enforcement applies only to subagent/delegate
sessions; the orchestrator session is never gated.

- **Layer 1 — hard-block guard** (`tool.execute.before`): an in-band, throw-to-block
  guard for subagent sessions. Enforces a tool-call budget ceiling, anti-redundancy
  (repeated identical reads), and anti-self-script (ad-hoc `bash` execution such as
  heredocs / `node -e` / `cat >`), with an optional deliverable-first rule. Writing
  source files is *never* blocked by default (`blockScriptWrites` is opt-in).
  `off` is a no-op, `advisory` surfaces a banner, `enforced` blocks.
- **Layer 2 — independent acceptance gate**: turns "the producer says it's done" into
  "the output was objectively accepted". A Definition-of-Done is parsed from an
  `[acceptance]` block (Mode B) or auto-inferred from the dispatch (Mode A) and checked
  either deterministically (`run` / `fileExists` / `schemaMatch` / `testsPass` /
  `buildPasses` / `lintClean` behind an allowlisted exec/fs seam) or by an **independent
  grader** in a fresh session at a tier ≥ the producer's. Fail-closed: any error,
  unparseable verdict, or non-independent grader counts as a failure. Never silently
  accepts a non-trivial delegation that lacks a checkable DoD.
- **Layer 3 — quality-escalation ladder**: on a failed gate the authoritative `delegate`
  tool retries, then escalates `fast → medium → heavy`, then returns an honest
  `status: unmet` — never a fake pass. Provably terminating (bounded by
  `maxAttemptsPerTier`, `maxTotalAttempts`, and a cost ceiling) and composes with the
  existing advisory provider-failover chain without double-counting attempts.

### Added — tooling & APIs

- New `delegate` tool (authoritative produce → verify → escalate in one call) alongside
  the existing raw `Task()` path (advisory-grade verify-dispatch).
- New `/router enforce <off|advisory|enforced>` command (persisted atomically).
- New `enforcement` configuration block in `tiers.json` (fully validated; see
  `docs/CONFIG_REFERENCE.md`). Per-mode example presets in `docs/ENFORCEMENT_PRESETS.md`.
- TypeScript + Vitest test infrastructure, golden-snapshot characterization tests, and a
  coverage gate. Documentation suite: `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`,
  `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/MIGRATION.md`, and ADRs
  `docs/adr/0000`–`0002`.

### Security

- Secret scrubbing (`scrubText`) is applied to every model-visible string the enforcement
  layers emit — forcing messages, grader prompts, scorecards, and trajectory dumps.
- The deterministic verifier runs only allowlisted binaries, rejects shell
  metacharacters, and blocks interpreter eval flags (`node -e`, `python -c`, …).

### Notes

- Default is OFF; upgrading changes nothing until you opt in. See `docs/MIGRATION.md`.
- The bundled per-mode enforcement presets are **preliminary** (tuned from fixtures, not
  field telemetry) and are documented rather than written into `tiers.json`.
