# SDD Artifacts Plugin Fix — Decision Record & Porting Guide

> Context: `sdd-task-result-artifacts.ts` is an OpenCode plugin that validates SDD subagent
> task results (the `<task>…<task_result>…</task_result></task>` transport envelope) before
> they are accepted as complete. This document records why the plugin was edited, what was
> changed, and how to reproduce the fix on another machine.
>
> Source of truth: Engram observations #891, #893, #931, #935–#942 (project
> `ms-access-mcp-server`, sessions of 2026-08-21 and 2026-08-23). Verified against live
> disk state on 2026-08-31.

---

## 1. Symptom

During SDD cycles, dispatches to subagents started failing with
`sdd_task_result_malformed`. The failure **latched**: once triggered, every subsequent SDD
dispatch was rejected until OpenCode was restarted (or the session deleted). A single
transient formatting hiccup could therefore kill an entire multi-hour SDD run and cascade
into a stuck SDD ledger that had to be manually reset (`reset → begin → finish`).

## 2. Root causes (two independent problems)

### 2.1 The trigger: orchestrator `[acceptance]` blocks polluting the envelope

Dispatch prompts contained acceptance blocks such as:

```
[acceptance]
check: fileExists path=engram topic_key=...
[/acceptance]
```

`path=engram` is not a file — it is a memory store. The orchestrator's router tried to
verify it as a literal file path, failed, and **appended the rejection text inside the
task wrapper without re-adding the closing `</task_result></task>` tags**. The result was
a genuinely malformed envelope that no regex could have parsed.

