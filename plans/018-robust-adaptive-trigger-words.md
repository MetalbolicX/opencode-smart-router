# Plan 018: Robust adaptive trigger-word selection (word-boundary matching, match modes, exclusions)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 60fb337..HEAD -- src/reasoning/adaptive.ts src/reasoning/match.ts src/router/config.types.ts src/router/config-validate.ts src/plugin/hooks.ts config/tiers/base.json docs/REASONING.md test/unit/adaptive-selector.test.ts test/unit/adaptive-match.test.ts test/unit/config-validate-sections.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: Plan 015 (adaptive engine — DONE)
- **Category**: direction
- **Planned at**: commit `60fb337`, 2026-07-02

## Why this matters

The adaptive selector in `src/reasoning/adaptive.ts` chooses a reasoning level
from task text using trigger words. Today it uses raw `String.includes()` on
lowercased prompt/description text. That is too permissive: `latest` matches
`test`, `prefix` matches `fix`, `dispatch` matches `patch`, and pasted code can
trigger false positives through identifiers. The selector also has no whitespace
normalization, no exclusions, and no config-load validation for the adaptive
block.

This plan keeps the system deterministic and rule-based, but makes the matching
accurate and maintainable: word-boundary matching with a safe `stem` default,
explicit match modes, rule exclusions, richer vocabulary, and validation at
load time. No ML, no embeddings, no contract changes.

## Current state

### The matcher that must change

`src/reasoning/adaptive.ts:96-119`:

```ts
const keywordRules = adaptive.keywordRules;
if (keywordRules) {
  for (const rule of keywordRules) {
    if (!Array.isArray(rule?.keywords)) continue;          // fail-soft guard
    const matched = rule.keywords.find(
      (kw) =>
        typeof kw === "string" &&
        (signals.prompt.includes(kw) || signals.description.includes(kw)),
    );
    if (matched !== undefined) {
      return { level: rule.level, reason: `keyword match: ${matched}` };
    }
  }
}
```

### Signal normalization is minimal

`src/plugin/hooks.ts:154-164`:

```ts
const signals: AdaptiveSignals = {
  prompt: prompt.toLowerCase(),
  description: description.toLowerCase(),
  tierName: subagentType,
  isTrivial: ctx.sessionStore.isTrivial(sid),
};
```

### Config shape

`src/router/config.types.ts:98-103`:

```ts
export interface AdaptiveKeywordRule {
  /** Case-insensitive substrings; a match in prompt OR description wins. */
  keywords: string[];
  /** Level applied when any keyword matches. */
  level: import("../reasoning/capability.js").ReasoningLevel;
}
```

`config/tiers/base.json:13-18` — only `normal`/`elevated`, never
`minimal`/`max`:

```json
"keywordRules": [
  { "keywords": ["refactor", "architecture", "security", "migration"], "level": "elevated" },
  { "keywords": ["debug", "diagnose", "investigate", "root cause"], "level": "elevated" },
  { "keywords": ["test", "fix", "patch"], "level": "normal" }
]
```

### No config-load validation for adaptive

`src/router/config-validate.ts` currently has no `reasoningPolicy`, `adaptive`,
or `keywordRules` validation. Malformed adaptive config is only caught by the
runtime fail-soft guards in the selector. This plan adds fail-fast validation
at load while keeping the runtime guards as defense-in-depth.

### Vocabulary of levels

`src/reasoning/capability.ts:17`:

```ts
export type ReasoningLevel = "minimal" | "normal" | "elevated" | "max";
```

### What must NOT change

- `src/reasoning/translate.ts:49` (`translateLevel`) — provider translation
  is untouched.
- The selector's decision order (`adaptive.ts:9-17`): no adaptive → trivial →
  tierDefaults → keywordRules → defaultLevel. This plan only changes the
  keyword step, not the precedence.
- `static`/`manual` mode behavior and the existing runtime fail-soft guards
  (`Array.isArray`, `typeof kw === "string"`) stay.
- The separate `taskPatterns` / `classifyTrivial` system is NOT unified in
  this plan.

### Repo conventions

- Pure functions live in `src/reasoning/`. The new matcher follows the same
  pattern: pure, no IO, no side effects.
- Config types live in `src/router/config.types.ts` with JSDoc on every field.
- Config validation lives in `src/router/config-validate.ts` as per-section
  validators. Model the new `validateReasoningPolicy` on the existing sections.
