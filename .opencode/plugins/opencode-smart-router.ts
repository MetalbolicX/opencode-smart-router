// Local OpenCode V2 entrypoint for this checkout.
// The V2 loader discovers files in `.opencode/plugins/` automatically.
// Load the built bundle so the loader does not have to resolve source-only
// TypeScript imports.
export { default } from "../../dist/plugin.mjs";
