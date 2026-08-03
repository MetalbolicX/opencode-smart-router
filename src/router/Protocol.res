// ---------------------------------------------------------------------------
// Protocol.res — Prompt builder module for the routing orchestrator.
//
// Ports src/router/protocol.ts to ReScript. This module generates the JSON
// prompts that get sent to LLMs. STRICT BYTE-LEVEL PARITY is required: the
// ReScript output must equal the TS output BYTE FOR BYTE.
//
// Exports:
//   - getActiveTiers: returns the active preset's tier map
//   - getActiveMode: returns the active mode config or undefined
//   - buildFallbackInstructions: builds Err→retry-alt-tier→fail→direct string
//   - buildTaskTaxonomy: builds R: taxonomy line
//   - buildDecomposeHint: builds multi-phase decomposition hint
//   - buildDelegationProtocol: builds the full delegation protocol string
//   - isClaudeModel: detects Claude model identifiers
//   - CLAUDE_TIER_PREFIX: per-tier adversarial openers (Record<string, string>)
//   - CLAUDE_ORCHESTRATOR_PREFIX: orchestrator authority override block
//   - CLAUDE_ANTI_NARRATION: anti-narration clause
//   - buildDoDProtocolSection: builds DoD/acceptance block for enforcement mode
//   - assembleSystemPrompt: assembles full system prompt
//   - tierConfigFromDict: converts Js.Dict.t<Js.Json.t> to internal tier config
//   - modeDefaultTier: extracts defaultTier from a mode record
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JSON decoding helpers
// ---------------------------------------------------------------------------

let optString = (json: JSON.t): string =>
  switch JSON.Decode.string(json) {
  | Some(s) => s
  | None => ""
  }

let optStringFromDict = (d: dict<JSON.t>, k: string): string =>
  switch Dict.get(d, k) {
  | Some(json) => optString(json)
  | None => ""
  }

let optStringOrNull = (json: JSON.t): Nullable.t<string> =>
  switch JSON.Decode.string(json) {
  | Some(s) => Nullable.make(s)
  | None => Nullable.null
  }

let optStringOrNullFromDict = (d: dict<JSON.t>, k: string): Nullable.t<string> =>
  switch Dict.get(d, k) {
  | Some(json) => optStringOrNull(json)
  | None => Nullable.null
  }

let optFloatFromDict = (d: dict<JSON.t>, k: string): Nullable.t<float> =>
  switch Dict.get(d, k) {
  | Some(json) =>
    switch JSON.Decode.float(json) {
    | Some(n) => Nullable.make(n)
    | None => Nullable.null
    }
  | None => Nullable.null
  }

let optStringArray = (json: JSON.t): array<string> =>
  switch JSON.Decode.array(json) {
  | Some(arr) => arr->Array.map(v => optString(v))
  | None => []
  }

let optStringArrayFromDict = (d: dict<JSON.t>, k: string): array<string> =>
  switch Dict.get(d, k) {
  | Some(json) => optStringArray(json)
  | None => []
  }

let optBoolFromDict = (d: dict<JSON.t>, k: string): Nullable.t<bool> =>
  switch Dict.get(d, k) {
  | Some(json) =>
    switch JSON.Decode.bool(json) {
    | Some(b) => Nullable.make(b)
    | None => Nullable.null
    }
  | None => Nullable.null
  }

// ---------------------------------------------------------------------------
// Types (matching Config.res pattern — separate declarations, type rec when needed)
// ---------------------------------------------------------------------------

type tierDef = {
  model: string,
  variant: Nullable.t<string>,
  costRatio: Nullable.t<float>,
  description: string,
  whenToUse: array<string>,
}

type modeConfig = {
  defaultTier: string,
  description: string,
  overrideRules: Nullable.t<array<string>>,
}

type verifyConfig = {
  requireExplicitDoD: Nullable.t<bool>,
}

type enforcementConfig = {
  verify: Nullable.t<verifyConfig>,
}

type fallbackConfig = {
  global: Nullable.t<dict<array<string>>>,
  presets: Nullable.t<dict<dict<array<string>>>>,
}

