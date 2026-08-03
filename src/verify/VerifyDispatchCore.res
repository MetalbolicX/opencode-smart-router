// src/verify/VerifyDispatchCore.res
// PURE dispatch core — no IO, no SDK calls.
// Pure helpers for task parsing, DoD building, tier resolution, and forcing notes.

open VerifyDoD

// ---------------------------------------------------------------------------
// ChangedFile
// ---------------------------------------------------------------------------

type changedFile = {
  path: string,
  status: string,
}

// ---------------------------------------------------------------------------
// ParsedTaskResult
// ---------------------------------------------------------------------------

type parsedTaskResult = {
  finalReturnText: string,
  childSessionID: Nullable.t<string>,
  parentSessionID: Nullable.t<string>,
}

// ---------------------------------------------------------------------------
// extractChangedFile
// ---------------------------------------------------------------------------

let writeTools: array<string> = ["write", "edit"]

let isWriteTool = (tool: string): bool => {
  let found = ref(false)
  for i in 0 to Array.length(writeTools) - 1 {
    switch writeTools[i] {
    | Some(w) if w === tool => found := true
    | _ => ()
    }
  }
  found.contents
}

let getStringField = (obj: dict<JSON.t>, key: string): string => {
  switch Dict.get(obj, key) {
  | Some(v) =>
    switch JSON.Decode.string(v) {
    | Some(s) => s
    | None => ""
    }
  | None => ""
  }
}

let extractChangedFile = (tool: string, args: JSON.t): Nullable.t<changedFile> => {
  if !isWriteTool(tool) {
    Nullable.null
  } else {
    let obj = switch JSON.Decode.object(args) {
    | Some(o) => o
    | None => Dict.make()
    }
    let path = getStringField(obj, "filePath")
    let pathB = if path === "" {
      getStringField(obj, "path")
    } else {
      path
    }
    let pathC = if pathB === "" {
      getStringField(obj, "file")
    } else {
      pathB
    }
    if pathC === "" {
      Nullable.null
    } else {
      let status = if tool === "write" {
        "written"
      } else {
        "modified"
      }
      Nullable.make({path: pathC, status})
    }
  }
}

// ---------------------------------------------------------------------------
// createChangedFileStore
// ---------------------------------------------------------------------------

type changedFileStore = {
  record: (string, string, JSON.t) => unit,
  get: string => array<changedFile>,
  clear: string => unit,
}

type fileMap = dict<string>

let recFindPrev = (m: fileMap, path: string): string => {
  switch Dict.get(m, path) {
  | Some(v) => v
  | None => ""
  }
}

let buildFileArray = (entries: array<(string, string)>): array<changedFile> => {
  let rec go = (i: int, acc: array<changedFile>): array<changedFile> => {
    if i >= Array.length(entries) {
      acc
    } else {
      switch entries[i] {
      | Some((path, status)) => go(i + 1, [...acc, {path, status}])
      | None => go(i + 1, acc)
      }
    }
  }
  go(0, [])
}

let createChangedFileStore = (): changedFileStore => {
  let bySession: dict<fileMap> = Dict.make()

  let record = (sessionID: string, tool: string, args: JSON.t): unit => {
    let cf = extractChangedFile(tool, args)
    switch cf->Nullable.toOption {
    | Some(f) => {
        let m = switch Dict.get(bySession, sessionID) {
        | Some(existing) => existing
        | None => {
            let newMap: fileMap = Dict.make()
            Dict.set(bySession, sessionID, newMap)
            newMap
          }
        }
        let prev = recFindPrev(m, f.path)
        let newStatus = if prev === "written" {
          "written"
        } else {
          f.status
        }
        Dict.set(m, f.path, newStatus)
      }
    | None => ()
    }
  }

  let get = (sessionID: string): array<changedFile> => {
    switch Dict.get(bySession, sessionID) {
    | Some(m) => {
        let entries = Dict.toArray(m)
        buildFileArray(entries)
      }
    | None => []
    }
  }

  let clear = (_sessionID: string): unit => {
    %raw(`delete bySession[sessionID]`)
  }

  {record, get, clear}
}

