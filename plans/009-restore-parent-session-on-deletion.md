# Plan 009: TUI plugin to restore parent session on child deletion

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bfd12e1..HEAD -- rolldown.config.js package.json src/tui.ts src/tui/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (complements plan 008 but does not require it)
- **Category**: bug
- **Planned at**: commit `bfd12e1`, 2026-06-30

## Why this matters

When a subagent session is killed or deleted, the opencode TUI falls back to a
blank "home" view instead of restoring focus to the parent (orchestrator)
session. This happens because opencode core's session-deletion handler does not
walk the `parentID` chain to find a restoration target.

A server-side plugin cannot fix this — it has no TUI navigation API. But a
`TuiPlugin` (loaded from `tui.json`, not `opencode.json`) has access to
`api.event.on("session.deleted")`, `api.route.navigate()`, and
`api.client.session.get()`. This plan adds a lightweight TUI plugin that
intercepts child-session deletion and redirects the view to the parent.

This is a **mitigation** layered on top of the real core bug. The permanent fix
belongs in opencode core's TUI session-deletion handler, but this plugin
provides immediate relief without waiting for an upstream release.

## Current state

### How TUI plugins are structured

TUI plugins are discovered from `~/.config/opencode/tui.json` (separate from
`opencode.json` which loads server plugins). A TUI plugin module exports:

```ts
// node_modules/@opencode-ai/plugin/dist/tui.d.ts:505-509
export type TuiPluginModule = {
    id?: string;
    tui: TuiPlugin;
    server?: never;   // mutual exclusion with server plugin
};
```

Import path: `@opencode-ai/plugin/tui` (from `package.json` exports field).

### The TuiPluginApi surface

```ts
// node_modules/@opencode-ai/plugin/dist/tui.d.ts:458-503
export type TuiPluginApi = {
    route: {
        register: (routes: TuiRouteDefinition[]) => () => void;
        navigate: (name: string, params?: Record<string, unknown>) => void;
        readonly current: TuiRouteCurrent;
    };
    client: OpencodeClient;      // full SDK client — session.get, etc.
    event: TuiEventBus;          // listen for session.deleted
    lifecycle: TuiLifecycle;     // onDispose cleanup
    state: TuiState;             // session.get local cache
    // ... app, keys, ui, theme, etc.
};
```

### Key types

```ts
// tui.d.ts:13-24
type TuiRouteCurrent = {
    name: "home";
} | {
    name: "session";
    params: { sessionID: string; prompt?: unknown; };
} | { name: string; params?: Record<string, unknown>; };

// tui.d.ts:406-410
type TuiEventBus = {
    on: <Type extends Event["type"]>(
        type: Type,
        handler: (event: Extract<Event, { type: Type }>) => void
    ) => () => void;  // returns unsubscribe function
};

// types.gen.d.ts:5370-5377
type EventSessionDeleted = {
    type: "session.deleted";
    properties: { sessionID: string; info: Session };
};

// types.gen.d.ts:71 — Session has optional parentID
type Session = { id: string; parentID?: string; /* ... */ };
```

### Existing reference TUI plugins

Two installed TUI plugins follow the standard structure:

- `~/.config/opencode/node_modules/opencode-subagent-statusline/` — exports
  `declare const plugin: TuiPluginModule; export { plugin as default }`
- `~/.config/opencode/node_modules/opencode-sdd-engram-manage/` — same pattern

Both export `{ id, tui }` as the default export.

### This repo's current build setup

`rolldown.config.js` currently:
```js
input: "src/index.ts",
output: { file: "dist/plugin.mjs", format: "esm" },
```

`package.json` has no `exports` field; `"main": "./src/index.ts"`.

To add a TUI plugin, the build needs a second entry point rendering
`src/tui.ts` to `dist/tui.mjs`.

### Repo conventions

- TypeScript, ESM (`"type": "module"`)
- Biome for lint/format
- Vitest for tests
- Conventional commits: `fix(tui): ...`, `feat(tui): ...`

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm run typecheck` | exit 0 |
| Unit tests | `pnpm run test` | all pass |
| Build | `pnpm run build` | exit 0, `dist/tui.mjs` exists |
| Lint | `pnpm run lint` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/tui.ts` (create) — TUI plugin entry point
- `src/tui/restore-parent.ts` (create) — pure decision logic
- `test/unit/tui-restore-parent.test.ts` (create) — unit tests for decision logic
- `rolldown.config.js` (edit) — add second entry point
- `package.json` (edit) — add `exports` field mapping `./tui`

**Out of scope** (do NOT touch, even though they look related):
- `src/index.ts` — the server plugin entry point, unchanged
- `src/plugin/`, `src/verify/`, `src/router/` — server plugin internals
- opencode core TUI source (not available locally)
- Integration/smoke tests requiring a running TUI
- UI components (SolidJS slots, statusline, etc.) — this plugin has no visual UI
- Any change to `~/.config/opencode/tui.json` — registration is manual/post-plan

