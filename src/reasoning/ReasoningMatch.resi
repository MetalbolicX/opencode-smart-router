// ---------------------------------------------------------------------------
// ReasoningMatch.resi — Public API contract for the keyword matcher.
//
// Pure functions: no I/O, no side effects, no router state. The module caches
// compiled regexes in a module-level Map so repeated dispatch signals do not
// pay the regex-compile cost.
//
// Four match modes:
//   - word        Strict word/phrase boundary match.
//   - stem        DEFAULT. Word-boundary start; suffix inflections on LAST
//                 token only (e.g. debug → debugging).
//   - substring   Legacy String.includes() behavior — kept as opt-in escape hatch.
//   - regex       User-supplied pattern, fail-soft at runtime.
// ---------------------------------------------------------------------------

type rec matchMode = [
  | #word
  | #stem
  | #substring
  | #regex
]

let normalizeSignalText: string => string
let matchSignal: (string, string, matchMode) => bool
