# Plan 021: Rebuild Plan 020 through strict TDD

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat fa9528b..HEAD -- src/router/sessions.ts src/plugin/hooks.ts src/plugin/runtime.ts test/unit/sessions.test.ts test/unit/plugin-hooks.test.ts test/integration`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 020 (this plan redoes Plan 020 with strict TDD discipline)
- **Category**: tests
- **Planned at**: commit `fa9528b`, 2026-07-08

## Why this matters

Plan 020 fixed a real production bypass, but it was delivered in standard mode.
This retrofit makes the change auditable under strict TDD: the store layer is
proven first, the hook layer is rebuilt from failing tests, and a separate
integration test proves the real store-to-hook path. That gives us stronger
regression protection and an evidence trail for future work.

## Current state

The executor needs the current facts inline, not from prior chat:

- `src/router/sessions.ts` — currently contains the Plan 020 parent/depth model
  (`parentMap`, `depth()`, `isDescendant()`, `parentOf()`,
  `registerFromSessionCreated()`, and cleanup in `unregister`).
- `src/plugin/hooks.ts` — currently contains the Plan 020 depth guard, the
  `session.created` branch, and the reordered orchestrator `task` branch.
- `src/plugin/runtime.ts` — currently wires `event` to `handleSessionEvent`.
- `test/unit/sessions.test.ts` — currently has store tests for depth/parent
  tracking, unregister cleanup, and null-parent behavior.
- `test/unit/plugin-hooks.test.ts` — currently has hook tests for depth-based
  blocking and `session.created` extraction, but the hook layer is still
  mock-heavy.
- `plans/020-close-nested-delegation-bypass.md` — the original implementation
  plan this retrofit redoes under strict TDD.
- `plans/README.md` — already lists 020; 021 will be added below it.

Repository conventions to match:

- TypeScript + Vitest + Biome.
- Conventional commits.
- Tests should assert behavior, not internal call shape, unless the assertion is
  the only practical way to pin a branch boundary.

Known repo context:

- `pnpm typecheck` and `pnpm test` are the main gates for this area.
- `pnpm lint` currently has a pre-existing biome baseline failure unrelated to
  this retrofit; report it if it still exists, but do not expand scope just to
  chase it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Store tests | `pnpm test -- test/unit/sessions.test.ts` | all pass |
| Hook tests | `pnpm test -- test/unit/plugin-hooks.test.ts` | all pass |
| Integration test | `pnpm test -- test/integration/nested-delegation-guard.test.ts` | all pass |
| Full tests | `pnpm test` | all pass |
| Lint | `pnpm lint` | exit 0 if the baseline is clean; otherwise report the known baseline failure |

## Suggested executor toolkit

- Use `work-unit-commits` if you split the redo into separate commits for store,
  hooks/runtime, and tests.
- Use the existing repo Vitest patterns as the model for all new tests.

## Scope

**In scope** (the only files you should modify):

- `src/router/sessions.ts`
- `src/plugin/hooks.ts`
- `src/plugin/runtime.ts`
- `test/unit/sessions.test.ts`
- `test/unit/plugin-hooks.test.ts`
- `test/integration/nested-delegation-guard.test.ts` (new)
- `plans/README.md`

**Out of scope** (do NOT touch):

- `src/verify/dispatch.ts` — its `unregister(sid)` call must keep working
  unchanged.
- Any unrelated Biome baseline cleanup.
- Public response shapes or unrelated router features.

## Git workflow

- Branch: `advisor/021-strict-tdd-020-retrofit`
- Commit per logical unit: store RED/GREEN, hooks RED/GREEN, integration test,
  refactor/docs.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 0: Safety net and baseline

1. Capture the current working tree state so the Plan 020 implementation can be
   restored if needed.
2. Confirm the current 020 tree still passes the targeted tests and typecheck.
3. Revert the implementation files back to the `fa9528b` baseline for the redo.
   Keep this plan file and `plans/README.md` in place.

**Verify**:
- `pnpm test -- test/unit/sessions.test.ts test/unit/plugin-hooks.test.ts`
  → pass on the current tree before the revert.
- `git diff --stat fa9528b..HEAD -- src/router/sessions.ts src/plugin/hooks.ts src/plugin/runtime.ts test/unit/sessions.test.ts test/unit/plugin-hooks.test.ts test/integration`
  → shows only the Plan 020 surface area.

### Step 1: RED — store layer first

Edit `test/unit/sessions.test.ts` before touching `src/router/sessions.ts`.
Write tests for the store behavior that Plan 020 introduced:

- `depth("root") === 0`
- `depth("child") === 1` after `registerFromSessionCreated("child", "root")`
- `depth("grandchild") === 2`
- `parentOf()` returns the expected parent or `null`
- `isDescendant()` mirrors `depth() >= 1`
- `unregister()` removes parent edges and resets depth to 0
- null-parent root sessions are not subagents
- cycle guard terminates defensively

Do not implement the store yet. The tests must fail for the right reason
(`depth`/`parentOf`/`registerFromSessionCreated` are missing or incomplete).

**Verify**: `pnpm test -- test/unit/sessions.test.ts` → new tests fail for the
missing store API, and no unrelated test failures are introduced.

### Step 2: GREEN — store implementation

Edit `src/router/sessions.ts` only enough to satisfy the store tests:

- add parent tracking
- add `registerFromSessionCreated()`
- add `depth()`, `parentOf()`, `isDescendant()`
- extend `unregister()` to clean parent edges
- keep `registerFromChatMessage()` and producer-session behavior intact

**Verify**: `pnpm test -- test/unit/sessions.test.ts` → all pass.

### Step 3: RED — hook layer tests, plus one integration test

Keep the hook unit tests mock-based for branch coverage, but add a separate
integration test file for the real store-to-hook path.

Write failing tests first:

#### Unit tests (`test/unit/plugin-hooks.test.ts`)

- `session.created` registers a child from `event.properties.info.parentID`
- `session.created` ignores non-created events
- `properties.parentID` is ignored if `properties.info.parentID` is absent
- depth-1 `task` is blocked with the new nested-delegation error
- depth-1 `delegate` is blocked with the same error
- depth-0 `task` still reaches the orchestrator path
- depth-0 `delegate` is allowed
- the depth guard runs before the reasoning-patch branch
- registration failure is best-effort and does not crash the session
- `session.idle` still works

#### Integration test (`test/integration/nested-delegation-guard.test.ts`)

- Use the real `createSessionStore()`.
- Drive `session.created` first.
- Then call `handleToolExecuteBefore()` with the registered child and verify
  the depth-based guard blocks `task`/`delegate` while allowing read-only tools.

Keep the existing Plan 008/012 regression tests aligned with the new contract;
they should fail until the implementation is redone.

**Verify**:
- `pnpm test -- test/unit/plugin-hooks.test.ts` → new tests fail for missing
  behavior, not setup mistakes.
- `pnpm test -- test/integration/nested-delegation-guard.test.ts` → fails until
  hooks/runtime are reimplemented.

### Step 4: GREEN — hook + runtime implementation

Edit `src/plugin/hooks.ts` and `src/plugin/runtime.ts` only enough to satisfy
the hook tests and integration test:

- add `session.created` handling through `handleSessionEvent`
- read `event.properties.info.parentID`
- keep the handler best-effort
- block descendant `task` and `delegate` before the orchestrator reasoning
  branch
- preserve depth-0 orchestrator behavior
- wire the renamed event handler in `runtime.ts`

**Verify**:
- `pnpm test -- test/unit/plugin-hooks.test.ts test/integration/nested-delegation-guard.test.ts`
  → all pass.

### Step 5: REFACTOR

Refactor only after the GREEN state is stable.

Suggested cleanup:

- extract the `info.parentID` parsing into a tiny helper
- simplify comments that were only needed while the implementation was in flux
- keep behavior unchanged

Run the targeted tests after each refactor change.

**Verify**: rerun the targeted unit + integration tests → still pass.

### Step 6: Final repo sync

1. Update `plans/README.md` with row 021 and its dependency on 020.
2. Mark 021 `DONE` only when the targeted tests and `pnpm typecheck` are green.
3. Run the full verification suite.

**Verify**:
- `pnpm typecheck` → exit 0
- `pnpm test` → all pass
- `pnpm lint` → report the known baseline failure if it still exists; do not
  expand scope unless the team explicitly wants that work

## Test plan

- Store tests: depth, parent tracking, unregister cleanup, null-parent root,
  lazy cap init, cycle guard.
- Hook tests: `session.created` registration, new nested-delegation error,
  depth-0 allowance, reasoning-branch ordering, best-effort error handling,
  `session.idle` regression.
- Integration test: real store + handler wiring from `session.created` through
  `handleToolExecuteBefore()`.

Structural pattern:

- `test/unit/sessions.test.ts` for store assertions
- `test/unit/plugin-hooks.test.ts` for hook branch assertions
- `test/unit/verify-dispatch.test.ts` for test harness style

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/router/sessions.ts` exposes the depth/parent API and cleanup
- [ ] `src/plugin/hooks.ts` handles `session.created` and blocks descendants at
      depth ≥ 1 before the orchestrator branch
- [ ] `src/plugin/runtime.ts` wires the renamed event handler
- [ ] `test/unit/sessions.test.ts` passes with the store behavior covered
- [ ] `test/unit/plugin-hooks.test.ts` passes with the hook behavior covered
- [ ] `test/integration/nested-delegation-guard.test.ts` exists and passes
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `plans/README.md` row 021 is `DONE`

## STOP conditions

Stop and report back (do not improvise) if:

- The current tree cannot be cleanly reverted to the `fa9528b` baseline without
  touching unrelated files.
- The integration test cannot prove the store-to-hook path without broader
  runtime changes.
- A verification command fails twice after a reasonable fix attempt.
- The Biome failure turns out to be caused by this retrofit instead of the known
  baseline issue.
- You discover a requirement conflict with the strict-TDD rules or the
  repository conventions.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Plan 020 remains the production fix; Plan 021 is the process retrofit that
  proves it under strict TDD.
- The hook unit tests are intentionally mock-based; the new integration test is
  what proves the real wiring.
- If the session event payload shape changes in the SDK, the helper for
  `info.parentID` is the single place to revisit.
- Reviewers should check that the integration test exercises the real store,
  not just the unit mocks.
