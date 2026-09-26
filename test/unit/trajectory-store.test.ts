import { describe, expect, it } from "vitest";
import { createTrajectoryStore, MAX_SESSIONS } from "../../src/telemetry/trajectory";

describe("createTrajectoryStore", () => {
  it("clears a session and recreates fresh state on the next event", () => {
    const store = createTrajectoryStore();
    store.recordToolEvent("sid", { tool: "read", readOnly: true });

    store.clear("sid");

    expect(store.get("sid")).toBeUndefined();
    store.recordToolEvent("sid", { tool: "read", readOnly: true });
    expect(store.get("sid")?.toolCallCount).toBe(1);
    expect(store.get("sid")?.readCount).toBe(1);
  });

  it("evicts the oldest session when the maximum is exceeded", () => {
    const store = createTrajectoryStore();
    for (let index = 0; index < MAX_SESSIONS + 10; index++) {
      store.ensure(`sid-${index}`);
    }

    expect(store.get("sid-0")).toBeUndefined();
    expect(store.get(`sid-${MAX_SESSIONS + 9}`)).toBeDefined();
    expect(store.size()).toBe(MAX_SESSIONS);
  });

  it("does nothing when clearing an unknown session", () => {
    const store = createTrajectoryStore();

    expect(() => store.clear("unknown")).not.toThrow();
    expect(store.size()).toBe(0);
  });
});
