# Plan 059: Rebuild CHANGELOG.md for releases 1.4.0 → 1.11.0

> **Executor instructions**: documentation-only plan (declared TDD
> exception). Every entry must trace to commits — cite SHAs in your working
> notes; the published file cites versions, not SHAs. Honor STOP
> conditions. Update your row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c780bf7..HEAD -- CHANGELOG.md package.json`
> Check `package.json` version (1.11.0 at planning time) and that
> CHANGELOG still stops at `[1.3.0]`. If someone already rebuilt it, STOP.

## Status

- **Priority**: P3
- **Effort**: M (curating 8 releases from ~3 months of git history)
- **Risk**: LOW (docs only; README links here, so accuracy matters)
- **Depends on**: plans/053 (AGENTS.md gets the "version bumps require a
  CHANGELOG entry" rule) — land 053 first or add the rule in the same cycle
- **Category**: docs
- **Planned at**: commit `c780bf7`, 2026-09-25

## Why this matters

`CHANGELOG.md` documents only `[1.3.0]` and `[1.2.0]` (last touched
2026-06-06, commit `55b4dce`) while the package is at 1.11.0 (2026-09-14).
Eight releases — including a BREAKING config change (legacy reasoning keys
rejected during validation; the Plan 041 migration) and major features
(fanout tool, five-tier expansion, reasoning profiles) — have zero release
notes. `README.md:953` links the CHANGELOG as "release history" and
`README.md:983` defers "the current token-overhead value" to it; both
currently dead-end at a June file. Upgraders following README links cannot
know they must migrate reasoning config.

## Current state

- `CHANGELOG.md:9` `[1.3.0]`, `:14` `[1.2.0]` — the only version headings
  (`grep '^## \['` → 2 hits).
- Format of existing entries: Keep-a-Changelog-ish (`## [x.y.z] — date`
  + Added/Changed/Fixed bullets — READ the file and match its exact shape).
- `package.json:3` version `1.11.0`; version-bump commits exist in history
  (e.g. `8c47699 1.11.0`); use them to segment the log.
- Major user-visible changes to make sure are NOT missed (verified during
  audit): five-tier routing expansion (plans 022 era), adaptive reasoning
  profiles + V2 selector (plan 041/015 era), reasoning-level escalation on
  retry (plan 034), child-initiated fanout tool + depth-2 workers (plans
  044/045), guard fail-closed/enforcement presets (plans 029-033 era),
  multi-provider tier model rotation (c780bf7), packaging fixes (88b8e68),
  and the BREAKING reasoning-config migration (legacy `capability` tier
  fields + global `reasoningEscalation` → v2 `reasoningControl`; legacy
  keys rejected — source: README Plan-041 fragment, docs/MIGRATION.md,
  docs/CONFIG_REFERENCE.md).
- `plans/README.md` rows 001-045 + `git log --oneline` are the content map.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| History | `git log --oneline --reverse 55b4dce..HEAD` | full segment list |
| Version anchors | `git log --oneline --grep="^[0-9]\+\.[0-9]\+\.[0-9]\+$"` | bump commits |
| Heading check | `grep -c '^## \[' CHANGELOG.md` | ≥ 10 after (1.2→1.11) |

## Scope

**In scope**:
- `CHANGELOG.md`
- `plans/README.md` (status row)

**Out of scope**:
- README content changes, docs/* rewrites, AGENTS.md (053 owns the rule)

## Git workflow

- Branch: `advisor/059-changelog`
- Commit: `docs(changelog): reconstruct 1.4.0..1.11.0 release notes`

## Steps

### Step 1: Segment history per version

Use version-bump commits (and tags if any exist — `git tag -l`) to bucket
`git log --oneline --reverse 55b4dce..HEAD` into 1.4.0…1.11.0 segments.
Where no explicit bump commit exists for a version, infer the boundary from
`package.json` diffs: `git log -p --follow -- package.json | grep -B10 '"version"'`.

### Step 2: Write the entries

For each version, one `## [x.y.z] — YYYY-MM-DD` section matching the
existing entry shape, with Added/Changed/Fixed/Breaking bullets derived
from the segment's commits. Rules:
- User-visible only (features, fixes, config contract changes, packaging);
  internal plan churn stays out unless it changed operator behavior.
- The breaking reasoning migration goes under its release's **Breaking** or
  a prominent **Changed** bullet pointing at `docs/MIGRATION.md`.
- The 1.11.0 entry includes the multi-provider model rotation (c780bf7).
- If the exact date of a version is unknown, use the bump commit's date;
  if a version's existence is uncertain, omit it rather than invent it —
  note omissions in your report.

### Step 3: Consistency pass

- Newest-first ordering (match existing file order — read it).
- `grep -c '^## \['` ≥ 10 (1.2.0 through 1.11.0).
- Ensure the top entry's version equals `package.json`'s version.

### Step 4: Rule pointer

Confirm `AGENTS.md` (from plan 053) contains the
"version bumps require a CHANGELOG entry" rule; if 053 hasn't landed, add
the one-line reminder to your report so the cycle doesn't lose it.

## Test plan

- Declared TDD exception (docs). Verification = Step 3 checks + every
  bullet traceable to a commit SHA in the executor's report.

## Done criteria

- [ ] `grep -c '^## \[' CHANGELOG.md` ≥ 10
- [ ] Top version heading matches `package.json` version
- [ ] Breaking reasoning-config migration documented with MIGRATION.md pointer
- [ ] Every entry traceable to commits (SHAs in the executor report)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The file has already been rebuilt (drift check).
- History segmentation is ambiguous for more than 2 versions (report the
  ambiguity; partial rebuild + notes beats invented dates).
- A "release" turns out to have never been published (npm reality check via
  `npm view opencode-smart-router versions` if network is available — mark
  unreleased versions accordingly or omit; note the decision).

## Maintenance notes

- The AGENTS.md rule (053) is the recurrence prevention; this plan is the
  one-time backfill.
- Plan 048 (allowlist tightening) and 058 (ladder default) will need
  CHANGELOG entries when they land — their plans say so.
