# Plan 011: Restore a trustworthy local verification baseline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 0400624..HEAD -- src/plugin/runtime.ts test/integration/layer2-wiring.test.ts test/integration/modeA-e2e.test.ts test/integration/modeB-e2e.test.ts test/integration/ladder-wiring.test.ts test/integration/failover-compose.test.ts test/unit/biome.test.ts test/unit/tiers-assembly.test.ts test/unit/router-config.test.ts scripts/build-tiers-config.ts src/plugin/types.ts src/escalate/ladder.ts src/guard/enforce.ts rolldown.config.js biome.jsonc`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `0400624`, 2026-07-01

## Why this matters

The repo has three independent problems that make `pnpm test` and `pnpm run lint`
both fail on a clean checkout. That means any executor working on a future plan
cannot tell whether a failure is their regression or pre-existing noise. This
plan fixes all three root causes so the baseline is green again. It must land
before Plan 012 (the reasoning wiring fix) and Plan 013 (CI), because both
depend on a trustworthy suite to verify their own changes.

The three problems are:

1. **11 integration tests crash** because they call `delegate.execute()` without
   the required `ToolContext` argument that the SDK contract demands.
2. **The Biome lint gate is red** because of a mix of pre-existing lint
   violations and a format mismatch between the `tiers.json` build output and
   Biome's JSON formatter expectations.
3. **One unit test races on `tiers.json`** because `tiers-assembly.test.ts`
   truncates and rewrites the repo-root file that `router-config.test.ts` reads
   concurrently.

## Current state

### Problem 1 — Missing `ToolContext` in integration tests (11 failures)

- `src/plugin/runtime.ts:105-107` — the production delegate tool wiring. This
  code is CORRECT; the bug is in the tests, not here.
  ```ts
  async execute(args: DelegateArgs, context: ToolContext): Promise<string> {
    return executeDelegate(ctx, args, context.sessionID, context.abort);
  }
  ```

- The SDK type contract (`node_modules/@opencode-ai/plugin/dist/tool.d.ts:47-55`)
  requires `execute(args, context: ToolContext)` — two arguments.

- Every failing integration test passes only one argument. Representative
  call site (`test/integration/layer2-wiring.test.ts:178-181`):
  ```ts
  const out: string = await hooks.tool.delegate.execute({
    task: "Write the file.\n[acceptance]\ncheck: fileExists path=deliver.txt\n[/acceptance]",
    tier: "fast",
  });
  ```

- The unit test already shows the correct pattern
  (`test/unit/plugin-runtime.test.ts:186-190`):
  ```ts
  const fakeAbort = { aborted: false } as any;
  const fakeContext = { sessionID: "sess_test", abort: fakeAbort };
  await executeFn(args, fakeContext);
  ```

- Commit `4bdcf42` added `context: ToolContext` to the execute signature; the
  integration tests were not updated to match.

- **Failing files and the `.execute()` call line in each**:
  - `test/integration/layer2-wiring.test.ts:178, 190`
  - `test/integration/modeA-e2e.test.ts:121, 146, 168`
  - `test/integration/modeB-e2e.test.ts:121, 150`
  - `test/integration/ladder-wiring.test.ts:115, 144, 169`
  - `test/integration/failover-compose.test.ts:137, 220`

### Problem 2 — Biome lint gate red (9 violations, exit 1)

- `test/unit/biome.test.ts:32-48` wraps `biome check` as a hard test gate:
  ```ts
  const result = spawnSync("node", [biomeBin, "check"], { encoding: "utf-8" });
  expect(result.status).toBe(0);
  ```

- The violations Biome reports (run `pnpm run lint` to see them):

  | Rule | File | Lines | Fix |
  |------|------|-------|-----|
  | `lint/complexity/useLiteralKeys` | `src/plugin/types.ts` | 65, 115, 116, 118, 119, 121, 122, 143, 144, 145, 146, 169, 170, 172 (14 instances) | Replace `rec["prop"]` with `rec.prop` — safe because `rec` is typed `Record<string, unknown>` |
  | `lint/style/noNonNullAssertion` | `src/escalate/ladder.ts` | 78, 160 | Replace `!` with a local variable + null check |
  | `lint/correctness/noUnusedFunctionParameters` | `src/guard/enforce.ts` | 26 | Rename `tier` to `_tier` (parameter is intentionally unused; documented in the comment above it) |
  | `lint/style/useTemplate` | `scripts/build-tiers-config.ts` | 149 | Replace `+ "\n"` with template literal |
  | Format mismatch | `rolldown.config.js` | 24-31 | Reindent from 4-space to 2-space (run `pnpm run format`) |
  | Format mismatch | `tiers.json` | Multiple arrays | Generated file — exclude from Biome (see Step 2) |

