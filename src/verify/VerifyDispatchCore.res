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
  childSessionID: Js.Nullable.t<string>,
  parentSessionID: Js.Nullable.t<string>,
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

let getStringField = (obj: Js.Dict.t<Js.Json.t>, key: string): string => {
  switch Js.Dict.get(obj, key) {
  | Some(v) =>
    switch Js.Json.classify(v) {
    | JSONString(s) => s
    | _ => ""
    }
  | None => ""
  }
}

let extractChangedFile = (tool: string, args: Js.Json.t): Js.Nullable.t<changedFile> => {
  if !isWriteTool(tool) {
    Js.Nullable.null
  } else {
    let obj = switch Js.Json.classify(args) {
    | JSONObject(o) => o
    | _ => Js.Dict.empty()
    }
    let path = getStringField(obj, "filePath")
    let pathB = if path === "" { getStringField(obj, "path") } else { path }
    let pathC = if pathB === "" { getStringField(obj, "file") } else { pathB }
    if pathC === "" {
      Js.Nullable.null
    } else {
      let status = if tool === "write" { "written" } else { "modified" }
      Js.Nullable.return({ path: pathC, status })
    }
  }
}

// ---------------------------------------------------------------------------
// createChangedFileStore
// ---------------------------------------------------------------------------

type changedFileStore = {
  record: (string, string, Js.Json.t) => unit,
  get: (string) => array<changedFile>,
  clear: (string) => unit,
}

type fileMap = Js.Dict.t<string>

let recFindPrev = (m: fileMap, path: string): string => {
  switch Js.Dict.get(m, path) {
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
      | Some((path, status)) =>
        go(i + 1, [...acc, { path, status }])
      | None =>
        go(i + 1, acc)
      }
    }
  }
  go(0, [])
}

let createChangedFileStore = (): changedFileStore => {
  let bySession: Js.Dict.t<fileMap> = Js.Dict.empty()

  let record = (sessionID: string, tool: string, args: Js.Json.t): unit => {
    let cf = extractChangedFile(tool, args)
    switch cf->Js.Nullable.toOption {
    | Some(f) => {
        let m = switch Js.Dict.get(bySession, sessionID) {
          | Some(existing) => existing
          | None => {
              let newMap: fileMap = Js.Dict.empty()
              Js.Dict.set(bySession, sessionID, newMap)
              newMap
            }
        }
        let prev = recFindPrev(m, f.path)
        let newStatus = if prev === "written" { "written" } else { f.status }
        Js.Dict.set(m, f.path, newStatus)
      }
    | None => ()
    }
  }

  let get = (sessionID: string): array<changedFile> => {
    switch Js.Dict.get(bySession, sessionID) {
    | Some(m) => {
        let entries = Js.Dict.entries(m)
        buildFileArray(entries)
      }
    | None => []
    }
  }

  let clear = (sessionID: string): unit => {
    %raw(`delete bySession[sessionID]`)
  }

  { record, get, clear }
}

// ---------------------------------------------------------------------------
// parseTaskResult
// ---------------------------------------------------------------------------

