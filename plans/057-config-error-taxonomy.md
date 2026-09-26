# Plan 057: Make config validation throw RouterConfigError — typed taxonomy with stable messages

> **Executor instructions**: strict TDD; message stability is a hard
> contract (golden tests assert it). Honor STOP conditions. Update your row
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- src/router/config-validate.ts src/router/config-errors.ts src/router/config-loader.ts src/cli/ test/golden/config-errors.golden.test.ts`
> On any change, compare excerpts; on mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S–M (91 mechanical call-site edits + tests)
- **Risk**: LOW–MED (error-type swap; message strings must stay byte-identical)
- **Depends on**: plans/046 (goldens trustworthy)
- **Category**: tech-debt
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`src/router/config-errors.ts` defines a typed config error taxonomy
(`ConfigErrorKind` + `RouterConfigError`), and `config-loader.ts:53`'s
header PROMISES "Throws `RouterConfigError` on any I/O / parse / validation
failure" — but `config-loader.ts:74` calls `validateConfig()` with no
try/catch, and `config-validate.ts` throws plain `Error` at **91 sites**
(`throw new Error("tiers.json: …")`). No production consumer can
`instanceof RouterConfigError` (grep in `src/cli/` + `src/index.ts` → 0
hits). Operators and tooling cannot distinguish "file unreadable" from
"schema invalid"; the typed taxonomy pays maintenance cost with zero
runtime benefit; the loader's doc is a lie.

## Current state

`src/router/config-validate.ts:57-92` (throw style — 91 sites like these):

```ts
export const validateConfig = (raw: unknown): RouterConfig => {
  if (!isPlainObject(raw)) {
    throw new Error("tiers.json: expected a JSON object at root");
  }
  ...
export const validateRootFields = (obj: Record<string, unknown>): void => {
  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
```

`src/router/config-errors.ts:63-75` (the existing class — message math
matters):

```ts
export class RouterConfigError extends Error {
  override readonly name = "RouterConfigError";
  readonly kind: ConfigErrorKind;   // "missing" | "unreadable" | "malformed" | "invalid" | "stale_refresh_failed"
  readonly path: string;
  constructor(kind: ConfigErrorKind, path: string, cause: unknown, message?: string) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const prefix = message ?? `config file at ${path} (kind=${kind})`;
    super(`${prefix}: ${reason}`, { cause });
    ...
```

**Byte-identical message recipe** (the load-bearing detail): for a current
`throw new Error("tiers.json: 'activePreset' must be a non-empty string")`,
the replacement
`throw new RouterConfigError("invalid", "tiers.json", new Error("'activePreset' must be a non-empty string"), "tiers.json")`
produces `message === "tiers.json: 'activePreset' must be a non-empty string"`
— because prefix `"tiers.json"` + `": "` + cause message. The golden tests
(`test/golden/config-errors.golden.test.ts` + its snapshot) and
`config-errors.ts:44`'s own comment ("golden-error-message tests in
test/golden/") pin these strings.

`src/router/config-loader.ts:73-74`:

```ts
  const mergedManual = deepMergeConfig(deepMergeConfig(bundled, global), local);
  const cfg = validateConfig(mergedManual);
```

**Conventions**: validators are exported pure functions per section
(root/presets/tiers/enforcement/reasoning/fanout); the barrel
`src/router/config.ts:25` re-exports them all — keep exports stable.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Targeted | `pnpm test -- test/unit/config.validate.test.ts test/unit/config-errors.test.ts test/golden/config-errors.golden.test.ts test/unit/config-loader*.test.ts` | all pass |
| Site count | `grep -c 'throw new Error("tiers.json' src/router/config-validate.ts` | 91 before, 0 after |
| Full | `pnpm test` | no NEW failures vs post-046 baseline |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope**:
- `src/router/config-validate.ts` (fail() helper + mechanical replacement)
- `src/router/config-loader.ts` (defensive wrap of the validateConfig call)
- ONE CLI consumer: `src/cli/main.ts` or `src/cli/config.ts` (whichever
  loads config for humans — find the user-facing error printer) to catch
  `RouterConfigError` and render kind-aware messages
- `test/unit/config-errors.test.ts` or a new `test/unit/config-validate-typed-errors.test.ts`

**Out of scope**:
- Message TEXT changes (any message that must change is a STOP)
- `RouterStateError`, `readConfigLayer` behavior, `ConfigErrorKind` additions
- The deep `__proto__` hardening (separate, deferred cycle-2 note)

## Git workflow

- Branch: `advisor/057-config-error-taxonomy`
- Commits: `test(config): pin typed RouterConfigError from validateConfig (RED)`,
  `refactor(config): throw RouterConfigError(kind=invalid) from all validators`,
  `fix(loader): guarantee typed errors from readMergedConfig`,
  `feat(cli): render RouterConfigError kinds in user-facing output`.

## Steps

### Step 1 (RED): typed-error tests

New tests: (1) `validateConfig({})` throws an error satisfying
`err instanceof RouterConfigError && err.kind === "invalid"`; (2) three
sample sites produce BYTE-IDENTICAL `.message` to the strings quoted above
(exact-match assertions); (3) `readMergedConfig` with an invalid merged
config surfaces a `RouterConfigError` (already true if validators throw
typed — after step 2; before, the instanceof assertions fail).

Run → FAIL (plain `Error` thrown).

### Step 2 (GREEN): fail() helper + mechanical sweep

At the top of `config-validate.ts`:

```ts
import { RouterConfigError } from "./config-errors";
/** Throw the typed validation error. Message stays byte-identical to the
 *  historical `throw new Error("tiers.json: …")` strings (golden-pinned):
 *  prefix "tiers.json" + ": " + detail. */
const fail = (detail: string): never => {
  throw new RouterConfigError("invalid", "tiers.json", new Error(detail), "tiers.json");
};
```

Replace every `throw new Error("tiers.json: <detail>")` with
`fail("<detail>")`. Mechanical method: editor regex
`throw new Error\("tiers\.json: ` → `fail("` (mind the closing paren), then
`grep -c 'throw new Error("tiers.json'` → 0, then typecheck to catch
stragglers. Some sites may throw with different prefixes or template
strings — any site that does not match the exact `"tiers.json: …"` literal
shape: convert ONLY if the byte-identical recipe holds; otherwise leave it
and list it in your report (do not change its message).

Run Step 1 tests → GREEN; goldens → green (no snapshot changes expected).

### Step 3: loader guarantee

Wrap `config-loader.ts:74`:

```ts
  let cfg: RouterConfig;
  try {
    cfg = validateConfig(mergedManual);
  } catch (err) {
    if (err instanceof RouterConfigError) throw err;
    throw new RouterConfigError("invalid", "tiers.json", err);  // unexpected validator escape — still typed
  }
```

Update the header comment at `:53` — it is now TRUE.

### Step 4: one CLI consumer

Find where CLI commands print config-load failures today (search
`src/cli/` for catch-of-readMergedConfig / "config" error strings). Add an
`instanceof RouterConfigError` branch: print `kind` + `path` + message;
keep the existing fallback for other errors. One-line-quality change; add
or extend the CLI test asserting the kind-aware output for an invalid
config file (model after `test/unit/cli-config.test.ts`).

### Step 5: gates

Typecheck, targeted, full suite, lint; update index row.

## Test plan

- Step 1 tests (typed + byte-identical messages); Step 4 CLI output test.
- Goldens must pass UNCHANGED — if `pnpm test -- test/golden` wants a
  snapshot update, STOP.

## Done criteria

- [ ] `grep -c 'throw new Error("tiers.json' src/router/config-validate.ts` → 0
- [ ] Typed-error tests pass; `err instanceof RouterConfigError` holds for validation failures via both direct validateConfig and readMergedConfig
- [ ] `pnpm test` no NEW failures; goldens unchanged (`git diff test/golden/` empty)
- [ ] CLI renders kind-aware config errors (test-asserted)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Any golden snapshot wants regeneration — message drift; restore and find
  the divergent site.
- A validator site's message cannot be preserved by the recipe (dynamic
  strings, multiline) — leave it typed-incompatible, list it, do not
  rewrite the message.
- The CLI consumer change grows beyond one catch-branch + test.

## Maintenance notes

- Future validators: use `fail()` from day one; the golden suite is the
  guardrail.
- Layer provenance (WHICH of bundled/global/local failed) is intentionally
  NOT solved here (validation is post-merge); if operators need it, thread
  layer paths through readMergedConfig's merge steps in a future plan.
