// ---------------------------------------------------------------------------
// src/router/config.ts — Re-export barrel.
//
// PR2 of the core-refactor-plan splits this file into four focused modules:
//   - `./config.types`     — type interfaces and `isPlainObject`
//   - `./config-loader`    — layer loading, merging, paths
//   - `./config-validate`  — `validateConfig()` and `normalizeEnforcement()`
//   - `./config-state`     — `readState()`, `writeState()`, `saveActive*()`
//
// PR3a adds two shared modules so `resolvePresetName()` and the
// enforcement-mode constants are not duplicated:
//   - `./config-resolve`   — `resolvePresetName()`, `ENFORCEMENT_MODES`,
//                            `VERIFY_REQUIRE_MODES`
//   - `./config-errors`    — typed errors (`RouterStateError`)
//
// All public exports are re-exported from here so existing imports of the
// shape `from "./config"` continue to resolve unchanged.
// ---------------------------------------------------------------------------

export * from "./config.types";
export * from "./config-errors";
export * from "./config-loader";
export * from "./config-resolve";
export * from "./config-state";
export * from "./config-validate";
