# Plan 026: Unify Protocol ABI naming — alias `tierConfig` to `RouterConfig`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9c744be..HEAD -- src/types/rescript-modules.d.ts src/router/Protocol.res src/router/Protocol.resi`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `9c744be`, 2026-08-03

## Why this matters

The ReScript `Protocol` module defines its full-routing-config type as
`tierConfig` (referencing the same shape as TS-native `config.types.ts`'s
`RouterConfig`: `activePreset`, `presets`, `modes`, `rules`, `fallback`,
`enforcement`, ...). The ABI bridge file `src/types/rescript-modules.d.ts`
mirrors that and exports `tierConfig` to TS. Eleven TS consumers import
`tierConfig` from `Protocol.res.mjs`:

- `src/plugin/{context,delegate}.ts`, `src/plugin/hooks/{chat,system-config,tool-guards}.ts`, `src/verify/dispatch-io.ts`
- `test/golden/{protocol,assembled-prompt}.golden.test.ts`
- `test/integration/{failover-compose,trajectory-wiring}.test.ts`
- `test/unit/overhead-ga1.test.ts`

Ten other TS consumers import `RouterConfig` from `config.types.ts` /
`config.ts`:

- `src/router/{config-store,config-loader}.ts`
- `test/unit/{plugin-delegate,router-agents,enforcement,ladder,sessions,get-fresh-config,plugin-hooks,router-commands}.test.ts`

The two types describe the same runtime object. The naming divergence is a
copy-paste-from-ReScript leftover from the migration; new contributors and
reviewers must remember `tierConfig === RouterConfig` at the ABI seam.
Compounding the confusion: `ReasoningCapability.tierConfig` (in
`src/reasoning/ReasoningCapability.res`) is a DIFFERENT type — the *per-tier*
config shape (just `model`, `variant`, `thinking`, ...), which is correctly
named `tierConfig`.

This plan adds a single, additive type alias — `export type RouterConfig = tierConfig;`
— in the `Protocol` section of the ABI bridge, so TS code COULD adopt the
canonical `RouterConfig` name when reading from `Protocol.res.mjs`, while
existing `tierConfig` imports keep working unchanged (`tierConfig` is left
as-is for backward compat, no rename across the 11 consumers). Future code
chooses `RouterConfig`; legacy code is untouched. Zero runtime impact.

## Current state

### The ABI bridge — `src/types/rescript-modules.d.ts`

The `Protocol` section is around line 866 (the line has shifted across the
migration; recon locks it in the 800–900 range). It currently declares the
module shape for `*Protocol.res.mjs`:

```ts
declare module "*Protocol.res.mjs" {
  export type tierConfig = { activePreset: string; presets: ...; modes: ...; rules: ...; fallback: ...; enforcement: ...; ... };
  export const getActiveTiers: (cfg: tierConfig) => { ... };
  export const assembleSystemPrompt: (cfg: tierConfig, ...) => string;
  export const buildDelegationProtocol: (cfg: tierConfig) => string;
  // ... all the other Protocol exports keyed off `tierConfig` ...
}
```

There is no `RouterConfig` declaration anywhere in this file.

### The ReScript source

- `src/router/Protocol.res:116` — `type tierConfig = { activePreset: string, ... }`
- `src/router/Protocol.resi:39` — `type tierConfig = { ... }` (public interface)

The shape mirrors `src/router/config.types.ts:112` — `RouterConfig`.

### The confusing per-tier type

- `src/reasoning/ReasoningCapability.res:37` — `type tierConfig` — per-tier shape `{ model, variant, thinking, ... }`. 

This is a DIFFERENT type from `Protocol.tierConfig`; it is correctly named
(per-tier config) and stays as-is. The plan does not touch
`ReasoningCapability.tierConfig`.

### Out-of-scope renaming considerations

A "purer" approach would be to RENAME `Protocol.tierConfig` →
`Protocol.routerConfig` in `Protocol.res`, `.resi`, regenerate
`Protocol.res.mjs`, update the ABI bridge, and update all 11 TS consumers.
That is L effort (touches the highest-risk module in the codebase and
risks byte-parity on golden tests). The alias approach is S effort, zero
runtime impact, zero parity risk — recommended.