- `tiers.json` format mismatch root cause: `scripts/build-tiers-config.ts:149`
  writes `JSON.stringify(merged, null, 2) + "\n"` which puts each array element
  on its own line. Biome's JSON formatter collapses arrays with few items to
  inline. Since `tiers.json` is a generated artifact (source of truth is
  `config/tiers/*` + the build script), the clean fix is to exclude it from
  Biome.

- `biome.jsonc:8-18` currently includes `"*.json"` in the `files.includes`
  array — that is why `tiers.json` gets checked:
  ```jsonc
  "files": {
    "includes": [
      "src/**",
      "test/**",
      "scripts/**",
      "*.ts",
      "*.js",
      "*.json",
      "*.jsonc",
      "!scripts/QUICK_REFERENCE.ts"
    ]
  }
  ```

### Problem 3 — `tiers.json` test race (1 intermittent failure)

- `test/unit/tiers-assembly.test.ts:87-104` saves/restores `tiers.json` around
  the suite, but individual tests call `runAssembler()` which overwrites the
  repo-root `tiers.json`:
  ```ts
  const runAssembler = (): { stdout: string; stderr: string } => {
    return {
      stdout: execFileSync("node", ["--experimental-strip-types", ASSEMBLER_PATH], {
        encoding: "utf-8",
      }),
      stderr: "",
    };
  };
  ```

- `scripts/build-tiers-config.ts:149-151` writes with `writeFileSync`, which
  truncates the file before writing:
  ```ts
  const output = JSON.stringify(merged, null, 2) + "\n";
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, output, "utf-8");
  ```

- `test/unit/router-config.test.ts:424-429` calls `readMergedConfig()` which
  reads the same repo-root `tiers.json`. When the read lands between
  truncation and write completion: `"Unexpected end of JSON input"`.

- Additionally, `test/unit/router-config.test.ts:400-411` temporarily renames
  `tiers.json` to `tiers.json.bak-test` — another concurrent-read hazard.

- `scripts/build-tiers-config.ts:147-151` — the `OUTPUT_PATH` constant is
  hardcoded at the top of the script. The fix is to make it overridable via
  an environment variable so tests can redirect output to a temp path.

### Repo conventions to match

- Tests live in top-level `test/`, never under `src/` (`vitest.config.ts:4-14`).
- Integration tests call real plugin hooks with temp dirs and mocked SDK
  clients; mirror `test/integration/layer2-wiring.test.ts`.
- Unit tests use Vitest `describe/it` with `beforeEach/afterEach`; mirror
  `test/unit/plugin-runtime.test.ts`.
- Conventional commits: `fix(...)`, `test(...)`, `chore(...)`.
- Arrow functions preferred; type-only re-exports from entry point.

### Documented design constraints to honor

- ADR 0002 confirms the `ToolContext` contract:
  `docs/adr/0002-acceptance-gate.md:19` — "Custom tool registration ...
  `execute(args, ctx)` ... `ToolContext` has NO `client` — but the tool's
  `execute` is a closure created inside the plugin factory, so it captures
  `client`, `$`, `directory`, `worktree` from `PluginInput`."
- The `tier` parameter in `src/guard/enforce.ts:26` is intentionally unused
  per the comment at lines 23-25: "deliverableSignal is null in Wave 1 (Mode
  A/B signal wiring lands in Wave 2/4), which disables the deliverable-first
  clause."

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0, no errors |
| Lint | `pnpm run lint` | exit 0 |
| Targeted tests | `pnpm test -- test/integration/layer2-wiring.test.ts test/integration/modeA-e2e.test.ts test/integration/modeB-e2e.test.ts test/integration/ladder-wiring.test.ts test/integration/failover-compose.test.ts` | all listed files pass |
| Full tests | `pnpm test` | exit 0 |
| Build | `pnpm run build` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `test/integration/layer2-wiring.test.ts`
- `test/integration/modeA-e2e.test.ts`
- `test/integration/modeB-e2e.test.ts`
- `test/integration/ladder-wiring.test.ts`
- `test/integration/failover-compose.test.ts`
- `test/unit/tiers-assembly.test.ts`
- `scripts/build-tiers-config.ts`
- `src/plugin/types.ts`
- `src/escalate/ladder.ts`
- `src/guard/enforce.ts`
- `rolldown.config.js`
- `biome.jsonc`

**Out of scope** (do NOT touch):
- `src/plugin/runtime.ts` — production code is correct; the tests are wrong.
- `src/plugin/hooks.ts` — covered by Plan 012.
- `.github/workflows/*` — covered by Plan 013.
- `test/smoke/` — opt-in only, not part of the standard suite.
- `test/unit/biome.test.ts` — do not weaken the assertion; fix the violations
  it reports instead.
