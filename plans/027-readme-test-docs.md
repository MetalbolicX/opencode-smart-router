# Plan 027: Document test commands in README

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 9c744be..HEAD -- README.md`
> If README.md changed since this plan was written, compare the
> "Current state" excerpts against the live file before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `9c744be`, 2026-08-03

## Why this matters

`opencode-smart-router` documents zero test commands. The 828-line README
has no Development / Testing / Contributing section, and `pnpm run test:res`
(the ReScript parity command introduced by the migration) is undocumented
entirely. New contributors have to learn the right command by reading
`package.json:15-20` — and the natural mistake `pnpm res:test` (common shape
for `name:command` npm scripts) does NOT exist, so it fails opaquely.

The verify-report archive (engram #3980, suggestion S5) tracks this. It's a
trivial, high-leverage doc patch — first impression for every new
contributor.

## Current state

### README structure (relevant excerpts)

The README has these top-level (`##`-prefixed) sections in order. **There is
no `## Testing`, no `## Development`, no `## Contributing` section at any
line**:

- `## Local clone` ending at line 250
- `## Updating` at line 252 (ends ~line 289)
- `## Configuration` at line 291
- ... (multiple sections) ...
- `## License` at line 826 (last section in the file)

There are zero matches in the README for: "testing", "pnpm test",
"test:res", "res:test", "Development", "Contributing", "vitest",
"rescript-test".

### The exact commands to document

From `package.json` (verified at recon):

| Script key         | Line    | Command                                                   | Purpose                                            |
|--------------------|---------|----------------------------------------------------------|----------------------------------------------------|
| `res:build`        | 8       | `rescript build`                                           | Compile ReScript → `.res.mjs` in-source             |
| `res:clean`        | 9       | `rescript clean`                                            | Wipe ReScript build cache                           |
| `res:dev`          | 10      | `rescript build -w`                                         | ReScript build with file-watcher                    |
| `test`             | 15      | `vitest run`                                                | Run the TS unit + integration vitest suite         |
| `test:watch`       | 16      | `vitest`                                                    | vitest in watch mode                                |
| `test:coverage`    | 17      | `vitest run --coverage`                                     | vitest with coverage report                         |
| `test:res`         | 18      | `retest 'src/**/*_test.res.mjs'`                            | Run the ReScript parity suite (rescript-test / retest) |
| `test:parity`      | 19      | `pnpm run res:build && pnpm run test:res`                   | Build ReScript then run its parity suite             |
| `smoke`            | 20      | `cross-env RUN_OC_SMOKE=1 vitest run --config vitest.smoke.config.ts test/smoke` | Optional smoke tests against a live opencode instance |

