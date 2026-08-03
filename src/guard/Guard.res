// ---------------------------------------------------------------------------
// Guard.res — Port of src/guard/guards.ts and src/guard/enforce.ts
//
// This module ports:
//   - src/guard/guards.ts  → pure classification/evaluation/state logic
//   - src/guard/enforce.ts → policy building and before/after hook integration
//
// The tool classification sets (FINISH_TOOLS, MUTATION_TOOLS, READ_ONLY_TOOLS,
// WRITE_TOOLS) are duplicated here as module-level Js.Dict.t<bool> to avoid
// circular imports. fingerprintToolCall is also inlined to keep this module
// self-contained.
//
// ABI discipline: all nullable fields use Js.Nullable.t<T> for explicit null
// handling at the TS boundary.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool classification sets (duplicated from router/tools.ts to avoid cycles)
// ---------------------------------------------------------------------------

// FINISH_TOOLS: tools that mark delegation as terminally complete
let _FINISH_TOOLS: Js.Dict.t<bool> = Js.Dict.fromArray([
  ("finish", true),
  ("return", true),
  ("task_complete", true),
])

// READ_ONLY_TOOLS: tools that never mutate the workspace
let _READ_ONLY_TOOLS: Js.Dict.t<bool> = Js.Dict.fromArray([
  ("grep", true),
  ("read", true),
  ("glob", true),
  ("ls", true),
])

// MUTATION_TOOLS: broader mutation set used by classify
let _MUTATION_TOOLS: Js.Dict.t<bool> = Js.Dict.fromArray([
  ("write", true),
  ("edit", true),
  ("patch", true),
  ("bash", true),
  ("multiedit", true),
])

// WRITE_TOOLS: tools that produce a changed-file record
let _WRITE_TOOLS: Js.Dict.t<bool> = Js.Dict.fromArray([
  ("write", true),
  ("edit", true),
  ("patch", true),
  ("multiedit", true),
])

// ---------------------------------------------------------------------------
// Regex constants for self-script detection
// ---------------------------------------------------------------------------

// SCRIPT_EXT_RE: /\.(mjs|sh|py|js|ts|cjs|bash)\b/i
let _SCRIPT_EXT_RE = %raw(`/\\.(mjs|sh|py|js|ts|cjs|bash)\\b/i`)

// HEREDOC_RE: /<<-?\s*['"]?[A-Za-z_]/
let _HEREDOC_RE = %raw(`/<<-?\\s*['"]?[A-Za-z_]/`)

// REDIRECT_SCRIPT_RE: />\s*\S+\.(mjs|sh|py|js|ts|cjs|bash)\b/i
let _REDIRECT_SCRIPT_RE = %raw(`/\\>\\s*\\S+\\.(mjs|sh|py|js|ts|cjs|bash)\\b/i`)

// INLINE_SCRIPT_RE: /\b(node|python3?|deno|bun)\s+-(e|c)\b/i
let _INLINE_SCRIPT_RE = %raw(`/\\b(node|python3?|deno|bun)\\s+-(e|c)\\b/i`)

// CAT_WRITE_RE: /\bcat\s+>\s*\S/
let _CAT_WRITE_RE = %raw(`/\\bcat\\s+>\\s*\\S/`)

// BASH_C_RE: /\bbash\s+-c\b/i
let _BASH_C_RE = %raw(`/\\bbash\\s+-c\\b/i`)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// defaultGuardBudget: default total tool-call ceiling for enforced subagent
let defaultGuardBudget = 25

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// guardKind: classifies a tool call into one of 5 buckets
type guardKind = [
  | #finish
  | #read
  | #mutation
  | #self_script
  | #other
]

// guardPolicy: configuration for the guard engine
type guardPolicy = {
  budget: int,
  readDraftCap: int,
  sameOpRetryCap: int,
  blockSelfScript: bool,
  deliverableFirst: bool,
  deliverableSignal: Js.Nullable.t<string>,
  deliverablePath: Js.Nullable.t<string>,
  deliverableIsScript: Js.Nullable.t<bool>,
  blockScriptWrites: Js.Nullable.t<bool>,
}

// guardCall: a tool call to be evaluated
type guardCall = {
  tool: string,
  args?: Js.Nullable.t<Js.Dict.t<Js.Json.t>>,
}

// guardDecision: result of evaluateGuards
type guardDecision = {
  allow: bool,
  guard: Js.Nullable.t<string>,
  observation: Js.Nullable.t<string>,
}

