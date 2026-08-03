// ---------------------------------------------------------------------------
// Guard_test.res — RED-first threat matrix + state/termination tests.
//
// Tests are written FIRST (RED) to define expected behavior, then the
// implementation is written to make them pass (GREEN).
//
// Port of guards.test.ts fixtures — threat matrix, state transitions,
// termination cases, and property-based invariants.
// ---------------------------------------------------------------------------

open Test

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let assertionEqual = (~operator: string, expected: 'a, actual: 'a): unit =>
  assertion(~operator, (a, b) => a === b, actual, expected)

let assertionTrue = (~operator: string, actual: Guard.guardKind): unit =>
  assertion(~operator, (_a, b) => b === #mutation, actual, #mutation)

let assertionFalse = (~operator: string, actual: Guard.guardKind): unit =>
  assertion(~operator, (_a, b) => b === #finish, actual, #finish)

// For bool-returning functions like isSelfScript
let assertionIsTrue = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === true, actual, true)

let assertionIsFalse = (~operator: string, actual: bool): unit =>
  assertion(~operator, (_a, b) => b === false, actual, false)

// For Js.Nullable.t<int> field comparisons (e.g., guardState.ttfa)
let assertionNullableEqual = (~operator: string, ~actual: Nullable.t<int>, ~expected: int): unit =>
  switch Nullable.toOption(actual) {
  | Some(v) => assertionEqual(~operator, expected, v)
  | None => assertion(~operator, (_a, _b) => false, 0, expected)
  }

// Helper record type for filePath args
type filePathArgs = {filePath: string}

// Helper record type for command args
type commandArgs = {command: string}

// Helper: construct a Js.Dict.t<Js.Json.t> from a filePathArgs record
let argsDict = (d: filePathArgs): dict<JSON.t> =>
  Dict.fromArray([("filePath", JSON.Encode.string(d.filePath))])

// Helper: construct a Js.Dict.t<Js.Json.t> from a commandArgs record
let commandDict = (d: commandArgs): dict<JSON.t> =>
  Dict.fromArray([("command", JSON.Encode.string(d.command))])

// Helper: construct a Js.Dict.t<Js.Json.t> for grep args
let grepArgsDict = (pattern: string, path: string): dict<JSON.t> =>
  Dict.fromArray([("pattern", JSON.Encode.string(pattern)), ("path", JSON.Encode.string(path))])

// ---------------------------------------------------------------------------
// Threat matrix: THREAT MATRIX — normal allowed files
// ---------------------------------------------------------------------------

test("THREAT MATRIX: requirements.txt => allowed (mutation)", () => {
  // requirements.txt is NOT a script extension → classify as mutation → allowed
  assertionTrue(
    ~operator="requirements.txt",
    Guard.classify(
      {tool: "write", args: Nullable.make(argsDict({filePath: "requirements.txt"}))},
      Guard.makePolicyDefault(),
    ),
  )
})

test("THREAT MATRIX: CMakeLists.txt => allowed (mutation)", () => {
  // CMakeLists.txt is NOT a script extension → classify as mutation → allowed
  assertionTrue(
    ~operator="CMakeLists.txt",
    Guard.classify(
      {tool: "write", args: Nullable.make(argsDict({filePath: "CMakeLists.txt"}))},
      Guard.makePolicyDefault(),
    ),
  )
})

test("THREAT MATRIX: README.md => allowed (mutation)", () => {
  // README.md is NOT a script extension → classify as mutation → allowed
  assertionTrue(
    ~operator="README.md",
    Guard.classify(
      {tool: "write", args: Nullable.make(argsDict({filePath: "README.md"}))},
      Guard.makePolicyDefault(),
    ),
  )
})

// ---------------------------------------------------------------------------
// Threat matrix: .ts source files allowed
// ---------------------------------------------------------------------------

test("THREAT MATRIX: .ts source files => allowed (mutation, not self_script)", () => {
  // .ts is NOT in SCRIPT_EXT_RE → classify as mutation → allowed
  assertionTrue(
    ~operator="app.ts",
    Guard.classify(
      {tool: "write", args: Nullable.make(argsDict({filePath: "src/app.ts"}))},
      Guard.makePolicyDefault(),
    ),
  )
  assertionTrue(
    ~operator="index.ts",
    Guard.classify(
      {tool: "edit", args: Nullable.make(argsDict({filePath: "src/index.ts"}))},
      Guard.makePolicyDefault(),
    ),
  )
})

// ---------------------------------------------------------------------------
// Threat matrix: README.sh requires opt-in
// ---------------------------------------------------------------------------

test(
  "THREAT MATRIX: README.sh DEFAULT (no blockScriptWrites) => NOT self_script (mutation allowed)",
  () => {
    // blockScriptWrites defaults to false → writing .sh is mutation, not self_script
    let p = Guard.makePolicyDefault()
    let kind = Guard.classify(
      {tool: "write", args: Nullable.make(argsDict({filePath: "README.sh"}))},
      p,
    )
    assertionEqual(~operator="README.sh default", kind, #mutation)
  },
)

test("THREAT MATRIX: README.sh with blockScriptWrites:true => self_script (blocked)", () => {
  // blockScriptWrites=true → writing .sh is self_script → blocked
  let p = Guard.makePolicyWithBlockScriptWrites(true)
  let kind = Guard.classify(
    {tool: "write", args: Nullable.make(argsDict({filePath: "README.sh"}))},
    p,
  )
  assertionEqual(~operator="README.sh opt-in", kind, #self_script)
})

// ---------------------------------------------------------------------------
// Threat matrix: heredoc blocked
// ---------------------------------------------------------------------------

test("THREAT MATRIX: bash heredoc (cat <<EOF) => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="heredoc",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "cat <<EOF\nhello\nEOF"}))},
      p,
    ),
  )
})