## Git workflow

- Branch: `advisor/009-restore-parent-session-on-deletion`
- Commit as one logical unit
- Commit message style: `fix(tui): restore parent session after child deletion`
- Do NOT push or open a PR unless explicitly instructed

## Steps

### Step 1: Create the pure decision function

Create `src/tui/restore-parent.ts` with the following content:

```ts
/**
 * Determine whether the TUI should restore focus to a parent session after
 * a child session is deleted.
 *
 * Policy table:
 *   viewing deleted child + has parent       → yes (navigate to parent)
 *   home (blank)           + has parent       → yes (navigate to parent)
 *   viewing parent already + has parent       → yes (navigate is a no-op)
 *   viewing unrelated sess + has parent       → no  (don't yank the user)
 *   any route              + no parentID      → no  (nothing to restore)
 *   unknown route          + has parent       → yes (conservative restore)
 */
export function shouldRestoreParent(
  current: { name: string; params?: Record<string, unknown> },
  deletedSessionID: string,
  parentID: string | undefined,
): boolean {
  if (!parentID) return false;
  if (current.name === "session") {
    const viewing = current.params?.sessionID;
    // Don't yank if viewing a different session
    if (viewing !== deletedSessionID && viewing !== parentID) return false;
  }
  // home, unknown, or viewing the deleted/parent session — restore
  return true;
}
```

This is a pure function with no side effects. It encodes the navigation policy
table from "Why this matters" and is independently testable.

**Verify**: `pnpm run typecheck` → exit 0

### Step 2: Create unit tests for the decision function

Create `test/unit/tui-restore-parent.test.ts` with tests covering every row of
the policy table:

```ts
import { describe, it, expect } from "vitest";
import { shouldRestoreParent } from "../../src/tui/restore-parent";

function current(name: string, sessionID?: string) {
  return sessionID !== undefined
    ? { name, params: { sessionID } }
    : { name, params: {} };
}

describe("shouldRestoreParent", () => {
  it("returns true when viewing the deleted child and parent exists", () => {
    expect(shouldRestoreParent(current("session", "child"), "child", "parent")).toBe(true);
  });

  it("returns true when home (blank) and parent exists", () => {
    expect(shouldRestoreParent(current("home"), "child", "parent")).toBe(true);
  });

  it("returns true when already viewing the parent (no-op)", () => {
    expect(shouldRestoreParent(current("session", "parent"), "child", "parent")).toBe(true);
  });

  it("returns false when viewing an unrelated session", () => {
    expect(shouldRestoreParent(current("session", "other"), "child", "parent")).toBe(false);
  });

  it("returns false when deleted session has no parentID", () => {
    expect(shouldRestoreParent(current("home"), "root", undefined)).toBe(false);
    expect(shouldRestoreParent(current("session", "root"), "root", undefined)).toBe(false);
  });

  it("returns true for unknown route name with parent", () => {
    expect(shouldRestoreParent(current("custom"), "child", "parent")).toBe(true);
  });
});
```

**Verify**: `npx vitest run --reporter=verbose test/unit/tui-restore-parent.test.ts` → 6 tests all pass

### Step 3: Create the TUI plugin entry point

Create `src/tui.ts`:

```ts
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import { shouldRestoreParent } from "./tui/restore-parent";

const plugin: TuiPluginModule = {
  id: "opencode-agent-router-tui",
  tui: async (api) => {
    const off = api.event.on("session.deleted", (event) => {
      const deletedID = event.properties.sessionID;
      const parentID = event.properties.info.parentID;
      if (!shouldRestoreParent(api.route.current, deletedID, parentID)) return;

      // Defer navigation so core finishes its own deletion handling first,
      // then we override the blank-session fallback.
      setTimeout(() => {
        // Re-check current after core has settled
        if (!shouldRestoreParent(api.route.current, deletedID, parentID)) return;

        // Verify the parent session still exists before navigating
        api.client.session
          .get({ sessionID: parentID })
          .then((result) => {
            if (result.data) {
              api.route.navigate("session", { sessionID: parentID });
            }
          })
          .catch(() => {
            // parent doesn't exist — leave the user where they are
          });
      }, 0);
    });

    api.lifecycle.onDispose(() => off());
  },
};

export default plugin;
```

Key design points:
- `setTimeout(0)` defers navigation so core finishes its own deletion handling
  first, then we override the blank-session fallback.
- Double-check `shouldRestoreParent` both synchronously and after the timeout
  to avoid race conditions when the route changes between now and then.
- `api.client.session.get()` verifies the parent exists before navigating.
- `api.lifecycle.onDispose()` cleans up the event listener on plugin unload.

**Verify**: `pnpm run typecheck` → exit 0

### Step 4: Add the TUI build entry point

