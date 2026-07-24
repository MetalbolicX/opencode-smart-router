// ---------------------------------------------------------------------------
// src/plugin/hooks/index.ts — Public barrel for the plugin hook surface.
//
// TypeScript resolves `from "./hooks"` → `./hooks/index.ts` once the
// `hooks.ts` monolith is deleted. The runtime plugin in
// `src/plugin/runtime.ts` imports the 8 handlers below from this barrel;
// the test suite imports them from the same path. Re-export names MUST
// stay in sync with the `Hooks` registry in `src/plugin/runtime.ts`.
// ---------------------------------------------------------------------------

export { handleChatMessage, handleChatParams, handleTextComplete } from "./chat";
export { handleSessionIdle } from "./session";
export { handleConfig, handleSystemTransform } from "./system-config";
export { handleToolExecuteAfter, handleToolExecuteBefore } from "./tool-execute";
