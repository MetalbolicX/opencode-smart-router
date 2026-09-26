# Plan 045: Make fanout workers true depth-2 children

> **Executor instructions**: Follow this plan step by step using strict
> RED -> GREEN -> REFACTOR TDD. Run every verification command and confirm
> the expected result before moving on. If any STOP condition occurs, stop
> and report; do not improvise. Do not implement asynchronous/background
> fanout as part of this plan.
>
> **Drift check (run first)**:
> `git diff --stat c91b875..HEAD -- src/plugin/fanout.ts src/plugin/runtime.ts config/tiers/prompts.json tiers.json test/unit/plugin-fanout.test.ts test/unit/sessions.test.ts test/integration/nested-delegation-guard.test.ts openspec/specs/tier-fanout/spec.md README.md docs/CONFIG_REFERENCE.md`
>
> If any in-scope file changed since this plan was written, compare the
> current-state excerpts below against live code. A semantic mismatch is a
> STOP condition. Plan artifacts are deliberately omitted from this command:
> `plans/045-fanout-tree.md` did not exist at the baseline, and its index row
> was created with it.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: Plan 044 completed and runtime-proven
- **Category**: direction
- **Planned at**: commit `c91b875`, 2026-09-14
- **Delivery**: strict TDD in one reviewable PR; no full SDD cycle

## Why this matters

Plan 044 gave a depth-1 medium/focused/heavy child an optional synchronous
`fanout` tool, but flattened every worker into a sibling under the root
session. That protects lifecycle safety, but it does not represent the
intended ownership tree: a child that requests exploration should own those
depth-2 workers and receive their aggregate before continuing.

This change makes that logical ownership structural: `root -> caller ->
workers`. It preserves the mechanisms that actually bound hangs -- explicit
create, worker, batch, and abort deadlines; cleanup; counters; circuit breaker;
and recursion guards. It does not use native nested `task`, which remains
blocked because OpenCode v1.18.30 provides no independent foreground Task
timeout and can retain child sessions after abort.

The feature remains optional. A child calls `fanout` only when bounded,
lower-value exploration is useful; otherwise it completes the work itself.

## Locked decisions

- Fanout workers are true children of the depth-1 caller and therefore depth 2.
- Depth 2 is a hard ceiling: no depth-2 session may create another session.
- Tier policy remains unchanged:
  - medium callers may request fast workers only;
  - focused/heavy callers may request fast/light/medium workers;
  - fast/light callers cannot fan out.
- Fanout remains synchronous. The child waits for the ordered aggregate or a
  bounded timeout before its next model turn.
- Usage remains discretionary and prompt-guided, never mandatory.
- Existing deadlines, cancellation, cleanup, breaker, caps, aggregation, and
  telemetry semantics remain unchanged.
- Async fire-and-collect, higher-tier escalation by children, worker-to-worker
  communication, acceptance grading, telemetry persistence, publishing, and
  versioning are outside this plan.

## Current state

### Runtime parent selection

`src/plugin/fanout.ts:172-178` already admits only depth-1 callers:

```ts
const depth = ctx.sessionStore.depth(callerSid);
if (depth !== 1) {
  log.warn({ event: "fanout.batch_rejected", reason: "depth_not_1" });
  return formatRejectedAggregate(`depth ${depth} !== 1; fanout requires depth-1 caller`);
}
```

`src/plugin/fanout.ts:231-238` currently resolves the caller's root parent only
to flatten workers:

```ts
const rootSid = ctx.sessionStore.parentOf(callerSid);
if (!rootSid) {
  log.warn({ event: "fanout.batch_rejected", reason: "caller_is_root" });
  return formatRejectedAggregate(
    "caller is root session; fanout workers require a parent session",
  );
}
```

`src/plugin/fanout.ts:344-350` then creates root-parented siblings:

