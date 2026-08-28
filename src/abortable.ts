/**
 * abortable.ts — race a promise against an AbortSignal without cancelling the
 * underlying work.
 *
 * Used by the `get_subagent_result` wait paths (top-level and nested): pressing
 * Esc cancels only the caller's wait; the background child keeps running and its
 * result stays unconsumed. The listener is removed on every settle path so the
 * signal accumulates no handlers, and a late settlement of the wrapped promise
 * after an abort is absorbed as a no-op (no unhandled rejection).
 */

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export interface WaitOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  now?: () => number;
}

export type WaitOutcome<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

/**
 * Await a promise until it settles, the caller aborts, or the timeout expires.
 * Timeout absorbs late promise settlement without throwing and returns `{ timedOut: true }`.
 */
export function abortableWithTimeout<T>(
  promise: Promise<T>,
  options: WaitOptions,
): Promise<WaitOutcome<T>> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason);
  }

  return new Promise<WaitOutcome<T>>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(options.signal?.reason);
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeoutMs <= 0) {
      settled = true;
      cleanup();
      resolve({ timedOut: true });
      return;
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ timedOut: true });
    }, options.timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