- Tests use Vitest (`describe`/`it`/`expect`). Mirror `src/` paths under
  `test/unit/`.
- Verification commands: `pnpm typecheck`, `pnpm test`, `pnpm lint`.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `pnpm install`                   | exit 0              |
| Typecheck | `pnpm typecheck`                 | exit 0, no errors   |
| Targeted  | `pnpm test -- adaptive-selector adaptive-match config-validate-sections` | all pass |
| Full      | `pnpm test`                      | all pass            |
| Lint      | `pnpm lint`                      | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/reasoning/match.ts` (create — pure matcher + memoized compiler)
- `src/reasoning/adaptive.ts` (use matcher; honor `match` + `excludeKeywords`; richer reason)
- `src/router/config.types.ts` (add `match?` + `excludeKeywords?` to `AdaptiveKeywordRule`)
- `src/plugin/hooks.ts:159` (normalize signal text)
- `src/router/config-validate.ts` (add `validateReasoningPolicy`)
- `config/tiers/base.json` (refresh vocabulary using all 4 levels + modes)
- `docs/REASONING.md` (document match modes + exclusions)
- `test/unit/adaptive-match.test.ts` (create — matcher unit tests)
- `test/unit/adaptive-selector.test.ts` (boundary / inflection / exclusion / mode cases)
- `test/unit/config-validate-sections.test.ts` (adaptive-validation cases)
- `plans/README.md` (add plan row)

**Out of scope** (do NOT touch):
- `src/reasoning/translate.ts`, `src/reasoning/capability.ts` — provider layer.
- `src/router/sessions.ts` (`classifyTrivial`, `taskPatterns`) — separate system.
- The selector's decision precedence (trivial → tier → keyword → default).
- `static`/`manual` mode behavior.
- ML classifiers, embeddings, TF-IDF, score-weighting, i18n aliases, code-fence stripping.

## Git workflow

- Branch: `feature/robust-adaptive-trigger-words`
- Commit per step; message style: conventional commits
  (`feat(reasoning): ...`, e.g. `feat(reasoning): add word-boundary keyword matcher`).
- Do NOT push or open a PR unless the operator instructed it.

## Design: the matcher

Implement this exactly.

**Match modes** (new `MatchMode` type, exported from `src/reasoning/match.ts`):

```ts
export type MatchMode = "word" | "stem" | "substring" | "regex";
```

**Signal normalization** (`normalizeSignalText`, exported, used by `hooks.ts`):

```ts
// lowercase → collapse all whitespace runs (spaces/tabs/newlines) to one
// space → trim. Keeps the selector cheap; phrase keywords like "root cause"
// then match "root\tcause" and "root  cause".
export const normalizeSignalText = (raw: string): string =>
  raw.toLowerCase().replace(/\s+/g, " ").trim();
```

**Compiler** (memoized in a module-level `Map<string, RegExp>` keyed by
`${mode}|${lowercasedKeyword}`; case-insensitive via the `i` flag):

| Mode | Regex shape | Behavior |
|---|---|---|
| `word` | `\b<escaped words joined by \s+>\b` | Strict word/phrase. `debug` ≠ `debugging`. |
| `stem` *(default)* | `\b<head \s+>…<last token>\w*` | Word-boundary at start, allows suffix inflections on the last token. `debug` → `debugging`; `latest` → ✗test; `prefix` → ✗fix; `dispatch` → ✗patch. |
| `substring` | `<escaped>` | Legacy `includes` behavior — opt-in escape hatch. |
| `regex` | `<user pattern>` | Power-user escape hatch. Compile in try/catch; invalid pattern → fail-soft at runtime, fail-fast at config load. |

Reference implementation (the executor may use this verbatim):

```ts
const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cache = new Map<string, RegExp>();