// ---------------------------------------------------------------------------
// Threat matrix: redirects blocked
// ---------------------------------------------------------------------------

test("THREAT MATRIX: bash redirect to script (> foo.sh) => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="redirect-sh",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "echo hello > foo.sh"}))},
      p,
    ),
  )
})

test("THREAT MATRIX: bash redirect to script (>> foo.mjs) => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="redirect-mjs",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "echo hello >> foo.mjs"}))},
      p,
    ),
  )
})

// ---------------------------------------------------------------------------
// Threat matrix: node -e blocked
// ---------------------------------------------------------------------------

test("THREAT MATRIX: bash 'node -e' => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="node -e",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "node -e 'console.log(1)'"}))},
      p,
    ),
  )
})

test("THREAT MATRIX: bash 'python3 -c' => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="python3 -c",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "python3 -c 'print(1)'"}))},
      p,
    ),
  )
})

test("THREAT MATRIX: bash 'deno eval' => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="deno eval",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "deno eval 'console.log(1)'"}))},
      p,
    ),
  )
})

test("THREAT MATRIX: bash 'bun -e' => self_script (blocked)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsTrue(
    ~operator="bun -e",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "bun -e \"console.log('hi')\""}))},
      p,
    ),
  )
})

// ---------------------------------------------------------------------------
// Threat matrix: safe bash commands NOT blocked
// ---------------------------------------------------------------------------

test("THREAT MATRIX: bash 'npm test' => NOT self_script (allowed)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsFalse(
    ~operator="npm test",
    Guard.isSelfScript({tool: "bash", args: Nullable.make(commandDict({command: "npm test"}))}, p),
  )
})

test("THREAT MATRIX: bash 'tsc --noEmit' => NOT self_script (allowed)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsFalse(
    ~operator="tsc --noEmit",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "tsc --noEmit"}))},
      p,
    ),
  )
})

test("THREAT MATRIX: bash 'cat > foo.txt' (non-script) => NOT self_script (allowed)", () => {
  let p = Guard.makePolicyDefault()
  assertionIsFalse(
    ~operator="cat-txt",
    Guard.isSelfScript(
      {tool: "bash", args: Nullable.make(commandDict({command: "cat > foo.txt"}))},
      p,
    ),
  )
})

// ---------------------------------------------------------------------------
// isSelfScript: deliverablePath exemption
// ---------------------------------------------------------------------------

test("isSelfScript: deliverablePath=build.sh + write build.sh => false (exempt)", () => {
  let p = Guard.makePolicyWithDeliverablePath("build.sh")
  assertionIsFalse(
    ~operator="deliverablePath exempt",
    Guard.isSelfScript({tool: "write", args: Nullable.make(argsDict({filePath: "build.sh"}))}, p),
  )
})

test(
  "isSelfScript: deliverablePath=build.sh + write other.sh (blockScriptWrites:true) => true",
  () => {
    let p = Guard.makePolicyWithDeliverablePathAndBlockScript("build.sh", true)
    assertionIsTrue(
      ~operator="other.sh blocked",
      Guard.isSelfScript({tool: "write", args: Nullable.make(argsDict({filePath: "other.sh"}))}, p),
    )
  },
)

