# Plan 043: Maintain the SDD plugin fix — git baseline, drift verifier, upstream-convergence runbook

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (repo: `opencode-smart-router`).
>
> **Drift check (run first)**: Plan 042 must already be DONE. Confirm:
>
> `bun test /home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts`
> → all pass (≥17). If not, STOP: this plan would baseline an unfixed state.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (adds tracking/tooling only; touches no runtime behavior)
- **Depends on**: plans/042-sdd-task-result-plugin-linux-fix.md
- **Category**: dx
- **Planned at**: commit `0ea3822` (repo `opencode-smart-router`), 2026-08-31. All edited files live in `~/.config/opencode/`.
- **Issue**: (not published)

## Why this matters

`gentle-ai sync|upgrade|restore` (and `brew upgrade gentle-ai`) can
silently overwrite `plugins/sdd-task-result-artifacts.ts` with the broken
upstream generation — this is not hypothetical: the stale 5,890-byte
generation that plagued every SDD session since 2026-08-30 arrived exactly
that way (gentle-ai 2.1.11 → 2.4.0 upgrade). The Windows port of this fix
initially built an always-on hash-guard plugin and REVERTED it after it
broke OpenCode startup — the durable answer they converged on, and the one
this plan implements for Linux, is: a **git baseline of the config dir**
(the recovery anchor), a **manual drift verifier** with distinct exit
codes, and a **convergence runbook** that turns "the author shipped a new
version" from a silent regression into a decided procedure — including the
path where upstream finally fixes it and we adopt theirs.

## Current state

- `/home/metalbolicx/.config/opencode/` is NOT a git repository (verified:
  `git -C ~/.config/opencode rev-parse --is-inside-work-tree` → fatal).
  There is no recovery anchor of any kind today.
- The dir contains secrets-adjacent and volatile entries that must NEVER
  be committed: `opencode.json.bak.*` (25+ rotating backups), `node_modules/`,
  and potentially credential files at the root. The whitelist `.gitignore`
  below is designed so these can never enter history.
- The Windows record's verifier lived at `plugin-tests/test-sdd-plugin.js`;
  its exact file was never ported. This plan creates the Linux equivalent.
- OpenCode auto-discovers and executes every `.js`/`.ts` file in
  `plugins/` at startup — the HARD RULE from the Windows record: test
  scripts and verifiers must live in `plugin-tests/`, never `plugins/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Contract tests | `bun test /home/metalbolicx/.config/opencode/tests/sdd-task-result-artifacts.test.ts` | all pass |
| Verifier (after Step 3) | `/home/metalbolicx/.config/opencode/plugin-tests/verify-sdd-plugin.sh` | exit 0, prints OK |
| Drift hash | `sha256sum …/plugins/sdd-task-result-artifacts.ts` | matches runbook + git |

## Scope

**In scope** (the only files you should create/modify):

- `/home/metalbolicx/.config/opencode/.git` (new repo — `git init`)
- `/home/metalbolicx/.config/opencode/.gitignore` (create)
- `/home/metalbolicx/.config/opencode/plugin-tests/verify-sdd-plugin.sh` (create)
- `/home/metalbolicx/.config/opencode/plans/001-maintain-sdd-plugin-fix.md` (create — runbook)
- Optionally the user's `~/.bashrc` (Step 6, only with explicit user consent)

**Out of scope** (do NOT touch):

- `plugins/sdd-task-result-artifacts.ts` and `tests/*` — Plan 042 owns
  them; this plan only TRACKS them (and may `git checkout --` restore
  them per the runbook).
- Any other config-dir content (skills/, commands/, opencode.json, …).
- The `opencode-smart-router` repo (the plans index update excepted).

## Git workflow

This plan CREATES the repo: `git init` in `~/.config/opencode`, one
baseline commit, one annotated tag. No branches, no pushes — this repo is
purely local recovery state (like the Windows record's "Git baseline"
anchor). Never push it anywhere: it exists to make `git checkout --
plugins/…` possible after an overwrite.

## Steps

### Step 1: Initialize the repo with a secrets-safe whitelist

```bash
cd /home/metalbolicx/.config/opencode
git init
cat > .gitignore <<'EOF'
/*
!/.gitignore
!/plugins/
!/tests/
!/plugin-tests/
!/plans/
!/skills/
**/node_modules/
*.bak.*
auth.json
*.log
EOF
```

How this whitelist works: `/*` ignores every root entry; the `!/dir/`
lines un-ignore ONLY the five tracked trees. Everything else —
`opencode.json.bak.*`, `node_modules/`, any credential file — is excluded
by construction, and the explicit `auth.json` / `*.bak.*` / `**/node_modules/`
lines are belt-and-suspenders inside the unignored trees.

**Verify**: `git -C ~/.config/opencode status --porcelain` → lists ONLY
files under `plugins/`, `tests/`, `plugin-tests/`, `plans/`, `skills/`
(plus `.gitignore`). If ANY `opencode.json.bak.*`, `node_modules`, or
credential-looking file appears → STOP (see STOP conditions).

### Step 2: Baseline commit + tag

```bash
cd /home/metalbolicx/.config/opencode
git add -A
git commit -m "baseline: SDD task-result plugin fix (tolerant envelope + reformed latch + recovery evidence) — Plan 042"
PLUGIN_SHA=$(sha256sum plugins/sdd-task-result-artifacts.ts | cut -d' ' -f1)
git tag -a sdd-plugin-fix-v1 -m "known-good plugin sha256:${PLUGIN_SHA}"
```

**Verify**: `git log --oneline` → 1 commit; `git tag` → `sdd-plugin-fix-v1`;
`git status --porcelain` → empty.

### Step 3: The drift verifier

Create `/home/metalbolicx/.config/opencode/plugin-tests/verify-sdd-plugin.sh`:

```bash
#!/usr/bin/env bash
# SDD plugin verifier — run after ANY gentle-ai sync|upgrade|restore,
# brew upgrade gentle-ai, or manual plugin edit.
# Exit codes: 0 = OK | 10 = integrity (drift/overwrite) | 20 = behavioral | 1 = usage
set -uo pipefail
CFG="${HOME}/.config/opencode"
cd "$CFG" || exit 10

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL(integrity): $CFG is not a git repo — baseline lost. See plans/001-maintain-sdd-plugin-fix.md."
  exit 10
