// ---------------------------------------------------------------------------
// src/config/ConfigMerge.res — deepMerge helper
//
// WU-6: Ports the pure deepMergeConfig from src/router/config-loader.ts.
// This is the ReScript implementation; the TS wrapper is replaced by this
// module's export after the dual-run gate passes.
//
// Semantic contract (identical to the TS original):
//   - base undefined  → return override
//   - override undefined → return base
//   - both plain objects → recursively merge, override wins per key
//   - array or scalar → return override (replacement, not concat/merge)
//   - JSON null is a value → treated as override-able scalar
// ---------------------------------------------------------------------------

let rec deepMerge = (base: Js.Json.t, override: Js.Json.t): Js.Json.t => {
  // Handle the three logical cases:
  //   - base undefined → return override
  //   - override undefined → return base (preserve base)
  //   - both plain objects → recursively merge (override wins per key)
  //   - array or scalar → return override (replacement, not concat/merge)
  let baseObj = Js.Json.decodeObject(base)
  let overrideObj = Js.Json.decodeObject(override)
  let baseIsObj = baseObj != None
  let overrideIsObj = overrideObj != None
  if !baseIsObj {
    // base is null/undefined/scalar → return override
    override
  } else if !overrideIsObj {
    // base is object, override is null/undefined/scalar
    if Js.typeof(override) == "undefined" {
      base  // override is undefined → return base (preserve base)
    } else {
      override  // override is null or scalar → return override (replacement)
    }
  } else {
    // Both are objects - merge recursively
    let b = Js.Option.getExn(baseObj)
    let o = Js.Option.getExn(overrideObj)
    let merged: Js.Dict.t<Js.Json.t> = Js.Dict.empty()
    // Copy all base keys
    let baseKeys = Js.Dict.keys(b)
    for i in 0 to Js.Array.length(baseKeys) - 1 {
      switch baseKeys[i] {
      | Some(key) =>
        switch Js.Dict.get(b, key) {
        | Some(v) => Js.Dict.set(merged, key, v)
        | None => ()
        }
      | None => ()
      }
    }
    // Apply override keys (recursive merge or scalar replacement)
    let overrideKeys = Js.Dict.keys(o)
    for i in 0 to Js.Array.length(overrideKeys) - 1 {
      switch overrideKeys[i] {
      | Some(key) =>
        switch Js.Dict.get(o, key) {
        | Some(ov) =>
          switch Js.Dict.get(b, key) {
          | Some(bv) => Js.Dict.set(merged, key, deepMerge(bv, ov))
          | None => Js.Dict.set(merged, key, ov)
          }
        | None => ()
        }
      | None => ()
      }
    }
    Js.Json.object_(merged)
  }
}