// guardState: mutable state tracked across a delegation session
type guardState = {
  mutable budget: int,
  mutable toolCallCount: int,
  mutable readCount: int,
  mutable execCount: int,
  mutable selfScriptCount: int,
  mutable redundantCount: int,
  mutable blockedCount: int,
  mutable consecutiveNonProducing: int,
  mutable deliverableExecuted: bool,
  mutable ttfa: Js.Nullable.t<int>,
  mutable seen: Js.Dict.t<int>,
  mutable lastBlock: Js.Nullable.t<string>,
}

// ---------------------------------------------------------------------------
// newGuardState
// ---------------------------------------------------------------------------

let newGuardState = (policy: guardPolicy): guardState => {
  {
    budget: policy.budget,
    toolCallCount: 0,
    readCount: 0,
    execCount: 0,
    selfScriptCount: 0,
    redundantCount: 0,
    blockedCount: 0,
    consecutiveNonProducing: 0,
    deliverableExecuted: false,
    ttfa: Js.Nullable.null,
    seen: Js.Dict.empty(),
    lastBlock: Js.Nullable.null,
  }
}

// guardStoreLike: interface for guard state persistence
type guardStoreLike = {
  ensure: (string, guardPolicy) => guardState,
  get: (string) => Js.Nullable.t<guardState>,
  setPendingNote: (string, string) => unit,
  takePendingNote: (string) => Js.Nullable.t<string>,
}

// makePolicyWithDefaults partial type
type makePolicyPartial = {
  budget?: int,
  readDraftCap?: int,
  sameOpRetryCap?: int,
  blockSelfScript?: bool,
  deliverableFirst?: bool,
  deliverableSignal?: Js.Nullable.t<string>,
  blockScriptWrites?: Js.Nullable.t<bool>,
}

// ---------------------------------------------------------------------------
// Policy helpers (for testing)
// ---------------------------------------------------------------------------

let makePolicyDefault = (): guardPolicy => {
  {
    budget: 8,
    readDraftCap: 3,
    sameOpRetryCap: 1,
    blockSelfScript: true,
    deliverableFirst: true,
    deliverableSignal: Js.Nullable.null,
    deliverablePath: Js.Nullable.null,
    deliverableIsScript: Js.Nullable.null,
    blockScriptWrites: Js.Nullable.null,
  }
}

let makePolicyWithDefaults = (partial: makePolicyPartial): guardPolicy => {
  let defaults = makePolicyDefault()
  {
    budget: switch partial.budget {
      | Some(v) => v
      | None => defaults.budget
      },
    readDraftCap: switch partial.readDraftCap {
      | Some(v) => v
      | None => defaults.readDraftCap
      },
    sameOpRetryCap: switch partial.sameOpRetryCap {
      | Some(v) => v
      | None => defaults.sameOpRetryCap
      },
    blockSelfScript: switch partial.blockSelfScript {
      | Some(v) => v
      | None => defaults.blockSelfScript
      },
    deliverableFirst: switch partial.deliverableFirst {
      | Some(v) => v
      | None => defaults.deliverableFirst
      },
    deliverableSignal: switch partial.deliverableSignal {
      | Some(v) => v
      | None => defaults.deliverableSignal
      },
    deliverablePath: defaults.deliverablePath,
    deliverableIsScript: defaults.deliverableIsScript,
    blockScriptWrites: switch partial.blockScriptWrites {
      | Some(v) => v
      | None => defaults.blockScriptWrites
      },
  }
}

let makePolicyWithBlockScriptWrites = (enabled: bool): guardPolicy => {
  let defaults = makePolicyDefault()
  { ...defaults, blockScriptWrites: Js.Nullable.return(enabled) }
}

let makePolicyWithDeliverablePath = (path: string): guardPolicy => {
  let defaults = makePolicyDefault()
  { ...defaults, deliverablePath: Js.Nullable.return(path) }
}

let makePolicyWithDeliverablePathAndBlockScript = (path: string, enabled: bool): guardPolicy => {
  let defaults = makePolicyDefault()
  {
    budget: defaults.budget,
    readDraftCap: defaults.readDraftCap,
    sameOpRetryCap: defaults.sameOpRetryCap,
    blockSelfScript: defaults.blockSelfScript,
    deliverableFirst: defaults.deliverableFirst,
    deliverableSignal: defaults.deliverableSignal,
    deliverablePath: Js.Nullable.return(path),
    deliverableIsScript: defaults.deliverableIsScript,
    blockScriptWrites: Js.Nullable.return(enabled),
  }
}

let makePolicyWithDeliverableIsScript = (enabled: bool): guardPolicy => {
  let defaults = makePolicyDefault()
  { ...defaults, deliverableIsScript: Js.Nullable.return(enabled) }
}

