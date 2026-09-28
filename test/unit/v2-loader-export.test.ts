import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import plugin from "../../src/v2/index";

describe("OpenCode V2 loader contract", () => {
  it("exports a definition object with a stable id and setup function", () => {
    expect(typeof plugin).toBe("object");
    expect(plugin.id).toBe("opencode-smart-router");
    expect(typeof plugin.setup).toBe("function");
  });

  it("uses the built definition from the auto-discovered local entrypoint", async () => {
    const localEntrypoint = await import(
      pathToFileURL(resolve(".opencode/plugins/opencode-smart-router.ts")).href
    );
    const bundledEntrypoint = await import(pathToFileURL(resolve("dist/plugin.mjs")).href);

    expect(localEntrypoint.default).toBe(bundledEntrypoint.default);
  });

  it("publishes the built V2 bundle as the package entrypoint", async () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      main?: string;
      exports?: { "."?: string };
    };

    expect(pkg.main).toBe("./dist/plugin.mjs");
    expect(pkg.exports?.["."]).toBe("./dist/plugin.mjs");

    const packageEntrypoint = createRequire(import.meta.url).resolve("opencode-smart-router");
    expect(packageEntrypoint).toBe(resolve("dist/plugin.mjs"));

    const packagePlugin = (await import(pathToFileURL(packageEntrypoint).href)).default;
    expect(packagePlugin).toBe(
      (await import(pathToFileURL(resolve("dist/plugin.mjs")).href)).default,
    );
  });
});