const compileMatcher = (keyword: string, mode: MatchMode): RegExp => {
  const key = `${mode}|${keyword.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let re: RegExp;
  const tokens = keyword.trim().split(/\s+/).map(escapeRegExp);
  switch (mode) {
    case "word":
      re = new RegExp(`\\b${tokens.join("\\s+")}\\b`, "i");
      break;
    case "substring":
      re = new RegExp(tokens.join("\\s+"), "i");
      break;
    case "regex":
      re = new RegExp(keyword, "i"); // user pattern, as-supplied
      break;
    case "stem":
    default: {
      // word-boundary start; suffix inflections allowed on the LAST token only.
      const last = tokens[tokens.length - 1] ?? "";
      const head = tokens.slice(0, -1);
      const body = head.length > 0 ? `${head.join("\\s+")}\\s+${last}\\w*` : `${last}\\w*`;
      re = new RegExp(`\\b${body}`, "i");
      break;
    }
  }
  cache.set(key, re);
  return re;
};

export const matchSignal = (text: string, keyword: string, mode: MatchMode): boolean => {
  if (!keyword) return false;
  try {
    return compileMatcher(keyword, mode).test(text);
  } catch {
    return false; // invalid regex pattern at runtime → fail-soft
  }
};
```

**Why `stem` is the default** (not strict `word`): strict `\bword\b` would
lose the useful inflection behavior the current system already has (`debug`
should still match `debugging`). `stem` kills the cross-word false positives
while preserving inflections, so switching the default is both a bug fix AND
backward-compatible for the inflection case. Existing match-less rules get
`stem` automatically.

**Known residual** (documented, out of scope here): `stem`/`word` still match
identifiers like `test_fixture` because `_` is a `\w` char and `\b` is
ASCII-only. Stripping code-fences before matching is a deeper change deferred
to a later plan.

## Steps

### Step 1: Create the pure matcher module

Create `src/reasoning/match.ts` with `MatchMode`, `normalizeSignalText`,
`compileMatcher` (internal), and `matchSignal` exactly as specified in
"Design: the matcher" above. Add a file header in the style of
`src/reasoning/translate.ts`: module purpose, purity contract, the four
modes, and the `stem` default rationale.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Extend the config type

In `src/router/config.types.ts`, add two optional fields to
`AdaptiveKeywordRule` (`:98-103`) — keep everything else identical:

```ts
export interface AdaptiveKeywordRule {
  /** Case-insensitive terms; a match in prompt OR description wins. */
  keywords: string[];
  /** Level applied when any keyword matches. */
  level: import("../reasoning/capability.js").ReasoningLevel;
  /**
   * Match strategy for this rule's keywords AND excludeKeywords.
   * Default "stem" (word-boundary + suffix inflections on the last token).
   * Use "word" for strict matching, "substring" for legacy behavior, or
   * "regex" for a user-supplied pattern.
   */
  match?: import("../reasoning/match.js").MatchMode;
  /**
   * Optional disqualifiers: if any matches (same `match` mode), the whole
   * rule is skipped.
   */
  excludeKeywords?: string[];
}
```

Update the JSDoc on `AdaptivePolicyConfig.keywordRules` (`:133-135`) to note
the new `match` / `excludeKeywords` fields and that `stem` is the default.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Rewire the selector's keyword step

In `src/reasoning/adaptive.ts:96-119`, replace the inline `includes()` loop
with calls to `matchSignal`. Import `matchSignal` and `MatchMode` from
`./match.js`. Preserve the existing fail-soft guards and the first-match-wins
order. Target shape:

```ts
const keywordRules = adaptive.keywordRules;
if (Array.isArray(keywordRules)) {
  for (let i = 0; i < keywordRules.length; i++) {
    const rule = keywordRules[i];
    if (!Array.isArray(rule?.keywords)) continue;          // keep fail-soft

    const mode: MatchMode = rule.match ?? "stem";
    const ex = Array.isArray(rule.excludeKeywords) ? rule.excludeKeywords : [];

    const excluded = ex.some(
      (k) => typeof k === "string" && k.length > 0 &&
        (matchSignal(signals.prompt, k, mode) || matchSignal(signals.description, k, mode)),
    );
    if (excluded) continue;

    let source: "prompt" | "description" | null = null;
    const matched = rule.keywords.find((kw) => {
      if (typeof kw !== "string" || kw.length === 0) return false;
      if (matchSignal(signals.prompt, kw, mode)) { source = "prompt"; return true; }
      if (matchSignal(signals.description, kw, mode)) { source = "description"; return true; }
      return false;
    });
    if (matched !== undefined) {
      return {
        level: rule.level,
        reason: `keyword match: rule[${i}] "${matched}" (${mode}) in ${source}`,
      };
    }
  }
}
```

Update the module header comment block (`:9-17`) to describe the new modes
and the `stem` default.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Normalize signal text in the hook

In `src/plugin/hooks.ts:154-164`, route `prompt`/`description` through
`normalizeSignalText` instead of bare `.toLowerCase()`:

```ts
import { normalizeSignalText } from "../reasoning/match.js";
// ...
const signals: AdaptiveSignals = {
  prompt: normalizeSignalText(prompt),
  description: normalizeSignalText(description),
  tierName: subagentType,
  isTrivial: ctx.sessionStore.isTrivial(sid),
};
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 5: Add config-load validation (fail-fast)

In `src/router/config-validate.ts`, add a `validateReasoningPolicy(obj)`
section modeled on the existing per-section validators, and call it from
`validateConfig`. Rules:

- `reasoningPolicy` optional; if absent, return.
- `mode` (if present) ∈ {`static`,`manual`,`adaptive`}.
- `adaptive` optional; if present must be a plain object.
- `adaptive.trivialLevel` / `adaptive.defaultLevel` (if present) ∈ the level
  set {`minimal`,`normal`,`elevated`,`max`} or `null`.
- `adaptive.keywordRules` (if present) must be an array; each rule:
  - `keywords` is a **non-empty** array of strings (reject `[]`);
  - `level` ∈ the level set;
  - `match` (if present) ∈ {`word`,`stem`,`substring`,`regex`};
  - `excludeKeywords` (if present) is an array of strings.
- `adaptive.tierDefaults` (if present) is a plain object whose values are in
  the level set.
- For `match: "regex"` rules, attempt `new RegExp(keyword)` for each keyword;
  throw on invalid patterns (fail-fast).

Use the existing level-set constant if one exists, else inline
`["minimal","normal","elevated","max"]`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 6: Refresh the shipped vocabulary

In `config/tiers/base.json`, replace the `keywordRules` array (`:13-18`)
with a curated seed using all four levels. Keep `mode: "manual"` (adaptive
stays opt-in) and `defaultLevel: "normal"`:

```json
"keywordRules": [
  {
    "keywords": ["format", "lint", "rename", "sort import", "bump version", "typo"],
    "level": "minimal",
    "excludeKeywords": ["refactor", "architect", "redesign"]
  },
  {
    "keywords": ["root cause", "rca", "security audit", "architecture redesign", "architect", "data migration"],
    "level": "max"
  },
  {
    "keywords": ["refactor", "security", "debug", "diagnose", "investigate", "performance", "profiling", "concurrency", "race condition", "optimize", "optimization", "memory leak", "bottleneck"],
    "level": "elevated"
  }
],
"defaultLevel": "normal",
```

Behavior notes: old `test`/`fix`/`patch` → `normal` is now covered by
`defaultLevel: "normal"` (unchanged outcome); `debug`/`refactor`/`security`
stay `elevated`; `root cause`/`migration` upgrade to `max` (deeper reasoning).

**Verify**: `pnpm typecheck && pnpm test` → pass.

### Step 7: Matcher unit tests

Create `test/unit/adaptive-match.test.ts`. Cases:

- `normalizeSignalText`: lowercases; collapses `"root\tcause"` and
  `"root  cause"` to `"root cause"`; trims leading/trailing space.
- `stem` default: `"debugging"` matches `debug`; `"refactoring"` matches
  `refactor`; `"migrations"` matches `migration`.
- `stem` rejects cross-word false positives: `latest` ✗ `test`, `prefix` ✗
  `fix`, `dispatch` ✗ `patch`, `contest` ✗ `test`.
- `word` strict: `"debugging"` ✗ `debug`; `"root causes"` ✗ `"root cause"`.
- `substring` legacy: `"latest"` matches `test` (documents the opt-in risk).
- `regex`: `^perf` matches `"performance"`; invalid pattern returns false
  (fail-soft) without throwing.
- Multi-word phrase with flexible whitespace under `stem`/`word`.
- Memoization smoke (no throw on repeated calls).

**Verify**: `pnpm test -- adaptive-match` → all pass.

### Step 8: Selector regression + new-behavior tests

Extend `test/unit/adaptive-selector.test.ts`. Add:

- Boundary regressions: prompt `"update the latest fixtures"` does NOT match a
  `test`/`fix` rule (assert level falls through to `defaultLevel`).
- Inflection via `stem`: prompt `"debugging the race condition"` matches an
  `elevated` rule whose keyword is `debug`.
- `match: "word"` rule does not match `"debugging"`.
- `excludeKeywords`: a `minimal` rule with `excludeKeywords: ["refactor"]` is
  skipped when the prompt contains `refactor`.
- Whitespace phrase: description `"investigate\nroot   cause"` matches a rule
  whose keyword is `"root cause"`.
- Richer reason: decision reason contains `rule[`, the matched keyword, the
  mode, and `prompt`/`description`.
- Backward-compat: a rule with **no** `match` field behaves as `stem` and
  still matches `"refactoring"`.

Update any existing test that relied on substring false-positives; if one
flips, it was a latent bug and the new assertion is the correct one.

**Verify**: `pnpm test -- adaptive-selector` → all pass.

### Step 9: Config-validation tests

Extend `test/unit/config-validate-sections.test.ts`. Cases:

- Valid adaptive block passes (including a `match: "regex"` rule with a valid
  pattern, and a rule with `excludeKeywords`).
- Rejects empty `keywords: []`.
- Rejects `level: "bogus"`.
- Rejects `match: "typo"` (not in the allowed set).
- Rejects an invalid regex when `match: "regex"`.
- Accepts `trivialLevel: null` and `defaultLevel: null`.

**Verify**: `pnpm test -- config-validate-sections` → all pass.

### Step 10: Docs + plan index

In `docs/REASONING.md`, add a subsection under Adaptive mode documenting:
the four match modes, the `stem` default and why, `excludeKeywords`, and the
known residual (code identifiers like `test_fixture` still match; code-fence
stripping is deferred).

In `plans/README.md`, add the Plan 018 row (Priority P2, Effort M, Risk LOW,
Depends on 015, Status TODO).

**Verify**: `pnpm typecheck && pnpm test` → pass.

## Test plan

- `test/unit/adaptive-match.test.ts` — matcher: normalization, four modes,
  false-positive rejection, inflection, regex fail-soft.
- `test/unit/adaptive-selector.test.ts` — boundary regressions, exclusions,
  phrase whitespace, richer reason, backward-compat (`stem` default).
- `test/unit/config-validate-sections.test.ts` — adaptive shape validation,
  empty keywords, bad level/mode, invalid regex.
- Full suite: no regressions in `static`/`manual` paths.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0; new test files exist and pass
- [ ] `pnpm lint` exits 0
- [ ] `grep -n ".includes(kw)" src/reasoning/adaptive.ts` returns no matches
      (the inline substring loop is gone)
- [ ] `src/reasoning/match.ts` exists and exports `matchSignal`, `MatchMode`,
      `normalizeSignalText`
- [ ] `config-validate.ts` references `reasoningPolicy`/`adaptive`
      (validation wired into `validateConfig`)
- [ ] `config/tiers/base.json` `keywordRules` uses at least 3 distinct levels
- [ ] Existing selector tests pass (with updated assertions where a latent
      false-positive was corrected)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts
  (drift since `60fb337`).
- `selectAdaptiveLevel`'s decision order has changed — this plan only
  touches the keyword step.
- `config-validate.ts` already has a `reasoningPolicy` validator (then adapt
  instead of adding a duplicate).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- Node's regex engine rejects the matcher shapes on the repo's minimum Node
  version (then switch to the documented equivalent and record it).

## Maintenance notes

- **Stem mode is prefix-based, not linguistic stemming.** It covers suffix
  inflections of the *exact base* (`debug` → debugging, `refactor` →
  refactoring). Words with divergent bases (`optimize` vs `optimization`)
  must each be listed. Document this for operators tuning `keywordRules`.
- **Known residual:** `stem`/`word` still match identifiers (`test_fixture`)
  because `_` is a `\w` char and `\b` is ASCII-only. Stripping code-fences
  before matching is a follow-up plan, not this one.
- **Adding a new match mode** is localized to `compileMatcher` in
  `match.ts` — do not change the selector loop.
- **A reviewer should scrutinize**: the `stem` regex (boundary + `\w*` on the
  last token) and the exclusion-before-match ordering.
- **Out of scope, deferred**: score-weighting (`minMatches`), unifying with
  `taskPatterns` / `classifyTrivial` behind one normalizer, i18n aliases,
  code-fence stripping, ML/embedding routing.
