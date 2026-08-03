// ---------------------------------------------------------------------------
// ReasoningMatch.res — Pure word/stem/substring/regex matcher.
//
// KNOWN ISSUES with ReScript 12 %raw:
// 1. `let pat = expr` where expr is only consumed by %raw → binding dropped
// 2. %raw cannot capture let-bindings from switch/if branches
// 3. %raw cannot access module-level variables (closure fails)
// 4. Helper functions with %raw get inlined and parameter names not
//    substituted correctly in nested IIFE calls
//
// SOLUTION: Use a two-level helper approach. _testPat receives the
// cache as a parameter (not %raw itself), and inside it a second nested
// helper _doTest does the actual %raw call with the pattern string.
// Since _doTest takes pattern as a PARAMETER (not from %raw), it works.
// ---------------------------------------------------------------------------

let _patCache: dict<string> = Dict.make()

type matchMode = [
  | #word
  | #stem
  | #substring
  | #regex
]

let normalizeSignalText = (_raw: string): string => {
  %raw(`raw.toLowerCase().split(/\s+/).join(' ').trim()`)
}

@setRuntimeSideEffects
let _escapeRe = (_s: string): string => {
  %raw(`s.replace(/[.*+?^$( )|[\\\\]\\\\]/g, '\\\\$&')`)
}

@setRuntimeSideEffects
let _buildPattern = (keyword: string, mm: matchMode): string => {
  let kwLower = keyword->String.toLowerCase
  mm === #word
    ? {
        let tokens = kwLower->String.split(" ")->Array.map(_escapeRe)
        "\\b" ++ tokens->Array.join("\\s+") ++ "\\b"
      }
    : mm === #substring
    ? {
      kwLower->String.split(" ")->Array.map(_escapeRe)->Array.join("\\s+")
    }
    : mm === #regex
    ? kwLower
    : {
        // stem
        let tokens = kwLower->String.split(" ")
        let tokLen = tokens->Array.length
        tokLen === 0
          ? "\\b\\w*"
          : tokLen === 1
          ? {
            let firstTok = switch tokens->Belt.Array.get(0) {
            | Some(v) => v
            | None => ""
            }
            "\\b" ++ firstTok ++ "\\w*"
          }
          : {
              let lastTok = switch tokens->Belt.Array.get(tokLen - 1) {
              | Some(v) => v
              | None => ""
              }
              let headToks = tokens->Belt.Array.slice(~offset=0, ~len=tokLen - 1)
              let escHead = headToks->Array.map(_escapeRe)->Array.join("\\s+")
              "\\b" ++ escHead ++ "\\s+" ++ lastTok ++ "\\w*"
            }
      }
}

// _doTest: takes pattern string and text as params; %raw is the return expr.
// Since pat and signalTxt are function params, %raw can access them directly.
let _doTest = (_pat: string, _signalTxt: string): bool => {
  %raw(`(function(pat, signalTxt) {
    try { return (new RegExp(pat, "i")).test(signalTxt); } catch(e) { return false; }
  })(pat, signalTxt)`)
}

// _testPat: takes cache dict + key, retrieves pattern, calls _doTest.
// This function is NOT inlinable because it uses %raw indirectly via _doTest.
let _testPat = (cache: dict<string>, key: string, signalTxt: string): bool => {
  switch Dict.get(cache, key) {
  | Some(pat) => _doTest(pat, signalTxt)
  | None => false
  }
}

let matchSignal = (signalTxt: string, keyword: string, mm: matchMode): bool => {
  if keyword === "" {
    false
  } else {
    let pat = _buildPattern(keyword, mm)
    // Touch pat to preserve the let-binding (workaround for bug #1).
    Dict.set(_patCache, "pat", pat)
    _testPat(_patCache, "pat", signalTxt)
  }
}