fi

# 1. Integrity: tracked plugin/tests unchanged vs baseline (modified OR untracked).
if ! git diff --quiet -- plugins/sdd-task-result-artifacts.ts tests/ \
   || [ -n "$(git status --porcelain -- plugins/sdd-task-result-artifacts.ts tests/)" ]; then
  echo "FAIL(integrity): SDD plugin/tests drifted from baseline (gentle-ai overwrite?)."
  echo "  Inspect: git -C $CFG diff -- plugins/ tests/"
  echo "  Restore: git -C $CFG checkout -- plugins/sdd-task-result-artifacts.ts tests/  (then RESTART OpenCode)"
  echo "  If upstream now passes tests, adopt it instead — see plans/001-maintain-sdd-plugin-fix.md."
  exit 10
fi

# 2. Behavioral: the contract suite against the LIVE files.
if ! bun test "$CFG/tests/sdd-task-result-artifacts.test.ts" >/tmp/sdd-verify-test.log 2>&1; then
  echo "FAIL(behavioral): contract tests failed against live plugin."
  tail -20 /tmp/sdd-verify-test.log
  exit 20
fi

echo "OK: SDD plugin matches baseline and passes the contract suite."
exit 0
```

`chmod +x` it.

**Verify**: run it → exit 0, prints `OK: …`.

### Step 4: The runbook

Create `/home/metalbolicx/.config/opencode/plans/001-maintain-sdd-plugin-fix.md`:

```markdown
# Maintain the SDD plugin fix (Linux)

Known-good plugin SHA-256: <fill with $PLUGIN_SHA from Step 2>
Baseline: git tag `sdd-plugin-fix-v1` in THIS directory (~/.config/opencode).
Design provenance: opencode-smart-router/sdd-artifacts-plugin-fix.md (Windows record)
+ plans/042-sdd-task-result-plugin-linux-fix.md (Linux implementation).

## After ANY gentle-ai sync | upgrade | restore, or brew upgrade gentle-ai
1. Run: ~/.config/opencode/plugin-tests/verify-sdd-plugin.sh
2. Exit 0 → done.
3. Exit 10 (drift) → decide, do not ignore:
   a. See what upstream shipped: git diff -- plugins/sdd-task-result-artifacts.ts
   b. TO TEST UPSTREAM'S VERSION: keep it in place, run
      bun test tests/sdd-task-result-artifacts.test.ts
      - ALL pass → upstream converged: git add -A && git commit -m
        "adopt upstream SDD plugin (passes contract)" && update the SHA above.
      - any fail → restore ours:
        git checkout -- plugins/sdd-task-result-artifacts.ts tests/
        re-run verifier (must exit 0).
   c. Either way: RESTART OpenCode — plugins load at startup.
4. Exit 20 (behavioral, no drift) → a real regression: capture
   /tmp/sdd-verify-test.log, do NOT weaken tests, report.

## Hard rules
- NEVER place executable scripts in plugins/ (OpenCode auto-discovery
  executes them at startup).
- NEVER commit this repo's contents anywhere remote — it is local
  recovery state only.
