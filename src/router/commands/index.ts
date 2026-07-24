// ---------------------------------------------------------------------------
// src/router/commands/index.ts — Public barrel for the router commands.
//
// TypeScript resolves `from "../router/commands"` → `commands/index.ts`
// once `commands.ts` is deleted. The plugin runtime in
// `src/plugin/runtime.ts` imports `handleCommandBefore` from this barrel;
// the test suite imports the builders + dispatcher + registerRouterCommands
// from the same path. Re-export names MUST stay in sync with the
// `Hooks` registry and the test imports.
// ---------------------------------------------------------------------------

export {
  buildBudgetOutput,
  buildPresetOutput,
  buildReasoningOutput,
  buildRouterOutput,
  buildTiersOutput,
} from "./builders";
export { handleCommandBefore, registerRouterCommands } from "./dispatch";
