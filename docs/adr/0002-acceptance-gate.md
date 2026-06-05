# ADR 0002 — Layer 2: Independent Acceptance Gate

> **Status:** Accepted **Date:** 2026-06-05 **Wave/Phase:** 2.0
> **Supersedes:** none **Depends on:** ADR 0000 (spike capabilities A/B/C), ADR 0001 (Layer 1 guard)
> **Deciders:** implementer + Senior-QA (self-review)

## Context

Layer 1 (hard-block guard) stops a weak subagent from thrashing, but it cannot tell whether the subagent's *output is correct*. The plan's central thesis (§0) is to convert the router from *"the weak model says it finished"* into *"the weak model's output was objectively accepted"*. That requires an **independent acceptance gate**: a delegation's result is not trusted until either a **deterministic check** (tests/build/lint/file/schema) or an **independent grader model** (producer ≠ grader, grader ≥ producer tier) returns PASS.

This ADR fixes the architecture, the verdict schema, the DoD sources, the artefact contract, the producer≠grader / grader≥producer enforcement, the verification locus, and concurrency handling. Implementation lands in Phases 2.1–2.4.

## Spike-confirmed primitives (the deciding facts)

From the Phase 2.0 pre-flight recon (types in `node_modules/@opencode-ai/{plugin,sdk}`):