// beforeResult: result of guardBeforeCall
type beforeResult = {
  block: bool,
  message: Js.Nullable.t<string>,
  mode: string,
  guard: Js.Nullable.t<string>,
}

// updateState opts
type updateStateOpts = {ok: bool}

// minimal RouterConfig shape for guard policy building
type routerConfigMinimal = {
  enforcement: option<{
    guard: option<{
      budget: option<int>,
      readDraftCap: option<int>,
      sameOpRetryCap: option<int>,
      blockSelfScript: option<bool>,
      deliverableFirst: option<bool>,
      blockScriptWrites: option<bool>,
    }>,
    proportional: option<{
      trivialBypass: option<bool>,
    }>,
  }>,
}

// guardBeforeCall params
type guardBeforeCallParams = {
  cfg: routerConfigMinimal,
  tier: Js.Nullable.t<string>,
  sessionID: string,
  tool: string,
  toolArgs: Js.Nullable.t<Js.Dict.t<Js.Json.t>>,
  store: guardStoreLike,
  env: Js.Dict.t<Js.Nullable.t<string>>,
  trivial: Js.Nullable.t<bool>,
}

// guardAfterCall params
type guardAfterCallParams = {
  cfg: routerConfigMinimal,
  tier: Js.Nullable.t<string>,
  sessionID: string,
  tool: string,
  toolArgs: Js.Nullable.t<Js.Dict.t<Js.Json.t>>,
  output: {mutable output: Js.Nullable.t<Js.Json.t>},
  store: guardStoreLike,
}

// resolveEnforcementMode result
type resolveEnforcementModeResult = {mode: string}

