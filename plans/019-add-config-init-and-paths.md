# Plan 019: Add explicit `osr config init` and `osr config paths` commands

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If anything in the STOP conditions occurs, stop and report back instead of improvising.
>
> **Drift check (run first)**: `git diff --stat 6391a27..HEAD -- src/cli src/router README.md test/unit/cli-commands.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the Current state excerpts against the live code before proceeding. If they do not match, stop and report.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `6391a27`, 2026-07-06
- **Issue**: n/a

## Why this matters

`osr install` currently registers the plugin in the global OpenCode config, but it does not create the optional global `tiers.json` override. Users who expect to edit a global tiers file have no obvious path to create one. This plan adds an explicit command for that job, keeps install focused on registration, and gives users a reliable way to discover every relevant config path.

## Current state

- `src/cli/install.ts:57-110` only edits `~/.config/opencode/opencode.json`.
- `src/cli/main.ts:131-172` dispatches on the first positional only.
- `src/router/config-paths.ts:114-166` already knows the global override path and the state paths.
- `src/router/config-loader.ts:82-95` already resolves the bundled `tiers.json` root.
- `src/cli/config.ts:361-441` already has reusable backup + atomic write helpers.
- `test/unit/cli-commands.test.ts` already has the in-memory `CliFs` pattern to model after.

Current code excerpt, install path:

```ts
// src/cli/install.ts
const loaded = loadGlobalConfig(fs);
const config: Record<string, unknown> = { ...loaded.config };
const existing = normalizePlugin(config.plugin);
...
config.plugin = [...dedupedNonOsr, specifier];
writeAtomically(loaded.path, JSON.stringify(config, null, JSON_INDENT), fs);
```

Current code excerpt, main dispatch:

```ts
// src/cli/main.ts
const command = parsed.positionals[0];
switch (command) {
  case "install":
  case "uninstall":
  case "status":
  case "doctor":
```

Current code excerpt, path resolution:

```ts
// src/router/config-paths.ts
globalConfig: join(root, "opencode-smart-router", "tiers.json"),
statePreferred: join(root, "opencode", "opencode-smart-router.state.json"),
stateLegacy: join(legacyRoot, "opencode", "opencode-smart-router.state.json"),
```

### Conventions to match

- CLI commands are sync and return structured results, then print a human-readable summary.
- Disk writes go through `writeAtomically` and backups through `backupIfWritable`.
- Tests use in-memory `CliFs` and do not touch real disk.
- Existing CLI help text is explicit and command-driven; keep the same tone.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Targeted tests | `pnpm test -- test/unit/cli-commands.test.ts` | exit 0 |
| Full tests | `pnpm test` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope**

- `src/cli/tiers-config.ts` (new)
- `src/cli/main.ts`
- `src/cli/install.ts`
- `src/cli/status.ts`
- `test/unit/cli-commands.test.ts`
- `README.md`
- `plans/README.md`

**Out of scope**

- Do not auto-create `tiers.json` during `osr install`.
- Do not change router layer precedence or merge behavior.
- Do not add JSONC support to the new tiers file flow.
- Do not extract shared path helpers unless needed to make this plan work.

## Steps

### Step 1: Add the new CLI module

Create `src/cli/tiers-config.ts` with two exports:

- `runConfigInit(opts, fs)`
- `runConfigPaths(fs)`

Implement `runConfigInit()` to support these options:

- `target?: "global" | "local"` with default `"global"`
- `preset?: string`
- `fromBundled?: boolean`
- `force?: boolean`
- `dryRun?: boolean`

Behavior:

- Default write target is the global override path from `globalConfigPath()`.
- Local mode writes to `<cwd>/.opencode/tiers.json`.
- Default content is `{}`.
- `--preset <name>` writes `{ "activePreset": "<name>" }`.
- `--from-bundled` copies the shipped `tiers.json` content.
- `--preset` and `--from-bundled` are mutually exclusive.
- If the target exists and `force` is false, throw a user-facing error that suggests `--force`.
- If `force` is true and the file exists, call `backupIfWritable()` before writing.
- Use `writeAtomically()` for the final write.
- `--dry-run` prints the resolved path and content and does not write.

For `--from-bundled`, read the bundled file through the existing `configPath()` helper from `src/router/config-loader.ts` and parse it to validate `preset` names when necessary. Validate `preset` against the bundled `presets` object before writing.

Implement `runConfigPaths()` to report:

- bundled tiers path and existence
- global override path and existence
- local override path and existence
- state file path and existence

Return a structured result so tests can assert without parsing stdout.

**Verify**: `pnpm typecheck` -> exit 0

### Step 2: Wire `config` into the CLI dispatcher

Update `src/cli/main.ts`:

- Add the new flags to `parseCliArgs()` so strict parsing accepts them.
- Add a `case "config"` branch.
- Read the subcommand from `parsed.positionals[1]`.
- Support only `init` and `paths`.
- Unknown or missing config subcommands must exit 2 with a clear usage error.
- Extend the usage text to document the new command group and flags.

Keep the current flat command style intact; do not introduce a new parser library.

**Verify**: `pnpm typecheck` -> exit 0

### Step 3: Add user guidance in install output

Update `src/cli/install.ts` so a successful write prints a tip line:

```text
tip: Run `osr config init` to create a global tiers.json override
```

Do not print the tip for the noop path.

**Verify**: `pnpm test -- test/unit/cli-commands.test.ts` -> existing install assertions still pass after any message updates.

### Step 4: Surface the global tiers path in status output

Update `src/cli/status.ts` so `runStatus()` prints the global tiers override path and whether it exists.

This is an informational discoverability aid, not a health check. Keep it read-only and non-failing.

**Verify**: `pnpm typecheck` -> exit 0

### Step 5: Add tests for the new command flow

Extend `test/unit/cli-commands.test.ts` using the existing in-memory `CliFs` pattern.

Add coverage for:

- default `runConfigInit()` creates global `{}`
- `--local` writes to `<cwd>/.opencode/tiers.json`
- `--preset multi-provider` writes the expected minimal JSON
- invalid preset names throw
- `--from-bundled` writes the bundled file contents
- `--preset` plus `--from-bundled` throws
- existing file without `--force` throws
- `--force` creates a backup then overwrites
- `--dry-run` writes nothing
- `runConfigPaths()` returns the four expected paths and existence flags

Use the existing `createMemFs()` helper and `CONFIG_PATH` pattern as the model.

**Verify**: `pnpm test -- test/unit/cli-commands.test.ts` -> all pass

### Step 6: Update README and plan index

Update `README.md` in the Installation and Configuration sections:

- mention `osr config init`
- mention `osr config paths`
- explain that `tiers.json` is an explicit override file
- note the tradeoff between `{}` / `--preset` / `--from-bundled`

Update `plans/README.md`:

- append the new Plan 019 row
- keep the execution order aligned with the existing list
- mark status as `TODO`

**Verify**: `pnpm lint` -> exit 0

## Test plan

- `test/unit/cli-commands.test.ts` should cover the new command behavior and the old install/uninstall behavior.
- No new integration tests are required for this plan.
- Prefer short, deterministic assertions on the in-memory file map and captured stdout.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- test/unit/cli-commands.test.ts` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm build` exits 0
- [ ] `plans/README.md` contains the Plan 019 row
- [ ] `README.md` documents the new config commands
- [ ] No out-of-scope files are modified

## STOP conditions

Stop and report back if:

- `configPath()` does not resolve correctly from the built CLI bundle
- strict `parseArgs()` rejects the new flags after they are added
- the new plan causes `osr install` to silently create `tiers.json`
- the plan requires touching files outside the in-scope list

## Maintenance notes

- `--from-bundled` intentionally freezes the current bundled defaults into a user file. Future updates will not propagate automatically.
- If the CLI later grows more config commands, keep `config init` and `config paths` as separate subcommands so creation stays explicit.
- If status output becomes too noisy, move the extra path line into `osr doctor` later; do not remove the new command until there is a better replacement.