- `test/unit/router-config.test.ts` — this file is a victim of the race, not
  the cause. The fix goes in `tiers-assembly.test.ts` and the build script.
  Exception: if the `tiers.json.bak-test` rename at line 400-411 needs an
  adjustment to avoid the concurrent-read hazard, that specific edit is allowed.

## Git workflow

- Branch: `advisor/011-restore-verification-baseline`
- Commit per logical unit; use conventional commits.
- Suggested commit messages:
  - `test(delegate): pass ToolContext in integration coverage`
  - `fix(lint): clear Biome violations and exclude generated tiers.json`
  - `fix(build): isolate tiers assembly output in tests`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Fix integration tests to pass `ToolContext` as the second argument

Update every `.execute()` call in the five integration test files listed in
"Problem 1" above. Each call currently passes one argument (the args object);
add a minimal fake `ToolContext` as the second argument.

Use the pattern from `test/unit/plugin-runtime.test.ts:186-190`:

```ts
const fakeContext = { sessionID: "sess_test", abort: new AbortController().signal };
```

The `sessionID` should be a deterministic string unique enough to avoid
collisions with other sessions in the test. The `abort` signal can be a
fresh `AbortController().signal` or a simple mock like `{ aborted: false }`.

If multiple call sites within the same file repeat the same context, define
a local `const fakeCtx = ...` near the top of the `describe` block and reuse
it. Do NOT create a shared helper file unless the duplication becomes
unmanageable — inline is fine for 1-2 call sites per file.

After editing, confirm the exact error message `Cannot read properties of
undefined (reading 'sessionID')` no longer appears in any of the five files.

**Verify**: `pnpm test -- test/integration/layer2-wiring.test.ts test/integration/modeA-e2e.test.ts test/integration/modeB-e2e.test.ts test/integration/ladder-wiring.test.ts test/integration/failover-compose.test.ts` → all pass

### Step 2: Fix Biome lint violations and exclude generated `tiers.json`

Fix each violation category:

**a. `src/plugin/types.ts` — `useLiteralKeys` (14 instances)**

Replace bracket notation with dot notation on all `Record<string, unknown>`
variables. Example at line 65:
```ts
// Before:
return rec["type"] === "text" && typeof rec["text"] === "string";
// After:
return rec.type === "text" && typeof rec.text === "string";
```
Apply the same transformation at lines 115, 116, 118, 119, 121, 122, 143, 144,
145, 146, 169, 170, 172. These are all on variables typed as
`Record<string, unknown>`, so dot access is semantically identical.

**b. `src/escalate/ladder.ts` — `noNonNullAssertion` (2 instances)**

Line 78: `return policy.ladder[ci + 1]!;`
Replace with a local variable and null guard:
```ts
const next = policy.ladder[ci + 1];
return next ?? null;
```

Line 160: `currentTier: action.tier!,`
Replace with a guard before the return:
```ts
if (action.action === "escalate") {
  if (!action.tier) return state; // defensive — escalate always carries tier
  return {
    ...state,
    currentTier: action.tier,
    attemptsThisTier: 0,
    escalations: state.escalations + 1,
  };
}
```

**c. `src/guard/enforce.ts` — `noUnusedFunctionParameters` (1 instance)**

Line 26: rename `tier` to `_tier`:
```ts
export const buildGuardPolicy = (cfg: RouterConfig, _tier: string | null): GuardPolicy => {
```

**d. `scripts/build-tiers-config.ts` — `useTemplate` (1 instance)**

Line 149:
```ts
// Before:
const output = JSON.stringify(merged, null, 2) + "\n";
// After:
const output = `${JSON.stringify(merged, null, 2)}\n`;
```

**e. `rolldown.config.js` — format mismatch**

Run `pnpm run format` (which runs `biome format --write`). This will reindent
lines 24-31 from 4-space to 2-space. Do NOT manually edit the indentation;
let Biome format it.

**f. `tiers.json` — generated artifact, exclude from Biome**

Add `"!tiers.json"` to the `files.includes` array in `biome.jsonc`, after the
existing `"!scripts/QUICK_REFERENCE.ts"` exclusion:
```jsonc
"files": {
  "includes": [
    "src/**",
    "test/**",
    "scripts/**",
    "*.ts",
    "*.js",
    "*.json",
    "*.jsonc",
    "!scripts/QUICK_REFERENCE.ts",
    "!tiers.json"
  ]
}
```