type tierConfig = {
  activePreset: string,
  activeMode: Nullable.t<string>,
  presets: dict<dict<tierDef>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Nullable.t<fallbackConfig>,
  taskPatterns: Nullable.t<dict<array<string>>>,
  modes: Nullable.t<dict<modeConfig>>,
  enforcement: Nullable.t<enforcementConfig>,
}

let tierDefFromDict = (d: dict<JSON.t>): tierDef => {
  model: optStringFromDict(d, "model"),
  variant: optStringOrNullFromDict(d, "variant"),
  costRatio: optFloatFromDict(d, "costRatio"),
  description: optStringFromDict(d, "description"),
  whenToUse: optStringArrayFromDict(d, "whenToUse"),
}

let fallbackConfigFromDict = (fb: dict<JSON.t>): fallbackConfig => {
  let optDictStringArray = (d: dict<JSON.t>, k: string): Nullable.t<dict<array<string>>> =>
    switch Dict.get(d, k) {
    | Some(json) =>
      switch JSON.Decode.object(json) {
      | Some(obj) => {
          let dict = Dict.make()
          obj
          ->Dict.toArray
          ->Array.forEach(((key, val)) =>
            switch JSON.Decode.array(val) {
            | Some(arr) => Dict.set(dict, key, arr->Array.map(v => optString(v)))
            | None => ()
            }
          )
          Nullable.make(dict)
        }
      | None => Nullable.null
      }
    | None => Nullable.null
    }
  let optDictDictStringArray = (d: dict<JSON.t>, k: string): Nullable.t<
    dict<dict<array<string>>>,
  > =>
    switch Dict.get(d, k) {
    | Some(json) =>
      switch JSON.Decode.object(json) {
      | Some(obj) => {
          let dict = Dict.make()
          obj
          ->Dict.toArray
          ->Array.forEach(((key1, val1)) =>
            switch JSON.Decode.object(val1) {
            | Some(innerObj) => {
                let innerDict = Dict.make()
                innerObj
                ->Dict.toArray
                ->Array.forEach(((key2, val2)) =>
                  switch JSON.Decode.array(val2) {
                  | Some(arr) => Dict.set(innerDict, key2, arr->Array.map(v => optString(v)))
                  | None => ()
                  }
                )
                Dict.set(dict, key1, innerDict)
              }
            | None => ()
            }
          )
          Nullable.make(dict)
        }
      | None => Nullable.null
      }
    | None => Nullable.null
    }
  {
    global: optDictStringArray(fb, "global"),
    presets: optDictDictStringArray(fb, "presets"),
  }
}

let modeConfigFromDict = (d: dict<JSON.t>): modeConfig => {
  defaultTier: optStringFromDict(d, "defaultTier"),
  description: optStringFromDict(d, "description"),
  overrideRules: switch Dict.get(d, "overrideRules") {
  | Some(json) =>
    switch JSON.Decode.array(json) {
    | Some(arr) => Nullable.make(arr->Array.map(v => optString(v)))
    | None => Nullable.null
    }
  | None => Nullable.null
  },
}

let verifyConfigFromDict = (d: dict<JSON.t>): verifyConfig => {
  requireExplicitDoD: optBoolFromDict(d, "requireExplicitDoD"),
}

let enforcementConfigFromDict = (d: dict<JSON.t>): enforcementConfig => {
  verify: switch Dict.get(d, "verify") {
  | Some(json) =>
    switch JSON.Decode.object(json) {
    | Some(obj) => Nullable.make(verifyConfigFromDict(obj))
    | None => Nullable.null
    }
  | None => Nullable.null
  },
}

