// ---------------------------------------------------------------------------
// ReasoningMatch.res — Pure word/stem/substring/regex matcher.
//
// All matching uses ReScript's stdlib (RegExp / Js.String) — no %raw, no
// Obj.magic. The pattern cache is a module-level dict; _testPat reads
// from it, _doTest runs the regex. _buildPattern constructs the regex
// source for each keyword/match-mode combination.
// ---------------------------------------------------------------------------

let _patCache: dict<string> = Dict.make()

type matchMode = [
  | #word
  | #stem
  | #substring
  | #regex
]

let normalizeSignalText = (raw: string): string => {
  raw
    ->String.toLowerCase
    ->String.split(" ")
    ->Array.filter(s => s->String.length > 0)
    ->Array.join(" ")
    ->String.trim
}

let _escapeRe = (s: string): string => {
  Js.String.replaceByRe(
    RegExp.fromString("[.*+?^$( )|[\\\\]\\\\]"),
    "\\$&",
    s
  )
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

// _doTest: takes pattern string and text as params.
let _doTest = (pat: string, signalTxt: string): bool => {
  try {
    RegExp.test(RegExp.fromString(pat, ~flags="i"), signalTxt)
  } catch {
  | _ => false
  }
}

// _testPat: cache lookup. Separated from _doTest so the cache read stays
// outside the regex try/catch path (an exception in RegExp.test returns
// false; the cache lookup never throws).
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
