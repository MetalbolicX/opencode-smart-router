# Plan 020: Close the nested-delegation bypass via `session.created` + depth guard

> This plan was authored under plan mode and stored in `.opencode/plans/` because
> the repo `plans/` directory is locked during plan mode. **When implementation
> begins, copy this file to `plans/020-close-nested-delegation-bypass.md`** and
> update the repo `plans/README.md` index (add row 020, set status, add the
> dependency note in "Dependency notes"). The content below assumes repo-root
> paths (`src/...`, `plans/README.md`).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat fa9528b..HEAD -- src/plugin/hooks.ts src/router/sessions.ts src/plugin/runtime.ts src/verify/dispatch.ts src/plugin/types.ts test/unit`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 008 (008 shipped the minimal flat-Set guard this plan supersedes/strengthens)
- **Category**: bug
- **Planned at**: commit `fa9528b`, 2026-07-08

## Why this matters

Plan 008 blocked nested built-in `task` delegation by throwing in
`tool.execute.before` when `isSubagent(sid) && tool === "task"`. **That guard is
bypassable in production.** Advanced models (e.g. `medium`/`heavy` tiers) reason
about tool availability and actively decompose by delegating; when they call the
built-in `task` tool from a subagent, the call is **not** blocked — instead the
runtime creates a grandchild session, which **hangs the opencode runtime
permanently** (the SDK cannot create children of subagent sessions), and is only
killed later by the runtime's own timeout.

The guard misses for three compounding reasons (full evidence in "Root-cause
analysis" below):

1. **Registration is racy/conditional.** `isSubagent(sid)` reads a flat Set
   (`subagentSessionIDs`) populated only by `registerFromChatMessage`, which is
   an *async `chat.message` hook* gated on `input.agent && tierNames.includes(agent)`.
   If the SDK does not populate `input.agent` for a built-in `task` child, or the
   subagent calls `task` before the event fires, the session is never registered.
2. **Branch ordering swallows the call.** The orchestrator reasoning-patch
   branch at `hooks.ts:127` (`sid && tool === "task" && !isSubagent(sid)`) was
   added by plans 012/014/015 *after* 008 landed. An unregistered subagent
   satisfies `!isSubagent(sid)`, enters that branch, and returns at line 259 —
   the 008 guard at line 272 is **never reached**.
3. **Grandchildren are structurally invisible.** Grandchild sessions are created
   inside the opencode runtime; the plugin never observes their creation, so they
   are never registered. `isSubagent(grandchild)` is always `false`.

The fix re-keys the guard on **nesting depth** derived from `parentID`, and
populates that depth **synchronously** from the `session.created` event, which
the runtime emits *before* a child's first `tool.execute.before`. This eliminates
the race, closes the branch-ordering hole (the guard runs first), and makes
grandchildren moot (a depth-1 subagent is blocked before it can create a
grandchild). Per product decision, descendants are blocked from **both** the
built-in `task` tool and the plugin `delegate` tool.

## Root-cause analysis (evidence the executor must preserve)

### The 008 guard and the branch that bypasses it

`src/plugin/hooks.ts:91-98` extracts `sid` + `tool`:

```ts
export const handleToolExecuteBefore = async (ctx, input, output): Promise<void> => {
  if (ctx.state.bypassed) return;
  const sid = input?.sessionID as string | undefined;
  const tool = input?.tool as string | undefined;
```

`src/plugin/hooks.ts:127` — the orchestrator branch (added post-008). Note the
gate is `!isSubagent(sid)`:

```ts
if (sid && tool === "task" && !ctx.sessionStore.isSubagent(sid)) {
  // ... adaptive reasoning patch ...
  return;   // line 259 — returns here, so an UNREGISTERED subagent never reaches the guard
}
```

`src/plugin/hooks.ts:262-276` — the 008 guard. It only runs when
`isSubagent(sid)` is `true`:

```ts
if (!sid || !ctx.sessionStore.isSubagent(sid) || typeof tool !== "string") {
  return;   // line 263 — early return for anything not a registered subagent
}
if (tool === "task") {
  throw new Error("Nested subagent delegation is not allowed: ...");
}
```

**Failure path:** unregistered subagent calls `task` → line 127's
`!isSubagent(sid)` is `true` → enters orchestrator branch → returns at 259 →
guard at 272 never runs → real `task` executes → runtime creates grandchild →
hang.

### Flat-Set registration is the single point of failure

`src/router/sessions.ts:160-167`:

```ts
const subagentSessionIDs = new Set<string>();
// ...
isSubagent(sessionID: string): boolean {
  return subagentSessionIDs.has(sessionID);
},
```

The only writer for built-in `task` children is `registerFromChatMessage`
(`src/router/sessions.ts:208-232`), an **event-driven** hook gated on
`input.agent`:

```ts
registerFromChatMessage(input: { agent?: string; sessionID: string }, ...): void {
  if (input.agent && tierNames.includes(input.agent)) {   // gate — fails when agent is absent
    subagentSessionIDs.add(input.sessionID);
    // ...
  }
},
```

Two holes: (a) `chat.message` fires async, so a fast subagent can call `task`
first; (b) `input.agent` is optional and may be absent for built-in `task`
children, so the `if` never enters.

### No plugin-side timeout rescues the built-in `task` path

The `delegate` plugin tool has a 600s `withTimeout`
(`src/plugin/delegate.ts:304`). The **built-in `task` tool has none** — it is
runtime-internal. The `verifyTaskAfterHook` finally cleanup
(`src/verify/dispatch.ts:491-517`) only runs *after* the task returns; if the
child hangs, the finally never fires. So the hung grandchild is killed only by
opencode's own runtime timeout — the "hangs then dies after a while" symptom.

### The signal we DO have: `session.created` + `parentID`

`docs/adr/0000-spike-results.md:88-105` (empirical, Run 2) established the fix
foundation:

- The opencode runtime emits a **`session.created`** event received by the
  plugin's `event` hook. `parentID` lives at **`event.properties.info.parentID`**
  (NOT `event.properties.parentID`, which is always `null` — that path was a
  known Run-1 extractor bug). The child's `info.parentID` equals the
  orchestrator's session id.
- The `event` hook fires **before** the child's first `tool.execute.before`
  (natural lifecycle: create → first message → tool).
- The plugin factory runs **once** and serves all sessions, so the `event` hook
  sees grandchildren too — though we only ever need depth 1.

`plans/009-restore-parent-session-on-deletion.md:102-103` confirms the `Session`
type carries `parentID`:

```ts
// types.gen.d.ts:71 — Session has optional parentID
type Session = { id: string; parentID?: string; /* ... */ };
```

The plugin already has an `event` handler — `src/plugin/hooks.ts:427-453` — but
it only processes `session.idle` and **throws away `session.created`**:

```ts
export const handleSessionIdle = async (ctx, payload): Promise<void> => {
  const event = payload?.event;
  if (event?.type !== "session.idle") return;   // <-- discards session.created
```

The misleading comment at `src/plugin/hooks.ts:471` ("Child sessions are detected
via session.created events with a parentID") describes an **intent that was never
implemented** — the actual code at line 473 uses the flat `isSubagent()` Set.

## Current state

### Relevant files

- `src/plugin/hooks.ts` — hook entry points. `handleToolExecuteBefore` (line 91)
  is the guard site; `handleSessionIdle` (line 427) is the `event` handler to
  extend; `handleSystemTransform` (line 460) already relies on subagent
  detection at line 473.
- `src/router/sessions.ts` — the session store factory `createSessionStore()`
  (line 159). Owns `subagentSessionIDs` + `subagentCapState`. Needs a
  `parentMap` + depth API.
- `src/plugin/runtime.ts` — registers hooks (the `event` handler is wired at
  ~line 128; `toHookPayload` at line 74 is a bare cast, no fields dropped).
- `src/plugin/types.ts` — `EventInput`/`HookEventPayload` shape
  (`{ event?: { type?: string; properties?: unknown } }`, lines ~193-198);
  `asChatMessageInput` (line 140), `asToolCallInput` (line 166).
- `src/verify/dispatch.ts` — `verifyTaskAfterHook` finally cleanup (line 448)
  calls `ctx.sessionStore.unregister(sid)` at line 482; must transparently drop
  the parentMap edge.
- `test/unit/verify-dispatch.test.ts` — the `makeCtx(...)` harness pattern to
  mirror for new tests.
- `docs/adr/0000-spike-results.md` — the spike that established the
  `properties.info.parentID` path and event ordering.

### Existing `event` handler (the extension point)

`src/plugin/hooks.ts:427-453` — currently `session.idle`-only. The `event` hook
input type (`src/plugin/types.ts:~193-198`):

```ts
// Shape of the `event` hook payload: `{ event: { type, properties } }`.
// `properties` is intentionally `unknown` — the SDK does not publish a stable
// shape for session.idle payloads.
event?: { type?: string; properties?: unknown };
```

### Repo conventions to match

- TypeScript, ESM, Vitest for unit tests, Biome for lint/format.
- Conventional commits — recent examples: `fix(plugin): ...`, `fix(router): ...`,
  `refactor(plugin): ...`.
- Hook code favors minimal runtime guards, best-effort non-crashing cleanup, and
  explicit comments explaining safety constraints. Match that tone.
- The store already has a `registerProducerSession(sid, tier, cfg)` pattern
  (synchronous registration from the `delegate` tool at
  `src/plugin/delegate.ts:~229`) — mirror its shape for the new registrar.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat fa9528b..HEAD -- src/plugin/hooks.ts src/router/sessions.ts src/plugin/runtime.ts src/verify/dispatch.ts src/plugin/types.ts` | no unexpected drift, or drift reconciled |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Unit tests | `pnpm test` | all pass |
| Targeted tests | `pnpm test -- test/unit/sessions-store.test.ts test/unit/hooks.test.ts` (adjust to real paths) | new/updated tests pass |
| Lint | `pnpm lint` | exit 0 |

(Commands verified from `package.json` scripts: `test` = `vitest run`,
`typecheck` = `tsc --noEmit`, `lint` = `biome check`.)

## Scope

**In scope** (the only files you should modify):

- `src/router/sessions.ts` — add `parentMap`, `registerFromSessionCreated`,
  `depth`/`isDescendant`; extend `unregister`.
- `src/plugin/hooks.ts` — add a `session.created` branch in the `event`
  handler; reorder `handleToolExecuteBefore` so the depth guard runs **before**
  the orchestrator reasoning-patch branch; guard now covers `task` AND
  `delegate`.
- `test/unit/sessions-store.test.ts` — new tests for depth/registration (create
  if absent, else add to the closest existing sessions-store test file).
- `test/unit/hooks.test.ts` — new/updated tests for the reordered guard (create
  if absent — 008 may have created it).

**Out of scope** (do NOT touch):

- `src/verify/dispatch.ts` — **no algorithm change**. The existing
  `unregister(sid)` call at line 482 transparently drops the parentMap edge once
  `unregister` is extended. Do not move cleanup logic or change verification
  semantics.
- The `chat.message` registration path (`registerFromChatMessage`) — keep it as
  a **secondary** registration for cap/triviality state; do not delete it. The
  `session.created` registrar becomes the *primary* subagent-identity source.
- opencode core / TUI session restoration (that is plan 009's domain).
- Any change to the public response shape or tier-agent registration.
- Adding hierarchy metadata to `SubagentState` beyond what `parentMap` needs.

## Git workflow

- Branch: `advisor/020-close-nested-delegation-bypass`
- Commit per logical unit (suggested split: store → hook → tests). Conventional
  commits, e.g. `fix(router): track session depth via session.created parentID`,
  `fix(plugin): block task+delegate for descendant sessions by depth`,
  `test(hooks): cover depth guard and session.created registration`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add depth tracking + `session.created` registration to the session store

Edit `src/router/sessions.ts`.

1. Add a module-level `const parentMap = new Map<string, string>();` alongside
   the existing `subagentSessionIDs` / `subagentCapState` (inside the
   `createSessionStore()` closure, ~line 161). Keys are child session IDs,
   values are parent session IDs.
2. Add a registrar keyed off `parentID`:

   ```ts
   /**
    * Called from the `event` hook on `session.created`. Records the child→parent
    * edge and marks the child as a subagent whenever it has a non-null parent
    * (i.e. it is not the root/orchestrator). This is the PRIMARY, race-free
    * subagent-identity source: `session.created` fires before the child's first
    * `tool.execute.before` (see docs/adr/0000-spike-results.md).
    *
    * `parentID` is read from `event.properties.info.parentID` — NOT
    * `properties.parentID` (always null; known Run-1 extractor bug).
    */
   registerFromSessionCreated(sessionID: string, parentID: string | null): void {
     if (!sessionID) return;
     if (parentID) {
       parentMap.set(sessionID, parentID);
       subagentSessionIDs.add(sessionID);
       // Initialise cap state lazily if absent (tier/triviality are filled in
       // later by registerFromChatMessage, or default to a permissive baseline).
       if (!subagentCapState.has(sessionID)) {
         subagentCapState.set(sessionID, {
           tierName: "", cap: Number.POSITIVE_INFINITY, calls: 0,
           seen: new Map(), trivial: false,
         });
       }
     }
     // Root/orchestrator sessions (parentID null) are intentionally NOT added.
   },
   ```

3. Add depth + ancestry queries:

   ```ts
   /** Returns the parent session ID for a tracked child, or null. */
   parentOf(sessionID: string): string | null {
     return parentMap.get(sessionID) ?? null;
   },

   /**
    * Nesting depth: 0 for root/orchestrator, ≥1 for any descendant. Walks the
    * parent chain; bounded by chain length (small — typically ≤2). Used by the
    * before-hook to block delegation from descendants.
    */
   depth(sessionID: string): number {
     let d = 0;
     let cur = parentMap.get(sessionID);
     const guard = new Set<string>();        // cycle guard (defensive)
     while (cur && !guard.has(cur)) {
       guard.add(cur);
       d += 1;
       cur = parentMap.get(cur);
     }
     return d;
   },

   /** True when the session is a descendant of any other session (depth ≥ 1). */
   isDescendant(sessionID: string): boolean {
     return this.depth(sessionID) >= 1;
   },
   ```

4. Extend `unregister` so cleanup drops the edge (keep it best-effort, wrapped
   so the existing `verifyTaskAfterHook` finally call at
   `src/verify/dispatch.ts:482` works unchanged):

   ```ts
   unregister(sessionID: string): void {
     subagentSessionIDs.delete(sessionID);
     subagentCapState.delete(sessionID);
     parentMap.delete(sessionID);
     // Also drop any children pointing at this session, so stale edges do not
     // inflate depth for a recycled id (defensive; ids are unique in practice).
     for (const [child, parent] of parentMap) {
       if (parent === sessionID) parentMap.delete(child);
     }
   },
   ```

Keep the return-object shape backward-compatible: existing `isSubagent`,
`getTier`, `isTrivial`, `registerProducerSession`, `registerFromChatMessage`,
`recordToolCall` signatures are unchanged.

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Register from `session.created` in the `event` handler

Edit `src/plugin/hooks.ts`, function `handleSessionIdle` (line 427). Add a
`session.created` branch **before** the existing `session.idle` filter so the
edge is recorded synchronously at creation time.

Replace:

```ts
export const handleSessionIdle = async (ctx, payload): Promise<void> => {
  const event = payload?.event;
  if (event?.type !== "session.idle") return;
```

with:

```ts
export const handleSessionEvent = async (ctx, payload): Promise<void> => {
  const event = payload?.event;
  if (!event || typeof event.type !== "string") return;

  // session.created — race-free subagent registration. parentID lives at
  // properties.info.parentID (NOT properties.parentID, which is always null —
  // see docs/adr/0000-spike-results.md Run 2). Fires before the child's first
  // tool.execute.before, so the depth guard in handleToolExecuteBefore always
  // sees the edge.
  if (event.type === "session.created") {
    try {
      const props = (event.properties ?? {}) as Record<string, unknown>;
      const info = (props.info ?? {}) as Record<string, unknown>;
      const childSid =
        typeof info.id === "string" ? info.id
        : typeof props.sessionID === "string" ? props.sessionID : null;
      const parentID =
        typeof info.parentID === "string" ? info.parentID : null;
      if (childSid) ctx.sessionStore.registerFromSessionCreated(childSid, parentID);
    } catch {
      // best-effort: a registration failure must never crash a real session.
    }
    return;
  }

  if (event.type !== "session.idle") return;
  // ... existing session.idle handling unchanged ...
```

Notes:
- If you rename `handleSessionIdle` → `handleSessionEvent`, update its call site
  in `src/plugin/runtime.ts` (the `event` hook registration, ~line 128) to match.
  Prefer the rename for clarity, but a no-rename approach (just add the branch)
  is acceptable if it minimizes diff churn.
- Read `properties.info.parentID`, never `properties.parentID`. That single path
  mistake was the Run-1 failure — honor it.

**Verify**: `pnpm typecheck` → exit 0

### Step 3: Re-key the before-hook guard on depth; block `task` AND `delegate`

Edit `src/plugin/hooks.ts`, function `handleToolExecuteBefore` (line 91).

The ordering change is the crux: the descendant-delegation block must run
**before** the orchestrator reasoning-patch branch so an unregistered-looking
descendant cannot be swallowed. After the `sid`/`tool` extraction (lines 97-98),
insert the depth guard first:

```ts
const sid = input?.sessionID as string | undefined;
const tool = input?.tool as string | undefined;

// Fail-fast nested-delegation guard (supersedes Plan 008's flat-Set check).
// A descendant session (depth ≥ 1) must NEVER delegate, because creating
// children of subagent sessions hangs the opencode runtime permanently.
// Depth is derived from parentID recorded synchronously by the session.created
// handler, so this does not depend on the racy chat.message registration.
// Blocks BOTH the built-in `task` tool and the plugin `delegate` tool.
if (sid && typeof tool === "string" && (tool === "task" || tool === "delegate")) {
  if (ctx.sessionStore.depth(sid) >= 1) {
    throw new Error(
      "Nested delegation is not allowed: subagent sessions cannot call task or delegate",
    );
  }
}
```

Then re-gate the existing orchestrator branch (line 127) so it only applies at
depth 0:

```ts
if (sid && tool === "task" && ctx.sessionStore.depth(sid) === 0) {
  // ... existing adaptive reasoning patch, unchanged ...
  return;   // line ~259
}
```

Finally, the old 008 guard block (lines 262-276) becomes redundant for `task`
but is harmless as defense-in-depth. Leave it in place OR simplify it to the
non-task subagent enforcement flow (`guardBeforeCall` for read-only tools). Do
**not** remove the early return at line 263 for non-subagent non-task tools.
Prefer minimal change: keep the block, since the depth guard above already
handles `task`/`delegate`.

**Why this closes all three bypass gaps:**
- Race: depth is set synchronously at `session.created`, before any tool call.
- Branch ordering: the depth guard runs *before* the orchestrator branch.
- Grandchild invisibility: moot — depth-1 subagent is blocked before it can
  create a grandchild.

**Verify**:
- `pnpm typecheck` → exit 0
- `pnpm test` → all pass (existing 008 tests may need the error-text update — see Step 4)

### Step 4: Tests — depth store + reordered guard

Create/extend tests mirroring `test/unit/verify-dispatch.test.ts`'s `makeCtx`
style (fake `PluginContext`, explicit mocked store, direct invocation).

**`test/unit/sessions-store.test.ts`** (or the closest existing sessions-store
test file) — add:

| Case | Setup | Assertion |
|---|---|---|
| root depth 0 | `registerFromSessionCreated("root", null)` | `depth("root") === 0`, `isDescendant("root") === false` |
| child depth 1 | register root, then `registerFromSessionCreated("child", "root")` | `depth("child") === 1`, `isSubagent("child") === true` |
| grandchild depth 2 | register root→child→grandchild | `depth("grandchild") === 2` |
| unregister drops edge | register child, `unregister("child")` | `depth("child") === 0`, `parentOf("child") === null` |
| cycle defensive | manually craft a 2-node cycle via internal API if exposed, else skip | `depth` terminates (bounded) |
| parentID null path | `registerFromSessionCreated("root2", null)` | not added to `subagentSessionIDs` |

**`test/unit/hooks.test.ts`** — add/extend:

| Case | Setup | Assertion |
|---|---|---|
| depth-0 `task` allowed | mock `depth(sid)` → 0, tool `task` | hook does not throw the nested error (may run reasoning patch) |
| depth-1 `task` blocked | mock `depth(sid)` → 1, tool `task` | throws `"Nested delegation is not allowed: subagent sessions cannot call task or delegate"` |
| depth-1 `delegate` blocked | mock `depth(sid)` → 1, tool `delegate` | throws the same nested-delegation error |
| depth-2 `task` blocked | mock `depth(sid)` → 2, tool `task` | throws (grandchild case) |
| depth-1 read-only tool allowed | mock `depth(sid)` → 1, tool `read` | does not throw nested-delegation error (continues to cap/guard flow) |
| `session.created` registers child | call `handleSessionEvent` with `{ event: { type: "session.created", properties: { info: { id: "c1", parentID: "root" } } } }` | `ctx.sessionStore.depth("c1") === 1` |
| `session.created` ignores null parent | same with `parentID: null` | `depth` stays 0, not added to subagent set |
| `session.created` reads `.info.parentID` not `.parentID` | payload with `properties.parentID: "x"` but `properties.info.parentID: null` | treated as root (depth 0) — proves the path matters |
| `session.idle` still works | `handleSessionEvent` with `session.idle` payload | existing scorecard path unchanged (no throw) |

If plan 008 already created `test/unit/hooks.test.ts` with assertions on the old
error text (`"Nested subagent delegation is not allowed: subagent sessions cannot
call the built-in task tool"`), update those assertions to the new message and
re-mock via `depth(sid)` instead of `isSubagent(sid)`. Note in the commit body
that 008's flat-Set tests are superseded by depth-based tests.

**Verify**:
- `pnpm test -- test/unit/sessions-store.test.ts test/unit/hooks.test.ts` → all pass
- `pnpm test` → all pass (whole suite green)

### Step 5: Repo-wide verification + index update

1. `pnpm typecheck` → exit 0
2. `pnpm test` → exit 0
3. `pnpm lint` → exit 0
4. Update `plans/README.md`:
   - Add row 020 to the status table: `| 020 | Close nested-delegation bypass via session.created + depth guard | P1 | M | MED | 008 | DONE |`
   - Add a dependency note under "Dependency notes": "**020 supersedes 008's flat-Set guard.** 008's minimal fix was correct given the information at the time and explicitly deferred parent/depth tracking. The orchestrator reasoning-patch branch added later by 012/014/015 (`hooks.ts:127`) created a bypass where an unregistered subagent's `task` call was swallowed before reaching 008's guard. 020 closes it by deriving depth from `parentID` recorded synchronously at `session.created` (fires before the child's first `tool.execute.before`) and blocking `task`+`delegate` at depth ≥ 1 before the orchestrator branch."

## Test plan

New/updated test files: `test/unit/sessions-store.test.ts`, `test/unit/hooks.test.ts`.

Structural pattern: `test/unit/verify-dispatch.test.ts` (`makeCtx` fake context +
mocked store + direct hook invocation + behavior-first assertions).

Coverage goals (all must pass):
- Depth store: root/child/grandchild depths, unregister cleanup, null-parent
  root, defensive cycle termination.
- Before-hook guard: depth-0 allowed, depth≥1 `task` blocked, depth≥1 `delegate`
  blocked, depth≥1 read-only tools unaffected.
- `session.created` handler: registers child via `.info.parentID`, ignores
  `.parentID` (the null-path bug), null parent stays root, `session.idle`
  path unchanged.

Do **not** add integration/smoke tests for this plan — the spike
(`docs/adr/0000-spike-results.md`) already established the runtime event
ordering; unit tests on the handler + store are sufficient and deterministic.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/router/sessions.ts` exposes `parentMap` (internal), `depth(sid)`,
      `isDescendant(sid)`, `parentOf(sid)`, `registerFromSessionCreated(sid, parentID)`;
      `unregister` drops the edge.
- [ ] `src/plugin/hooks.ts` registers subagents from `session.created` via
      `properties.info.parentID`, and blocks `task`/`delegate` for `depth(sid) >= 1`
      **before** the orchestrator reasoning-patch branch.
- [ ] A depth-1 subagent calling `task` throws the new nested-delegation error
      (no grandchild created, no hang).
- [ ] A depth-0 orchestrator calling `task` still runs the reasoning patch
      (unchanged behavior).
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new tests for depth + guard + session.created exist and pass
- [ ] `pnpm lint` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` row 020 = DONE; dependency note recorded

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations no longer matches the excerpts —
  especially if `handleToolExecuteBefore` no longer extracts `sid`/`tool`, or the
  orchestrator branch at line 127 has moved/changed its gate.
- The `event` hook payload does not carry `properties.info.parentID` on
  `session.created` in the live runtime (re-run the spike probe if unsure; the
  field path was established empirically in `0000-spike-results.md` Run 2 — if it
  has changed, this plan's registration approach is invalid).
- The root/orchestrator session's `session.created` carries a non-null
  `parentID` (would break the depth-0 baseline) — report so the registrar can
  distinguish root explicitly.
- The only clean implementation appears to require changing `src/verify/dispatch.ts`
  algorithm (out of scope — the existing `unregister(sid)` call must suffice).
- An existing test proves nested delegation is intentionally allowed in some case
  (would contradict the product decision to block at depth ≥ 1).
- `session.created` does NOT fire before the child's first `tool.execute.before`
  in the live runtime (would reintroduce the race — report so a fallback is
  designed).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **This plan supersedes Plan 008's flat-Set guard.** 008's minimal fix was
  correct given the information at the time and its STOP conditions explicitly
  deferred parent/depth tracking. 020 is the depth-based hardening 008 deferred,
  plus the `session.created` registration that closes the bypass 008 could not
  foresee (the orchestrator branch that created the hole was added later by
  012/014/015).
- **Field-path invariant**: always read `properties.info.parentID`, never
  `properties.parentID`. If a future opencode SDK change moves the field, the
  `session.created` branch will silently stop registering subagents — the
  depth-based guard will then under-block. A defensive check (log when a
  `session.created` has neither path) would make a regression visible.
- **Reviewer focus in the PR:**
  - Confirm the depth guard runs *before* the orchestrator reasoning-patch
    branch (the ordering is the crux — a future refactor that moves the branch
    above the guard reintroduces the bypass).
  - Confirm both `task` and `delegate` are blocked at depth ≥ 1.
  - Confirm `unregister` (called by `verifyTaskAfterHook` at
    `dispatch.ts:482`) drops the parentMap edge with no dispatch.ts change.
  - Confirm the `session.created` branch reads `.info.parentID`.
- **Follow-up explicitly deferred:**
  - If the product ever needs *real* nested subagents (depth > 1 allowed), the
    fix is to change the depth threshold from `≥ 1` to `> N` AND confirm the
    opencode SDK can parent sessions beyond depth 1 without hanging. That is an
    architecture feature, not a tweak.
  - Logging/analytics on how often the guard fires, so the bypass frequency can
    be measured post-ship.
