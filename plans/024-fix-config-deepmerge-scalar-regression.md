# Plan 024: Restore ConfigMerge scalar-override (regression from JSON migration cleanup)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9c744be..HEAD -- src/config/ConfigMerge.res src/config/ConfigMerge.resi src/config/ConfigMerge.res.mjs src/router/config-loader.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `9c744be`, 2026-08-03

## Why this matters

`Config.deepMerge` is the user-facing config layering primitive: every
`opencode-smart-router` install composes a base config with one or more
operator overrides (`second.config.json` layered onto `default.config.json`,
etc.). The contract is:

- *object base & object override* → merge recursively, key-by-key.
- *object base & scalar override* → the scalar REPLACES the base object.
- *scalar base & any override* → the override REPLACES the base.
- *object base & `undefined` override* → the base is PRESERVED (operator did
  not specify this key).

The cleanup commits `2a4a4b2` ("eliminate all compiler warnings") and
`9c744be` ("eliminate %raw and Obj.magic from core") migrated `ConfigMerge.res`
from `Js.Json.*` / `Js.Dict.*` to `@rescript/core`'s `JSON.*` / `Dict.*`. As
part of that migration they replaced the runtime-type check
`Js.typeof(override) == "undefined"` (which inspects the raw runtime value)
with `overrideObj == None` (which inspects the *decoded-object result*).

`JSON.Decode.object(42)` returns `None` because `42` is a scalar, not an
object. `JSON.Decode.object(undefined)` also returns `None`. The replacement
check therefore **cannot distinguish a scalar override from an `undefined`
override** — and the function falls back to returning `base` in both cases.
A user override `{ hotspotScale: 100 }` silently no longer layers onto a
default that has `hotspotScale: { sensitivity: "moderate" }` — the operator's
scalar `100` is discarded.

One failing test confirmed the regression:

```
test/unit/config-deepmerge.test.ts:135
  it("scalar override replaces object base", () => {
    const base = { key: "value" };
    expect(deepMergeConfig(base, 42)).toBe(42);   // → received { key: "value" }
  });
```

The test imports via `src/router/config-loader.ts:37-39` which re-exports the
ReScript port:

```ts
import { deepMerge as deepMergeConfig } from "../config/ConfigMerge.res.mjs";
// Re-export for backward compat — deepMergeConfig is now the ReScript port.
export { deepMergeConfig };
```

So the failure is the ReScript `deepMerge`, not a leftover TS shim.

## Current state

### The broken branch — `src/config/ConfigMerge.res:16-44`

```rescript
let rec deepMerge = (base: JSON.t, override: JSON.t): JSON.t => {
  let baseObj = JSON.Decode.object(base)
  let overrideObj = JSON.Decode.object(override)
  let baseIsObj = baseObj != None
  let overrideIsObj = overrideObj != None
  if !baseIsObj {
    override
  } else if !overrideIsObj {
    if overrideObj == None {            // ← conflates "scalar" with "undefined"
      base
    } else {
      override
    }
  } else {
    // both are objects — recursive merge (unchanged, correct)
    ...
  }
}
```

The `!overrideIsObj` branch is reached whenever `override` is not a JSON
object, i.e. when it is a scalar, an array, `null`, or `undefined`. Inside
that branch, the new code checks `overrideObj == None` — but `overrideObj` IS
`None` for ALL of those cases (they all fail `JSON.Decode.object`). The
inner `else` is therefore **dead code** and every non-object override is
treated as "preserve base".

### The old (working) branch at commit `2dedbde`

The same logic, before the cleanup, used the runtime-type inspector:

```rescript
let rec deepMerge = (base: Js.Json.t, override: Js.Json.t): Js.Json.t => {
  ...
  } else if !overrideIsObj {
    if Js.typeof(override) == "undefined" {   // raw typeof — only true for undefined
      base
    } else {
      override                                // scalars, arrays, null → replace base
    }
  } else {
  ...
```

`Js.typeof(42) == "undefined"` is `"number" == "undefined"` → `false` → returns
`override` (42). That is the contract.

### Compiled JS diff (root cause in one line)

```diff
   if (!overrideIsObj) {
-    if (typeof override === "undefined") {   // raw runtime value
+    if (overrideObj === undefined) {          // decoded result (None for scalar AND undefined)
       return base;
     } else {
       return override;                        // ← dead: overrideObj is ALWAYS undefined here
     }
   }
```

### Repo conventions to match

- The codebase has migrated to `@rescript/core` (`JSON`, `Dict`, `Option`).
  The fix should stay inside that surface, NOT reintroduce `Js.Json.*` or
  `Js.typeof`.
- `ConfigMerge.resi` is the public contract: `let deepMerge: (JSON.t, JSON.t) => JSON.t`.
  The fix must not change the signature.
