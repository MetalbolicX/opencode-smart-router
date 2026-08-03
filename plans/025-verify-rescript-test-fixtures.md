# Plan 025: Add VerifyDoD_test.res + VerifyDispatch_test.res parity fixtures (REQ-CORE-104 strict)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9c744be..HEAD -- src/verify/VerifyDoD.res src/verify/VerifyDoD.resi src/verify/VerifyDispatchCore.res src/verify/VerifyDispatchCore.resi`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 023 (Guard fix should land first so the integration
  suite that informs these fixtures is green; not a code dependency — only a
  test-hygiene ordering)
- **Category**: tests
- **Planned at**: commit `9c744be`, 2026-08-03

## Why this matters

The SDD change `rescript-migration-phase4-5` REQ-CORE-104 specified that the
Verify helpers port to ReScript and that "rescript-test runs the parity
suite". The WU-5 implementation ported `VerifyDoD` and `VerifyDispatchCore`
to ReScript, but the dedicated `*_test.res` parity fixtures were deferred —
all coverage today runs through the TS adapter layer:

- `test/unit/gate.test.ts` — `normalizeDoD`
- `test/integration/modeB-e2e.test.ts` — `parseDoDFromAnnotation`,
  `parseDoDFromDispatch`
- `test/unit/plugin-delegate.test.ts` — `tierModel` via `dispatch-io.ts`

That is *functionally* sufficient (the public ABI is exercised), but it does
NOT satisfy the spec's "rescript-test runs the parity suite" wording, and it
leaves five pure-logic functions with NO direct test coverage:

- `summarizeDispatch` (VerifyDoD)
- `parseAcceptanceBlock` (VerifyDoD)
- `inferDoD` (VerifyDoD)
- `buildDelegationDoD` (VerifyDispatchCore)
- `shouldVerifyTask` (VerifyDispatchCore)

This plan adds the two `*_test.res` files so REQ-CORE-104 is met strictly and
the five uncovered functions get parity fixtures mirroring the TS adapter
assertions. The migration's archive report (engram #3980, S1) tracks this as
the top follow-up.

## Current state

### The two modules to test

**`src/verify/VerifyDoD.resi`** — public API (57 lines). Exported:

- Types — `checkKind` (variant: `#run | #fileExists | #schemaMatch | #testsPass | #buildPasses | #lintClean`),
  `check` (record), `dodKind` (variant: `#deterministic | #checker | #none`),
  `dodSource` (variant: `#explicit | #inferred | #annotation | #none`), `dod`
  (record), `inferHints` (record).
- Core functions (8): `summarizeDispatch: string => string`,
  `normalizeDoD: dod => dod`, `parseAcceptanceBlock: (string, dodSource) => Nullable.t<dod>`,
  `parseDoDFromDispatch: string => Nullable.t<dod>`,
  `parseDoDFromAnnotation: string => Nullable.t<dod>`,
  `inferDoD: (string, string, inferHints) => dod`,
  `isCheckable: dod => bool`.
- Accessors (10): `getCheckCommand`, `getCheckExpect`, `getCheckPath`,
  `getCheckSchema`, `getCheckKind`, `getDodDeliverable`, `getDodKind`,
  `getDodChecks`, `getDodCriteria`, `getDodSource`.

**`src/verify/VerifyDispatchCore.resi`** — public API (56 lines). Exported:

- Types — `changedFile`, `changedFileStore` (opaque), `parsedTaskResult`,
  `tierModelResult`, `escalationHint`, `delegationArgs`, `protocolTierConfig`.
- Functions (7+): `extractChangedFile: (string, JSON.t) => Nullable.t<changedFile>`,
  `createChangedFileStore: unit => changedFileStore`,
  `parseTaskResult: JSON.t => parsedTaskResult`,
  `buildDelegationDoD: (delegationArgs, VerifyDoD.inferHints) => VerifyDoD.dod`,
  `tierModel: (protocolTierConfig, string) => Nullable.t<tierModelResult>`,
  `shouldVerifyTask: (string, string, Nullable.t<string>) => bool`,
  `buildForcingNote: (array<string>, Nullable.t<escalationHint>) => string`,
  `buildAcceptedSuffix: string => string`.

