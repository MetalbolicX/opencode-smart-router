import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RouterConfig } from "../../src/router/config";
import { validateConfig } from "../../src/router/config";
import { buildDelegationProtocol } from "../../src/router/protocol";

describe("protocol golden", () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8"));
  const base = validateConfig(raw);

  for (const preset of Object.keys(base.presets)) {
    it(`protocol-${preset}`, () => {
      const cfg: RouterConfig = {
        ...base,
        activePreset: preset,
        activeMode: undefined,
      };
      expect(buildDelegationProtocol(cfg)).toMatchSnapshot(`protocol-${preset}`);
    });
  }

  for (const m of Object.keys(base.modes ?? {})) {
    it(`protocol-anthropic-mode-${m}`, () => {
      const cfg: RouterConfig = {
        ...base,
        activePreset: "anthropic",
        activeMode: m,
      };
      expect(buildDelegationProtocol(cfg)).toMatchSnapshot(`protocol-anthropic-mode-${m}`);
    });
  }
});
