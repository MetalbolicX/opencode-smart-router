import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Biome conformance test.
//
// Spec: linting-formatting (production-readiness).
//
// The canonical assertion is the spec's strong gate: `biome check` MUST
// exit 0 against the project source. Unformatted or lint-invalid code
// MUST produce a failing exit status (acceptance criterion). This test
// runs the exact same command CI will run, against the same source.
// ---------------------------------------------------------------------------

const biomeBin = "./node_modules/@biomejs/biome/bin/biome";

describe("biome conformance (linting-formatting)", () => {
  it("biome --version reports a semver string (binary resolves)", () => {
    const result = spawnSync("node", [biomeBin, "--version"], { encoding: "utf-8" });

    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error(result.stderr);
    }

    expect(result.status).toBe(0);
    // Biome prints `Version: X.Y.Z` — assert the trailing semver substring
    // so the test is resilient to prefix changes.
    expect(result.stdout).toMatch(/Version:\s*\d+\.\d+\.\d+/);
  });

  it("biome check exits 0 against project source (spec gate)", () => {
    // The strong assertion from the linting-formatting spec: `biome check`
    // MUST exit 0 against the project source. This is the same command
    // wired into `pnpm run lint` and the future CI gate.
    const result = spawnSync("node", [biomeBin, "check"], { encoding: "utf-8" });

    if (result.status !== 0) {
      // Surface Biome diagnostics on failure so the test report explains
      // the regression without forcing the reader to re-run locally.
      // eslint-disable-next-line no-console
      console.error("biome check stdout:", result.stdout);
      // eslint-disable-next-line no-console
      console.error("biome check stderr:", result.stderr);
    }

    expect(result.status).toBe(0);
  });

  it("biome format --help exits 0 (formatter subcommand is wired)", () => {
    const result = spawnSync("node", [biomeBin, "format", "--help"], { encoding: "utf-8" });

    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error(result.stderr);
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/format/i);
  });
});