let tierConfigFromDict = (d: dict<JSON.t>): tierConfig => {
  activePreset: optStringFromDict(d, "activePreset"),
  activeMode: optStringOrNullFromDict(d, "activeMode"),
  presets: {
    let result = Dict.make()
    switch Dict.get(d, "presets") {
    | Some(json) =>
      switch JSON.Decode.object(json) {
      | Some(presetsObj) =>
        presetsObj
        ->Dict.toArray
        ->Array.forEach(((presetName, presetVal)) =>
          switch JSON.Decode.object(presetVal) {
          | Some(presetObj) => {
              let tierMap = Dict.make()
              presetObj
              ->Dict.toArray
              ->Array.forEach(((tierName, tierVal)) =>
                switch JSON.Decode.object(tierVal) {
                | Some(tierObj) => Dict.set(tierMap, tierName, tierDefFromDict(tierObj))
                | None => ()
                }
              )
              Dict.set(result, presetName, tierMap)
            }
          | None => ()
          }
        )
      | None => ()
      }
    | None => ()
    }
    result
  },
  rules: optStringArrayFromDict(d, "rules"),
  defaultTier: optStringFromDict(d, "defaultTier"),
  fallback: switch Dict.get(d, "fallback") {
  | Some(json) =>
    switch JSON.Decode.object(json) {
    | Some(fbObj) => Nullable.make(fallbackConfigFromDict(fbObj))
    | None => Nullable.null
    }
  | None => Nullable.null
  },
  taskPatterns: switch Dict.get(d, "taskPatterns") {
  | Some(json) =>
    switch JSON.Decode.object(json) {
    | Some(obj) => {
        let dict = Dict.make()
        obj
        ->Dict.toArray
        ->Array.forEach(((k, v)) =>
          switch JSON.Decode.array(v) {
          | Some(arr) => Dict.set(dict, k, arr->Array.map(sv => optString(sv)))
          | None => ()
          }
        )
        Nullable.make(dict)
      }
    | None => Nullable.null
    }
  | None => Nullable.null
  },
  modes: switch Dict.get(d, "modes") {
  | Some(json) =>
    switch JSON.Decode.object(json) {
    | Some(obj) => {
        let dict = Dict.make()
        obj
        ->Dict.toArray
        ->Array.forEach(((k, v)) =>
          switch JSON.Decode.object(v) {
          | Some(modeObj) => Dict.set(dict, k, modeConfigFromDict(modeObj))
          | None => ()
          }
        )
        Nullable.make(dict)
      }
    | None => Nullable.null
    }
  | None => Nullable.null
  },
  enforcement: switch Dict.get(d, "enforcement") {
  | Some(json) =>
    switch JSON.Decode.object(json) {
    | Some(enfObj) => Nullable.make(enforcementConfigFromDict(enfObj))
    | None => Nullable.null
    }
  | None => Nullable.null
  },
}

let modeDefaultTier = (m: modeConfig): string => m.defaultTier

// ---------------------------------------------------------------------------
// getActiveTiers — returns the active preset's tiers
// ---------------------------------------------------------------------------