This is correct because `tiers.json` is generated by
`scripts/build-tiers-config.ts` from `config/tiers/*` — the source of truth
is the part files and the script, not the generated output.

**Verify**: `pnpm run lint` → exit 0

### Step 3: Eliminate the `tiers.json` test race

**a. Make the build script output path overridable**

In `scripts/build-tiers-config.ts`, find the `OUTPUT_PATH` constant and make
it overridable via an environment variable:

```ts
// Before:
const OUTPUT_PATH = resolve(...);

// After:
const OUTPUT_PATH = process.env.TIERS_OUTPUT_PATH
  ? resolve(process.env.TIERS_OUTPUT_PATH)
  : resolve(...);
```

Keep the default value identical so production behavior is unchanged.

**b. Redirect the assembly test output to a temp file**

In `test/unit/tiers-assembly.test.ts`, update `runAssembler()` to pass
`TIERS_OUTPUT_PATH` pointing at a temp file, then compare that temp output
against the checked-in `tiers.json`:

```ts
const tmpPath = path.join(os.tmpdir(), `tiers-assembled-${Date.now()}.json`);

const runAssembler = (): { stdout: string; stderr: string } => {
  return {
    stdout: execFileSync(
      "node",
      ["--experimental-strip-types", ASSEMBLER_PATH],
      { encoding: "utf-8", env: { ...process.env, TIERS_OUTPUT_PATH: tmpPath } },
    ),
    stderr: "",
  };
};
```

Then update assertions that read the assembled output to read from `tmpPath`
instead of `ASSEMBLED_PATH`. The `beforeAll`/`afterAll` save-restore of
`ASSEMBLED_PATH` can be removed entirely since the test no longer writes to
it.

**c. Address the `tiers.json.bak-test` rename**

In `test/unit/router-config.test.ts:400-411` (the test that renames
`tiers.json`), the rename creates a window where the file is temporarily
absent. Since the race is now eliminated for the assembly test, the remaining
risk is if another test file reads `tiers.json` during this rename window.
If the targeted test command below passes consistently, no further change is
needed. If it still races, wrap the rename-restore in a `beforeAll`/`afterAll`
at the file level (not inside an individual `it`) so vitest schedules it
outside the concurrent test body.

**Verify**: `pnpm test -- test/unit/tiers-assembly.test.ts test/unit/router-config.test.ts` → both pass, run 3 times to confirm no flakiness

### Step 4: Re-run the full baseline end to end

Confirm the repo is green locally after all three fixes.

**Verify**:
- `pnpm run typecheck` → exit 0
- `pnpm run lint` → exit 0
- `pnpm test` → exit 0 (1693+ tests, 0 failures)
- `pnpm run build` → exit 0

## Test plan

- No new product-behavior tests are required; this plan restores broken suites.
- Regression checks:
  - The five delegate integration files pass without `context.sessionID` errors.
  - `test/unit/biome.test.ts` passes because `biome check` exits 0.
  - `test/unit/tiers-assembly.test.ts` and `test/unit/router-config.test.ts`
    pass together without timing-dependent failures.
- Structural patterns:
  - `test/unit/plugin-runtime.test.ts:186-190` for the `ToolContext` shape.
  - `test/integration/layer2-wiring.test.ts` for the hook-assembly style.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm test` exits 0 with zero failures
- [ ] `pnpm run build` exits 0
- [ ] The five delegate integration files pass without `context.sessionID` errors
- [ ] `test/unit/biome.test.ts` passes without weakening the assertion
- [ ] `test/unit/tiers-assembly.test.ts` no longer writes to the repo-root `tiers.json`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `ToolContext` shape from the SDK type definition
  (`node_modules/@opencode-ai/plugin/dist/tool.d.ts`) does not match the
  minimal `{ sessionID, abort }` pattern — additional required fields would
  need a different mock.
- Fixing a Biome lint violation requires changing runtime behavior (not just
  syntax/format). For example, if removing the `!` at `ladder.ts:78` changes
  the return type signature in a way that breaks callers.
- Making `OUTPUT_PATH` overridable breaks the `prebuild` script in
  `package.json:10` or the `build` script at `package.json:8`.
- `pnpm test` still fails after Steps 1-3 for a reason outside the three
  documented failure clusters.

## Maintenance notes

- Reviewers should verify the Biome gate was not weakened. The assertion in
  `biome.test.ts:47` (`expect(result.status).toBe(0)`) must remain unchanged.
- Once `tiers.json` is excluded from Biome, future human edits should go to
  `config/tiers/*` + `scripts/build-tiers-config.ts`, never directly to
  `tiers.json`.
- This plan does not add CI (that is Plan 013). The goal here is a green
  local baseline; CI makes it permanent.