// ---------------------------------------------------------------------------
// isSelfScript: deliverableIsScript exemption
// ---------------------------------------------------------------------------

test("isSelfScript: deliverableIsScript:true + write build.sh => false (intent wins)", () => {
  let p = Guard.makePolicyWithDeliverableIsScript(true)
  assertionIsFalse(
    ~operator="deliverableIsScript",
    Guard.isSelfScript({tool: "write", args: Nullable.make(argsDict({filePath: "build.sh"}))}, p),
  )
})

// ---------------------------------------------------------------------------
// classify: tool kind mapping
// ---------------------------------------------------------------------------

test("classify: finish tools => finish", () => {
  let p = Guard.makePolicyDefault()
  assertionEqual(~operator="finish", Guard.classify({tool: "finish"}, p), #finish)
  assertionEqual(~operator="return", Guard.classify({tool: "return"}, p), #finish)
  assertionEqual(~operator="task_complete", Guard.classify({tool: "task_complete"}, p), #finish)
})

test("classify: read tools => read", () => {
  let p = Guard.makePolicyDefault()
  assertionEqual(~operator="grep", Guard.classify({tool: "grep"}, p), #read)
  assertionEqual(~operator="read", Guard.classify({tool: "read"}, p), #read)
  assertionEqual(~operator="glob", Guard.classify({tool: "glob"}, p), #read)
  assertionEqual(~operator="ls", Guard.classify({tool: "ls"}, p), #read)
})

test("classify: mutation tools => mutation", () => {
  let p = Guard.makePolicyDefault()
  assertionEqual(
    ~operator="write",
    Guard.classify({tool: "write", args: Nullable.make(argsDict({filePath: "x.txt"}))}, p),
    #mutation,
  )
  assertionEqual(
    ~operator="edit",
    Guard.classify({tool: "edit", args: Nullable.make(argsDict({filePath: "x.txt"}))}, p),
    #mutation,
  )
  assertionEqual(
    ~operator="patch",
    Guard.classify({tool: "patch", args: Nullable.make(argsDict({filePath: "x.txt"}))}, p),
    #mutation,
  )
  assertionEqual(
    ~operator="bash",
    Guard.classify({tool: "bash", args: Nullable.make(commandDict({command: "npm test"}))}, p),
    #mutation,
  )
  assertionEqual(
    ~operator="multiedit",
    Guard.classify({tool: "multiedit", args: Nullable.make(argsDict({filePath: "x.txt"}))}, p),
    #mutation,
  )
})

test("classify: unknown tool => other", () => {
  let p = Guard.makePolicyDefault()
  assertionEqual(~operator="foo", Guard.classify({tool: "foo"}, p), #other)
})

// ---------------------------------------------------------------------------
// evaluateGuards: clause 1 — finish always allowed
// ---------------------------------------------------------------------------

test("evaluateGuards: finish always allowed even when budget exhausted", () => {
  let p = Guard.makePolicyWithDefaults({budget: 8, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  s.toolCallCount = 8
  s.budget = 8
  let d = Guard.evaluateGuards(s, {tool: "finish"}, p)
  assertionIsTrue(~operator="finish allowed", d.allow)
})

test("evaluateGuards: finish allowed even when deliverableSignal set + not executed", () => {
  let p = Guard.makePolicyWithDefaults({
    budget: 8,
    deliverableSignal: Nullable.make("write:output.txt"),
  })
  let s = Guard.newGuardState(p)
  s.deliverableExecuted = false
  let d = Guard.evaluateGuards(s, {tool: "return"}, p)
  assertionIsTrue(~operator="finish allowed with signal", d.allow)
})

// ---------------------------------------------------------------------------
// evaluateGuards: clause 2 — self_script denied
// ---------------------------------------------------------------------------

test("evaluateGuards: self_script => deny with anti_self_script guard", () => {
  let p = Guard.makePolicyWithDefaults({
    deliverableSignal: Nullable.make("write:output.txt"),
    blockScriptWrites: Nullable.make(true),
  })
  let s = Guard.newGuardState(p)
  let d = Guard.evaluateGuards(
    s,
    {tool: "write", args: Nullable.make(argsDict({filePath: "run.sh"}))},
    p,
  )
  assertionIsFalse(~operator="self_script denied", d.allow)
  assertionEqual(~operator="anti_self_script", d.guard, Nullable.make("anti_self_script"))
})

test(
  "evaluateGuards: self_script with blockSelfScript:false => treated as mutation (allowed)",
  () => {
    let p = Guard.makePolicyWithDefaults({
      blockSelfScript: false,
      blockScriptWrites: Nullable.make(true),
      deliverableSignal: Nullable.null,
    })
    let s = Guard.newGuardState(p)
    let d = Guard.evaluateGuards(
      s,
      {tool: "write", args: Nullable.make(argsDict({filePath: "run.sh"}))},
      p,
    )
    assertionIsTrue(~operator="blockSelfScript=false", d.allow)
  },
)

// ---------------------------------------------------------------------------
// evaluateGuards: clause 3 — budget exhausted
// ---------------------------------------------------------------------------

test("evaluateGuards: toolCallCount=budget => iteration_cap denied", () => {
  let p = Guard.makePolicyWithDefaults({budget: 8, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  s.toolCallCount = 8
  s.budget = 8
  let d = Guard.evaluateGuards(s, {tool: "grep", args: Nullable.make(grepArgsDict("x", ""))}, p)
  assertionIsFalse(~operator="budget exhausted", d.allow)
  assertionEqual(~operator="iteration_cap", d.guard, Nullable.make("iteration_cap"))
})

test("evaluateGuards: toolCallCount < budget => not budget-denied", () => {
  let p = Guard.makePolicyWithDefaults({budget: 8, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  s.toolCallCount = 7
  s.budget = 8
  let d = Guard.evaluateGuards(s, {tool: "grep", args: Nullable.make(grepArgsDict("x", ""))}, p)
  assertionIsTrue(~operator="under budget", !Nullable.isNullable(d.guard))
})

// ---------------------------------------------------------------------------
// evaluateGuards: clause 4 — redundant read
// ---------------------------------------------------------------------------

test("evaluateGuards: same read twice (sameOpRetryCap=1) => redundant_read denied", () => {
  let p = Guard.makePolicyWithDefaults({sameOpRetryCap: 1, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  let call: Guard.guardCall = {tool: "grep", args: Nullable.make(grepArgsDict("foo", "src"))}
  // Prime the seen map via updateState
  let _ = Guard.updateState(s, call, {ok: false}, p)
  // Second identical call
  let d = Guard.evaluateGuards(s, call, p)
  assertionIsFalse(~operator="redundant read", d.allow)
  assertionEqual(~operator="redundant_read", d.guard, Nullable.make("redundant_read"))
})

test("evaluateGuards: different read => allow", () => {
  let p = Guard.makePolicyWithDefaults({sameOpRetryCap: 1, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  let call1: Guard.guardCall = {tool: "grep", args: Nullable.make(grepArgsDict("foo", "src"))}
  let _ = Guard.updateState(s, call1, {ok: false}, p)
  let call2: Guard.guardCall = {tool: "grep", args: Nullable.make(grepArgsDict("foo", "lib"))}
  let d = Guard.evaluateGuards(s, call2, p)
  assertionIsTrue(~operator="different read", d.allow)
})

// ---------------------------------------------------------------------------
// evaluateGuards: clause 5 — read draft budget
// ---------------------------------------------------------------------------

test("evaluateGuards: consecutiveNonProducing=readDraftCap => read_budget denied", () => {
  let p = Guard.makePolicyWithDefaults({readDraftCap: 3, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  s.consecutiveNonProducing = 3
  let d = Guard.evaluateGuards(
    s,
    {tool: "read", args: Nullable.make(argsDict({filePath: "x.ts"}))},
    p,
  )
  assertionIsFalse(~operator="read budget", d.allow)
  assertionEqual(~operator="read_budget", d.guard, Nullable.make("read_budget"))
})

test("evaluateGuards: consecutiveNonProducing < readDraftCap => allow", () => {
  let p = Guard.makePolicyWithDefaults({readDraftCap: 3, deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  s.consecutiveNonProducing = 2
  let d = Guard.evaluateGuards(
    s,
    {tool: "read", args: Nullable.make(argsDict({filePath: "x.ts"}))},
    p,
  )
  assertionIsTrue(~operator="under read budget", d.allow)
})

// ---------------------------------------------------------------------------
// evaluateGuards: clause 6 — deliverable_first
// ---------------------------------------------------------------------------

test("evaluateGuards: deliverable_first: signal set, not executed, read => deny", () => {
  let p = Guard.makePolicyWithDefaults({
    deliverableSignal: Nullable.make("write:out.ts"),
    deliverableFirst: true,
  })
  let s = Guard.newGuardState(p)
  s.deliverableExecuted = false
  let d = Guard.evaluateGuards(
    s,
    {tool: "read", args: Nullable.make(argsDict({filePath: "x.ts"}))},
    p,
  )
  assertionIsFalse(~operator="deliverable_first", d.allow)
  assertionEqual(~operator="deliverable_first", d.guard, Nullable.make("deliverable_first"))
})

test("evaluateGuards: deliverable_first: deliverableSignal=null => allow", () => {
  let p = Guard.makePolicyWithDefaults({deliverableSignal: Nullable.null, deliverableFirst: true})
  let s = Guard.newGuardState(p)
  s.deliverableExecuted = false
  let d = Guard.evaluateGuards(
    s,
    {tool: "read", args: Nullable.make(argsDict({filePath: "x.ts"}))},
    p,
  )
  assertionIsTrue(~operator="no signal", d.allow)
})

test("evaluateGuards: deliverable_first: deliverableExecuted=true => allow", () => {
  let p = Guard.makePolicyWithDefaults({
    deliverableSignal: Nullable.make("write:out.ts"),
    deliverableFirst: true,
  })
  let s = Guard.newGuardState(p)
  s.deliverableExecuted = true
  let d = Guard.evaluateGuards(
    s,
    {tool: "read", args: Nullable.make(argsDict({filePath: "x.ts"}))},
    p,
  )
  assertionIsTrue(~operator="already executed", d.allow)
})

test("evaluateGuards: deliverable_first: mutation call is allowed", () => {
  let p = Guard.makePolicyWithDefaults({
    deliverableSignal: Nullable.make("write:output.json"),
    deliverableFirst: true,
  })
  let s = Guard.newGuardState(p)
  s.deliverableExecuted = false
  // .json is not a script extension → classify=mutation → allowed
  let d = Guard.evaluateGuards(
    s,
    {tool: "write", args: Nullable.make(argsDict({filePath: "output.json"}))},
    p,
  )
  assertionIsTrue(~operator="mutation allowed", d.allow)
})

// ---------------------------------------------------------------------------
// evaluateGuards: clause precedence
// ---------------------------------------------------------------------------

test(
  "evaluateGuards: self_script + budget exhausted => anti_self_script (clause 2 before 3)",
  () => {
    let p = Guard.makePolicyWithDefaults({
      budget: 5,
      blockSelfScript: true,
      blockScriptWrites: Nullable.make(true),
      deliverableSignal: Nullable.null,
    })
    let s = Guard.newGuardState(p)
    s.toolCallCount = 5
    s.budget = 5
    let d = Guard.evaluateGuards(
      s,
      {tool: "write", args: Nullable.make(argsDict({filePath: "run.sh"}))},
      p,
    )
    assertionIsFalse(~operator="self_script first", d.allow)
    assertionEqual(
      ~operator="anti_self_script precedence",
      d.guard,
      Nullable.make("anti_self_script"),
    )
  },
)

// ---------------------------------------------------------------------------
// updateState transitions
// ---------------------------------------------------------------------------

test("updateState: read increments readCount, consecutiveNonProducing, seen", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let call: Guard.guardCall = {tool: "grep", args: Nullable.make(grepArgsDict("x", "src"))}
  let _ = Guard.updateState(s, call, {ok: false}, p)
  assertionEqual(~operator="readCount", s.readCount, 1)
  assertionEqual(~operator="consecutiveNonProducing", s.consecutiveNonProducing, 1)
  assertionEqual(~operator="toolCallCount", s.toolCallCount, 1)
  assertionIsTrue(~operator="seen has entries", Dict.keysToArray(s.seen)->Array.length > 0)
})

test(
  "updateState: mutation resets consecutiveNonProducing, sets deliverableExecuted+ttfa on first ok",
  () => {
    let p = Guard.makePolicyDefault()
    let s = Guard.newGuardState(p)
    s.consecutiveNonProducing = 2
    let call: Guard.guardCall = {
      tool: "write",
      args: Nullable.make(argsDict({filePath: "src/foo.txt"})),
    }
    let _ = Guard.updateState(s, call, {ok: true}, p)
    assertionEqual(~operator="consecutiveNonProducing reset", s.consecutiveNonProducing, 0)
    assertionIsTrue(~operator="deliverableExecuted", s.deliverableExecuted)
    assertionNullableEqual(~operator="ttfa", ~actual=s.ttfa, ~expected=1)
    assertionEqual(~operator="execCount", s.execCount, 1)
  },
)

test("updateState: mutation with ok:false does NOT set deliverableExecuted", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let call: Guard.guardCall = {
    tool: "write",
    args: Nullable.make(argsDict({filePath: "src/foo.txt"})),
  }
  let _ = Guard.updateState(s, call, {ok: false}, p)
  assertionIsFalse(~operator="not executed", s.deliverableExecuted)
  assertionIsTrue(~operator="ttfa still null", Nullable.isNullable(s.ttfa))
})

test("updateState: self_script increments selfScriptCount and consecutiveNonProducing", () => {
  let p = Guard.makePolicyWithDefaults({blockScriptWrites: Nullable.make(true)})
  let s = Guard.newGuardState(p)
  let _ = Guard.updateState(
    s,
    {tool: "write", args: Nullable.make(argsDict({filePath: "run.sh"}))},
    {ok: false},
    p,
  )
  assertionEqual(~operator="selfScriptCount", s.selfScriptCount, 1)
  assertionEqual(~operator="consecutiveNonProducing", s.consecutiveNonProducing, 1)
  assertionEqual(~operator="toolCallCount", s.toolCallCount, 1)
})

test("updateState: finish no-ops (toolCallCount unchanged)", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  s.toolCallCount = 3
  let _ = Guard.updateState(s, {tool: "finish"}, {ok: true}, p)
  assertionEqual(~operator="toolCallCount unchanged", s.toolCallCount, 3)
  assertionEqual(~operator="readCount", s.readCount, 0)
  assertionEqual(~operator="execCount", s.execCount, 0)
})

test("updateState: read->read->mutation resets consecutiveNonProducing to 0", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let _ = Guard.updateState(
    s,
    {tool: "grep", args: Nullable.make(grepArgsDict("a", "."))},
    {ok: false},
    p,
  )
  let _ = Guard.updateState(
    s,
    {tool: "grep", args: Nullable.make(grepArgsDict("b", "."))},
    {ok: false},
    p,
  )
  assertionEqual(~operator="after 2 reads", s.consecutiveNonProducing, 2)
  let _ = Guard.updateState(
    s,
    {tool: "write", args: Nullable.make(argsDict({filePath: "out.txt"}))},
    {ok: true},
    p,
  )
  assertionEqual(~operator="after mutation", s.consecutiveNonProducing, 0)
})

test("updateState: ttfa set once (second ok mutation doesn't change it)", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let _ = Guard.updateState(
    s,
    {tool: "write", args: Nullable.make(argsDict({filePath: "a.txt"}))},
    {ok: true},
    p,
  )
  let firstTtfa = s.ttfa
  let _ = Guard.updateState(
    s,
    {tool: "write", args: Nullable.make(argsDict({filePath: "b.txt"}))},
    {ok: true},
    p,
  )
  assertionEqual(~operator="ttfa stable", s.ttfa, firstTtfa)
})

test("updateState: 'other' tool increments consecutiveNonProducing", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let _ = Guard.updateState(s, {tool: "foo"}, {ok: false}, p)
  assertionEqual(~operator="consecutiveNonProducing", s.consecutiveNonProducing, 1)
  assertionEqual(~operator="toolCallCount", s.toolCallCount, 1)
})

// ---------------------------------------------------------------------------
// recordBlock
// ---------------------------------------------------------------------------

test("recordBlock: increments blockedCount and sets lastBlock", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let _ = Guard.recordBlock(
    s,
    {allow: false, guard: Nullable.make("iteration_cap"), observation: Nullable.null},
  )
  assertionEqual(~operator="blockedCount", s.blockedCount, 1)
  assertionEqual(~operator="lastBlock", s.lastBlock, Nullable.make("iteration_cap"))
  assertionEqual(~operator="redundantCount", s.redundantCount, 0)
})

test("recordBlock: redundant_read increments redundantCount", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  let _ = Guard.recordBlock(
    s,
    {allow: false, guard: Nullable.make("redundant_read"), observation: Nullable.null},
  )
  assertionEqual(~operator="redundantCount", s.redundantCount, 1)
  assertionEqual(~operator="blockedCount", s.blockedCount, 1)
})

// ---------------------------------------------------------------------------
// forcingMessage formatting
// ---------------------------------------------------------------------------

test(
  "forcingMessage: signal not executed => contains 'deliverable=NOT RUN' and 'run the deliverable'",
  () => {
    let p = Guard.makePolicyWithDefaults({deliverableSignal: Nullable.make("write:output.ts")})
    let s = Guard.newGuardState(p)
    s.deliverableExecuted = false
    s.toolCallCount = 3
    s.consecutiveNonProducing = 2
    let msg = Guard.forcingMessage(s, p)
    assertionIsTrue(~operator="NOT RUN", Js.String.includes("NOT RUN", msg))
    assertionIsTrue(~operator="run the deliverable", Js.String.includes("run the deliverable", msg))
    assertionIsTrue(~operator="write:output.ts", Js.String.includes("write:output.ts", msg))
    assertionIsTrue(~operator="budget 3/8", Js.String.includes("budget 3/8", msg))
    assertionIsTrue(
      ~operator="reads_since_produce=2",
      Js.String.includes("reads_since_produce=2", msg),
    )
  },
)

test("forcingMessage: signal null => 'deliverable=n/a' and 'take a producing action'", () => {
  let p = Guard.makePolicyWithDefaults({deliverableSignal: Nullable.null})
  let s = Guard.newGuardState(p)
  let msg = Guard.forcingMessage(s, p)
  assertionIsTrue(~operator="n/a", Js.String.includes("deliverable=n/a", msg))
  assertionIsTrue(
    ~operator="take a producing action",
    Js.String.includes("take a producing action", msg),
  )
})

test("forcingMessage: executed => 'deliverable=ran'", () => {
  let p = Guard.makePolicyWithDefaults({deliverableSignal: Nullable.make("write:output.ts")})
  let s = Guard.newGuardState(p)
  s.deliverableExecuted = true
  let msg = Guard.forcingMessage(s, p)
  assertionIsTrue(~operator="ran", Js.String.includes("deliverable=ran", msg))
  assertionIsTrue(
    ~operator="take a producing action",
    Js.String.includes("take a producing action", msg),
  )
})

// ---------------------------------------------------------------------------
// trajectoryMetrics
// ---------------------------------------------------------------------------

test("trajectoryMetrics: returns correct snake_case keys", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  s.readCount = 4
  s.execCount = 2
  s.ttfa = Nullable.make(3)
  s.toolCallCount = 6
  let m = Guard.trajectoryMetrics(s)
  // Access fields from dict<JSON.t> using safe JSON decoders
  let ttfaVal = Dict.getUnsafe(m, "ttfa")->JSON.Decode.float->Option.mapOr(0, Float.toInt)
  let readExecRatioVal = Dict.getUnsafe(m, "read_exec_ratio")->JSON.Decode.float->Option.getOr(0.0)
  let toolCallCountVal = Dict.getUnsafe(m, "tool_call_count")->JSON.Decode.float->Option.mapOr(0, Float.toInt)
  let deliverableExecutedVal = Dict.getUnsafe(m, "deliverable_executed")->JSON.Decode.bool->Option.getOr(false)
  let blockedCountVal = Dict.getUnsafe(m, "blocked_count")->JSON.Decode.float->Option.mapOr(0, Float.toInt)
  let redundantCountVal = Dict.getUnsafe(m, "redundant_count")->JSON.Decode.float->Option.mapOr(0, Float.toInt)
  let consecutiveNonProducingVal = Dict.getUnsafe(m, "consecutive_non_producing")->JSON.Decode.float->Option.mapOr(0, Float.toInt)
  let selfScriptCountVal = Dict.getUnsafe(m, "self_script_count")->JSON.Decode.float->Option.mapOr(0, Float.toInt)
  assertionEqual(~operator="ttfa", 3, ttfaVal)
  assertionEqual(~operator="read_exec_ratio", 2.0, readExecRatioVal)
  assertionEqual(~operator="tool_call_count", 6, toolCallCountVal)
  assertionEqual(~operator="deliverable_executed", false, deliverableExecutedVal)
  assertionEqual(~operator="blocked_count", 0, blockedCountVal)
  assertionEqual(~operator="redundant_count", 0, redundantCountVal)
  assertionEqual(~operator="consecutive_non_producing", 0, consecutiveNonProducingVal)
  assertionEqual(~operator="self_script_count", 0, selfScriptCountVal)
})

test("trajectoryMetrics: read_exec_ratio when execCount=0 => readCount", () => {
  let p = Guard.makePolicyDefault()
  let s = Guard.newGuardState(p)
  s.readCount = 5
  s.execCount = 0
  let m = Guard.trajectoryMetrics(s)
  let ratioVal = Dict.getUnsafe(m, "read_exec_ratio")->JSON.Decode.float->Option.getOr(0.0)
  assertionEqual(~operator="ratio with 0 exec", 5.0, ratioVal)
})

// ---------------------------------------------------------------------------
// observationOk
// ---------------------------------------------------------------------------

test("observationOk: empty string => true", () => {
  assertionIsTrue(~operator="empty", Guard.observationOk(JSON.Encode.string("")))
})

test("observationOk: 'OK done' => true", () => {
  assertionIsTrue(~operator="OK", Guard.observationOk(JSON.Encode.string("OK done")))
})

test("observationOk: 'DENIED: ...' => false", () => {
  assertionIsFalse(
    ~operator="DENIED",
    Guard.observationOk(JSON.Encode.string("DENIED: not allowed")),
  )
})

test("observationOk: '  Error: x' with leading whitespace => false", () => {
  assertionIsFalse(
    ~operator="Error prefix",
    Guard.observationOk(JSON.Encode.string("  Error: something went wrong")),
  )
})

test("observationOk: 'Traceback ...' => false", () => {
  assertionIsFalse(
    ~operator="Traceback",
    Guard.observationOk(JSON.Encode.string("Traceback (most recent call last)")),
  )
})

test("observationOk: non-string (number) => true", () => {
  assertionIsTrue(~operator="number", Guard.observationOk(JSON.Encode.float(123.0)))
})

test("observationOk: undefined => true", () => {
  assertionIsTrue(~operator="undefined", Guard.observationOk(JSON.Encode.null))
})

// ---------------------------------------------------------------------------
// Termination tests
// ---------------------------------------------------------------------------

test("TERMINATION: model that only tries SAME read is blocked by clause 4 on 2nd call", () => {
  let p = Guard.makePolicyWithDefaults({
    budget: 20,
    readDraftCap: 10,
    sameOpRetryCap: 1,
    deliverableSignal: Nullable.null,
  })
  let s = Guard.newGuardState(p)
  let call: Guard.guardCall = {tool: "grep", args: Nullable.make(grepArgsDict("x", "src"))}

  // First call should be allowed
  let d1 = Guard.evaluateGuards(s, call, p)
  assertionIsTrue(~operator="first allowed", d1.allow)
  let _ = Guard.updateState(s, call, {ok: false}, p)

  // Second identical call => redundant_read
  let d2 = Guard.evaluateGuards(s, call, p)
  assertionIsFalse(~operator="second denied", d2.allow)
  assertionEqual(~operator="redundant_read", d2.guard, Nullable.make("redundant_read"))

  // All subsequent calls also denied — use recursive helper
  let rec checkAllDenied = (remaining: int, soFar: bool): bool => {
    if remaining <= 0 || !soFar {
      soFar
    } else {
      let d = Guard.evaluateGuards(s, call, p)
      checkAllDenied(remaining - 1, soFar && !d.allow)
    }
  }
  assertionIsTrue(~operator="all denied", checkAllDenied(10, true))
})

test(
  "TERMINATION: model that only tries DIFFERENT reads is blocked by clause 5 at readDraftCap",
  () => {
    let p = Guard.makePolicyWithDefaults({
      budget: 30,
      readDraftCap: 3,
      sameOpRetryCap: 10,
      deliverableSignal: Nullable.null,
    })
    let s = Guard.newGuardState(p)

    // Use recursive helper for iteration
    let rec loop = (idx: int): unit => {
      if idx < p.readDraftCap {
        let call: Guard.guardCall = {
          tool: "grep",
          args: Nullable.make(grepArgsDict("unique" ++ Int.toString(idx), "src")),
        }
        let d = Guard.evaluateGuards(s, call, p)
        assertionIsTrue(~operator="allowed at i=" ++ Int.toString(idx), d.allow)
        let _ = Guard.updateState(s, call, {ok: false}, p)
        loop(idx + 1)
      }
    }
    loop(0)

    // Now consecutive = readDraftCap, next read must be denied
    let after: Guard.guardCall = {tool: "grep", args: Nullable.make(grepArgsDict("new", "src"))}
    let d = Guard.evaluateGuards(s, after, p)
    assertionIsFalse(~operator="read_budget triggered", d.allow)
    assertionEqual(~operator="read_budget guard", d.guard, Nullable.make("read_budget"))
  },
)