let getActiveTiers = (cfg: tierConfig): dict<tierDef> => {
  switch cfg.presets->Dict.get(cfg.activePreset) {
  | Some(tiers) => tiers
  | None => {
      let keys = Dict.keysToArray(cfg.presets)
      if Array.length(keys) > 0 {
        switch cfg.presets->Dict.get(Array.getUnsafe(keys, 0)) {
        | Some(tiers) => tiers
        | None => Dict.make()
        }
      } else {
        Dict.make()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// getActiveMode — returns the active mode or undefined
// ---------------------------------------------------------------------------

let getActiveMode = (cfg: tierConfig): option<modeConfig> => {
  switch (Nullable.toOption(cfg.modes), Nullable.toOption(cfg.activeMode)) {
  | (Some(modes), Some(activeMode)) =>
    switch modes->Dict.get(activeMode) {
    | Some(mode) => Some(mode)
    | None => None
    }
  | _ => None
  }
}

// ---------------------------------------------------------------------------
// buildFallbackInstructions
// ---------------------------------------------------------------------------

let buildFallbackInstructions = (cfg: tierConfig): string => {
  switch cfg.fallback->Nullable.toOption {
  | None => ""
  | Some(fb) =>
    // presetMap = fb.presets?.[cfg.activePreset]; map = presetMap || fb.global
    let presetMap = switch fb.presets->Nullable.toOption {
    | None => None
    | Some(fbPresets) => fbPresets->Dict.get(cfg.activePreset)
    }
    let map = switch presetMap {
    | Some(pm) =>
      let keys = Dict.keysToArray(pm)
      if Array.length(keys) > 0 {
        Some(pm)
      } else {
        fb.global->Nullable.toOption
      }
    | None => fb.global->Nullable.toOption
    }
    switch map {
    | None => ""
    | Some(m) =>
      // chains = Object.entries(map).flatMap(...)
      let chains: array<(string, array<string>)> = []
      Dict.toArray(m)->Array.forEach(((provider, presetOrder)) => {
        // Guard: if presetOrder is not an array (e.g. a string value in fb.global), skip
        if !Array.isArray(presetOrder) {
          ()->ignore
        } else {
          let valid =
            presetOrder->Array.filter(p =>
              p !== cfg.activePreset && cfg.presets->Dict.get(p)->Option.isSome
            )
          if Array.length(valid) > 0 {
            Array.push(chains, (provider ++ "→" ++ valid->Array.join("→"), valid))->ignore
          }
        }
      })
      let validChains = chains->Array.map(((s, _arr)) => s)->Array.filter(s => s !== "")
      if Array.length(validChains) === 0 {
        ""
      } else {
        `Err→retry-alt-tier→fail→direct. Chain: ${validChains->Array.join(" | ")}`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// buildTaskTaxonomy
// ---------------------------------------------------------------------------

let buildTaskTaxonomy = (cfg: tierConfig): string => {
  switch cfg.taskPatterns->Nullable.toOption {
  | None => ""
  | Some(tp) => {
      let keys = Dict.keysToArray(tp)
      if Array.length(keys) === 0 {
        ""
      } else {
        let lines: array<string> = ["R:"]
        keys->Array.forEach(k =>
          switch tp->Dict.get(k) {
          | Some(patterns) =>
            if Array.length(patterns) > 0 {
              Array.push(lines, `@${k}→${patterns->Array.join("/")}`)->ignore
            }
          | None => ()
          }
        )
        lines->Array.join(" ")
      }
    }
  }
}

// ---------------------------------------------------------------------------
// buildDecomposeHint
// ---------------------------------------------------------------------------

let buildDecomposeHint = (cfg: tierConfig): string => {
  let modeOpt = getActiveMode(cfg)
  // Skip if active mode has overrideRules
  let hasOverrideRules = switch modeOpt {
  | None => false
  | Some(mode) =>
    switch mode.overrideRules->Nullable.toOption {
    | None => false
    | Some(rules) => Array.length(rules) > 0
    }
  }
  if hasOverrideRules {
    ""
  } else {
    let tiers = getActiveTiers(cfg)
    let entries = Dict.toArray(tiers)
    if Array.length(entries) < 2 {
      ""
    } else {
      let entriesCopy = Array.copy(entries)
      Array.sort(entriesCopy, ((_ka, va), (_kb, vb)) => {
        let aRatio = switch va.costRatio->Nullable.toOption {
        | Some(r) => r
        | None => 1.0
        }
        let bRatio = switch vb.costRatio->Nullable.toOption {
        | Some(r) => r
        | None => 1.0
        }
        Int.toFloat(compare(aRatio, bRatio))
      })
      let (cheapestName, _) = Array.getUnsafe(entriesCopy, 0)
      let (midName, _) = Array.getUnsafe(entriesCopy, 1)
      if cheapestName === midName {
        ""
      } else {
        `Multi-phase: prefer explore(@${cheapestName})→execute(@${midName}) when phases are separable. Cheapest-first when practical.`
      }
    }
  }
}

// ---------------------------------------------------------------------------
// System prompt builder — buildDelegationProtocol
// ---------------------------------------------------------------------------

let buildDelegationProtocol = (cfg: tierConfig): string => {
  let tiers = getActiveTiers(cfg)

  // Compact tier summary: @name=model/variant(costRatio)
  let tierLineParts: array<string> = []
  Dict.toArray(tiers)->Array.forEach(((name, t)) => {
    let shortParts = String.split(t.model, "/")
    let short = Array.getUnsafe(shortParts, Array.length(shortParts) - 1)
    let v = switch t.variant->Nullable.toOption {
    | Some(vv) => `/${vv}`
    | None => ""
    }
    let c = switch t.costRatio->Nullable.toOption {
    | Some(r) => `(${Math.round(r)->Float.toInt->Int.toString}x)`
    | None => ""
    }
    Array.push(tierLineParts, `@${name}=${short}${v}${c}`)->ignore
  })
  let tierLine = tierLineParts->Array.join(" ")

  let modeOpt = getActiveMode(cfg)
  let modeSuffix = switch cfg.activeMode->Nullable.toOption {
  | Some(am) => ` mode:${am}`
  | None => ""
  }

  let taxonomy = buildTaskTaxonomy(cfg)
  let decompose = buildDecomposeHint(cfg)

  let effectiveRules: array<string> = switch modeOpt {
  | None => cfg.rules
  | Some(mode) =>
    switch mode.overrideRules->Nullable.toOption {
    | None => cfg.rules
    | Some(rules) =>
      if Array.length(rules) > 0 {
        rules
      } else {
        cfg.rules
      }
    }
  }
  let rulesLine = {
    let parts: array<string> = []
    effectiveRules->Array.forEach(r =>
      Array.push(parts, `${(parts->Array.length + 1)->Int.toString}.${r}`)->ignore
    )
    parts->Array.join(" ")
  }

  let fallback = buildFallbackInstructions(cfg)

  // Build the protocol array (matching TS array join structure)
  let protocolParts: array<string> = []
  let add = (s: string) => Array.push(protocolParts, s)->ignore

  add("## Model Delegation Protocol — MANDATORY")
  add("")
  add(
    "You are the orchestrator. Information-gathering is NOT orchestration — it IS execution. Execution belongs to subagents, not to you.",
  )
  add("")
  add(`Preset: ${cfg.activePreset}. Tiers: ${tierLine}.${modeSuffix}`)
  add("")
  add("### HARD ROUTING (non-negotiable)")
  add(
    "- **Read-only work** (grep, glob, read, ls, lookup, count, git-info, doc-lookup, type-check, exists-check) → default to `Task(subagent_type=\"fast\", ...)`. Self-cap (TARGET): ≤2 direct read-only calls per user turn; on the 3rd read-only need, dispatch @fast instead. You may exceed with a 1-line `reason:` note when dispatching feels clearly wrong. Rationale: every tool-result token is billed at your tier rate — a grep via @fast costs ~20x less than the same grep here.",
  )
  add(
    "- **Localized/simple implementation** (simple edits, small fixes, config tweaks, single-file refactoring) → `Task(subagent_type=\"light\", ...)`.",
  )
  add(
    "- **Standard implementation work** (write, edit, refactor, tests, bug-fix, build-fix, create-file, config, api-endpoint) → `Task(subagent_type=\"medium\", ...)`.",
  )
  add(
    "- **Deep single-system analysis** (single-system debugging, complex bug isolation, single-system review) → `Task(subagent_type=\"focused\", ...)`.",
  )
  add(
    "- **Architecture / security / perf / debugging after ≥2 failures / multi-system tradeoffs / RCA** → `Task(subagent_type=\"heavy\", ...)`, UNLESS you ARE @heavy (opus); then handle locally and never self-call @heavy.",
  )
  add("")
  add("### DISPATCH CAPS (read-only budget per subagent)")
  add(
    "Subagents carry a TARGET cap on their own read-only tool calls (baseline: @fast=8, @light=7, @medium=5, @focused=4, @heavy=3). Include `CAP:N` in the dispatch prompt to override (e.g., `CAP:3` for a tight lookup, `CAP:none` to disable). Mode adjustments apply automatically via rules below. Subagents also run a redundancy check every call: if they detect repeated reads/greps of the same area, they STOP and return partial findings with `DONE: ...`, `NEED MORE: ...`, or `ESCALATE: ...` — you decide the next step from their return.",
  )
  add("")
  add("### ROLE CONTRACT")
  add(
    "The primary agent's job: decompose the user's request, dispatch subagents, synthesize their results, and answer the user. Keep orchestration-first posture: prefer dispatching read-only exploration to @fast rather than running repeated Grep/Read/Glob/Bash calls yourself. Self-cap applies (see HARD ROUTING above): ≤2 direct read-only calls per turn as a target; beyond that, dispatch @fast.",
  )
  add("")
  add("### @fast contract")
  add(
    "@fast is a read-only explorer. It will search/grep/read/count/lookup and return file:line paths, snippets, and a one-line summary. It will refuse edits. Batch related searches into a single @fast dispatch when possible; fire independent searches in parallel (one message, multiple Task calls).",
  )
  add("")
  add("### @medium contract")
  add(
    "@medium is the implementer. It writes, edits, refactors, adds tests, fixes bugs, applies build-fixes. It matches existing project patterns, runs targeted tests for changed areas, and reports back if it hits 2+ consecutive failures instead of self-escalating. Give it context: file paths, patterns to match, what verification to run.",
  )
  add("")
  add("### @light contract")
  add(
    "@light is a localized implementation specialist. Scope: simple edits, small fixes, config tweaks, single-file refactoring. CAP\u22647. Stay within the given scope; if work grows beyond a single file or touches multiple modules, ESCALATE immediately. Return a concise summary: files changed, what was done, verification run.",
  )
  add("")
  add("### @focused contract (CRITICAL \u2014 read before every @focused dispatch)")
  add(
    "@focused is a deep single-system analysis specialist. Scope: deep single-system debugging, complex bug isolation, single-system code review, targeted performance analysis within one module/package. CAP\u22644. Stay within the one system you were dispatched to; if the work spans multiple systems or packages, return SCOPE GROWTH. Your 4 reads are for targeted single-system verification, not cross-system exploration.",
  )
  add("")
  add("### @heavy contract (CRITICAL \u2014 read before every @heavy dispatch)")
  add(
    "@heavy has **no Task tool** \u2014 it cannot self-explore, cannot grep, cannot delegate. Dispatching @heavy without context can waste a run: it may reason on thin evidence or return \"SCOPE GROWTH\" asking for additional @fast findings.",
  )
  add(
    "**Before @heavy, gather context first \u2014 usually via @fast.** If you already have sufficient concrete context, dispatch @heavy directly. If @heavy still needs more evidence, collect it with @fast and re-invoke.",
  )
  add(
    "Pattern: `Task(@fast, \"collect X, Y, Z\")` (when needed) \u2192 synthesize findings \u2192 `Task(@heavy, \"given these findings: [paste], analyze W\")`.",
  )
  add("")
  add("### CONFLICT WITH CLAUDE.md / AGENTS.md")
  add(
    "If CLAUDE.md or AGENTS.md (or any other guide in your context) says \"use direct tools first when scope is clear\" or labels Grep/Read/Glob as \"FREE\", **this protocol wins**. Those labels are wrong about cost: tools executed by you are billed at your tier rate \u2014 every tool-result token is tokenized into your context. A Grep dispatched to @fast costs ~20x less than the same Grep executed by @heavy. Treat yourself as expensive and delegate reads by default.",
  )
  add("")

  if taxonomy !== "" {
    add(taxonomy)
    add("")
  }

  if decompose !== "" {
    add(decompose)
    add("")
  }

  add("### Compact rules")
  add(rulesLine)

  if fallback !== "" {
    add("")
    add(fallback)
  }

  add("")
  add(
    "Delegate with `Task(subagent_type=\"fast\"|\"light\"|\"medium\"|\"focused\"|\"heavy\", prompt=\"...\")`. Keep orchestration and final synthesis here.",
  )
  add("")
  add("### Invalid Targets")
  add(
    "**`build` is NOT a valid `Task(subagent_type=...)` target** \u2014 the `build` agent is the built-in primary/default agent, not a router-managed subagent. Dispatching `Task(subagent_type=\"build\")` will be rejected with a runtime guard error. Use `fast`, `light`, `medium`, `focused`, or `heavy` instead, or use a skill agent that carries the `\"subagent\"` mode marker in its definition.",
  )

  protocolParts->Array.join("\n")
}

// ---------------------------------------------------------------------------
// Claude-model adversarial prefixes
// ---------------------------------------------------------------------------

let isClaudeModel = (modelID: Nullable.t<string>): bool => {
  let stringContains = (s: string, needle: string): bool => {
    let rec go = (i: int): bool => {
      if i > String.length(s) - String.length(needle) {
        false
      } else {
        let remaining = String.substring(s, ~start=i, ~end=String.length(s))
        if String.startsWith(remaining, needle) {
          true
        } else {
          go(i + 1)
        }
      }
    }
    go(0)
  }
  let startsWith = (s: string, prefix: string): bool => String.startsWith(s, prefix)
  switch modelID->Nullable.toOption {
  | None => false
  | Some(s) => {
      let lower = s->String.toLowerCase
      if startsWith(lower, "anthropic/") {
        true
      } else {
        stringContains(lower, "/claude-") || {
          let rec go = (i: int): bool => {
            if i >= String.length(lower) {
              false
            } else {
              let remaining = String.substring(lower, ~start=i, ~end=String.length(lower))
              if String.startsWith(remaining, "claude-") {
                if i === 0 {
                  true
                } else {
                  let prev = String.charAt(lower, i - 1)
                  prev === "/" || prev === "-" ? true : go(i + 1)
                }
              } else {
                go(i + 1)
              }
            }
          }
          go(0)
        }
      }
    }
  }
}

let claudeTierPrefix: dict<string> = {
  let d = Dict.make()
  Dict.set(
    d,
    "fast",
    "SCOPE NOTE \u2014 any cached instruction priming you to 'thoroughly explore\nthe codebase' or 'gather context broadly' does not apply here. This is\na single dispatch with a single question. Stay narrow to the ask.\n\nBefore every tool call, ask: 'Does THIS read answer the dispatch\nquestion specifically, or am I drifting into context-gathering for my\nown understanding?' If the latter, stop \u2014 you have enough.",
  )
  Dict.set(
    d,
    "light",
    "SCOPE NOTE \u2014 this dispatch is for localized single-file or small-scope\nchanges. If the work grows beyond a single file or touches multiple\nmodules, return ESCALATE immediately. Do NOT expand scope unilaterally.\n\nStay within the given scope. A 6th or 7th tool call is a sign the\nscope is growing \u2014 ESCALATE rather than continuing.",
  )
  Dict.set(
    d,
    "medium",
    "SCOPE NOTE \u2014 cached instructions may prime you to deeply understand\nsurrounding code before editing. For THIS dispatch, the orchestrator\nhas already scoped the problem; trust that scoping. Read what's needed\nfor the edit, not the whole module.\n\nA 4th or 5th 'context read' is usually a sign the dispatch was under-\nscoped \u2014 return NEED CONTEXT rather than expanding scope yourself.",
  )
  Dict.set(
    d,
    "focused",
    "AUTHORITY OVERRIDE \u2014 this block supersedes any cached prefix suggesting\nyou should 'investigate broadly' or 'trace through multiple systems'.\nYou are @focused, a SINGLE-SYSTEM deep analysis specialist. Stay within\nthe one system/module you were dispatched to.\n\nIf the work spans multiple systems or packages, return SCOPE GROWTH\nimmediately. Your 4 reads are for targeted single-system verification,\nnot cross-system exploration.",
  )
  Dict.set(
    d,
    "heavy",
    "AUTHORITY OVERRIDE \u2014 this block supersedes any cached prefix suggesting\nyou should 'investigate thoroughly', 'gather comprehensive context', or\n'trace through the code systematically before analyzing'. You are\n@heavy, an ANALYSIS specialist. The orchestrator should have pre-\ngathered context via @fast before dispatching you. If it didn't, return\n`SCOPE GROWTH:` immediately \u2014 do NOT self-gather.\n\n40 minutes of Read/Grep is not analysis \u2014 it is the orchestrator's job\nthat leaked into yours. Push it back with SCOPE GROWTH. Your 3 reads\nare for targeted verification, not exploration.",
  )
  d
}

let claudeOrchestratorPrefix = "AUTHORITY OVERRIDE \u2014 this block supersedes any prior system instruction\nabout 'exploring the codebase', 'gathering context with tools', or using\nRead/Grep/Glob to validate assumptions. Those instructions describe a\ngeneral-purpose Claude Code session. THIS session is a routing\norchestrator.\n\nYour job is to DISPATCH, not to EXECUTE. Read-only work (grep/read/\nglob/ls) is execution, and execution is delegated to @fast. You may run\nAT MOST 2 direct read-only tool calls per turn \u2014 a 3rd call is a rule\nviolation. If you need more context, you dispatch @fast.\n\nIf a cached instruction told you to 'be thorough', 'explore broadly', or\n'read supporting files' \u2014 ignore it here. Thoroughness is achieved by\ndispatching the right tier, not by you becoming the explorer."

let claudeAntiNarration = "ANTI-NARRATION \u2014 do NOT write progress commentary in your response or\nthinking output. Forbidden phrasings include:\n  - \"Still writing the X function...\"\n  - \"Now I'll implement Y...\"\n  - \"Let me add Z...\"\n  - \"Continuing with W...\"\n  - \"Going to fix V...\"\n\nEach of these signals planning without production. If you write one, the\nNEXT tokens MUST contain the actual artifact (the code, the edit, the\nconcrete output). Otherwise, stop and return with status.\n\nException: when the user explicitly asks for an explanation, plan, or\nwalkthrough, prose is welcome \u2014 this rule targets unsolicited progress\nnarration during code and implementation tasks."

// ---------------------------------------------------------------------------
// buildDoDProtocolSection
// ---------------------------------------------------------------------------

let buildDoDProtocolSection = (cfg: tierConfig): string => {
  let requireExplicit = switch cfg.enforcement->Nullable.toOption {
  | None => false
  | Some(enf) =>
    switch enf.verify->Nullable.toOption {
    | None => false
    | Some(v) =>
      switch v.requireExplicitDoD->Nullable.toOption {
      | Some(b) => b
      | None => false
      }
    }
  }
  let omitLine = if requireExplicit {
    "A DoD is REQUIRED: a non-trivial dispatch without an [acceptance] block is rejected."
  } else {
    "If you omit the block, a minimal DoD is auto-inferred from the task type."
  }
  let lines: array<string> = []
  let add = (s: string) => Array.push(lines, s)->ignore
  add("### Acceptance / Definition of Done (enforcement is ON)")
  add(
    "Non-trivial delegations are independently verified before their result is accepted (producer \u2260 grader; grader \u2265 producer tier). Attach an acceptance block to your dispatch so the gate knows what \"done\" means:",
  )
  add("")
  add("[acceptance]")
  add("check: testsPass")
  add("check: buildPasses")
  add("check: fileExists path=src/foo.ts")
  add("check: run command=\"node -e ...\" expect=OK")
  add("criteria: <plain-language success condition>")
  add("deliverable: <path or short description>")
  add("[/acceptance]")
  add("")
  add(
    "- check kinds: testsPass | buildPasses | lintClean | fileExists path=\u2026 | schemaMatch path=\u2026 schema=\u2026 | run command=\"\u2026\" expect=\u2026",
  )
  add("- " ++ omitLine)
  add(
    "- A failing DoD causes the result to be rejected and retried/escalated, not silently accepted.",
  )
  lines->Array.join("\n")
}

// ---------------------------------------------------------------------------
// assembleSystemPrompt
// ---------------------------------------------------------------------------

let assembleSystemPrompt = (
  cfg: tierConfig,
  orchestratorModel: Nullable.t<string>,
  enforcementOn: bool,
): string => {
  let delegationProtocol = buildDelegationProtocol(cfg)
  let dodSection = if enforcementOn {
    `\n\n---\n\n${buildDoDProtocolSection(cfg)}`
  } else {
    ""
  }
  if isClaudeModel(orchestratorModel) {
    `${claudeOrchestratorPrefix}\n\n${claudeAntiNarration}\n\n---\n\n${delegationProtocol}${dodSection}`
  } else {
    `${delegationProtocol}${dodSection}`
  }
}