```ts
// 1. Create session with root as parent (NOT callerSid -- no grandchild invariant)
const created = await withTimeout(
  ctx.plugin.client.session.create({
    body: { parentID: rootSid },
```

The depth-1 admission gate makes the `rootSid` lookup and the second
caller-is-root rejection redundant after caller-parenting is introduced.

### Existing depth and recursion controls

`src/router/sessions.ts:177-184` computes arbitrary depth by walking parent
links; no store redesign is needed:

```ts
const computeDepth = (sid: string, visited: Set<string> = new Set()): number => {
  if (visited.has(sid)) return 0;
  const parent = parentMap.get(sid);
  if (!parent) return 0;
  visited.add(sid);
  return computeDepth(parent, visited) + 1;
};
```

`src/plugin/hooks/tool-guards.ts:75-81` blocks native `task` and `delegate`
for descendants. `executeFanout` independently rejects callers whose depth is
not 1 and rejects sessions marked as fanout workers. Keep all three controls;
their overlap is intentional defense in depth.

### Public wording and specification

`src/plugin/runtime.ts:44-45` currently describes workers as root siblings:

```ts
const FANOUT_DESCRIPTION =
  "Delegate a batch of bounded lower-tier worker tasks in parallel from a depth-1 medium/focused/heavy caller. Workers are root-session siblings (never nested under the caller). Caller tier policy: medium->fast; focused/heavy->fast|light|medium. fast/light cannot call this tool. The plugin owns deadlines, cancellation, and cleanup.";
```

The medium/focused/heavy entries in `config/tiers/prompts.json` say:

```text
Workers run in parallel as siblings under your parent session.
```

`openspec/specs/tier-fanout/spec.md:5,23-30` explicitly specifies no
physical grandchildren and root-parented siblings. `README.md:904` repeats
the same contract. These are contract changes, not optional documentation
cleanup.

### Verification baseline

At planned commit `c91b875`:

- `pnpm run typecheck` passes.
- The full suite has one documented pre-existing failure only:
  `test/unit/packaging.test.ts` throws `TypeError: parsed.flatMap is not a
  function` in the npm-pack allowlist case.
- The acceptance gate is therefore **no new failures versus this baseline**,
  not unconditional `pnpm test` exit 0.