Edit `rolldown.config.js`. The current config is approximately:

```js
export default {
  input: "src/index.ts",
  output: { file: "dist/plugin.mjs", format: "esm" },
};
```

Add a second entry point for the TUI plugin. The exact approach depends on
rolldown's multi-entry support:

- If rolldown supports `input: { plugin: "src/index.ts", tui: "src/tui.ts" }`,
  use that and add a corresponding `output` per entry.
- Otherwise, use an array config with one element per entry.

The target output must be: `dist/tui.mjs` from `src/tui.ts`.

**Verify**: `pnpm run build` → exit 0, `ls dist/tui.mjs` exists

### Step 5: Add exports field to package.json

Edit `package.json`. Add an `exports` field that maps both the server and TUI
entry points, following the pattern from the installed reference plugins:

```json
{
  "type": "module",
  "main": "./dist/plugin.mjs",
  "exports": {
    ".": {
      "import": "./dist/plugin.mjs"
    },
    "./tui": {
      "import": "./dist/tui.mjs"
    }
  }
}
```

Keep all existing fields unchanged. Add `exports` only if it does not already
exist; if it does, extend it with the `./tui` mapping.

**Verify**: `pnpm run build` → exit 0, both entry points resolve

### Step 6: Run full repo verification

**Verify**:
- `pnpm run typecheck` → exit 0
- `pnpm run test` → all pass
- `pnpm run lint` → exit 0
- `pnpm run build` → exit 0, `dist/plugin.mjs` and `dist/tui.mjs` both exist

## Test plan

New test file: `test/unit/tui-restore-parent.test.ts`

| Test case | Current route | Deleted ID | Parent ID | Expected |
|---|---|---|---|---|
| viewing deleted child | `session/child` | child | parent | `true` |
| home after kill | `home` | child | parent | `true` |
| already on parent | `session/parent` | child | parent | `true` |
| viewing unrelated session | `session/other` | child | parent | `false` |
| no parent (root deleted) | any | root | undefined | `false` |
| unknown route | `custom` | child | parent | `true` |

Do NOT write integration tests that require a running TUI. The pure-function
tests are sufficient to lock the navigation policy.

## Done criteria

All of the following must hold:

- [ ] `src/tui/restore-parent.ts` exports `shouldRestoreParent` with the policy table
- [ ] `src/tui.ts` exports a `TuiPluginModule` that listens for `session.deleted`
- [ ] `test/unit/tui-restore-parent.test.ts` covers all 6 policy cases
- [ ] `rolldown.config.js` produces `dist/tui.mjs` from `src/tui.ts`
- [ ] `package.json` has `exports` mapping for `./tui`
- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run test` exits 0
- [ ] `pnpm run lint` exits 0
- [ ] `pnpm run build` exits 0, both `dist/plugin.mjs` and `dist/tui.mjs` exist
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if any of these occur:

- `@opencode-ai/plugin/tui` import path does not resolve — the installed plugin
  SDK version may not expose the TUI entry point. Check
  `node_modules/@opencode-ai/plugin/package.json` exports for `"./tui"`.
- `TuiPluginApi` does not expose `route.navigate` or `event.on` in the installed
  version — the API may have changed. Compare against `tui.d.ts` before
  proceeding.
- `rolldown` does not support multiple entry points in the current config format
  without significant restructuring. If the build change is larger than adding a
  second input/output pair, stop and report.
- `EventSessionDeleted` does not include `info.parentID` in the installed SDK
  version. Check `types.gen.d.ts` for the exact event shape.
- The `setTimeout(0)` deferral approach does not work because the TUI event loop
  processes events differently than expected. If manual testing shows the
  navigation fires too early or too late, stop and report for design adjustment.
- The `pnpm run build` produces a server-plugin entry that conflicts with or
  overwrites the TUI entry. This repo was designed as a server plugin; adding a
  TUI output must not regress the server output.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- This is a **mitigation**, not a permanent fix. The real fix belongs in
  opencode core's TUI session-deletion handler (at
  `github.com/anomalyco/opencode`).
- When opencode core fixes this upstream, this TUI plugin can be removed.
- The `setTimeout(0)` deferral is intentional — it lets core finish its
  deletion handling before we override the navigation. If core's timing
  changes in a future version, this delay may need adjustment.
- The `shouldRestoreParent` policy table is the single source of truth for
  when to intervene. Any future policy change should modify only that function
  and its tests.
- Registration: after building, the `dist/tui.mjs` output must be added to
  `~/.config/opencode/tui.json` under the `plugin` array to be loaded. This is
  a manual step outside this plan.
- Reviewer focus:
  - confirm `shouldRestoreParent` matches the policy table exactly
  - confirm event listener cleanup via `lifecycle.onDispose`
  - confirm the build produces both server and TUI outputs
  - confirm no existing server plugin behavior is affected