### Repo conventions to match

- The ABI bridge is ADDITIVE — every other ReScript module added its `.resi`
  types to `rescript-modules.d.ts` by *adding* declarations, never by removing
  or renaming. Match this.
- `Protocol.res` / `Protocol.resi` are treated as byte-parity-locked —
  `test/golden/protocol.golden.test.ts` (50/50) is the authority. This plan
  does NOT touch the ReScript source; only the TS ABI bridge gains one
  additional line.

### Documented design constraints to honor

- `sdd/rescript-migration-phase4-5` Spec REQ-CORE-103: Protocol byte-parity
  is gold-locked. The plan MUST NOT change the compiled `.res.mjs` output.
- `sdd/rescript-migration-phase4-5` archive-report W3 (engram #3980) logs
  this as a non-blocking ABI divergence; this plan is the suggested S4
  follow-up.

## Commands you will need

| Purpose     | Command                          | Expected on success                                    |
|-------------|----------------------------------|-------------------------------------------------------|
| Install     | `pnpm install`                   | exit 0                                                |
| Typecheck   | `pnpm run typecheck`             | exit 0, no errors                                     |
| Golden tests| `pnpm test -- test/golden/protocol.golden.test.ts` | 50/50 passing (Protocol authority unchanged) |
| Full tests  | `pnpm test`                      | unchanged from pre-plan baseline                      |
| Build       | `pnpm run build`                 | exit 0                                               |
| Rescript    | `pnpm run res:build`             | exit 0 (no ReScript change; sanity)                  |

## Suggested executor toolkit

- The TypeScript type alias pattern is well-trodden:
  `export type RouterConfig = tierConfig;` — idempotent, structural, no
  runtime footprint.
- Confirm the ABI module regex behaviour: `declare module "*Protocol.res.mjs"`
  is a glob; multiple `export type` lines inside are unioned in TS's view.
  Adding `RouterConfig` does not shadow `tierConfig`.

## Scope

**In scope** (the only file you should modify):
- `src/types/rescript-modules.d.ts` — add `export type RouterConfig = tierConfig;`
  inside the `declare module "*Protocol.res.mjs"` block, directly after the
  `tierConfig` type definition. Optionally add a one-line comment:
  `// Canonical TS name; tierConfig is kept as an alias for backward compat.`

**Out of scope** (do NOT touch, even though they look related):
- `src/router/Protocol.res`, `Protocol.resi`, `Protocol.res.mjs` — the
  ReScript source and compiled output are unchanged. Byte-parity is gold-locked.
- The 11 existing TS consumers — leave their `tierConfig` imports as-is.
  Backward-compat is the whole point. They can adopt `RouterConfig`
  opportunistically in future PRs as they're touched for other reasons.
- `src/reasoning/ReasoningCapability.res` or its ABI section —
  `ReasoningCapability.tierConfig` is a different (per-tier) type and is
  correctly named.
- Any test file. The alias is a pure type addition.

## Git workflow

- Branch: `advisor/026-protocol-abi-routerconfig-alias`
- Commit style (conventional):
  - `chore(types): alias Protocol.tierConfig as RouterConfig in ABI bridge`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Locate the Protocol section and add the alias

Open `src/types/rescript-modules.d.ts`. Find the `declare module "*Protocol.res.mjs"`
block (search for the exact quoted glob). Inside that block, find the
`export type tierConfig = { ... };` definition (it is the first big type in
the section, line ~866). Immediately AFTER the closing `;` of that
definition, add:

```ts
  export type RouterConfig = tierConfig; // canonical TS name; `tierConfig` kept as an alias for backward compat.
```

Match the existing indentation (the bridge uses 2-space inside the
`declare module { ... }` block).

**Verify (typecheck)**: `pnpm run typecheck` → exit 0 with no errors. The
alias is structurally identical to `tierConfig`, so every existing consumer
continues to typecheck — including the `as unknown as tierConfig` casts
already present in the 11 consumer sites.

### Step 2: Confirm parity is untouched

**Verify**:
- `pnpm run res:build` → exit 0 (sanity; no ReScript change).
- `pnpm run build` → exit 0. The compiled `Protocol.res.mjs` is byte-identical
  to before — confirm by `git diff` showing only `src/types/rescript-modules.d.ts`
  changed.
- `pnpm test -- test/golden/protocol.golden.test.ts test/golden/assembled-prompt.golden.test.ts` → 50/50 golden tests still pass (Protocol authority is intact).

### Step 3: Confirm the full suite is unchanged

**Verify**: `pnpm test` → the failure count is unchanged from the
pre-plan baseline (no TS consumer's behaviour changed; only the type
namespace gained a synonym). `pnpm run typecheck` → exit 0.

## Test plan

- No new tests required; the alias is purely additive at the type level
  and has no runtime behavior. The 50 golden Protocol tests are the parity
  authority and continue to pass.
- Optional belt-and-suspenders probe (TEMPORARY — REVERT after running):

```sh
# Confirm a new consumer COULD adopt RouterConfig
cat > /tmp/probe-routerconfig.ts <<'EOF'
import type { RouterConfig } from "opencode-smart-router/src/router/Protocol.res.mjs";
export const probe = (cfg: RouterConfig) => cfg.activePreset;
EOF
pnpm exec tsc --noEmit --strict /tmp/probe-routerconfig.ts && echo OK
rm /tmp/probe-routerconfig.ts
```

Expected: `OK`. This is a one-off confirmation; don't commit the probe.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/types/rescript-modules.d.ts` adds exactly one line
      `export type RouterConfig = tierConfig;` inside the Protocol module block
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run res:build` exits 0 with NO change to any `.res.mjs` output
      (`git status` shows only `src/types/rescript-modules.d.ts modified`)
- [ ] `pnpm run build` exits 0
- [ ] `pnpm test -- test/golden/protocol.golden.test.ts test/golden/assembled-prompt.golden.test.ts` → 50/50
- [ ] `pnpm test` → failure count unchanged from pre-plan baseline
- [ ] `grep -nE 'export type RouterConfig = tierConfig' src/types/rescript-modules.d.ts` returns exactly 1 hit
- [ ] `grep -rn 'export type tierConfig' src/router/Protocol.res src/router/Protocol.resi` returns unchanged matches (source untouched)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `declare module "*Protocol.res.mjs"` block in `rescript-modules.d.ts`
  has been removed or restructured since this plan was written — STOP and
  consult the live file; do not invent a new section.
- The TypeScript alias `RouterConfig = tierConfig` produces a type error
  (e.g. `Subsequent variable declarations must have the same type`).
  This means a `RouterConfig` declaration already exists somewhere — STOP
  and report the existing site; choose a different alias name or relocate.
- `pnpm run typecheck` reports the alias creates an *override* of an
  existing `RouterConfig` export from a different module — STOP. Do not
  create shadowing; the alias is meant only to expose an alternate name
  for `Protocol.tierConfig` inside the Protocol glob module.
- A different test goes red that wasn't red at HEAD `9c744be` — STOP and
  report which test; the alias is supposed to be zero-impact.

## Maintenance notes

- This plan DOES NOT rename `tierConfig` across the 11 consumers. That bulk
  rename is intentionally deferred — each consumer can adopt `RouterConfig`
  opportunistically when it's already being touched for another reason.
  Reviewers should encourage (but not block) the adoption over time.
- The `ReasoningCapability.tierConfig` per-tier type stays as-is; do not
  alias it. If a future contributor confuses the two, point at this plan
  and the rescript-modules.d.ts comment.
- The ABI bridge comment introduced by this plan (`canonical TS name;
  tierConfig kept as an alias for backward compat`) is the doc anchor
  future contributors will read — keep it accurate if the alias is ever
  promoted to the canonical name.
- Plan 027 (README test docs) is independent; the two may land in sequence
  or together. Plan 025 (Verify parity fixtures) is independent.