**There is no `res:test` script**. The right command is `pnpm run test:res`,
NOT `pnpm run res:test` — this misnomer is the common failure mode (the
SDD migration cycle carried the reminder "Document `pnpm run test:res`
(not `pnpm res:test`) in README" as a discovered gotcha).

### Repo conventions to match

- README uses lowercase `## Section` headings, no trailing punctuation.
- Code blocks are fenced with triple backticks; inline commands are in
  inline backticks.
- Other sections show commands as `pnpm <verb>` (without the explicit `run`
  for built-in verbs like `test` / `install`, but with `run` for custom
  scripts like `test:res`). Match the existing style of the sections
  immediately above and below.
- No "emoji" or decorative cruft in the existing README.

### Documented design constraints to honor

- The build pipeline order (per `sdd/rescript-migration-phase4-5` archive
  report): `res:build → build:tiers → tsc → rolldown → build:copy-res`.
  README should explicitly mention the ReScript build when documenting
  test commands, since a contributor who runs `pnpm test` WITHOUT having
  run `pnpm run build` may see stale `.res.mjs` / missing `tiers.json`
  errors.
- The "test:res not res:test" gotcha was a real failure mode in the
  migration cycle; document it explicitly under the new section.

## Commands you will need

| Purpose            | Command                         | Expected on success                                       |
|--------------------|---------------------------------|-----------------------------------------------------------|
| Install            | `pnpm install`                  | exit 0                                                    |
| Build              | `pnpm run build`                | exit 0                                                    |
| Typecheck          | `pnpm run typecheck`            | exit 0                                                    |
| Lint               | `pnpm run lint`                 | exit 0                                                    |
| Test (TS adapter)  | `pnpm test`                     | exit 0 or the 14-failure accepted baseline               |
| Test (ReScript)    | `pnpm run test:res`             | 416/416 passing                                          |
| Test (parity whole)| `pnpm run test:parity`          | 416/416 passing                                          |

## Suggested executor toolkit

- None special. Plain markdown editing. No code under test.

## Scope

**In scope** (the only file you should modify):
- `README.md` — add a `## Testing` section immediately AFTER the `## Local
  clone` section (i.e. before `## Updating`). This placement matches the
  first-time-contributor reading order (after local clone setup, before
  upgrading). Do NOT edit any other section.

**Out of scope** (do NOT touch, even though they look related):
- `CONTRIBUTING.md` — does not exist; not a scope-creep target. Create a
  new CONTRIBUTING guide is its own plan.
- `docs/` — product-facing docs; the dev test commands belong in README.
- `package.json` comment fields — there's no documentation block in
  package.json; do not add one.
- Any other README section — strictly additive; no edits to `##
  Configuration`, `## License`, etc.
- CHANGELOG.md — this is user-facing doc, not a release-note item.

## Git workflow

- Branch: `advisor/027-readme-test-docs`
- Commit style (conventional):
  - `docs(readme): document test commands and rescript-test suite`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Insert the `## Testing` section

Edit `README.md`. After the `## Local clone` section ends (around line
250, just before `## Updating` at line 252), insert a new `## Testing`
section. Use this content; adapt the wording to match the README's exact
tone if the existing sections use a particular voice:

```markdown
## Testing

The project has two test surfaces — a TypeScript adapter suite (vitest) and
a ReScript parity suite (rescript-test / `retest`). Both must be green
before a PR merges.

### Quick command reference

| Command                       | What it runs                                   |
|-------------------------------|------------------------------------------------|
| `pnpm test`                   | TypeScript unit + integration tests (vitest)    |
| `pnpm run test:res`           | ReScript parity suite (`src/**/*_test.res.mjs`) |
| `pnpm run test:parity`        | `pnpm run res:build && pnpm run test:res`        |
| `pnpm run test:coverage`      | vitest with coverage                            |
| `pnpm run smoke`              | Optional smoke tests against a live opencode instance |

The command is `pnpm run test:res` (note the `test:` prefix). It is NOT
`pnpm run res:test` — that script does not exist.

### Build before you test

Before running `pnpm test`, build the project once so the compiled
`.res.mjs` modules and the `tiers.json` config are up to date:

\`\`\`sh
pnpm install
pnpm run build
pnpm test
\`\`\`

The full `build` script chains `res:build → build:tiers → tsc → rolldown →
build:copy-res`. If you skip it, vitest may import stale
`.res.mjs` outputs or a missing `tiers.json`, surfacing red herrings that
are NOT your regression.

### ReScript-only rapid loop

When you're iterating on ReScript pure-logic (the `src/{reasoning,guard,validate,verify,config,router}/` ReScript modules):

\`\`\`sh
pnpm run res:build          # or `pnpm run res:dev` for the watcher
pnpm run test:res          # runs only the ReScript parity suite
\`\`\`

`res:dev` starts `rescript build -w` so recompiles happen on every save.
`test:parity` is the one-shot "build then test" convenience.
```

**Verify**: open the edited README and confirm the new section appears
between `## Local clone` and `## Updating`. Markdown linter (if any) runs
clean: `pnpm exec markdownlint README.md 2>&1 | head` — if the project
has no markdownlint config, skip this verification (most repos don't
enforce it).

### Step 2: Confirm no other tooling broke

The README has no executable test role; just run lint to confirm:

**Verify**: `pnpm run lint` → exit 0 (Biome ignores `.md` files; if it
doesn't, this is a pre-existing condition outside this plan's scope).

### Step 3: Push a sanity grep

**Verify**:
- `grep -n 'pnpm run test:res' README.md` → at least one hit (the doc now
  mentions the correct command).
- `grep -n 'pnpm res:test' README.md` → zero hits (we did not propagate the
  wrong command anywhere).
- `grep -nE '^## Testing$' README.md` → exactly one hit (the new section).

## Test plan

- No automated test required; the done criteria are grep-authoritative.
- A human / reviewer pass: render the README in a markdown viewer and
  confirm the table is readable and the code blocks are fenced properly.
- Backward-compat check: `grep -c 'pnpm test' README.md` after the plan —
  pre-plan had zero hits; post-plan has ≥3 (the table row + the code block
  + the prose).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -nE '^## Testing$' README.md` returns exactly 1 hit
- [ ] `grep -cE 'pnpm run test:res' README.md` returns ≥3
- [ ] `grep -nE 'pnpm res:test' README.md` returns no hits (the wrong command
      is not propagated)
- [ ] The new section is positioned between `## Local clone` and `## Updating`
      (verify via `awk '/^## Local clone/{print NR} /^## Updating/{print NR} /^## Testing/{print NR}' README.md`
      — the Testing line number is between the Local clone block end and the
      Updating line)
- [ ] `pnpm run lint` exits 0 (no Biome violation introduced in any
      `.ts`/`.js` source — README edits should not change Biome status)
- [ ] The 8 commands from "Current state" are each referenced at least once
      in the new section (test, test:res, test:parity, smoke at minimum —
      the ReScript ones are needed in the second subsection)
- [ ] No files outside `README.md` are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `README.md` has been restructured since this plan was written and
  `## Local clone` or `## Updating` no longer exists at the cited lines —
  STOP and re-find an insertion point between two existing sections. Do not
  insert in the middle of an unrelated section.
- `package.json` no longer has the `test:res`, `test:parity`, or `smoke`
  scripts at the lines cited — STOP and re-confirm the script keys; the doc
  must match live package.json exactly.
- A site-wide markdown linter is configured and flagging the new section —
  STOP and adapt the formatting to match the linter's rules; do not disable
  the linter.
- The existing README uses a strikingly different tone / heading style (e.g.
  Emoji `## 🧪 Testing`) — STOP and either match the existing emoji style or
  report; the plan intentionally uses plain `## Testing` because the
  existing sections are plain, but if recon drifted since the plan was
  written, respect the live style.

## Maintenance notes

- Future scripts added to `package.json` that are contributor-facing (e.g.
  `test:integration`, `bench`) MUST be added to the table in this section
  in the same PR that introduced the script.
- The "test:res not res:test" gotcha line is the single highest-impact
  part of this section; do not delete it without a strong replacement
  (the gotcha caused real wasted time during the migration cycle).
- The build-before-test note is structural: if the build pipeline order
  ever changes (e.g. a new prebuild step), update both the README chain
  and the contract doc in `sdd/rescript-migration-phase4-5/archive-report`.
- This plan is independent of Plans 025 / 026 and the regression fixes
  (023 / 024); it can be merged in any order.