### The exemplar pattern — `src/router/Protocol_test.res`

The repo's existing `*_test.res` fixtures follow this shape:

```rescript
open Test

let assertionEqual = (~operator: string, expected: string, actual: string): unit =>
  assertion(~operator, (a, b) => a === b, actual, expected)

let assertionTrue = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === true, actual, true)

test("getActiveTiers: returns the active preset's tiers", () => {
  let tiers = Protocol.getActiveTiers(Protocol.tierConfigFromDict(minimalCfg))
  assertionEqual(~operator="key count", "only", Array.getUnsafe(Dict.keysToArray(tiers), 0))
})
```

Key conventions (match exactly):

- First line: `open Test`.
- Private assertion helpers wrapping `Test.assertion` with a `~operator: string`
  label (used by the rescript-test reporter).
- JSON fixtures: typed via `%raw(\`{...}\`)` for inline JS object literals, or
  build via `JSON.Encode.*`. The user's prior directive ("eliminate %raw from
  CORE") applies to source modules under `src/`; test files are EXPECTED to
  keep `%raw` for fixture literals — it is the idiomatic ReScript pattern for
  test data and is not "core". The Protocol_test.res exemplar uses `%raw(`{...}`)
  for fixture dicts; follow that.
- Flat `test("name", () => { ... })` blocks — **no `describe` wrapper**.
- Module called directly with the module name prefix (`VerifyDoD.normalizeDoD(...)`).
- File naming: `<Module>_test.res` placed next to the module
  (`src/verify/VerifyDoD_test.res`, `src/verify/VerifyDispatchCore_test.res`).

### What the existing TS adapter tests already cover (the cases to mirror)

- `test/unit/gate.test.ts` (373 lines) — PASS / FAIL gates via `normalizeDoD`,
  deterministic checks, checker deps, registry mutex, missing artefacts,
  redundant reads, unmet DoD, deterministic file checks.
- `test/integration/modeB-e2e.test.ts` (193 lines) — Mode B plan-annotation:
  plan task with `[acceptance]` block accepted first try;
  `fast → light → light` escalation; annotation vs dispatch DoD
  convergence (GA-5 single path). Uses `parseDoDFromAnnotation`,
  `parseDoDFromDispatch`.
- `test/unit/plugin-delegate.test.ts` (2521 lines) — `tierModel` null
  fail-fast, nonretryable errors, error toast on guard fail-fast, malformed
  tier model.

### Repo conventions to match

- Test file location: directly inside the package, e.g.
  `src/verify/VerifyDoD_test.res` — NOT under a separate `test/` tree. The
  `rescript.json` `sources` array has `{"dir": "src", "subdirs": true}`, so
  `src/verify/` files are auto-compiled and picked up by
  `pnpm run test:res` (which runs `retest 'src/**/*_test.res.mjs'`).
- ReScript 12 in-source ESM (`suffix: ".res.mjs"`); the test file compiles to
  `VerifyDoD_test.res.mjs` and is executed by `retest`.
- `package.json:18` — `"test:res": "retest 'src/**/*_test.res.mjs'"`. There is
  no separate jest config.
- No new exports in the `.resi` files. The tests are private; just place the
  files under `src/verify/` — `rescript.json` auto-includes them.

### Documented design constraints to honor

- Parity rule (from WU-5 design, engram #3966): the ReScript `_test.res`
  fixtures must exercise the same scenarios as the TS adapter vitest on
  IDENTICAL fixtures, so that parity is provable at the rescript-test layer
  (the spec wording "rescript-test runs the parity suite").
- The five currently-uncovered functions (`summarizeDispatch`,
  `parseAcceptanceBlock`, `inferDoD`, `buildDelegationDoD`,
  `shouldVerifyTask`) must each have at least: one happy-path test and one
  edge case (empty/missing/null input). The archive report S1 estimated
  ~50 tests across both files; that is the capacity target, not a strict
  minimum — aim for ~25 per file.

## Commands you will need

| Purpose            | Command                                                      | Expected on success                                |
|--------------------|-------------------------------------------------------------|----------------------------------------------------|
| Install            | `pnpm install`                                              | exit 0                                             |
| ReScript build     | `pnpm run res:build`                                        | exit 0; new test files compile to `.res.mjs`       |
| Typecheck          | `pnpm run typecheck`                                        | exit 0, no errors                                  |
| New parity tests   | `pnpm run test:res -- src/verify/VerifyDoD_test.res.mjs src/verify/VerifyDispatchCore_test.res.mjs` | all pass                            |
| Full rescript-test | `pnpm run test:res`                                          | increases from 416 → 416 + N (where N = new tests) |
| Full vitest        | `pnpm test`                                                  | unchanged — these tests add no vitest cases        |
| Build              | `pnpm run build`                                            | exit 0                                             |

## Suggested executor toolkit

- Reference the exemplar `src/router/Protocol_test.res` (566 lines, 40+ flat
  `test()` blocks) for the assertion-helper and fixture patterns.
- Open `src/verify/VerifyDoD.resi` and `src/verify/VerifyDispatchCore.resi`
  to read the full signatures (57 and 56 lines respectively) before writing
  calls; `Nullable.t<dod>` returns need `Nullable.toOption` or
  `Nullable.getOpt` to pattern-match, exactly as the TS adapter does with
  null-check helpers.
- Use `JSON.Encode.object_` / `Dict.fromArray` to build `protocolTierConfig`
  fixtures for `tierModel`/`buildDelegationDoD`, or `%raw(\`{...}\`)` for
  flat object literals — both idiomatic; `%raw` matches Protocol_test.res.

## Scope

**In scope** (the only files you should create):
- `src/verify/VerifyDoD_test.res` — parity fixtures for `VerifyDoD`'s 8 core
  functions. Focus on the 5 currently-uncovered functions plus mirror
  assertions for `parseDoDFromAnnotation` / `parseDoDFromDispatch` /
  `normalizeDoD` that `gate.test.ts` and `modeB-e2e.test.ts` already cover
  via vitest.
- `src/verify/VerifyDispatchCore_test.res` — parity fixtures for the 7+
  exported functions, focusing on `buildDelegationDoD` and
  `shouldVerifyTask` (no direct TS test today), and mirroring `tierModel` /
  `buildForcingNote` coverage from `plugin-delegate.test.ts`.
- `src/verify/VerifyDoD_test.res.mjs` and
  `src/verify/VerifyDispatchCore_test.res.mjs` — regenerated by
  `pnpm run res:build`. Do NOT hand-edit; treat as verification artifacts.

**Out of scope** (do NOT touch, even though they look related):
- `src/verify/VerifyDoD.res`, `.resi` — the implementation is correct; only
  test coverage is missing.
- `src/verify/VerifyDispatchCore.res`, `.resi` — same.
- `src/verify/dispatch-io.ts` — the TS adapter that wraps the ReScript
  modules for the SDK. Its vitest coverage is the *second* line of defense
  and stays in TS.
- `src/types/rescript-modules.d.ts` — no new module declaration is needed;
  test files have no public ABI surface.
- `test/unit/deterministic.test.ts` and `test/integration/modeB-e2e.test.ts`
  — do NOT weaken or remove existing TS adapter assertions to "avoid
  duplication". The TS layer stays as is.

## Git workflow

- Branch: `advisor/025-verify-rescript-test-fixtures`
- Commit style (conventional):
  - `test(verify): add VerifyDoD_test.res parity fixtures`
  - `test(verify): add VerifyDispatchCore_test.res parity fixtures`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Write `VerifyDoD_test.res` covering the 5 uncovered functions

Create `src/verify/VerifyDoD_test.res` with:

1. The `open Test` header and private `assertionEqual` / `assertionTrue` /
   `assertionNullable` / `assertionContains` helpers, mirroring
   `Protocol_test.res:1-43`.
2. `%raw` fixture.blocks or `JSON.Encode.*` builders for:
   - `summarizeDispatch` — feed a representative dispatch text and assert
     the summary string contains the key markers. Cases: empty string,
     one-line dispatch, multi-line dispatch with `[acceptance]` block.
   - `parseAcceptanceBlock` — happy path with a well-formed
     `[acceptance] ... [/acceptance]` block; missing-close-tag returns
     `Nullable.null`; empty-block returns Nullable.dod with
     `dodKind = #none`; whitespace tolerance; mixed `check:` lines.
   - `parseDoDFromDispatch` & `parseDoDFromAnnotation` — mirror
     `modeB-e2e.test.ts:180-181`: identical inputs produce identical `dod`.
   - `inferDoD` — happy path with non-empty `inferHints`; empty hints;
     one-command-only (build OR test OR lint) hints; declaredPath present
     vs null.
   - `normalizeDoD` — mirror `gate.test.ts`'s fixture for one PASS / one
     FAIL DoD; verify the structure produced is the SAME as what the
     integration tests use.

Aim for ~25 `test()` blocks in this file. Each must include a `~operator`
label so failures are machine-classifiable.

**Verify**: `pnpm run res:build` → exit 0. Then
`pnpm run test:res -- src/verify/VerifyDoD_test.res.mjs` → all new tests pass.

### Step 2: Write `VerifyDispatchCore_test.res` covering `buildDelegationDoD` and `shouldVerifyTask`

Create `src/verify/VerifyDispatchCore_test.res` with:

1. Same `open Test` header and assertion helpers (you can copy from the
   first file or factor a tiny `VerifyTestHelpers.res` module — but prefer
   inline duplication; the repo pattern is per-file helpers, see
   Protocol_test.res).
2. Fixtures covering:
   - `buildDelegationDoD` — when `delegationArgs` has `acceptance` filled,
     the returned `VerifyDoD.dod` matches what `parseDoDFromAnnotation`
     would produce for the same string (parity assertion against
     `VerifyDoD.parseDoDFromAnnotation`). When `acceptance` is empty /
     null, the dod falls back to `inferDoD`.
   - `shouldVerifyTask` — `(prompt, description, null)` (no acceptance
     string); `(prompt, description, Some("..."))` with an empty
     acceptance block; with a populated acceptance block. Each returning
     the documented `bool` per `modeB-e2e.test.ts` semantics.
   - `tierModel` — the null fail-fast case `tierModel(cfg, "")` returns
     `Nullable.null` (mirror `plugin-delegate.test.ts`); a known-tier
     `tierModel(cfg, "fast")` returns a `tierModelResult` with the
     expected `providerID` and `modelID`.
   - `buildForcingNote` — empty hints (None) returns the empty / fallback
     string; `Some(escalationHint)` returns a string containing both the
     producerTier and the nextTier markers.
   - `buildAcceptedSuffix` — happy path; empty input.
   - `parseTaskResult` — feed a JSON object with
     `finalReturnText`/`childSessionID`/`parentSessionID` and assert the
     decoded record fields. Missing-key case returns empty strings.
   - `extractChangedFile` — feed a JSON object with `path` and `status` and
     assert `Nullable.toOption` returns `Some(changedFile)`; missing
     `path` returns `Nullable.null`.

Aim for ~25 `test()` blocks.

**Verify**: `pnpm run res:build` → exit 0. Then
`pnpm run test:res -- src/verify/VerifyDispatchCore_test.res.mjs` → all new tests pass.

### Step 3: Confirm the full rescript-test suite grew with no regressions

**Verify**: `pnpm run test:res` → the total grew from 416 to 416 + N (where
N = the count of new `test()` blocks you added). Zero failures. The full
vitest baseline in `pnpm test` is unchanged from before this plan (no TS
adapter deleted).

### Step 4: Re-confirm TS adapter coverage is intact

**Verify**: `pnpm test -- test/unit/gate.test.ts test/integration/modeB-e2e.test.ts test/unit/plugin-delegate.test.ts` → these files still pass exactly as before (or fail only on
the already-accepted baseline Failures, not on anything you touched). The new
ReScript tests are NEW parity; they do not change the TS adapter's
behaviour.

## Test plan

- These fixtures ARE the test plan. No additional vitest changes.
- Reviewer checklist (audit each new `test()` block):
  - It name-locates a real ReScript symbol (`VerifyDoD.normalizeDoD`,
    `VerifyDispatchCore.shouldVerifyTask`).
  - It uses a `~operator` label.
  - It asserts at least one positive (happy) and one negative (empty /
    null / malformed) input.
  - It does not duplicate a `Protocol_test.res` helper verbatim without
    adapting the type — `VerifyDoD.dod` is a different record from
    `Protocol.tierConfig`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/verify/VerifyDoD_test.res` exists and compiles to `.res.mjs`
- [ ] `src/verify/VerifyDispatchCore_test.res` exists and compiles to `.res.mjs`
- [ ] `pnpm run res:build` exits 0
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test:res -- src/verify/VerifyDoD_test.res.mjs` → all pass
- [ ] `pnpm run test:res -- src/verify/VerifyDispatchCore_test.res.mjs` → all pass
- [ ] `pnpm run test:res` → grew from 416 → ≥441 (at least 25 new tests per file)
- [ ] Each of the 5 previously-uncovered functions has ≥1 dedicated `test()`
      block asserting its happy path AND ≥1 edge case
- [ ] `pnpm test` → unchanged from before this plan (no vitest regression)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A `*_test.res` failure surfaces NOT in the functions under test but in the
  fixture builder (e.g. `%raw` JS object literal that produces a shape the
  ReScript side rejects). STOP and report which fixture construction
  pattern failed — do not silently weaken the assertion.
- The `VerifyDoD.resi` or `VerifyDispatchCore.resi` signatures do not match
  the excerpts in "Current state" — the modules have drifted since this plan
  was written. Treat as a STOP; the executor must inspect the live `.resi`
  rather than trust the plan's excerpts.
- `buildDelegationDoD` turns out to be a pure caller of
  `parseDoDFromAnnotation` already covered by the other fixture — STOP and
  report the duplication; the plan's parity assertions can be reduced but
  the coverage intent must be preserved.
- A rescript-test fixture triggers a parity divergence with the
  corresponding vitest assertion (same input, different result). STOP —
  that is a real ReScript bug, not a test bug; route to a new plan and do
  not paper over it.

## Maintenance notes

- Future Verify-module work that adds a public function to either `.resi`
  MUST land a parity fixture in the matching `*_test.res` in the same PR.
- The archive report at engram #3980 (warning W1 / suggestion S1) is the
  tracking document this plan closes. When this plan lands, update the
  archive-report's W1 status to "RESOLVED" and verify-report #3978's
  REQ-CORE-104 entry from "PARTIAL" to "MET".
- The TS adapter layer (`dispatch-io.ts`, `gate.test.ts`,
  `modeB-e2e.test.ts`, `plugin-delegate.test.ts`) is the second line of
  defense — it stays. The new `*_test.res` files are the FIRST line; both
  must remain green on future merges.
- This plan is independent of Plans 023 / 024 (the regression fixes) at the
  file level. It is safe to execute in any order relative to them.