// resolveEnforcementMode params
type resolveEnforcementModeParams = {
  config: option<routerConfigMinimal>,
  tier: option<string>,
  env: Js.Dict.t<Js.Nullable.t<string>>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// _hasToolSet: checks if a tool is in the given set (plain object in ReScript 12.x)
@setRuntimeSideEffects
let _hasToolSet = (tool: string, set: Js.Dict.t<bool>): bool => {
  %raw(`tool in set`)
}

// _hasScriptExt: checks if target has a script extension
@setRuntimeSideEffects
let _hasScriptExt = (target: string): bool => {
  %raw(`/\.(mjs|sh|py|js|ts|cjs|bash)\b/i.test(target)`)
}

// _hasHeredoc: checks for heredoc pattern
@setRuntimeSideEffects
let _hasHeredoc = (cmd: string): bool => {
  %raw(`/<<-?\\s*['"]?[A-Za-z_]/.test(cmd)`)
}

// _hasRedirectScript: checks for redirect-to-script pattern
@setRuntimeSideEffects
let _hasRedirectScript = (cmd: string): bool => {
  %raw(`/>\\s*\\S+\\.(mjs|sh|py|js|ts|cjs|bash)\\b/i.test(cmd)`)
}

// _hasInlineScript: checks for inline script execution
@setRuntimeSideEffects
let _hasInlineScript = (cmd: string): bool => {
  %raw(`/\b(node|python3?|deno|bun)\s+-(e|c)\b/i.test(cmd)`)
}

// _hasCatWrite: checks for cat-write pattern
@setRuntimeSideEffects
let _hasCatWrite = (cmd: string): bool => {
  %raw(`/\bcat\s+>\s*\S/.test(cmd)`)
}

// _hasBashC: checks for bash -c pattern
@setRuntimeSideEffects
let _hasBashC = (cmd: string): bool => {
  %raw(`/\bbash\s+-c\b/i.test(cmd)`)
}

// _stringifyArgs: converts args to a JSON string for fingerprinting
@setRuntimeSideEffects
let _stringifyArgs = (args: Js.Dict.t<Js.Json.t>): string => {
  %raw(`JSON.stringify(args).slice(0, 120)`)
}

// ---------------------------------------------------------------------------
// newGuardState
// ---------------------------------------------------------------------------

let newGuardState = (policy: guardPolicy): guardState => {
  {
    budget: policy.budget,
    toolCallCount: 0,
    readCount: 0,
    execCount: 0,
    selfScriptCount: 0,
    redundantCount: 0,
    blockedCount: 0,
    consecutiveNonProducing: 0,
    deliverableExecuted: false,
    ttfa: Js.Nullable.null,
    seen: Js.Dict.empty(),
    lastBlock: Js.Nullable.null,
  }
}

// ---------------------------------------------------------------------------
// fingerprintToolCall
// ---------------------------------------------------------------------------

@setRuntimeSideEffects
let _fingerprintToolCall = (tool: string, args: Js.Dict.t<Js.Json.t>): string => {
  %raw(`
    (function(tool, args) {
      var a = args || {};
      switch (tool) {
        case 'read': return 'read:' + (a.file_path || a.filePath || '');
        case 'grep': return 'grep:' + (a.pattern || '') + ':' + (a.path || a.glob || '');
        case 'glob': return 'glob:' + (a.pattern || '') + ':' + (a.path || '');
        case 'ls': return 'ls:' + (a.path || '');
        default: return tool + ':' + JSON.stringify(a).slice(0, 120);
      }
    })(tool, args)
  `)
}

// ---------------------------------------------------------------------------
// isSelfScript
// ---------------------------------------------------------------------------

let isSelfScript = (call: guardCall, policy: guardPolicy): bool => {
  // Get target from args (filePath, path, or file key)
  let args: Js.Dict.t<Js.Json.t> = switch call.args {
    | Some(a) => a->Js.Nullable.toOption->Belt.Option.getWithDefault(Js.Dict.empty())
    | None => Js.Dict.empty()
  }
  let target = switch args->Js.Dict.get("filePath") {
    | Some(v) => v->Js.Json.stringify
    | None =>
      switch args->Js.Dict.get("path") {
      | Some(v) => v->Js.Json.stringify
      | None =>
        switch args->Js.Dict.get("file") {
        | Some(v) => v->Js.Json.stringify
        | None => ""
        }
      }
  }
  let targetStr = target

  // Intent exemption: deliverableIsScript === true => never self-script
  switch policy.deliverableIsScript->Js.Nullable.toOption {
  | Some(true) => false
  | _ => {
      // deliverablePath exemption
      switch policy.deliverablePath->Js.Nullable.toOption {
      | Some(dp) =>
        if targetStr === dp {
          false
        } else {
          // Check for bash/shell ad-hoc execution
          if call.tool === "bash" || call.tool === "shell" {
            let cmd = switch args->Js.Dict.get("command") {
            | Some(v) => {
                let s: string = Obj.magic(v)
                s
              }
            | None =>
              switch args->Js.Dict.get("cmd") {
              | Some(v) => {
                  let s: string = Obj.magic(v)
                  s
                }
              | None => ""
              }
            }
            let cmdStr = cmd
            if cmdStr === "" {
              false
            } else {
              _hasHeredoc(cmdStr) ||
                _hasRedirectScript(cmdStr) ||
                _hasInlineScript(cmdStr) ||
                _hasCatWrite(cmdStr) ||
                _hasBashC(cmdStr)
            }
          } else if _hasToolSet(call.tool, _WRITE_TOOLS) {
            // WRITE-to-script (OPT-IN): only when blockScriptWrites === true
            switch policy.blockScriptWrites->Js.Nullable.toOption {
            | Some(true) => _hasScriptExt(targetStr)
            | _ => false
            }
          } else {
            false
          }
        }
      | None =>
        // No deliverablePath exemption — check for bash/shell ad-hoc
        if call.tool === "bash" || call.tool === "shell" {
          let cmd = switch args->Js.Dict.get("command") {
          | Some(v) => {
              let s: string = Obj.magic(v)
              s
            }
          | None =>
            switch args->Js.Dict.get("cmd") {
            | Some(v) => {
                let s: string = Obj.magic(v)
                s
              }
            | None => ""
            }
          }
          let cmdStr = cmd
          if cmdStr === "" {
            false
          } else {
            _hasHeredoc(cmdStr) ||
              _hasRedirectScript(cmdStr) ||
              _hasInlineScript(cmdStr) ||
              _hasCatWrite(cmdStr) ||
              _hasBashC(cmdStr)
          }
        } else if _hasToolSet(call.tool, _WRITE_TOOLS) {
          // WRITE-to-script (OPT-IN): only when blockScriptWrites === true
          switch policy.blockScriptWrites->Js.Nullable.toOption {
          | Some(true) => _hasScriptExt(targetStr)
          | _ => false
          }
        } else {
          false
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

let classify = (call: guardCall, policy: guardPolicy): guardKind => {
  if _hasToolSet(call.tool, _FINISH_TOOLS) {
    #finish
  } else if isSelfScript(call, policy) {
    #self_script
  } else if _hasToolSet(call.tool, _READ_ONLY_TOOLS) {
    #read
  } else if _hasToolSet(call.tool, _MUTATION_TOOLS) {
    #mutation
  } else {
    #other
  }
}

// ---------------------------------------------------------------------------
// evaluateGuards
// ---------------------------------------------------------------------------

let evaluateGuards = (state: guardState, call: guardCall, policy: guardPolicy): guardDecision => {
  let args: Js.Dict.t<Js.Json.t> = switch call.args {
    | Some(a) => a->Js.Nullable.toOption->Belt.Option.getWithDefault(Js.Dict.empty())
    | None => Js.Dict.empty()
  }
  let fp = _fingerprintToolCall(call.tool, args)
  let kind = classify(call, policy)

  // If blockSelfScript is false, treat self_script as mutation
  let effectiveKind: guardKind = switch kind {
  | #self_script =>
    if policy.blockSelfScript === false {
      #mutation
    } else {
      #self_script
    }
  | other => other
  }

  switch effectiveKind {
  | #finish =>
    { allow: true, guard: Js.Nullable.null, observation: Js.Nullable.null }

  | #self_script =>
    {
      allow: false,
      guard: Js.Nullable.return("anti_self_script"),
      observation: Js.Nullable.return(
        "DENIED: do not author or run a throwaway script. Do the task directly — write/edit the real target file, or run the actual build/test command."
      ),
    }

  | _ =>
    // CLAUSE 3: budget
    if state.toolCallCount >= state.budget {
      {
        allow: false,
        guard: Js.Nullable.return("iteration_cap"),
        observation: Js.Nullable.return(
          "DENIED: tool-call budget " ++ Belt.Int.toString(state.budget) ++ " exhausted. Stop now and emit your final answer with what you have."
        ),
      }
    } else {
      // CLAUSE 4: redundancy (only for read)
      if effectiveKind === #read {
        let seenCount = switch Js.Dict.get(state.seen, fp) {
        | Some(c) => c
        | None => 0
        }
        if seenCount >= policy.sameOpRetryCap {
          {
            allow: false,
            guard: Js.Nullable.return("redundant_read"),
            observation: Js.Nullable.return(
              "DENIED: you already ran this exact read (" ++ fp ++ "). Reuse the result you already have; take a producing action or finish."
            ),
          }
        } else if state.consecutiveNonProducing >= policy.readDraftCap {
          {
            allow: false,
            guard: Js.Nullable.return("read_budget"),
            observation: Js.Nullable.return(
              "DENIED: read/draft budget exhausted (" ++ Belt.Int.toString(policy.readDraftCap) ++ " consecutive non-producing actions). Take a producing action now (write/edit) or finish."
            ),
          }
        } else {
          // CLAUSE 6: deliverable_first
          if policy.deliverableFirst !== false &&
             !(policy.deliverableSignal->Js.Nullable.isNullable) &&
             state.deliverableExecuted === false &&
             (effectiveKind === #read || effectiveKind === #other) {
            {
              allow: false,
              guard: Js.Nullable.return("deliverable_first"),
              observation: Js.Nullable.return(
                "DENIED: you have not produced the deliverable yet. Your next action must be the deliverable (" ++
                (switch policy.deliverableSignal->Js.Nullable.toOption {
                | Some(s) => s
                | None => ""
                }) ++ ") before further exploration."
              ),
            }
          } else {
            // CLAUSE 7: allow
            { allow: true, guard: Js.Nullable.null, observation: Js.Nullable.null }
          }
        }
      } else {
        // Non-read: skip clauses 4-5, check deliverable_first
        if policy.deliverableFirst !== false &&
           !(policy.deliverableSignal->Js.Nullable.isNullable) &&
           state.deliverableExecuted === false &&
           (effectiveKind === #read || effectiveKind === #other) {
          {
            allow: false,
            guard: Js.Nullable.return("deliverable_first"),
            observation: Js.Nullable.return(
              "DENIED: you have not produced the deliverable yet. Your next action must be the deliverable (" ++
              (switch policy.deliverableSignal->Js.Nullable.toOption {
              | Some(s) => s
              | None => ""
              }) ++ ") before further exploration."
            ),
          }
        } else {
          // CLAUSE 7: allow
          { allow: true, guard: Js.Nullable.null, observation: Js.Nullable.null }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// updateState
// ---------------------------------------------------------------------------

let updateState = (
  state: guardState,
  call: guardCall,
  opts: updateStateOpts,
  policy: guardPolicy,
): guardState => {
  let kind = classify(call, policy)

  // finish: no count
  if kind === #finish {
    state
  } else {
    state.toolCallCount = state.toolCallCount + 1

    let args: Js.Dict.t<Js.Json.t> = switch call.args {
    | Some(a) => a->Js.Nullable.toOption->Belt.Option.getWithDefault(Js.Dict.empty())
    | None => Js.Dict.empty()
  }
    let fp = _fingerprintToolCall(call.tool, args)

    switch kind {
    | #self_script => {
        state.selfScriptCount = state.selfScriptCount + 1
        state.consecutiveNonProducing = state.consecutiveNonProducing + 1
        state
      }

    | #mutation => {
        state.execCount = state.execCount + 1
        state.consecutiveNonProducing = 0
        if opts.ok && !state.deliverableExecuted {
          state.deliverableExecuted = true
          state.ttfa = Js.Nullable.return(state.toolCallCount)
        }
        state
      }

    | #read => {
        state.readCount = state.readCount + 1
        state.consecutiveNonProducing = state.consecutiveNonProducing + 1
        let existing = switch Js.Dict.get(state.seen, fp) {
        | Some(c) => c
        | None => 0
        }
        Js.Dict.set(state.seen, fp, existing + 1)
        state
      }

    | #other | #finish => {
        state.consecutiveNonProducing = state.consecutiveNonProducing + 1
        state
      }
    }
  }
}

// ---------------------------------------------------------------------------
// recordBlock
// ---------------------------------------------------------------------------

let recordBlock = (state: guardState, decision: guardDecision): guardState => {
  state.lastBlock = decision.guard
  state.blockedCount = state.blockedCount + 1
  switch decision.guard->Js.Nullable.toOption {
  | Some("redundant_read") => state.redundantCount = state.redundantCount + 1
  | _ => ()
  }
  state
}

// ---------------------------------------------------------------------------
// forcingMessage
// ---------------------------------------------------------------------------

let forcingMessage = (state: guardState, policy: guardPolicy): string => {
  let deliverable = switch policy.deliverableSignal->Js.Nullable.toOption {
  | None => "n/a"
  | Some(_) =>
    if state.deliverableExecuted {
      "ran"
    } else {
      "NOT RUN"
    }
  }

  let next = switch policy.deliverableSignal->Js.Nullable.toOption {
  | Some(sig) =>
    if !state.deliverableExecuted {
      "run the deliverable (" ++ sig ++ ")"
    } else {
      "take a producing action (write/edit) or emit your final answer"
    }
  | None =>
    "take a producing action (write/edit) or emit your final answer"
  }

  "[budget " ++
    Belt.Int.toString(state.toolCallCount) ++ "/" ++
    Belt.Int.toString(state.budget) ++
    " | deliverable=" ++ deliverable ++
    " | reads_since_produce=" ++
    Belt.Int.toString(state.consecutiveNonProducing) ++
    "] NEXT: " ++ next
}

// ---------------------------------------------------------------------------
// trajectoryMetrics
// ---------------------------------------------------------------------------

let trajectoryMetrics = (state: guardState): Js.Dict.t<unknown> => {
  let ratio = if state.execCount === 0 {
    Belt.Float.fromInt(state.readCount)
  } else {
    Belt.Float.fromInt(state.readCount) /. Belt.Float.fromInt(state.execCount)
  }
  let ttfaVal = switch state.ttfa->Js.Nullable.toOption {
    | Some(v) => v
    | None => 0
  }
  // Pass local values explicitly to IIFE since %raw cannot capture let bindings
  %raw(`(function() { return arguments[0]; })`)({
    "ttfa": ttfaVal,
    "read_exec_ratio": ratio,
    "self_script_count": state.selfScriptCount,
    "tool_call_count": state.toolCallCount,
    "deliverable_executed": state.deliverableExecuted,
    "blocked_count": state.blockedCount,
    "redundant_count": state.redundantCount,
    "consecutive_non_producing": state.consecutiveNonProducing
  })
}

// ---------------------------------------------------------------------------
// observationOk
// ---------------------------------------------------------------------------

// ERROR_PREFIXES from the original TS
let _ERROR_PREFIXES: array<string> = [
  "DENIED",
  "BLOCKED",
  "Error",
  "error:",
  "ERROR",
  "Exception",
  "Traceback",
  "FAIL",
  "failed:",
]

@setRuntimeSideEffects
let observationOk = (output: Js.Json.t): bool => {
  // Inline ERROR_PREFIXES array since %raw cannot capture module-level let bindings
  %raw(`
    (function(output) {
      var s = typeof output === 'string' ? output.trimStart() : '';
      if (s.length === 0) return true;
      var prefixes = ["DENIED", "BLOCKED", "Error", "error:", "ERROR", "Exception", "Traceback", "FAIL", "failed:"];
      for (var i = 0; i < prefixes.length; i++) {
        if (s.startsWith(prefixes[i])) return false;
      }
      return true;
    })(output)
  `)
}

// ---------------------------------------------------------------------------
// buildGuardPolicy (from enforce.ts)
// ---------------------------------------------------------------------------

let buildGuardPolicy = (cfg: routerConfigMinimal, _tier: Js.Nullable.t<string>): guardPolicy => {
  let gg = switch cfg.enforcement {
  | Some(e) => e.guard
  | None => None
  }
  {
    budget: switch gg {
      | Some(g) => switch g.budget {
        | Some(v) => v
        | None => defaultGuardBudget
        }
      | None => defaultGuardBudget
      },
    readDraftCap: switch gg {
      | Some(g) => switch g.readDraftCap {
        | Some(v) => v
        | None => 3
        }
      | None => 3
      },
    sameOpRetryCap: switch gg {
      | Some(g) => switch g.sameOpRetryCap {
        | Some(v) => v
        | None => 1
        }
      | None => 1
      },
    blockSelfScript: switch gg {
      | Some(g) => switch g.blockSelfScript {
        | Some(v) => v
        | None => true
        }
      | None => true
      },
    deliverableFirst: switch gg {
      | Some(g) => switch g.deliverableFirst {
        | Some(v) => v
        | None => true
        }
      | None => true
      },
    deliverableSignal: Js.Nullable.null,  // always null in Wave 1
    deliverablePath: Js.Nullable.null,
    deliverableIsScript: Js.Nullable.null,
    blockScriptWrites: switch gg {
      | Some(g) => switch g.blockScriptWrites {
        | Some(v) => Js.Nullable.return(v)
        | None => Js.Nullable.null
        }
      | None => Js.Nullable.null
      },
  }
}

// ---------------------------------------------------------------------------
// formatScorecard (from enforce.ts)
// ---------------------------------------------------------------------------

let formatScorecard = (state: guardState, tier: Js.Nullable.t<string>): string => {
  let ttfaStr = switch state.ttfa->Js.Nullable.toOption {
  | Some(v) => Belt.Int.toString(v)
  | None => "n/a"
  }
  let tierStr = switch tier->Js.Nullable.toOption {
  | Some(t) => t
  | None => "?"
  }
  "[router scorecard | tier=" ++ tierStr ++
  " | ttfa=" ++ ttfaStr ++
  " | read:exec=" ++ Belt.Int.toString(state.readCount) ++ ":" ++
  Belt.Int.toString(state.execCount) ++
  " | self_scripts=" ++ Belt.Int.toString(state.selfScriptCount) ++
  " | tool_calls=" ++ Belt.Int.toString(state.toolCallCount) ++
  " | blocks=" ++ Belt.Int.toString(state.blockedCount) ++
  " | stop=" ++
  (switch state.lastBlock->Js.Nullable.toOption {
  | Some(b) => b
  | None => "none"
  }) ++ "]"
}

// ---------------------------------------------------------------------------
// resolveEnforcementMode (duplicated from router/enforcement.ts to avoid cycle)
// ---------------------------------------------------------------------------

let _DEFAULT_ENV_GATE = "MODEL_ROUTER_ENFORCE"

@setRuntimeSideEffects
let _resolveEnforcementMode = (params: resolveEnforcementModeParams): resolveEnforcementModeResult => {
  %raw(`
    (function(params) {
      var enf = params.config && params.config.enforcement;
      var gateName = (enf && enf.guard && enf.guard.envGate) || 'MODEL_ROUTER_ENFORCE';
      var raw = params.env && params.env[gateName];
      // Env gate overrides
      if (raw === '1') return { mode: 'enforced' };
      if (raw === '0') return { mode: 'off' };
      // Config resolution
      var base = (enf && enf.mode) || 'advisory';
      if (params.tier !== undefined && enf && enf.perTier && enf.perTier[params.tier] !== undefined) {
        base = enf.perTier[params.tier];
      }
      return { mode: base };
    })(params)
  `)
}

// ---------------------------------------------------------------------------
// guardBeforeCall (from enforce.ts)
// ---------------------------------------------------------------------------

// scrubText: redacts secrets from a string (duplicated from guard/scrub.ts to avoid cycle)
@setRuntimeSideEffects
let _scrubText = (input: string): string => {
  %raw(`
    (function(input) {
      if (typeof input !== 'string' || input.length === 0) return input;
      var KEYVALUE_RE = /(\\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization)\\b\\s*[:=]\\s*)['"]?[A-Za-z0-9._-]{6,}['"]?/gi;
      var TOKEN_PATTERNS = [
        /\\bsk-ant-[A-Za-z0-9_-]{16,}/g,
        /\\bsk-[A-Za-z0-9_-]{20,}/g,
        /\\bgh[posru]_[A-Za-z0-9]{20,}/g,
        /\\bAKIA[0-9A-Z]{16}\\b/g,
        /\\bAIza[0-9A-Za-z_-]{20,}/g,
        /\\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
        /\\beyJ[A-Za-z0-9._-]{20,}/g,
        /\\bBearer\\s+[A-Za-z0-9._-]+/gi,
      ];
      var out = input.replace(KEYVALUE_RE, '$1[REDACTED]');
      for (var i = 0; i < TOKEN_PATTERNS.length; i++) {
        out = out.replace(TOKEN_PATTERNS[i], '[REDACTED]');
      }
      return out;
    })(input)
  `)
}

let guardBeforeCall = (params: guardBeforeCallParams): beforeResult => {
  let tierStr = params.tier->Js.Nullable.toOption
  let modeResult = _resolveEnforcementMode({
    config: Some(params.cfg),
    tier: tierStr,
    env: params.env,
  })
  let mode = modeResult.mode

  // Trivial downgrade
  let effectiveMode = if mode === "enforced" {
    switch params.trivial->Js.Nullable.toOption {
    | Some(true) =>
      // Check proportional.trivialBypass (default true)
      switch params.cfg.enforcement {
      | Some(e) =>
        switch e.proportional {
        | Some(p) =>
          switch p.trivialBypass {
          | Some(false) => "enforced"
          | _ => "advisory"
          }
        | None => "advisory"
        }
      | None => "advisory"
      }
    | _ => "enforced"
    }
  } else {
    mode
  }

  if effectiveMode === "off" {
    { block: false, message: Js.Nullable.null, mode: "off", guard: Js.Nullable.null }
  } else {
    let policy = buildGuardPolicy(params.cfg, params.tier)
    let state = params.store.ensure(params.sessionID, policy)
    let call: guardCall = { tool: params.tool, args: params.toolArgs }
    let decision = evaluateGuards(state, call, policy)

    if decision.allow {
      { block: false, message: Js.Nullable.null, mode: effectiveMode, guard: Js.Nullable.null }
    } else if effectiveMode === "enforced" {
      // Count the refused attempt
      let _ = updateState(state, call, { ok: false }, policy)
      let _ = recordBlock(state, decision)
      let msg = _scrubText(
        (switch decision.observation->Js.Nullable.toOption {
        | Some(o) => o
        | None => ""
        }) ++ "\n" ++ forcingMessage(state, policy)
      )
      { block: true, message: Js.Nullable.return(msg), mode: effectiveMode, guard: decision.guard }
    } else {
      // advisory: never block; record the would-block and stash a banner
      let _ = recordBlock(state, decision)
      let note = _scrubText(
        "[⚠ GUARD:" ++
        (switch decision.guard->Js.Nullable.toOption {
        | Some(g) => g
        | None => ""
        }) ++ "] " ++ forcingMessage(state, policy)
      )
      params.store.setPendingNote(params.sessionID, note)
      { block: false, message: Js.Nullable.null, mode: effectiveMode, guard: decision.guard }
    }
  }
}

// ---------------------------------------------------------------------------
// guardAfterCall (from enforce.ts)
// ---------------------------------------------------------------------------

let guardAfterCall = (params: guardAfterCallParams): unit => {
  let state = params.store.get(params.sessionID)->Js.Nullable.toOption
  switch state {
  | None => ()
  | Some(s) => {
      let policy = buildGuardPolicy(params.cfg, params.tier)
      let call: guardCall = { tool: params.tool, args: params.toolArgs }
      let okResult = observationOk(
        switch params.output.output->Js.Nullable.toOption {
        | Some(o) => o
        | None => Js.Json.null
        }
      )
      let _ = updateState(s, call, { ok: okResult }, policy)
      let note = params.store.takePendingNote(params.sessionID)->Js.Nullable.toOption
      switch note {
      | Some(n) => {
          let existing = switch params.output.output->Js.Nullable.toOption {
          | Some(String(s)) => Some(s)
          | Some(_) => None
          | None => None
          }
          switch existing {
          | Some(e) => params.output.output = Js.Nullable.return(Js.Json.string(e ++ "\n\n" ++ n))
          | None => params.output.output = Js.Nullable.return(Js.Json.string(n))
          }
        }
      | None => ()
      }
    }
  }
}