- The `ConfigMerge_test.res` rescript-test parity suite (19 cases) has 19
  RED-first fixtures covering the merge contract — including the
  scalar-override-replaces-object case. **All 19 must stay green**.

### Documented design constraints to honor

- `sdd/rescript-migration-phase4-5` Task WU-6 design (engram #3966):
  scalar override REPLACES object base; recursive merge only when both sides
  are plain objects; `undefined` preserves the base; `null` is a value that
  overrides. The `ConfigMerge_test.res` suite is the authoritative contract.
- ABI boundary typing (WU-6 resi) uses `JSON.t` for both args (the `Js.Json.t`
  rename is part of the same cleanup migration and must remain; only the
  scalar branch is wrong).

## Commands you will need

| Purpose            | Command                                                       | Expected on success                                  |
|--------------------|--------------------------------------------------------------|------------------------------------------------------|
| Install            | `pnpm install`                                                | exit 0                                               |
| ReScript build     | `pnpm run res:build`                                          | exit 0, regenerates `src/config/ConfigMerge.res.mjs` |
| Typecheck          | `pnpm run typecheck`                                          | exit 0, no errors                                    |
| ReScript parity    | `pnpm run test:res -- src/config/ConfigMerge_test.res.mjs`    | 19/19 passing                                        |
| Targeted vitest    | `pnpm test -- test/unit/config-deepmerge.test.ts`            | all pass                                             |
| Full rescript-test | `pnpm run test:res`                                            | 416/416                                              |
| Full vitest        | `pnpm test`                                                    | at most the 14-failure accepted baseline (this plan's 1 fixed) |
| Build              | `pnpm run build`                                              | exit 0                                               |

## Suggested executor toolkit

- `JSON.classify(v: JSON.t)` (from `@rescript/core`) — returns the variant
  `JSON.Null | JSON.Undefined | JSON.Bool(_) | JSON.Number(_) |
  JSON.String(_) | JSON.Array(_) | JSON.Object(_)`. This is the structural
  inspector that lets you tell scalars apart from `undefined` without
  reintroducing `Js.typeof`. Use it where the broken code currently keys off
  `overrideObj == None`.

A one-line probe (confirm the fix is the right kind of behaviour):

```
node -e "import('./dist/src/config/ConfigMerge.res.mjs').then(m => console.log(m.deepMerge({key:'value'}, 42)))"
# must print: 42
```

## Scope

**In scope** (the only files you should modify):
- `src/config/ConfigMerge.res` — restore the scalar-override-replaces-object
  semantic in the `!overrideIsObj` branch using `JSON.classify`.
- `src/config/ConfigMerge.res.mjs` — regenerated by `pnpm run res:build`. Do
  NOT hand-edit; treat as a verification artifact.

**Out of scope** (do NOT touch, even though they look related):
- `src/config/ConfigMerge.resi` — the public signature is unchanged.
- `src/config/ConfigMerge_test.res` — the parity suite is the contract. Do
  not rewrite its assertions to mask the bug. If a parity case needs to
  change to expose this bug, STOP — the suite had a coverage gap and the
  case belongs in a separate plan.
- `src/router/config-loader.ts` — the TS re-export grows naturally from the
  regenerated ABI; no source change needed here.
- `src/types/rescript-modules.d.ts` — untouched.
- The `Js.*` family in any other module. This plan does not roll back the
  cleanup migration; it only corrects the one branch whose semantics were
  lost.

## Git workflow

- Branch: `advisor/024-fix-config-deepmerge-scalar-regression`
- Commit style (conventional):
  - `fix(config): restore scalar-override-replaces-object in deepMerge`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Replace the conflation branch with a structural classifier

In `src/config/ConfigMerge.res`, edit the `!overrideIsObj` branch to inspect
the runtime structure of `override` rather than the decoded-object result.
Use `JSON.classify`:

```rescript
} else if !overrideIsObj {
  switch JSON.classify(override) {
  | JSON.Undefined => base
  | _ => override
  }
} else {
  ...
}
```

Semenity: preserves exactly the pre-cleanup contract —
`Undefined` preserves base; every other non-object JSON value (Number, Bool,
String, Null, Array) replaces base. `Null` overriding base was *already* the
old behaviour (`Js.typeof(null) == "object"`, so the old `Js.typeof == "undefined"`
was false and returned override; classified as `JSON.Null` here it returns
`override` — same result).

**Verify (compile)**: `pnpm run res:build && pnpm run typecheck` → both
exit 0, no errors. Inspect the regenerated `ConfigMerge.res.mjs` and confirm
the branch compiles to a `switch` on the runtime type / classify result
rather than `overrideObj === undefined`.

### Step 2: Confirm the parity suite is unchanged

**Verify**: `pnpm run test:res -- src/config/ConfigMerge_test.res.mjs` → 19/19
passing. All 19 RED-first fixtures (undefined-layer identity, recursive plain
object merge, array/scalar replacement, explicit null replacement, key
preservation, three-way chained merge, nested null overrides) must still pass.
The "scalar-override-replaces-object" parity case is one of them.

### Step 3: Confirm the regressionCase vitest is fixed

**Verify**: `pnpm test -- test/unit/config-deepmerge.test.ts` → all `it`s in
the file pass, specifically the `scalar override replaces object base` case
now returns `42` (no longer `{key:"value"}`).

### Step 4: Re-run the full baseline to confirm no new regressions

**Verify**:
- `pnpm run typecheck` → exit 0
- `pnpm run test:res` → 416/416
- `pnpm test` → total failures reduced from 20 → 19 (only this plan's 1
  fixed; the 14 accepted baseline + the unrelated 5 still-red cases from
  Plan 023 remain). If Plan 023 has already landed, failures should be 19 →
  14 (this plan completes the 6-regression restoration).
- `pnpm run build` → exit 0

## Test plan

- No new tests required; the red `test/unit/config-deepmerge.test.ts > scalar
  override replaces object base` is the regressionCase fixture restored to
  green.
- Optional belt-and-suspenders probe (only useful for diffing):

```
pnpm run build && node -e "import('./dist/src/config/ConfigMerge.res.mjs').then(m => {
  console.log(m.deepMerge({key: 'value'}, 42));        // 42
  console.log(m.deepMerge({key: 'value'}, undefined)); // { key: 'value' }
  console.log(m.deepMerge({key: 'value'}, null));      // null
  console.log(m.deepMerge({key: 'value'}, [1,2,3]));   // [1,2,3]
  console.log(m.deepMerge({key: 'value'}, 'sub'));      // 'sub'
})"
```

Expected exactly: `42`, `{ key: 'value' }`, `null`, `[1,2,3]`, `'sub'`. If any
differs, the classifier has the wrong arm mapping — STOP.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm run res:build` exits 0 and regenerates `ConfigMerge.res.mjs`
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test:res -- src/config/ConfigMerge_test.res.mjs` → 19/19
- [ ] `pnpm run test:res` → 416/416
- [ ] `pnpm test -- test/unit/config-deepmerge.test.ts` → all pass (the
      `scalar override replaces object base` case returns `42`)
- [ ] `pnpm test` → failures reduced by at least 1 from the pre-plan baseline
- [ ] `grep -nE 'Js\.typeof|Js\.Json|Obj\.magic' src/config/ConfigMerge.res`
      returns NO matches (the cleanup migration is preserved, only the
      conflation branch corrected)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `JSON.classify` is not exported by the installed `@rescript/core` (verify:
  `grep -rn 'classify' node_modules/@rescript/core/src/JSON.*`). If the
  installed version enumerates runtime JSON differently (e.g. a
  pattern-match on `Js.Json.typeof`-style helper), STOP and report what IS
  available — the executor must NOT reintroduce `Js.typeof` if a structural
  `@rescript/core` alternative exists, but must not invent one either.
- The `ConfigMerge_test.res` parity suite falls below 19 passing after the
  Step 1 edit — STOP. The classifier arm mapping is wrong (probably `Null`
  falling into the wrong branch). Revert and report which case regressed.
- The probe in "Test plan" prints anything other than the expected sequence
  — STOP. Each diff is a contract break; the arms are mapped wrong.
- The runtime value reaching `deepMerge` from `config-loader.ts` is *not* a
  JS value that `JSON.classify` can inspect (e.g. wrapped in a
  `Nullable.t` variant rather than raw JSON). STOP — that means the cleanup
  migration introduced an earlier bug at the ABI boundary and this plan's
  fix would mask it.

## Maintenance notes

- Reviewers should specifically check that `JSON.Null => base` would be WRONG
  (we route `Null` to `override` to honor pre-cleanup semantics — `null` is a
  value, not "absent"). If the future design wants `null` to PRESERVE base
  instead of override, that is a separate spec change, NOT this bugfix.
- A subtle, common error is to wrap the classifier arms incompletely, e.g.
  omitting `JSON.Array` and causing it to fall through to the `else` (which
  may not exist after a refactor). The `_ => override` catch-all is the
  safe default — it preserves "anything that isn't undefined replaces base".
- The full picture of the 6-regression cluster introduced by `2a4a4b2` +
  `9c744be` is:
  - 5 of 6 are Guard self-script — covered by Plan 023.
  - 1 of 6 is this scalar-override regression — Plan 024.
  The two fixes are file-disjoint (`Guard.res` vs `ConfigMerge.res`) and
  can be implemented in parallel on separate branches.
- This plan does NOT address the unrelated 14-failure accepted baseline
  referenced in `sdd/rescript-migration-phase4-5/verify-report` (engram
  #3978). Those failures pre-date the two cleanup commits and are tracked
  separately; Plan 011 (DONE) covers the ToolContext and biome portions, and
  the remaining five are out of scope here.