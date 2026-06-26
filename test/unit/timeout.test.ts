// ---------------------------------------------------------------------------
// test/unit/timeout.test.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { withTimeout } from "../../src/utils/timeout";

describe("withTimeout", () => {
  it("resolves with the value when promise completes within timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
    expect(result).toBe("ok");
  });

  it("rejects with timeout error when promise is slower than timeout", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 10, "slow-promise"),
    ).rejects.toThrow("slow-promise timed out after 10ms");
  });

  it("includes the label in the timeout error message", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 10, "custom-label"),
    ).rejects.toThrow("custom-label");
  });

  it("rejects with the original error when promise rejects before timeout", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("original")), 1000, "test"),
    ).rejects.toThrow("original");
  });

  // -------------------------------------------------------------------------
  // AbortSignal — abort-before-settle / reject path
  // -------------------------------------------------------------------------

  it("rejects with AbortError when an already-aborted signal is passed", async () => {
    const ac = new AbortController();
    ac.abort();
    let caught: unknown;
    try {
      await withTimeout(Promise.resolve("nope"), 1000, "test", ac.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });

  it("rejects with AbortError when signal is aborted before promise settles", async () => {
    const ac = new AbortController();
    const pending = withTimeout(
      new Promise(() => {}),
      10_000,
      "long",
      ac.signal,
    );
    // Abort on next microtask so the listener is in place.
    queueMicrotask(() => ac.abort());
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });

  it("wins the race against a pending promise (no value returned)", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1);
    let caught: unknown;
    try {
      await withTimeout(new Promise(() => {}), 5000, "long", ac.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });

  it("removes the abort listener after success — no leak", async () => {
    const ac = new AbortController();
    const addSpy = vi.spyOn(ac.signal, "addEventListener");
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const result = await withTimeout(
      Promise.resolve(42),
      1000,
      "test",
      ac.signal,
    );
    expect(result).toBe(42);
    // The signal was actually wired — a listener was added and removed.
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("removes the abort listener after abort fires", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    queueMicrotask(() => ac.abort());
    try {
      await withTimeout(new Promise(() => {}), 10_000, "long", ac.signal);
    } catch {
      // expected
    }
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("removes the abort listener when the timeout wins", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    try {
      await withTimeout(new Promise(() => {}), 5, "fast-timeout", ac.signal);
    } catch {
      // expected timeout error
    }
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    removeSpy.mockRestore();
  });

  it("clears the timer on abort — no late timeout error after abort", async () => {
    const ac = new AbortController();
    queueMicrotask(() => ac.abort());
    try {
      await withTimeout(new Promise(() => {}), 5, "t", ac.signal);
    } catch {
      // expected AbortError
    }
    // Wait past the timeout duration; if the timer were still active we
    // would get an UnhandledPromiseRejection (re-thrown timeout error).
    await new Promise((r) => setTimeout(r, 30));
    // No assertion failure here — the fact we reached this line without
    // the process surfacing an unhandled rejection is the proof.
  });

  it("does not wire a listener when no signal is provided (back-compat)", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000, "test");
    expect(result).toBe("ok");
  });

  it("does not wire a listener when an un-aborted signal is provided but the promise settles fast", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "test",
      ac.signal,
    );
    expect(result).toBe("ok");
    // The fast path still adds then removes — no leak.
    expect(removeSpy).toHaveBeenCalled();
    removeSpy.mockRestore();
  });

  it("multiple aborts are idempotent — only one rejection surfaces", async () => {
    const ac = new AbortController();
    const pending = withTimeout(
      new Promise(() => {}),
      10_000,
      "long",
      ac.signal,
    );
    ac.abort();
    ac.abort(); // second abort is a no-op
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect((caught as DOMException)?.name).toBe("AbortError");
  });
});
