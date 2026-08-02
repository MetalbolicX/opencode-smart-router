import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDelegationProtocol } from "../../src/router/Protocol.res.mjs";
import type { tierConfig } from "../../src/router/Protocol.res.mjs";
import type { RouterConfig } from "../../src/router/config";
import { validateConfig } from "../../src/router/config";

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
      expect(buildDelegationProtocol(cfg as unknown as tierConfig)).toMatchSnapshot(`protocol-${preset}`);
    });
  }

  for (const m of Object.keys(base.modes ?? {})) {
    it(`protocol-anthropic-mode-${m}`, () => {
      const cfg: RouterConfig = {
        ...base,
        activePreset: "anthropic",
        activeMode: m,
      };
      expect(buildDelegationProtocol(cfg as unknown as tierConfig)).toMatchSnapshot(`protocol-anthropic-mode-${m}`);
    });
  }
});
