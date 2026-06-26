// ---------------------------------------------------------------------------
// src/utils/timeout.ts — Promise timeout helper for SDK calls.
//
// Wraps a promise with a timeout so the caller never hangs indefinitely.
// The timer is always cleaned up via finally, even on success or rejection.
//
// When an `AbortSignal` is supplied, an `abort` listener races the
// timer/promise and rejects with a DOMException(`"aborted"` / `AbortError`).
// The listener and timer are ALWAYS removed in `finally` — no leak even on
// the success, timeout, or abort paths. If the signal is already aborted
// at call time, the helper rejects synchronously on the next microtask
// without scheduling a timer.
// ---------------------------------------------------------------------------

export const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> => {
  // Fast path: signal already aborted at call time. Reject on the next
  // microtask (so the caller's `await` sees a real rejection) without
  // scheduling a timer or wiring a listener. A bare `throw` from an async
  // function is equivalent to rejecting the returned promise, so we just
  // throw — but we must wait until after the function call returns so the
  // caller gets the rejection via await.
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const race = Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );

      if (signal) {
        abortListener = () =>
          reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", abortListener);
      }
    }),
  ]);

  try {
    return await race;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
};
