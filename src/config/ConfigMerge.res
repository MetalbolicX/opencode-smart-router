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

let rec deepMerge = (base: JSON.t, override: JSON.t): JSON.t => {
  // Handle the three logical cases:
  //   - base undefined → return override
  //   - override undefined → return base (preserve base)
  //   - both plain objects → recursively merge (override wins per key)
  //   - array or scalar → return override (replacement, not concat/merge)
  let baseObj = JSON.Decode.object(base)
  let overrideObj = JSON.Decode.object(override)
  let baseIsObj = baseObj != None
  let overrideIsObj = overrideObj != None
  if !baseIsObj {
    // base is null/undefined/scalar → return override
    override
  } else if !overrideIsObj {
    // base is object, override is null/undefined/scalar
    if overrideObj == None {
      base // override is undefined → return base (preserve base)
    } else {
      override // override is null or scalar → return override (replacement)
    }
  } else {
    // Both are objects - merge recursively
    let b = Option.getOrThrow(baseObj)
    let o = Option.getOrThrow(overrideObj)
    let merged: dict<JSON.t> = Dict.make()
    // Copy all base keys
    let baseKeys = Dict.keysToArray(b)
    for i in 0 to Array.length(baseKeys) - 1 {
      switch baseKeys[i] {
      | Some(key) =>
        switch Dict.get(b, key) {
        | Some(v) => Dict.set(merged, key, v)
        | None => ()
        }
      | None => ()
      }
    }
    // Apply override keys (recursive merge or scalar replacement)
    let overrideKeys = Dict.keysToArray(o)
    for i in 0 to Array.length(overrideKeys) - 1 {
      switch overrideKeys[i] {
      | Some(key) =>
        switch Dict.get(o, key) {
        | Some(ov) =>
          switch Dict.get(b, key) {
          | Some(bv) => Dict.set(merged, key, deepMerge(bv, ov))
          | None => Dict.set(merged, key, ov)
          }
        | None => ()
        }
      | None => ()
      }
    }
    JSON.Encode.object(merged)
  }
}