// ---------------------------------------------------------------------------
// parseTaskResult
// ---------------------------------------------------------------------------

let getMetadataField = (metadata: dict<JSON.t>, key1: string, key2: string): Nullable.t<string> => {
  let rec tryKeys = (keys: list<string>): Nullable.t<string> => {
    switch keys {
    | list{} => Nullable.null

    | list{key, ...rest} =>
      switch Dict.get(metadata, key) {
      | Some(v) =>
    switch JSON.Decode.string(v) {
        | Some(s) => Nullable.make(s)
        | None => tryKeys(rest)
        }
      | None => tryKeys(rest)
      }
    }
  }
  tryKeys(list{key1, key2})
}

let extractTaskResultContent = (s: string): string => {
  let openTag = "<task_result>"
  let closeTag = "</task_result>"
  let openIdx = String.indexOf(openTag, s)
  let closeIdx = switch openIdx {
  | -1 => -1
  | _ => String.indexOf(closeTag, s)
  }
  switch (openIdx, closeIdx) {
  | (-1, _) => s
  | (_, -1) => s
  | (oi, ci) =>
    let start = oi + String.length(openTag)
    if start > ci {
      s
    } else {
      String.trim(String.substring(s, ~start, ~end=ci))
    }
  }
}

let parseTaskResult = (output: JSON.t): parsedTaskResult => {
  let obj = switch JSON.Decode.object(output) {
  | Some(o) => o
  | None => Dict.make()
  }
  let outputStr = switch Dict.get(obj, "output") {
  | Some(v) =>
    switch JSON.Decode.string(v) {
    | Some(s) => s
    | None => ""
    }
  | None => ""
  }
  let finalReturnText = String.trim(extractTaskResultContent(outputStr))
  let metadata = switch Dict.get(obj, "metadata") {
  | Some(v) =>
    switch JSON.Decode.object(v) {
    | Some(o) => o
    | None => Dict.make()
    }
  | None => Dict.make()
  }
  let childSessionID = getMetadataField(metadata, "sessionId", "sessionID")
  let parentSessionID = getMetadataField(metadata, "parentSessionId", "parentSessionID")
  {finalReturnText, childSessionID, parentSessionID}
}

// ---------------------------------------------------------------------------
// buildDelegationDoD
// ---------------------------------------------------------------------------

type delegationArgs = {
  prompt: Nullable.t<string>,
  description: Nullable.t<string>,
  acceptance: Nullable.t<string>,
}

let buildDelegationDoD = (args: delegationArgs, hints: inferHints): dod => {
  let blockSource = switch args.acceptance->Nullable.toOption {
  | Some(v) => v
  | None =>
    switch args.prompt->Nullable.toOption {
    | Some(v) => v
    | None =>
      switch args.description->Nullable.toOption {
      | Some(v) => v
      | None => ""
      }
    }
  }
  let explicit = parseDoDFromDispatch(blockSource)
  switch explicit->Nullable.toOption {
  | Some(d) => d
  | None => {
      let dispatch = switch args.prompt->Nullable.toOption {
      | Some(v) => v
      | None =>
        switch args.description->Nullable.toOption {
        | Some(v) => v
        | None => ""
        }
      }
      inferDoD(dispatch, "", hints)
    }
  }
}

// ---------------------------------------------------------------------------
// tierModel
// ---------------------------------------------------------------------------

type tierDefMinimal = {
  model: string,
}