- Plan 044's root-parented runtime probe passed. It does not prove the new
  depth-2 parent relationship; this plan requires a new live probe.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat c91b875..HEAD -- <in-scope paths>` | no semantic drift before work |
| Generate tiers | `pnpm run build:tiers` | exit 0; `tiers.json` regenerated from `config/tiers/` |
| Targeted tests | `pnpm exec vitest run test/unit/plugin-fanout.test.ts test/unit/sessions.test.ts test/integration/nested-delegation-guard.test.ts` | exit 0; all selected tests pass |
| Typecheck | `pnpm run typecheck` | exit 0, no diagnostics |
| Lint | `pnpm run lint` | exit 0, no new diagnostics |
| Full tests | `pnpm test` | no failures except the documented packaging baseline |
| Diff hygiene | `git diff --check` | exit 0 |

Do not run a formatter over unrelated files. Plan 044 showed that Biome can
inflate fixture diffs substantially; format only files touched by this plan.

## Scope

**In scope** -- modify only when required by a step:

- `src/plugin/fanout.ts` -- worker parent selection and obsolete root-parent block.
- `src/plugin/runtime.ts` -- tool description.
- `config/tiers/prompts.json` -- source tier prompts.
- `tiers.json` -- generated output from `pnpm run build:tiers`.
- `test/unit/plugin-fanout.test.ts` -- executor behavior and parent assertions.
- `test/unit/sessions.test.ts` -- depth-2 parent/depth behavior.
- `test/integration/nested-delegation-guard.test.ts` -- end-to-end depth ceiling.
- `openspec/specs/tier-fanout/spec.md` -- promoted contract amendment.
- `README.md` -- user-facing hierarchy description.
- `docs/CONFIG_REFERENCE.md` -- only if a live search finds root/sibling wording.
- `openspec/changes/archive/2026-09-14-tier-fanout-tool/045-tree-runtime-probe.md`
  -- live probe evidence, created after implementation.
- `plans/README.md` -- status only.
- `plans/045-fanout-tree.md` -- read-only execution instructions; do not
  annotate or rewrite it during implementation.

**Temporary probe-only files outside the repository**:

- `~/.config/opencode/opencode.json`
- `~/.config/opencode-smart-router/tiers.json`

Back up and restore both in the probe step. Never commit their contents.

**Out of scope** -- do not touch even if related:

- `src/plugin/fanout-store.ts` -- caps/breaker are parent-agnostic.
- `src/plugin/hooks/tool-guards.ts` -- existing descendant protection is correct.
- `src/router/sessions.ts` -- implementation already supports arbitrary depth;
  tests may change, production code should not.
- Archived Plan 044 specifications/reports, except the new standalone probe
  evidence file named above.
- Native OpenCode `task` behavior or `subagent_depth` configuration.
- Async/background fanout, status/collect tools, detached batches, or polling.
- Worker-to-worker communication or dependent task graphs.
- Tier allowlist changes, especially medium-to-heavy escalation.
- Fanout acceptance grading or telemetry persistence.
- Publishing and version changes.

## Git workflow

- Branch: `advisor/045-fanout-tree`.
- Use a new work-unit/ledger label; Plan 044 is already settled.
- Prefer one reviewable PR under 450 changed lines. If tests and generated
  prompt output exceed the budget, split into two dependent work units:
  1. contract + RED tests;
  2. implementation + generated prompts + runtime evidence.
- Use conventional commits matching history, for example:
  - `test(plugin): specify caller-parented fanout workers`
  - `feat(plugin): parent fanout workers to the caller`
  - `docs(fanout): describe the depth-2 worker tree`
- Keep tests with the behavior they prove when possible.
- Do not push or open a PR unless the operator explicitly requests it.

## Steps

### Step 1: Establish the strict-TDD RED baseline

Before changing production code, update tests to describe the new contract.

In `test/unit/plugin-fanout.test.ts`:

1. Locate every assertion for `client.session.create` parentage.
2. Change the expected `parentID` from the root session ID to the depth-1
   `callerSid`.
3. Replace any test expecting `caller_is_root` after a successful depth lookup;
   root callers should already reject through `depth_not_1`, with zero SDK calls.
4. Preserve all deadline, ordering, abort, cleanup, breaker, and per-tier
   assertions byte-for-byte unless parentage makes an expectation obsolete.
5. Add or strengthen a case proving a depth-2/fanout-worker caller is rejected
   before `session.create` and `session.prompt`.

In `test/unit/sessions.test.ts`:

1. Register a depth-1 caller with `parentID = rootSid`.
2. Register a worker with `parentID = callerSid`.
3. Assert `parentOf(workerSid) === callerSid` and `depth(workerSid) === 2`.
4. Assert the existing cycle guard and cache invalidation still behave.

In `test/integration/nested-delegation-guard.test.ts`:

1. Replace the old flattening assertion (workers never use caller parentage)
   with the tree invariant: workers are caller-parented at depth 2.
2. Assert a depth-2 worker cannot execute native `task` or `delegate`.
3. Assert a depth-2 worker cannot invoke `fanout` and no depth-3
   `session.create` occurs.
4. Do not weaken the existing native nested-delegation guard.

**Verify RED**:

`pnpm exec vitest run test/unit/plugin-fanout.test.ts test/unit/sessions.test.ts test/integration/nested-delegation-guard.test.ts`

Expected: only new/changed parentage assertions fail against the flattened
implementation. If unrelated deadline, cleanup, breaker, or guard tests fail,
STOP and report rather than changing production code.

### Step 2: Amend the promoted specification

Update `openspec/specs/tier-fanout/spec.md` directly; do not rewrite Plan 044's
historical archive.

Required contract edits:

1. Purpose: replace "without physical grandchildren" with bounded
   child-initiated work whose workers are depth-2 children and terminal leaves.
2. Rename `Parallel Root-Parented Workers` to `Parallel Caller-Parented Workers`.
3. Require `parentID = callerSid`, correct tier model/agent, parallel overlap,
   and unchanged native task/delegate guards.
4. Rename `Overlapping siblings` to `Overlapping children`; require both
   prompts to start in caller-parented depth-2 sessions, never root-parented.
5. Add an explicit hard-depth scenario:
   - GIVEN a depth-2 fanout worker;
   - WHEN it attempts `fanout`, `task`, or `delegate`;
   - THEN it is rejected before any SDK session creation and depth 3 never exists.
6. Leave bounded aggregation, cancellation, cleanup, visibility, statuses, and
   no-session-delete requirements unchanged.

**Verify**:

`grep -nE 'Root-Parented|root-parented|without physical grandchildren|Overlapping siblings' openspec/specs/tier-fanout/spec.md`

Expected: no matches. Then manually confirm `Caller-Parented`, `depth 2`, and
the hard-depth scenario exist.

### Step 3: Implement caller-parented workers

In `src/plugin/fanout.ts`:

1. Keep the `depth !== 1` admission gate unchanged.
2. Keep tier allowlists, producer/grader exclusions, and
   `isFanoutWorker(callerSid)` rejection unchanged.
3. Remove the now-unused `rootSid = parentOf(callerSid)` lookup and the redundant
   `caller_is_root` block. The depth gate already rejects root callers.
4. Create each worker with `body: { parentID: callerSid }`.
5. Rewrite the nearby comment to state the new invariant: workers are depth-2
   children of the caller and terminal leaves.
6. Do not alter create/prompt/batch/abort timeout values, cleanup order,
   aggregate shape, breaker accounting, or counter release.

In `src/plugin/runtime.ts`, update `FANOUT_DESCRIPTION` to say workers are
child sessions of the caller at depth 2 and cannot spawn further sessions.
Keep caller/worker tier policy and lifecycle ownership wording unchanged.

**Verify GREEN**:

`pnpm exec vitest run test/unit/plugin-fanout.test.ts test/unit/sessions.test.ts test/integration/nested-delegation-guard.test.ts`

Expected: exit 0; all selected tests pass.

Then run:

`grep -nE 'rootSid|root-session siblings|siblings of the caller|root as parent' src/plugin/fanout.ts src/plugin/runtime.ts`

Expected: no matches.

### Step 4: Align prompts and generated configuration

In the medium/focused/heavy prompt strings in
`config/tiers/prompts.json`, replace:

```text
Workers run in parallel as siblings under your parent session.
```

with wording equivalent to:

```text
Workers run in parallel as your child sessions at depth 2 and cannot spawn
further sessions.
```

Add concise synchronous pipelining guidance without implying overlap:

```text
Prefer small focused batches over one large batch. Use each returned aggregate
to continue your own work or decide whether another batch is needed.
```

Do not tell the child it can continue while a batch is running; the tool is
synchronous. Keep fast/light prompts explicitly unable to fan out.

Run `pnpm run build:tiers` to regenerate `tiers.json`. Do not hand-edit the
generated output.

**Verify**:

`pnpm run build:tiers && grep -n 'siblings under your parent session' config/tiers/prompts.json tiers.json`

Expected: build exits 0; grep returns no matches. Confirm the caller-child and
small-batch wording appears in both source and generated files.

### Step 5: Align user-facing documentation

Update `README.md` around the fanout section (currently near line 904):

- replace "parallel sibling workers under its own parent session" with
  caller-owned depth-2 children;
- remove "depth-1 children of the orchestrator (never grandchildren)";
- state that workers are terminal leaves and cannot invoke `task`, `delegate`,
  or `fanout`;
- retain optional/discretionary use, synchronous aggregate behavior, tier
  policy, and bounded cleanup language.

Search `docs/CONFIG_REFERENCE.md`; edit it only if live wording asserts
root-parented/sibling workers.

**Verify**:

`grep -nEi 'root-parented|root-session sibling|parallel sibling|never grandchildren' README.md docs/CONFIG_REFERENCE.md src/plugin/fanout.ts src/plugin/runtime.ts config/tiers/prompts.json openspec/specs/tier-fanout/spec.md`

Expected: no current-contract matches. Historical files under
`openspec/changes/archive/` are intentionally excluded.

### Step 6: Run static and automated gates

Run all gates; do not settle based on targeted tests alone:

1. `pnpm run typecheck` -- must exit 0.
2. `pnpm run lint` -- must exit 0 with no new diagnostics.
3. `pnpm test` -- must introduce no failure beyond the existing
   `test/unit/packaging.test.ts` `parsed.flatMap` baseline failure.
4. `git diff --check` -- must exit 0.
5. `git status --short` -- only in-scope files may appear.

If either typecheck or lint fails, fix it before the runtime probe. Plan 044
demonstrated that a green test suite alone did not catch type and formatting
regressions.

### Step 7: Execute the live depth-2 STOP-gated probe

This step is mandatory before merge because the old live probe proved only
root-parented workers. The historical native-Task hang involved a child
session creating descendants; SDK-created depth-2 sessions must be proven,
not assumed.

Preparation:

1. Ensure `advisor/045-fanout-tree` is the checkout loaded by the local plugin.
2. Back up `~/.config/opencode/opencode.json` and
   `~/.config/opencode-smart-router/tiers.json` with clearly named temporary
   probe backups.
3. Temporarily load this checkout via
   `file:///home/metalbolicx/Documents/opencode-smart-router` in the OpenCode
   plugin list.
