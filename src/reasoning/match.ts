// ---------------------------------------------------------------------------
// src/reasoning/match.ts — Pure word/stem/substring/regex matcher for the
// adaptive selector's keyword step.
//
// Pure function. No router state, no side effects, no IO. The module caches
// compiled regexes in a module-level `Map`, so repeated dispatch signals do
// not pay the regex-compile cost. The cache key is `${mode}|${keyword}` so
// each (mode, keyword) pair compiles once for the lifetime of the process.
//
// Four match modes are exposed via the `MatchMode` union:
//
//   - `word`        Strict word/phrase. `debug` ≠ `debugging`. Intended for
//                   rules that need to forbid inflections.
//   - `stem`        DEFAULT. Word-boundary at the start; suffix inflections
//                   allowed on the LAST token only (e.g. `debug` → `debugging`,
//                   `refactor` → `refactoring`). This is the only default
//                   that both rejects cross-word false positives (`latest`
//                   no longer matches `test`, `prefix` no longer matches `fix`)
//                   AND preserves the inflection behavior the legacy
//                   `String.includes()` already provided for `debug` etc.
//   - `substring`   Legacy `includes()` behavior — kept as an opt-in escape
//                   hatch for operators that really want to match across
//                   word breaks.
//   - `regex`       User-supplied pattern, as-is. Fail-soft at runtime
//                   (returns `false`); regex is also compile-checked at
//                   config load in `src/router/config-validate.ts`, where
//                   invalid patterns fail fast.
//
// `normalizeSignalText` is the canonical preprocessor used by the plugin
// hook layer before signals reach the selector; phrase keywords like
// "root cause" then match "root\tcause" and "root  cause" identically.
//
// Known residual (out of scope here): `stem`/`word` still match identifiers
// like `test_fixture` because `_` is a `\w` char and `\b` is ASCII-only.
// Stripping code-fences before matching is a follow-up plan.
// ---------------------------------------------------------------------------

/**
 * Match strategy for a single `AdaptiveKeywordRule`. See the module header
 * for the per-mode semantics. `stem` is the recommended default; pass an
 * explicit value to override.
 */
export type MatchMode = "word" | "stem" | "substring" | "regex";

/**
 * Preprocess raw task text (prompt or description) before keyword matching.
 *
 * Pipeline: lowercase → collapse every run of whitespace (spaces, tabs,
 * newlines) to a single space → trim. Phrase keywords then match across
 * any whitespace input without surprising the operator.
 */
export const normalizeSignalText = (raw: string): string =>
  raw.toLowerCase().replace(/\s+/g, " ").trim();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Memoized regex cache. Key shape: `${mode}|${keyword.toLowerCase()}`.
 * Resetting it would force re-compilation on the next call, which is
 * intentional — the cache only needs to outlive a single dispatch tick.
 */
const cache = new Map<string, RegExp>();

/**
 * Compile (and cache) the regex that `matchSignal` tests against. Internal
 * to this module — callers should go through `matchSignal`, which also
 * handles the runtime fail-soft path for invalid regex patterns.
 */
const compileMatcher = (keyword: string, mode: MatchMode): RegExp => {
  const key = `${mode}|${keyword.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tokens = keyword.trim().split(/\s+/).map(escapeRegExp);
  let re: RegExp;
  switch (mode) {
    case "word":
      re = new RegExp(`\\b${tokens.join("\\s+")}\\b`, "i");
      break;
    case "substring":
      re = new RegExp(tokens.join("\\s+"), "i");
      break;
    case "regex":
      // User-supplied pattern: passed through verbatim. The try/catch in
      // `matchSignal` makes invalid patterns fail soft at runtime; config
      // validation is responsible for failing them fast at load time.
      re = new RegExp(keyword, "i");
      break;
    default: {
      // `stem` (the documented default) and any unknown mode share the
      // same shape: word-boundary start; suffix inflections allowed on the
      // LAST token only.
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

/**
 * Test whether `text` matches `keyword` under the given `mode`.
 *
 * Contract:
 * - Empty keyword (`""`) → `false` (falsy short-circuit). Whitespace-only
 *   keywords fall through and compile to a degenerate regex that matches
 *   every word; operators must guard against that at config-time, since
 *   `matchSignal` is a low-level primitive.
 * - `mode === "regex"` with an invalid pattern → `false` (fail-soft at
 *   runtime). Config validation is the fail-fast gate.
 * - All other modes compile once per (mode, keyword) pair, then cache.
 * - Any unknown `mode` is treated as `"stem"` (see `compileMatcher`).
 *
 * Callers MUST pre-normalize `text` with `normalizeSignalText` so phrase
 * whitespace does not silently defeat a multi-word keyword.
 */
export const matchSignal = (text: string, keyword: string, mode: MatchMode): boolean => {
  if (!keyword) return false;
  try {
    return compileMatcher(keyword, mode).test(text);
  } catch {
    return false;
  }
};