Lessons (obs #893):
- Never include `path=engram` (or any non-file target) in acceptance checks.
- When the `[acceptance]` block is omitted, the orchestrator auto-infers a minimal,
  safer definition of done — safer than a wrong one.
- The plugin regex fix was always secondary; the primary fix was dispatch-prompt hygiene.

### 2.2 The amplifier: brittle plugin design

Even with clean dispatch prompts, the plugin itself converted *benign* envelope-adjacent
output into permanent failures (obs #931):

| Flaw | Location (original) | Effect |
|---|---|---|
| Anchored full-output regex (line 3) | envelope regex required the wrapper to be the entire output | prose around the envelope → malformed |
| `TASK_TAG` rejection without code-fence stripping (lines 4/26/30) | scanned raw output for `<task>` tags | code-fenced *examples* of the envelope → malformed |
| Module-level session latch (lines 87/98-99/109) | one malformed result latched the session, no recovery path | transient failure → permanent block until restart |
| Silent-pass holes (lines 23-25, 27) | truncated envelope passed; no-envelope passed | strictness was inconsistent: harsh on noise, lenient on real damage |

## 3. Dead end: the CRLF theory (kept as a lesson)

The first hypothesis was Windows line endings. The fix sequence went: `\n` → `\r?\n` in
four regex positions → still failed → maximally permissive `\s*` between tags (matches
LF, CRLF, CR, spaces, tabs, or nothing) plus a debug log that dumped wrapper length,
line-ending probe, first 600 and last 200 chars to
`~/.config/opencode/sdd-envelope-debug.log` on every mismatch (obs #891).

The permissive regex never mattered — the debug log revealed the truncated tail ending in
prose instead of `</task_result></task>`, which exposed the acceptance-block root cause.
**Takeaway: when a regex fix "doesn't take", log the actual bytes before loosening
further; the wrapper format was fine, the *content* was truncated.**

## 4. The approved decision: "Tolerant + reformed latch"

User-approved posture (obs #931): **transport-level validation only** — no enforcement of
Section D markdown payload headings. A subagent's *content* is never validated; only the
delivery envelope is. Rationale: the plugin's job is transport integrity, not spec
compliance, and payload enforcement re-introduces blocking on model formatting variance.

Implemented changes (obs #935/#936):

1. **Tolerant, non-anchored payload extraction** — the envelope may be surrounded by
   prose; extraction finds the wrapper instead of requiring the whole output to be it.
2. **Code-fence stripping before the nested-tag scan** — fenced examples of
   `<task>`/`<task_result>` no longer trigger rejection.
3. **Interruption classification** — results with `state != completed` surface as
   `sdd_task_interrupted` and **never mutate retry/latch state**. A cancelled or failed
   subagent is not a protocol violation.
4. **Latch reform** — the session latch now applies only to `empty_result`. Malformed
   results get **one contract-pure retry**; the latch engages only if the retry is also
   malformed.
5. **State reset on user message** — any chat message from the user clears session state,
   giving a manual recovery path that does not require a restart.
6. **Secret-safe diagnostics** — failure snippets are sanitized and size-bounded so
   credentials or arbitrary task output never leak into failure handoffs.
7. **Documentation hardening** — `skills/_shared/sdd-phase-common.md` now explicitly
   warns against emitting literal `<task>`/`<task_result>` transport tags in agent final
   responses (they are transport, not content).

Verification at the time: consolidated 40-test Node harness, 40 passed / 0 failed.

## 5. The guard detour — and why it was reverted

`gentle-ai sync|upgrade|restore` manages OpenCode assets and can silently overwrite the
fixed plugin, regressing the fix (obs #939). Two countermeasures were built (obs
#937/#938):

- `sdd-task-result-artifacts-guard.ts` — an independent plugin that recomputed the
  primary plugin's SHA-256 **before every SDD task dispatch** (via `tool.execute.before`,
  not after, so drift is blocked before any subagent/provider/artifact write) and
  **fail-closed** on mismatch or unreadable source.
- A separate guard test harness.

Both were then **deleted** (obs #940/#941/#942) because of a fatal platform behavior:

> **OpenCode auto-discovers and executes every `.js`/`.ts` file in the global
> `plugins/` directory at startup.** Test scripts and guard helpers placed there were
> imported as plugins, ran their tests at TUI startup, and prevented OpenCode from
> starting normally.

Additional insight that motivated the revert: a distinct-filename guard is not
guaranteed to survive future gentle-ai changes either, and a behavioral test harness
that runs on a JS *copy* of the plugin logic can stay green after the live TS file is
overwritten. The Git-baseline runbook is the durable recovery anchor; the automatic
guard added startup fragility for marginal protection.

**Hard rule: never place executable test scripts in the auto-discovered global
`plugins/` directory.**

## 6. Final layout (current, verified 2026-08-31)

| Path | Role |
|---|---|
| `~/.config/opencode/plugins/sdd-task-result-artifacts.ts` | Fixed primary plugin (known-good, 16,156 bytes) |
| `~/.config/opencode/plugin-tests/test-sdd-plugin.js` | Manual harness: live-source SHA-256 + invariant checks (16/16) + behavioral regression tests (40/40) |
| `~/.config/opencode/plans/001-maintain-sdd-plugin-fix.md` | Maintenance runbook |
| `~/.config/opencode/skills/_shared/sdd-phase-common.md` | Section D transport-contract warning |

Known-good primary plugin digest (SHA-256, lowercase):

```
c7910b5e67203abd2c033866014d87828bf3b97cb51d8705195e37bceaa0a467
```

Verified on 2026-08-31 — the live file still matches.

Windows hash check:

```powershell
(Get-FileHash "$env:USERPROFILE\.config\opencode\plugins\sdd-task-result-artifacts.ts" -Algorithm SHA256).Hash
```

## 7. Porting checklist for another computer

1. Copy the fixed plugin to `~/.config/opencode/plugins/sdd-task-result-artifacts.ts`
   (from this machine's config dir or from the Git baseline).
2. Verify the SHA-256 matches `c7910b5e…a467` (command above). If it differs, do **not**
   trust the copy — re-extract from the Git baseline.
3. Copy `plugin-tests/test-sdd-plugin.js` into `~/.config/opencode/plugin-tests/`
   (create the folder). It must **not** live in `plugins/`.
4. Run the harness manually:
   ```
   node "%USERPROFILE%\.config\opencode\plugin-tests\test-sdd-plugin.js"
   ```
   Expect: live-source integrity 16/16, behavioral 40/40, exit code 0. The harness
   distinguishes live-source integrity failures from behavioral failures via separate
   exit-code paths.
5. Apply the Section D doc warning in `skills/_shared/sdd-phase-common.md` (explicit
   note that `<task>`/`<task_result>` in final responses are transport tags, never
   content).
6. Take a Git baseline of `~/.config/opencode/` (the runbook's durable recovery anchor).
7. **Restart OpenCode.** Plugins load at startup; none of this takes effect until then.
8. Smoke-test with one benign SDD phase before resuming real work.

## 8. Ongoing maintenance

- After any `gentle-ai sync|upgrade|restore`, re-run the harness manually and re-check
  the digest. If the plugin was overwritten, restore from Git baseline and re-verify.
- After editing any plugin file, restart OpenCode before testing behavior.
- Keep dispatch prompts free of acceptance checks that reference non-file targets
  (`path=engram` was the original offender). When in doubt, omit the `[acceptance]`
  block and let the orchestrator infer a minimal DoD.

## 9. Failure-mode cheat sheet

| Symptom | Cause | Fix |
|---|---|---|
| `sdd_task_result_malformed` once, then works | transient model formatting; plugin allows one retry | none needed |
| `sdd_task_result_malformed` latched (all dispatches blocked) | malformed twice in one phase | send any user chat message (clears state) or restart OpenCode |
| `sdd_task_interrupted` surfaced | subagent ended non-completed; **not** a latch | re-dispatch the task |
| OpenCode TUI fails to start, test output at startup | executable script in `plugins/` | move it to `plugin-tests/` (or delete) |
| Harness live-source check fails but behavioral passes | plugin overwritten by gentle-ai | restore from Git baseline, re-verify |
| Envelope tail ends in prose, not `</task_result></task>` | orchestrator appended rejection inside wrapper (acceptance-block check failed) | fix the dispatch prompt; don't touch the plugin |
