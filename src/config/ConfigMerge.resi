// ---------------------------------------------------------------------------
// src/config/ConfigMerge.resi — Public interface for ConfigMerge deepMerge
//
// WU-6: Ports the pure deepMergeConfig from src/router/config-loader.ts.
// The deepMerge function performs a recursive deep merge of two JSON values:
//   - undefined base → return override
//   - undefined override → return base
//   - both plain objects → recursively merge (override wins per-key)
//   - otherwise → return override (scalar/array replacement semantics)
// ---------------------------------------------------------------------------

/** Recursively deep-merge two JSON values.
    Override wins for non-object values (scalar/array replacement). */
let deepMerge: (JSON.t, JSON.t) => JSON.t