- **`PluginInput.client: OpencodeClient`** (`plugin/dist/index.d.ts:10–17`) exposes `client.session.create()` and **`client.session.prompt({ path:{id}, body:{ model?, agent?, system?, tools?, parts } })`** which **sends a prompt and awaits the full assistant reply** → `{ info: AssistantMessage, parts: Part[] }` (`sdk/dist/gen/...`). There is also `promptAsync` (fire-and-forget) and `session.messages()` (list a session's messages/tool calls).
- **`PluginInput.$: BunShell`** + `directory` + `worktree` — a workspace-scoped shell/exec seam for deterministic checks.
- **Custom tool registration** (cap B, ADR 0000): `tool({ description, args, execute(args, ctx) })` returned under the factory's `tool` map. **`ToolContext` has NO `client`** — but the tool's `execute` is a **closure created inside the plugin factory**, so it captures `client`, `$`, `directory`, `worktree` from `PluginInput`. This is the linchpin: a plugin-owned `delegate` tool can drive a producer sub-session **and** a grader sub-session and run deterministic checks, all within a single `execute()` call, returning only an accepted result.
- **Raw `Task()` interception** (cap C, ADR 0000): the built-in `task` tool's `tool.execute.after` output carries the subagent's final return wrapped `<task_result>…</task_result>` + metadata `{parentSessionId, sessionId}`; changed files are attributable to the child `sessionID`'s edit/write calls seen in `tool.execute.after`.

## Decision

### D1 — Two-track rollout (Option i first, Option ii is the authoritative end-state)

- **Option (i) — verify-dispatch around raw `Task()` (advisory-grade gate).** When the orchestrator uses the built-in `Task()`, the plugin observes the `task` after-hook, assembles the artefact, runs the gate, **records the verdict**, and (in enforced mode) **appends a forcing note** to the task result when the verdict is FAIL. It **cannot** force a retry on an already-completed `task` call, so by itself Option (i) is *advisory-grade* for acceptance. Ships first because it is low-risk and additive.
- **Option (ii) — plugin-provided `delegate` tool (authoritative gate + escalation).** A custom `delegate` tool whose `execute` closure uses the captured `client` to: **produce** (`session.create` + `session.prompt` to the producer tier/agent), **assemble** the artefact, **gate** (deterministic and/or checker), and on FAIL **hand to the Layer-3 ladder** (Wave 3) to retry/escalate, finally **returning only an accepted result** (or an honest `status:"unmet"`). This is the robust path that actually realises GA-3. Raw `Task()` continues to work unchanged.

Both tracks **share one gate implementation** (`src/verify/gate.ts`) and one DoD type (`src/verify/dod.ts`) so Mode A (on-the-fly) and Mode B (plan-annotated) converge on a single code path (GA-5).

### D2 — Verdict schema (fixed)

```ts
type VerifyMethod = "deterministic" | "checker" | "none";
interface Verdict {
  pass: boolean;            // accept iff true
  method: VerifyMethod;     // how it was decided
  reasons: string[];        // human-readable, fail-closed; ALWAYS populated on FAIL
  evidence?: string;        // scrubbed: exit codes, failing check ids, grader citation; NEVER raw secrets
}
```

- A `none` method is **never** an implicit PASS. `none` arises only for trivial-bypass or "no checkable DoD and not required"; it yields `pass:true` **only** when policy explicitly allows skipping (see D5), and is recorded as `verdict:"SKIPPED"` in telemetry — distinct from a real PASS.
- **Fail-closed everywhere:** any internal error (grader dispatch throws, unparseable grader output, exec seam error, timeout) → `pass:false` with a reason. Never swallow an error into a PASS.

### D3 — Artefact contract (§3.3, made concrete)

```ts
interface Artefact {
  changedFiles: { path: string; status: "added"|"modified"|"deleted" }[]; // attributed to the producer sub-session's edit/write calls (NOT a global git diff)
  finalReturnText: string;     // Option ii: concatenated text parts of the producer's AssistantMessage; Option i: inner text of <task_result>…</task_result>
  declaredOutputs: string[];   // paths/commands named by the DoD
  producerSessionID: string;   // the session that produced this artefact (for producer≠grader)
  producerTier: string;        // "fast"|"medium"|"heavy" (for grader≥producer)
}
```

- **Changed-file attribution** is per-session: the after-hook records edit/write/patch/multiedit calls keyed by `sessionID`; the gate reads the producer session's set. This avoids a global `git diff` that would race under concurrency (§5.6).
- **Residual (documented limitation):** a free-form, text-only deliverable with **no** declared output and **no** changed files can only be **checker-graded on `finalReturnText`**. Deterministic verification is impossible without a declared artefact. This is acceptable and explicitly recorded.

### D4 — Producer ≠ grader, grader ≥ producer (C3)

- **Producer ≠ grader is structural:** the grader always runs in a **freshly created session** (`client.session.create`) distinct from `producerSessionID`. A subagent never grades its own output. The gate asserts `graderSessionID !== producerSessionID` and refuses (fail-closed) if they would coincide.
- **Grader ≥ producer:** `graderTier = atLeastProducerTier(producerTier)` over the ladder `["fast","medium","heavy"]`, further raised to `verify.minGraderTier` if configured. Never below the producer. For **deterministic** checks no grader model is used (the check itself is the authority), so the strength rule applies only to the **checker** path.
- **Grader determinism:** the grader prompt is dispatched at a pinned low temperature (`verify.graderTemperature`, default 0). Temperature is not a field of `session.prompt` body; it is applied via the existing `chat.params` hook keyed to the grader session (Phase 2.3 wires this — open implementation detail, not an architecture risk).

### D5 — DoD sourcing per mode + "no checkable DoD" policy

- **Mode A (on-the-fly):** DoD is parsed from a structured dispatch block if present; otherwise **auto-inferred** from task type/tier (M2 default, so a live session never stalls). `verify.requireExplicitDoD:true` flips this to "must supply" (forcing message instead of inferring).
- **Mode B (plan-annotated):** DoD comes from the plan task's acceptance block (emitted by an extended `/annotate-plan`). Mode B may be **strict**: a non-trivial task with no acceptance block is a clear plan-authoring error.
- **No checkable DoD:** trivial ⇒ skip (`verdict:SKIPPED`); non-trivial Mode A ⇒ auto-infer (default) or forcing message if `requireExplicitDoD`; Mode B ⇒ strict error. **Never silently accept** a non-trivial delegation with no DoD.
- **Auto-inference must never produce a vacuous always-PASS DoD.** If no deterministic check is discoverable (no test/build command, no declared file), inference falls back to a **checker** on the declared criteria — not to `none`.

### D6 — Verification locus + concurrency (§5.6)

- Producer and verifier operate on the **single shared OpenCode workspace** (`directory`/`worktree`).
- Deterministic checks run behind an **injected exec/fs seam** (production adapter wraps `$`/node `child_process` + `fs`; tests inject fakes — no live commands in CI), with a **command allowlist** and **timeouts**.
- **Concurrency:** all gate state keyed by `sessionID`; whole-repo deterministic checks (`testsPass`/`buildPasses`) serialize behind a **per-workspace mutex**; prefer **artefact-scoped** checks (file/schema on declared paths) when concurrency is detected; changed-file attribution uses the session's own edit calls (never a global diff).

### D7 — Token budget (M6/GA-7)

The DoD mini-syntax + `delegate` tool documentation are injected into the delegation protocol **only when enforcement is on**. Off-mode injects **zero** added tokens (Layer-2 protocol additions are gated exactly like Layer-1). Measured in Phase 5.1.

## Consequences

- **Positive:** GA-3 (a lying `DONE:` is rejected by an independent, sufficiently-strong grader) becomes achievable via Option (ii); GA-5 (both modes, one gate path) is structural; the gate is fail-closed and secret-scrubbed.
- **Negative / cost:** the `delegate` path spends extra model calls (grader; retries in Wave 3). Mitigated by: prefer-deterministic, proportional trivial-bypass (Layer 1), and the Wave-3 cost ceiling + `floorTier`.
- **Limitation:** Option (i) (raw `Task()`) remains advisory-grade — it records and warns but cannot retry. Users who want authoritative acceptance must route through `delegate`. Documented in Wave 4.
- **Open implementation details (not architecture risks):** (1) grader temperature via `chat.params` keyed to the grader session; (2) exact `session.prompt` body for an agent-typed producer (agent vs explicit model); (3) reading changed files via per-session after-hook set vs `session.messages()` — pick the cheaper in Phase 2.4. All probed by a real-OpenCode smoke (M1) before Wave 2 is declared done.

## Module plan (Wave 2)

```
src/verify/
  dod.ts            # Phase 2.1 — DoD schema + parse (Mode A/B) + inferDoD (M2)
  deterministic.ts  # Phase 2.2 — runners behind injected exec/fs seam + allowlist + timeout + mutex
  checker.ts        # Phase 2.3 — grader≥producer dispatch (fresh session) + strict verdict parse + anti-rubber-stamp
  gate.ts           # Phase 2.4 — assemble artefact + accept() + producer≠grader + record verdict; delegate tool + Option(i) verify-dispatch
```

All pure logic dependency-injected (no SDK/network/fs in the pure core); the `client`/`$`/`fs` seams live in `index.ts` adapters and are passed in — mirroring the Layer-1 split (`guards.ts` pure vs `enforce.ts`/`index.ts` wiring).
