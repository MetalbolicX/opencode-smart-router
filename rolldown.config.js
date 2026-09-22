import { defineConfig } from "rolldown";

const sharedExternal = [
  "@opencode-ai/plugin",
  "@opencode/plugin",
  "node:fs",
  "node:fs/promises",
  "node:os",
  "node:path",
  "node:url",
  "node:crypto",
  "node:child_process",
  "node:util",
];

export default defineConfig([
  {
    input: "src/v2/index.ts",
    output: {
      file: "dist/plugin.mjs",
      format: "esm",
    },
    external: sharedExternal,
  },
  {
    input: "src/cli/main.ts",
    output: {
      file: "dist/cli.mjs",
      format: "esm",
    },
    external: sharedExternal,
  },
]);