- The tests outlive any implementation: they are the permanent contract.
- After editing the plugin manually: re-run verifier, update the SHA
  above, commit.

## Failure-mode cheat sheet
| Symptom | Cause | Fix |
|---|---|---|
| malformed once, then works | transient formatting; retry allowed | none |
| malformed twice → latched | retry exhausted | send any chat message (clears state) or restart OpenCode |
| sdd_task_interrupted | subagent ended non-completed; NOT a latch | re-dispatch the task |
| OpenCode TUI won't start, test output at startup | executable in plugins/ | move to plugin-tests/ |
| verifier integrity-fail, tests would pass | plugin overwritten by gentle-ai | restore from git or adopt upstream (above) |
| envelope tail ends in prose, not </task_result></task> | orchestrator appended inside wrapper (acceptance-check failure) | fix the dispatch prompt (no non-file targets like path=engram); do NOT loosen the parser |
```

**Verify**: file exists; the SHA line matches `sha256sum` output; the tag
name matches `git tag`.

### Step 5: Prove the guard actually guards (tamper test)

```bash
echo "// tamper" >> /home/metalbolicx/.config/opencode/plugins/sdd-task-result-artifacts.ts
/home/metalbolicx/.config/opencode/plugin-tests/verify-sdd-plugin.sh; echo "exit=$?"
```

**Verify**: prints `FAIL(integrity)` and `exit=10`. Then restore:

```bash
git -C /home/metalbolicx/.config/opencode checkout -- plugins/sdd-task-result-artifacts.ts
/home/metalbolicx/.config/opencode/plugin-tests/verify-sdd-plugin.sh; echo "exit=$?"
```

**Verify**: `OK` and `exit=0`.

### Step 6 (OPTIONAL, needs explicit user consent): shell-level reminder

Offer (do not apply unprompted) to append to `~/.bashrc`:

```bash
gentle-ai() {
  command gentle-ai "$@"
  case "$1" in sync|upgrade|restore)
    echo ">> gentle-ai $1 ran — verifying SDD plugin…"
    ~/.config/opencode/plugin-tests/verify-sdd-plugin.sh || \
      echo ">> ACTION REQUIRED: see plans/001-maintain-sdd-plugin-fix.md"
  ;; esac
}
```

**Verify**: user confirms they want it, or the step is skipped and noted
in the report.

## Test plan

Steps 2-5 ARE the test plan: baseline commit exists and is clean; verifier
green on pristine state; verifier exits 10 on tamper; restore returns to
green; runbook hash matches live file. No unit tests of its own (it is
tooling).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git -C ~/.config/opencode log --oneline` → exactly 1 baseline commit (plus any Step-4/6 commits if you folded the runbook in — then ≤2)
- [ ] `git -C ~/.config/opencode tag` → `sdd-plugin-fix-v1`
- [ ] `~/.config/opencode/plugin-tests/verify-sdd-plugin.sh` → exit 0
- [ ] Tamper test produced exit 10, then restore returned exit 0
- [ ] `git -C ~/.config/opencode status --porcelain` → empty
- [ ] No `opencode.json.bak.*`, `node_modules`, or credential file is tracked (`git ls-files | grep -cE 'bak\.|node_modules|auth'` → 0)
- [ ] Runbook exists with the correct SHA
- [ ] `plans/README.md` status row for 043 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 042's tests do not pass (you would baseline a broken state).
- `git status` after Step 1 shows ANY file outside the five whitelisted
  trees — especially anything resembling credentials; do not "fix" the
  ignore file to hide it, report what you saw (credential TYPE only,
  never content).
- The tamper test does NOT produce exit 10 — the verifier is broken;
  fixing it is in scope, weakening it is not.
- `git init` reveals the directory was already inside some parent
  repository (unexpected `GIT_DIR`/`GIT_WORK_TREE` env or a parent `.git`)
  — report rather than nesting repos.

## Maintenance notes

- The upstream-convergence loop is THE long-term answer to "the author
  ships a new version": drift is detected (never silent), upstream gets
  one chance to pass the contract suite, and adoption vs restore is a
  one-command decision. When upstream converges permanently, the local
  override dies naturally and only the tests remain — the desired end
  state.
- If gentle-ai someday also overwrites `tests/`, the integrity check
  catches it the same way (tests are tracked); treat upstream tests as a
  candidate spec — merge only if the combined suite still covers every
  case Plan 042 Step 3 enumerated.
- Reviewer scrutiny: the `.gitignore` whitelist is the only secret
  boundary — re-verify it whenever new top-level entries appear in
  `~/.config/opencode/`.
- Deferred: any CI/cron automation of the verifier (deliberately — the
  Windows record showed always-on guards cost more than they protect);
  reconsider only if manual verification is demonstrably being skipped.