4. Temporarily set `fanout.enabled: true` in the global router configuration.
5. Validate both JSON files parse, then restart OpenCode.

From the fresh root session, invoke the runtime's Task tool directly with:

```text
description: Run tree fanout probe
subagent_type: medium
```

Use this complete child prompt:

```text
Invoke the plugin-owned fanout tool directly with two fast items. Each worker
must return one distinct fixed token. Return the raw fanout aggregate verbatim.
Do not simulate fanout or use native Task from the child.
```

The root must explicitly select `subagent_type: medium`; do not rely on
automatic routing. If the root runtime does not expose the Task tool or cannot
select a medium child, STOP and report instead of substituting another path.

Capture evidence in
`openspec/changes/archive/2026-09-14-tier-fanout-tool/045-tree-runtime-probe.md`:

- root, medium-caller, and both worker session IDs;
- raw aggregate showing two completed fast workers;
- elapsed time and confirmation that the call returned within the batch bound;
- OpenCode log records showing `root -> medium caller -> fast workers`;
- worker `parentID` values equal the medium caller, never the root;
- no session created with a worker as parent (no depth 3);
- no timeout, abort failure, unreconciled worker, or TUI focus jump observed.

Restore both temporary configuration files and validate their JSON before
ending the probe session. A further restart may be required for restoration
to take effect.

