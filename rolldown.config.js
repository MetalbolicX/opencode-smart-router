import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/plugin.mjs",
    format: "esm",
  },
  external: [
    "@opencode-ai/plugin",
    "node:fs",
    "node:fs/promises",
    "node:os",
    "node:path",
    "node:url",
    "node:crypto",
    "node:child_process",
    "node:util",
  ],
});
