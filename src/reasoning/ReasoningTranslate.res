// ---------------------------------------------------------------------------
// ReasoningTranslate.res — Translate a normalized reasoning level into a
// provider-specific patch, routed by the capability's `field` channel.
//
// Pure function. No router state, no side effects, no IO.
//
// Routing by cap.kind:
//   - "none"    → null (never mutated; silent no-op)
//   - "binary"  → variant channel: elevated/max → cap.elevated,
//                                minimal/normal → cap.baseline (if declared)
//   - "discrete"→ variant channel OR reasoning.effort channel (cap.field)
//                 Discrete ladder clamps via:
//                   Math.round((rank/3)*(len-1)) → index
//   - "budgeted"→ thinking.budgetTokens channel:
//                 cap.recommended[level] ?? cap.recommended["normal"]
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types (mirrors ReasoningCapability — defined locally for module boundary)
// ---------------------------------------------------------------------------

type reasoningLevel = [
  | #minimal
  | #normal
  | #elevated
  | #max
]

type reasoningCapability = {
  kind: string,
  field?: string,
  baseline?: string,
  elevated?: string,
  levels?: array<string>,
  recommended?: dict<float>,
}

type resolvedReasoning = {
  variant?: string,
  options?: dict<JSON.t>,
}

// ---------------------------------------------------------------------------
// Helpers — build JS-shaped option dicts for provider payloads
// ---------------------------------------------------------------------------

let _effortOpts = (picked: string): dict<JSON.t> => {
  let d = Dict.make()
  Dict.set(d, "reasoning_effort", JSON.Encode.string(picked))
  d
}
let _budgetOpts = (tokens: float): dict<JSON.t> => {
  let d = Dict.make()
  Dict.set(d, "budget_tokens", JSON.Encode.float(tokens))
  d
}

// Compute Math.round((rank / 3) * (len - 1))
let _clampIdx = (rank: int, len: int): int => {
  Math.round(Float.fromInt(rank) /. 3.0 *. (Float.fromInt(len) -. 1.0))->Float.toInt
}

// ---------------------------------------------------------------------------
// DISCRETE_RANK — maps normalized level to ordinal position
// ---------------------------------------------------------------------------

let discreteRank: dict<int> = {
  let d = Dict.make()
  Dict.set(d, "minimal", 0)
  Dict.set(d, "normal", 1)
  Dict.set(d, "elevated", 2)
  Dict.set(d, "max", 3)
  d
}

// ---------------------------------------------------------------------------
// translateLevel — pure capability-to-patch translator
// ---------------------------------------------------------------------------

let translateLevel = (cap: reasoningCapability, level: reasoningLevel): option<
  resolvedReasoning,
> => {
  // Switch on kind string — matches TS discriminated union via string literals
  switch cap.kind {
  | "none" => None

  | "binary" => {
      let isElevated = level === #elevated || level === #max
      if isElevated {
        switch cap.elevated {
        | Some(v) => Some({variant: v})
        | None => None
        }
      } else {
        switch cap.baseline {
        | Some(b) => Some({variant: b})
        | None => None
        }
      }
    }

  | "discrete" => {
      // Map level name to numeric rank
      let levelName = switch level {
      | #minimal => "minimal"
      | #normal => "normal"
      | #elevated => "elevated"
      | #max => "max"
      }
      let rank = switch Dict.get(discreteRank, levelName) {
      | Some(r) => r
      | None => 0
      }
      let levels = switch cap.levels {
      | Some(l) => l
      | None => []
      }
      let len = levels->Array.length
      if len === 0 {
        None
      } else {
        // Math.round((rank / 3) * (len - 1)) with JS Math
        let rawIdx = _clampIdx(rank, len)
        let idx = rawIdx < len ? rawIdx : len - 1
        let picked = switch levels->Array.get(idx) {
        | Some(v) => v
        | None => ""
        }
        if picked === "" {
          None
        } else {
          switch cap.field {
          | Some("variant") => Some({variant: picked})
          | _ => {
              let opts = _effortOpts(picked)
              Some({options: opts})
            }
          }
        }
      }
    }

  | "budgeted" => {
      let levelName = switch level {
      | #minimal => "minimal"
      | #normal => "normal"
      | #elevated => "elevated"
      | #max => "max"
      }
      let rec_ = switch cap.recommended {
      | Some(r) => r
      | None => Dict.make()
      }
      let tokens = switch Dict.get(rec_, levelName) {
      | Some(t) => Some(t)
      | None => Dict.get(rec_, "normal")
      }
      switch tokens {
      | Some(t) => {
          let opts = _budgetOpts(t)
          Some({options: opts})
        }
      | None => None
      }
    }

  | _ => None
  }
}