**Verify**: evidence file contains an explicit `PASS` for both caller-parented
session creation and no-depth-3 containment.

**STOP gate**: any hang, missing tool, depth-3 session, incorrect parentID,
unbounded response, cleanup failure, or TUI focus jump is a FAIL. Do not merge;
preserve raw evidence and report.

### Step 8: Final review and status update

Review the diff against the locked decisions. Ensure it changes structural
parentage only and preserves synchronous lifecycle behavior.

Run the targeted tests, typecheck, lint, full baseline comparison, and
`git diff --check` once more after recording probe evidence. Update Plan 045's
row in `plans/README.md` only when every gate and the live probe pass.

**Verify**:

`git diff --name-only c91b875..HEAD`

Expected: only files listed in Scope, plus commit metadata outside the diff.

## Test plan

Model additions after the existing mock/seam patterns in
`test/unit/plugin-fanout.test.ts`; do not add a second executor harness.

Required behavior coverage:

- eligible depth-1 medium caller creates fast workers with
  `parentID = callerSid`;
- eligible focused/heavy callers preserve current allowed worker tiers;
- root caller rejects before SDK calls through `depth_not_1`;
- depth-2 fanout worker rejects `fanout` before SDK calls;
- depth-2 descendants remain blocked from native `task` and `delegate`;
- session store computes and invalidates depth 2 correctly;
- two caller-parented workers overlap and preserve ordered aggregation;
- create timeout, worker timeout, batch timeout, cancellation, cleanup abort,
  breaker transitions, and slot release remain unchanged;