let getMetadataField = (metadata: Js.Dict.t<Js.Json.t>, key1: string, key2: string): Js.Nullable.t<string> => {
  let rec tryKeys = (keys: list<string>): Js.Nullable.t<string> => {
    switch keys {
    | list{} => Js.Nullable.null
    | list{key, ...rest} =>
      switch Js.Dict.get(metadata, key) {
      | Some(v) =>
        switch Js.Json.classify(v) {
        | JSONString(s) => Js.Nullable.return(s)
        | _ => tryKeys(rest)
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
  let openIdx = Js.String2.indexOf(openTag, s)
  let closeIdx = switch openIdx {
    | -1 => -1
    | _ => Js.String2.indexOf(closeTag, s)
  }
  switch (openIdx, closeIdx) {
  | (-1, _) => s
  | (_, -1) => s
  | (oi, ci) =>
    let start = oi + Js.String2.length(openTag)
    if start > ci {
      s
    } else {
      Js.String2.trim(Js.String2.substring(s, ~from=start, ~to_=ci))
    }
  }
}

let parseTaskResult = (output: Js.Json.t): parsedTaskResult => {
  let obj = switch Js.Json.classify(output) {
  | JSONObject(o) => o
  | _ => Js.Dict.empty()
  }
  let outputStr = switch Js.Dict.get(obj, "output") {
  | Some(v) =>
    switch Js.Json.classify(v) {
    | JSONString(s) => s
    | _ => ""
    }
  | None => ""
  }
  let finalReturnText = Js.String2.trim(extractTaskResultContent(outputStr))
  let metadata = switch Js.Dict.get(obj, "metadata") {
  | Some(v) =>
    switch Js.Json.classify(v) {
    | JSONObject(o) => o
    | _ => Js.Dict.empty()
    }
  | None => Js.Dict.empty()
  }
  let childSessionID = getMetadataField(metadata, "sessionId", "sessionID")
  let parentSessionID = getMetadataField(metadata, "parentSessionId", "parentSessionID")
  { finalReturnText, childSessionID, parentSessionID }
}

// ---------------------------------------------------------------------------
// buildDelegationDoD
// ---------------------------------------------------------------------------

type delegationArgs = {
  prompt: Js.Nullable.t<string>,
  description: Js.Nullable.t<string>,
  acceptance: Js.Nullable.t<string>,
}

let buildDelegationDoD = (
  args: delegationArgs,
  hints: inferHints,
): dod => {
  let blockSource = switch args.acceptance->Js.Nullable.toOption {
    | Some(v) => v
    | None =>
      switch args.prompt->Js.Nullable.toOption {
      | Some(v) => v
      | None =>
        switch args.description->Js.Nullable.toOption {
        | Some(v) => v
        | None => ""
        }
      }
    }
  let explicit = parseDoDFromDispatch(blockSource)
  switch explicit->Js.Nullable.toOption {
  | Some(d) => d
  | None => {
      let dispatch = switch args.prompt->Js.Nullable.toOption {
        | Some(v) => v
        | None =>
          switch args.description->Js.Nullable.toOption {
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
  activeMode: Js.Nullable.t<string>,
  presets: Js.Dict.t<Js.Dict.t<tierDefMinimal>>,
  rules: array<string>,
  defaultTier: string,
  fallback: Js.Nullable.t<{ global: Js.Nullable.t<Js.Dict.t<array<string>>>, presets: Js.Nullable.t<Js.Dict.t<Js.Dict.t<array<string>>>> }>,
  taskPatterns: Js.Nullable.t<Js.Dict.t<array<string>>>,
  modes: Js.Nullable.t<Js.Dict.t<{ defaultTier: string, overrideRules: Js.Nullable.t<array<string>> }>>,
  enforcement: Js.Nullable.t<{ verify: Js.Nullable.t<{ requireExplicitDoD: Js.Nullable.t<bool> }> }>,
}

type tierModelResult = {
  providerID: string,
  modelID: string,
}

let getActiveTiers = (cfg: protocolTierConfig): Js.Dict.t<tierDefMinimal> => {
  switch Js.Dict.get(cfg.presets, cfg.activePreset) {
  | Some(tiers) => tiers
  | None => Js.Dict.empty()
  }
}

let tierModel = (
  cfg: protocolTierConfig,
  tierName: string,
): Js.Nullable.t<tierModelResult> => {
  let tiers = getActiveTiers(cfg)
  switch Js.Dict.get(tiers, tierName) {
  | Some(t) => {
      let model = t.model
      if model === "" {
        Js.Nullable.null
      } else {
        let slashIdx = Js.String2.indexOf(model, "/")
        if slashIdx <= 0 || slashIdx >= String.length(model) - 1 {
          Js.Nullable.null
        } else {
          let providerID = String.slice(model, ~start=0, ~end=slashIdx)
          let modelID = String.slice(model, ~start=slashIdx + 1, ~end=String.length(model))
          Js.Nullable.return({ providerID, modelID })
        }
      }
    }
  | None => Js.Nullable.null
  }
}

// ---------------------------------------------------------------------------
// shouldVerifyTask
// ---------------------------------------------------------------------------

let shouldVerifyTask = (
  tool: string,
  mode: string,
  require: Js.Nullable.t<string>,
): bool => {
  if tool !== "task" {
    false
  } else if mode === "off" {
    false
  } else {
    let requireStr = switch require->Js.Nullable.toOption {
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
  producerTier: Js.Nullable.t<string>,
  nextTier: Js.Nullable.t<string>,
}

let joinReasons = (reasons: array<string>): string => {
  let rec go = (i: int, acc: string): string => {
    if i >= Array.length(reasons) {
      acc
    } else {
      switch reasons[i] {
      | Some(reason) =>
        let prefix = if acc === "" { "- " } else { "\n- " }
        go(i + 1, acc ++ prefix ++ reason)
      | None => go(i + 1, acc)
      }
    }
  }
  go(0, "")
}

let buildForcingNote = (
  reasons: array<string>,
  escalation: Js.Nullable.t<escalationHint>,
): string => {
  let body = if Array.length(reasons) > 0 {
    joinReasons(reasons)
  } else {
    "- (no reasons provided)"
  }

  let next = switch escalation->Js.Nullable.toOption {
    | Some(e) =>
      switch e.nextTier->Js.Nullable.toOption {
      | Some(nextTier) => {
          let producer = switch e.producerTier->Js.Nullable.toOption {
            | Some(pt) => " (escalated from " ++ pt ++ ")"
            | None => ""
          }
          "NEXT: address the above, then re-run via `Task(subagent_type=\"" ++
          nextTier ++ "\")" ++ producer ++ "; do not treat the prior result as complete."
        }
      | None => "NEXT: address the above and re-run the delegation; do not treat the prior result as complete."
      }
    | None => "NEXT: address the above and re-run the delegation; do not treat the prior result as complete."
  }

  "[router ⚠ NOT ACCEPTED] The delegated result was not accepted by independent verification:\n" ++
  body ++ "\n" ++ next
}

// ---------------------------------------------------------------------------
// buildAcceptedSuffix
// ---------------------------------------------------------------------------

let buildAcceptedSuffix = (method: string): string => {
  "\n\n[router ✓ accepted: " ++ method ++ "]"
}
