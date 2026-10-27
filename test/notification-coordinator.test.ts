import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationCoordinator } from "../src/notification-coordinator.js";
import type { AgentRecord } from "../src/types.js";

function makeRecord(id: string, opts: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `task ${id}`,
    status: "completed",
    toolUses: 1,
    startedAt: 1_000,
    completedAt: 2_000,
    lifetimeUsage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
    ...opts,
  };
}

describe("NotificationCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("holds single completion for holdMs and sends with steer delivery by default", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const coordinator = new NotificationCoordinator({
      sessionGeneration: 1,
      holdMs: 200,
      send,
    });

    const record = makeRecord("a1");
    coordinator.enqueue(record);

    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([record], {
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  it("suppresses notification when result is consumed before hold expires", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const coordinator = new NotificationCoordinator({
      sessionGeneration: 1,
      holdMs: 200,
      send,
    });

    const record = makeRecord("a1");
    coordinator.enqueue(record);

    vi.advanceTimersByTime(100);
    record.resultConsumed = true;
    const consumed = coordinator.consume("a1");
    expect(consumed).toBe(true);

    vi.advanceTimersByTime(200);
    expect(send).not.toHaveBeenCalled();
  });

  it("settled mode holds until parentSettled() is called", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const coordinator = new NotificationCoordinator({
      sessionGeneration: 1,
      delivery: "settled",
      holdMs: 200,
      send,
    });

    coordinator.parentStarted();

    const record = makeRecord("a1");
    coordinator.enqueue(record);

    vi.advanceTimersByTime(200);
    expect(send).not.toHaveBeenCalled();

    coordinator.parentSettled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([record], {
      triggerTurn: true,
    });
  });

  it("disposes all pending timers and ignores late callbacks", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const coordinator = new NotificationCoordinator({
      sessionGeneration: 1,
      holdMs: 200,
      send,
    });

    coordinator.enqueue(makeRecord("a1"));
    coordinator.dispose();

    vi.advanceTimersByTime(300);
    expect(send).not.toHaveBeenCalled();
  });
});