- successful workers remain available without `session.delete`;
- live probe proves parent chain and no hang under the real OpenCode runtime.

No test should claim that the synchronous child continues working while a
batch is active. Its next model turn occurs after the aggregate returns.

## Done criteria

All must hold:

- [ ] Strict TDD evidence exists: parentage tests failed before production edit
  and passed after it.
- [ ] `src/plugin/fanout.ts` creates workers with `parentID: callerSid` and
  contains no `rootSid` flattening path.
- [ ] Depth-1 caller admission and depth-2 terminal-leaf enforcement are both
  covered by tests.
- [ ] Tier allowlists are unchanged.
- [ ] Fanout remains synchronous and all existing deadlines/cleanup semantics
  are unchanged.
- [ ] Prompts describe optional caller-owned depth-2 workers and small focused
  batches without claiming asynchronous overlap.
- [ ] Promoted spec and README describe the same parent/depth contract.
- [ ] `pnpm run build:tiers` succeeds and generated `tiers.json` is current.
- [ ] Targeted fanout/session/guard tests pass.
- [ ] `pnpm run typecheck` exits 0.
- [ ] `pnpm run lint` exits 0.
- [ ] Full tests have no new failure versus `c91b875`.
- [ ] `git diff --check` exits 0.
- [ ] Live probe records `root -> caller -> workers`, no depth 3, and no hang.
- [ ] No out-of-scope files are modified.
- [ ] `plans/README.md` status reflects the verified outcome.

## STOP conditions

Stop and report; do not improvise if:

- In-scope code no longer matches the current-state excerpts after the drift
  check.
- New parentage requires modifying `src/plugin/hooks/tool-guards.ts`,
  `src/router/sessions.ts`, or `src/plugin/fanout-store.ts`; the existing
  production mechanisms should already support this tree.
- A test requires weakening native nested-Task protection.
- Any lifecycle, timeout, cleanup, breaker, aggregate, or tier-policy behavior
  changes to make the parentage tests pass.
- The implementation needs async/background workers or a status/collect tool.
- The live probe hangs, exceeds the batch bound, creates depth 3, reports the
  wrong parent, leaves unreconciled workers, or causes a TUI focus jump.
- Verification fails twice after one reasonable correction.
- The change exceeds the 450-line review budget; split it rather than requesting
  an exception.

## Maintenance notes

- Parentage and execution mode are independent contracts. Future async work
  must not be smuggled into tree-parenting maintenance.
- `depth !== 1`, descendant native-tool guards, and `isFanoutWorker` are
  intentionally redundant. Reviewers should reject attempts to collapse them
  without equivalent runtime evidence.
- The strongest review question is not whether `parentID` changed; it is
  whether all failure paths still release slots, bound aborts, and return an
  ordered aggregate.
- If OpenCode later ships reliable native nested Task deadlines and cleanup,
  reassess against immutable upstream evidence before replacing the SDK-owned
  executor.
- Preserve historical Plan 044 archive artifacts unchanged. They document the
  previous flattened contract and its verified runtime behavior.
