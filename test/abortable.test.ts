// src/abortable.ts was the only module in the repo that no test imported. It is
// reached indirectly through the get_subagent_result wait paths, but its two
// real invariants were never asserted:
//
//   1. Aborting cancels the CALLER'S WAIT, not the work (#159). The background
//      child keeps running and its result stays unconsumed — so the wrapped
//      promise settles later, after `abortable` already rejected. What makes
//      that safe is that `abortable` subscribes to the child with BOTH handlers
//      (`promise.then(onFulfilled, onRejected)`): the child's eventual rejection
//      is therefore already handled and goes nowhere. Drop the rejection handler
//      and a child that fails after the user pressed Esc raises an unhandled
//      rejection at the process level, long after the abort, with nothing
//      pointing back here.
//
//      (The `settled` latch is defensive, not load-bearing: settling an already
//      settled promise a second time is a no-op per spec, so removing the latch
//      changes nothing observable. No test here claims to protect it.)
//   2. The abort listener is removed on every settle path. The parent's signal
//      outlives many waits, so a leak here accumulates handlers across a fleet.
//
// Both failures are invisible to a test that only checks the happy path, which
// is why they are asserted directly rather than through a consumer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { abortable, abortableWithTimeout } from "../src/abortable.js";

/**
 * Collect unhandled rejections for the duration of a block.
 *
 * Vitest installs its own handler, so `process.on` alone would not observe them —
 * `removeAllListeners` is used and the originals restored afterwards.
 */
async function withUnhandledRejectionSpy(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const prior = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  const capture = (reason: unknown) => { seen.push(reason); };
  process.on("unhandledRejection", capture);
  try {
    await fn();
    // Unhandled rejections are reported on a later macrotask, not a microtask.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", capture);
    for (const l of prior) process.on("unhandledRejection", l as never);
  }
  return seen;
}

describe("abortable", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the original promise untouched when there is no signal", async () => {
    const promise = Promise.resolve("value");
    // Identity, not just equality: with no signal there is nothing to race, so
    // wrapping would add a needless tick and a needless rejection surface.
    expect(abortable(promise)).toBe(promise);
    await expect(promise).resolves.toBe("value");
  });

  it("rejects immediately with the signal's reason when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone before we started"));
    await expect(abortable(new Promise(() => {}), controller.signal))
      .rejects.toThrow("gone before we started");
  });

  it("resolves normally when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve(42), controller.signal)).resolves.toBe(42);
  });

  it("propagates a rejection from the wrapped promise", async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.reject(new Error("work failed")), controller.signal))
      .rejects.toThrow("work failed");
  });

  it("rejects with the abort reason when the signal fires mid-wait", async () => {
    const controller = new AbortController();
    const pending = abortable(new Promise(() => {}), controller.signal);
    controller.abort(new Error("user pressed Esc"));
    await expect(pending).rejects.toThrow("user pressed Esc");
  });

  it("absorbs a late REJECTION of the wrapped promise after an abort", async () => {
    // The #159 guarantee: the child was not cancelled, so it can still fail
    // after we stopped waiting. That failure must go nowhere, not to the
    // process's unhandled-rejection handler. Verified to fail if `abortable`
    // stops attaching a rejection handler to the wrapped promise.
    const unhandled = await withUnhandledRejectionSpy(async () => {
      const controller = new AbortController();
      let failChild: ((e: unknown) => void) | undefined;
      const childWork = new Promise((_resolve, reject) => { failChild = reject; });

      const pending = abortable(childWork, controller.signal);
      controller.abort(new Error("stopped waiting"));
      await expect(pending).rejects.toThrow("stopped waiting");

      failChild!(new Error("child died later"));
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(unhandled).toEqual([]);
  });

  it("absorbs a late RESOLUTION of the wrapped promise after an abort", async () => {
    const controller = new AbortController();
    let finishChild: ((v: string) => void) | undefined;
    const childWork = new Promise<string>((resolve) => { finishChild = resolve; });

    const pending = abortable(childWork, controller.signal);
    controller.abort(new Error("stopped waiting"));
    await expect(pending).rejects.toThrow("stopped waiting");

    finishChild!("child finished anyway");
    // The child's own result is still available to whoever holds it — abortable
    // cancelled the wait, not the work.
    await expect(childWork).resolves.toBe("child finished anyway");
  });

  it("removes its abort listener once the promise resolves", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await abortable(Promise.resolve("done"), controller.signal);

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes its abort listener once the promise rejects", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    await expect(abortable(Promise.reject(new Error("nope")), controller.signal)).rejects.toThrow();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("a late abort after normal settlement is inert", async () => {
    // A long-lived parent signal is aborted for unrelated reasons after this
    // wait already finished; nothing should be re-rejected or throw.
    const unhandled = await withUnhandledRejectionSpy(async () => {
      const controller = new AbortController();
      await expect(abortable(Promise.resolve("done"), controller.signal)).resolves.toBe("done");
      controller.abort(new Error("much later"));
      await new Promise((r) => setTimeout(r, 5));
    });

    expect(unhandled).toEqual([]);
  });

  it("does not leak a listener per wait on a shared parent signal", async () => {
    // Many children wait on one parent signal over a session's lifetime.
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");

    for (let i = 0; i < 20; i++) {
      await abortable(Promise.resolve(i), controller.signal);
    }

    expect(remove).toHaveBeenCalledTimes(20);
  });
});

describe("abortableWithTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves value when promise completes before timeout", async () => {
    const res = await abortableWithTimeout(Promise.resolve("hello"), {
      timeoutMs: 1_000,
    });
    expect(res).toEqual({ timedOut: false, value: "hello" });
  });

  it("returns timedOut: true when deadline expires", async () => {
    vi.useFakeTimers();
    let resolveChild: (v: string) => void;
    const child = new Promise<string>((r) => {
      resolveChild = r;
    });

    const waitPromise = abortableWithTimeout(child, { timeoutMs: 500 });
    vi.advanceTimersByTime(500);

    const res = await waitPromise;
    expect(res).toEqual({ timedOut: true });

    // Late resolution is absorbed
    resolveChild!("late value");
  });

  it("rejects when caller signal aborts before timeout", async () => {
    const controller = new AbortController();
    const waitPromise = abortableWithTimeout(new Promise(() => {}), {
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    controller.abort(new Error("caller aborted"));
    await expect(waitPromise).rejects.toThrow("caller aborted");
  });

  it("rejects immediately on already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));

    await expect(
      abortableWithTimeout(Promise.resolve("nope"), {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("already aborted");
  });
});
