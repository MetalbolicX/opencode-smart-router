import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  validateConfig,
  assembleSystemPrompt,
  type RouterConfig,
} from "../../src/index";

describe("assembled-prompt golden", () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "tiers.json"), "utf-8"),
  );
  const base = validateConfig(raw);

  const modelCases: Array<{ label: string; modelID: string | undefined }> = [
    { label: "claude", modelID: "anthropic/claude-sonnet-4-6" },
    { label: "openai", modelID: "openai/gpt-5" },
    { label: "undefined", modelID: undefined },
  ];

  for (const preset of ["anthropic", "openai"]) {
    if (!base.presets[preset]) continue;

    for (const { label, modelID } of modelCases) {
      it(`assembled-prompt-${preset}-model-${label}`, () => {
        const cfg: RouterConfig = {
          ...base,
          activePreset: preset,
          activeMode: undefined,
        };
        expect(assembleSystemPrompt(cfg, modelID)).toMatchSnapshot(
          `assembled-prompt-${preset}-model-${label}`,
        );
      });
    }
  }
});
