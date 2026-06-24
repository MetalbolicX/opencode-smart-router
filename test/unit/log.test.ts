import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTrajectoryLog } from "../../src/utils/log";

// ---------------------------------------------------------------------------
// writeTrajectoryLog (src/utils/log.ts)
//
// Centralises the mkdir+append pattern used by the per-delegation scorecard
// (hooks.ts), the opt-in full trajectory dump (hooks.ts), and the delegate
// scorecard (escalate/ladder.ts). The contract:
// - Default filename: `<sid>.log` under `<tmpdir>/opencode-model-router-trajectory/`.
// - With `subdir`:     `<sid>.<subdir>.log` in the same directory.
// - Fail-soft: any IO error is swallowed; callers must not crash a real
//   session on a logging failure.
// ---------------------------------------------------------------------------

let sidCounter = 0;
function uniqueSid(prefix: string): string {
  sidCounter += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sidCounter}`;
}

function trajPath(sid: string, subdir?: string): string {
  const filename = subdir ? `${sid}.${subdir}.log` : `${sid}.log`;
  return join(tmpdir(), "opencode-model-router-trajectory", filename);
}

const written: string[] = [];

afterEach(() => {
  for (const p of written.splice(0)) {
    try {
      rmSync(p, { force: true });
    } catch {
      // ignore
    }
  }
});

describe("writeTrajectoryLog", () => {
  it("writes content to <tmpdir>/opencode-model-router-trajectory/<sid>.log by default", () => {
    const sid = uniqueSid("ses-default");
    const path = trajPath(sid);
    written.push(path);

    writeTrajectoryLog(sid, "hello world");

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("hello world\n");
  });

  it("inserts <subdir> as a filename suffix when provided", () => {
    const sid = uniqueSid("ses-suffix");
    const scorecardPath = trajPath(sid, "scorecard");
    const delegatePath = trajPath(sid, "delegate");
    written.push(scorecardPath, delegatePath);

    writeTrajectoryLog(sid, "scorecard line", "scorecard");
    writeTrajectoryLog(sid, "delegate line", "delegate");

    expect(existsSync(scorecardPath)).toBe(true);
    expect(readFileSync(scorecardPath, "utf-8")).toBe("scorecard line\n");

    expect(existsSync(delegatePath)).toBe(true);
    expect(readFileSync(delegatePath, "utf-8")).toBe("delegate line\n");
  });

  it("appends rather than truncates when called multiple times", () => {
    const sid = uniqueSid("ses-append");
    const path = trajPath(sid);
    written.push(path);

    writeTrajectoryLog(sid, "line one");
    writeTrajectoryLog(sid, "line two");
    writeTrajectoryLog(sid, "line three");

    const contents = readFileSync(path, "utf-8");
    expect(contents).toBe("line one\nline two\nline three\n");
  });

  it("does not double-terminate when content already ends with a newline", () => {
    const sid = uniqueSid("ses-newline");
    const path = trajPath(sid);
    written.push(path);

    writeTrajectoryLog(sid, "already terminated\n");

    expect(readFileSync(path, "utf-8")).toBe("already terminated\n");
  });

  it("does not throw when given an empty content string", () => {
    const sid = uniqueSid("ses-empty");
    const path = trajPath(sid);
    written.push(path);

    expect(() => writeTrajectoryLog(sid, "")).not.toThrow();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("\n");
  });
});
