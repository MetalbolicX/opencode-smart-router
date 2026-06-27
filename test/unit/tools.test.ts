import { describe, expect, it } from "vitest";
import { FINISH_TOOLS, MUTATION_TOOLS, READ_ONLY_TOOLS, WRITE_TOOLS } from "../../src/router/tools";

// ---------------------------------------------------------------------------
// Shared tool classification sets (src/router/tools.ts).
//
// Single source of truth for the four tool sets used by guard, verify, and
// router modules. The contents MUST stay byte-stable because:
// - `extractChangedFile` (verify/dispatch.ts) treats membership in WRITE_TOOLS
//   as "this tool produces a changed-file record".
// - `classify` (guard/guards.ts) routes tool calls into finish/read/mutation
//   buckets based on FINISH_TOOLS / READ_ONLY_TOOLS / MUTATION_TOOLS.
// ---------------------------------------------------------------------------

describe("src/router/tools.ts", () => {
  it("READ_ONLY_TOOLS contains grep, read, glob, ls", () => {
    expect([...READ_ONLY_TOOLS].sort()).toEqual(["glob", "grep", "ls", "read"]);
  });

  it("WRITE_TOOLS contains write, edit, patch, multiedit", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(["edit", "multiedit", "patch", "write"]);
  });

  it("MUTATION_TOOLS contains write, edit, patch, bash, multiedit", () => {
    expect([...MUTATION_TOOLS].sort()).toEqual(["bash", "edit", "multiedit", "patch", "write"]);
  });

  it("FINISH_TOOLS contains finish, return, task_complete", () => {
    expect([...FINISH_TOOLS].sort()).toEqual(["finish", "return", "task_complete"]);
  });

  it("READ_ONLY_TOOLS and MUTATION_TOOLS are disjoint", () => {
    for (const t of READ_ONLY_TOOLS) {
      expect(MUTATION_TOOLS.has(t)).toBe(false);
    }
  });

  it("WRITE_TOOLS is a strict subset of MUTATION_TOOLS", () => {
    for (const t of WRITE_TOOLS) {
      expect(MUTATION_TOOLS.has(t)).toBe(true);
    }
  });

  it("FINISH_TOOLS is disjoint from READ_ONLY_TOOLS, WRITE_TOOLS, and MUTATION_TOOLS", () => {
    for (const t of FINISH_TOOLS) {
      expect(READ_ONLY_TOOLS.has(t)).toBe(false);
      expect(WRITE_TOOLS.has(t)).toBe(false);
      expect(MUTATION_TOOLS.has(t)).toBe(false);
    }
  });
});
