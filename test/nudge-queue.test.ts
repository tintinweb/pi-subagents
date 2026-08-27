/**
 * nudge-queue.test.ts — Delivery timing for completion notifications.
 *
 * The regression this guards: a notification emitted while the parent agent is
 * mid-run is parked by pi's follow-up queue until the run ends, where it can no
 * longer be suppressed — so agents the orchestrator already joined with
 * `get_subagent_result` still notified after the final answer, one wasted turn
 * each. Fake timers keep the hold window deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOLD_MS, NudgeQueue } from "../src/nudge-queue.js";

describe("NudgeQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers after the hold window when the parent is idle", () => {
    const send = vi.fn();
    const q = new NudgeQueue(() => false);

    q.schedule("a", send);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.heldCount).toBe(0);
  });

  it("parks instead of delivering while the parent is mid-run", () => {
    const send = vi.fn();
    const q = new NudgeQueue(() => true);

    q.schedule("a", send);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    expect(send).not.toHaveBeenCalled();
    expect(q.heldCount).toBe(1);
  });

  it("delivers parked notifications on flush", () => {
    const first = vi.fn();
    const second = vi.fn();
    const q = new NudgeQueue(() => true);

    q.schedule("a", first);
    q.schedule("b", second);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    expect(q.heldCount).toBe(2);

    q.flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(q.heldCount).toBe(0);
  });

  it("never delivers a notification cancelled while parked", () => {
    const send = vi.fn();
    const q = new NudgeQueue(() => true);

    q.schedule("a", send);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    // The orchestrator joins the agent with get_subagent_result mid-run.
    q.cancel("a");
    q.flush();

    expect(send).not.toHaveBeenCalled();
    expect(q.heldCount).toBe(0);
  });

  it("cancels a notification still inside its hold window", () => {
    const send = vi.fn();
    const q = new NudgeQueue(() => false);

    q.schedule("a", send);
    q.cancel("a");
    vi.advanceTimersByTime(DEFAULT_HOLD_MS * 10);

    expect(send).not.toHaveBeenCalled();
    expect(q.pendingCount).toBe(0);
  });

  it("re-reads busy state at delivery time rather than at schedule time", () => {
    const send = vi.fn();
    let busy = false;
    const q = new NudgeQueue(() => busy);

    q.schedule("a", send);
    busy = true; // parent started a run inside the hold window
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    expect(send).not.toHaveBeenCalled();
    expect(q.heldCount).toBe(1);
  });

  it("replaces an earlier notification for the same key", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const q = new NudgeQueue(() => false);

    q.schedule("a", stale);
    q.schedule("a", fresh);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("flushes each parked notification exactly once", () => {
    const send = vi.fn();
    const q = new NudgeQueue(() => true);

    q.schedule("a", send);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    q.flush();
    q.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering after a send throws", () => {
    const boom = vi.fn(() => {
      throw new Error("stale record");
    });
    const ok = vi.fn();
    const q = new NudgeQueue(() => true);

    q.schedule("a", boom);
    q.schedule("b", ok);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);

    expect(() => q.flush()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("drops everything undelivered on dispose", () => {
    const parked = vi.fn();
    const inWindow = vi.fn();
    const q = new NudgeQueue(() => true);

    q.schedule("a", parked);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS);
    q.schedule("b", inWindow);

    q.dispose();
    vi.advanceTimersByTime(DEFAULT_HOLD_MS * 10);
    q.flush();

    expect(parked).not.toHaveBeenCalled();
    expect(inWindow).not.toHaveBeenCalled();
    expect(q.heldCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });
});