type protocolTierConfig = {
  activePreset: string,
  activeMode: Nullable.t<string>,
  presets: dict<dict<tierDefMinimal>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Nullable.t<{global: Nullable.t<dict<array<string>>>, fallback_presets: Nullable.t<dict<dict<array<string>>>>}>,
  taskPatterns: Nullable.t<dict<array<string>>>,
  modes: Nullable.t<dict<{modes_defaultTier: string, overrideRules: Nullable.t<array<string>>}>>,
  enforcement: Nullable.t<{verify: Nullable.t<{requireExplicitDoD: Nullable.t<bool>}>}>,
}

type tierModelResult = {
  providerID: string,
  modelID: string,
}

let getActiveTiers = (cfg: protocolTierConfig): dict<tierDefMinimal> => {
  switch Dict.get(cfg.presets, cfg.activePreset) {
  | Some(tiers) => tiers
  | None => Dict.make()
  }
}

let tierModel = (cfg: protocolTierConfig, tierName: string): Nullable.t<tierModelResult> => {
  let tiers = getActiveTiers(cfg)
  switch Dict.get(tiers, tierName) {
  | Some(t) => {
      let model = t.model
      if model === "" {
        Nullable.null
      } else {
        let slashIdx = String.indexOf(model, "/")
        if slashIdx <= 0 || slashIdx >= String.length(model) - 1 {
          Nullable.null
        } else {
          let providerID = String.slice(model, ~start=0, ~end=slashIdx)
          let modelID = String.slice(model, ~start=slashIdx + 1, ~end=String.length(model))
          Nullable.make({providerID, modelID})
        }
      }
    }
  | None => Nullable.null
  }
}

// ---------------------------------------------------------------------------
// shouldVerifyTask
// ---------------------------------------------------------------------------

let shouldVerifyTask = (tool: string, mode: string, require: Nullable.t<string>): bool => {
  if tool !== "task" {
    false
  } else if mode === "off" {
    false
  } else {
    let requireStr = switch require->Nullable.toOption {
    | Some(v) => v
    | None => "whenDoDPresent"
    }
    requireStr !== "never"
  }
}

// ---------------------------------------------------------------------------
// buildForcingNote
// ---------------------------------------------------------------------------

type escalationHint = {
  producerTier: Nullable.t<string>,
  nextTier: Nullable.t<string>,
}

let joinReasons = (reasons: array<string>): string => {
  let rec go = (i: int, acc: string): string => {
    if i >= Array.length(reasons) {
      acc
    } else {
      switch reasons[i] {
      | Some(reason) =>
        let prefix = if acc === "" {
          "- "
        } else {
          "\n- "
        }
        go(i + 1, acc ++ prefix ++ reason)
      | None => go(i + 1, acc)
      }
    }
  }
  go(0, "")
}

let buildForcingNote = (reasons: array<string>, escalation: Nullable.t<escalationHint>): string => {
  let body = if Array.length(reasons) > 0 {
    joinReasons(reasons)
  } else {
    "- (no reasons provided)"
  }

  let next = switch escalation->Nullable.toOption {
  | Some(e) =>
    switch e.nextTier->Nullable.toOption {
    | Some(nextTier) => {
        let producer = switch e.producerTier->Nullable.toOption {
        | Some(pt) => " (escalated from " ++ pt ++ ")"
        | None => ""
        }
        "NEXT: address the above, then re-run via `Task(subagent_type=\"" ++
        nextTier ++
        "\")" ++
        producer ++ "; do not treat the prior result as complete."
      }
    | None => "NEXT: address the above and re-run the delegation; do not treat the prior result as complete."
    }
  | None => "NEXT: address the above and re-run the delegation; do not treat the prior result as complete."
  }

  "[router ⚠ NOT ACCEPTED] The delegated result was not accepted by independent verification:\n" ++
  body ++
  "\n" ++
  next
}

// ---------------------------------------------------------------------------
// buildAcceptedSuffix
// ---------------------------------------------------------------------------

let buildAcceptedSuffix = (method: string): string => {
  "\n\n[router ✓ accepted: " ++ method ++ "]"
}
