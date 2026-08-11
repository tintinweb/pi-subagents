/**
 * group-join.test.ts — Behavior of GroupJoinManager's state machine and timers.
 *
 * Uses fake timers to assert deterministic timeout behavior without flakiness.
 * The class itself is exercised directly with real records — no mocks beyond
 * a spy on the delivery callback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupJoinManager } from "../src/group-join.js";
import type { AgentRecord } from "../src/types.js";

function makeRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: "test",
    status: "completed",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ...overrides,
  };
}

describe("GroupJoinManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns 'pass' for unregistered agents and never invokes the callback", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver);
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("pass");
    expect(deliver).not.toHaveBeenCalled();
    expect(mgr.isGrouped("a")).toBe(false);
  });

  it("holds the first completion and arms the join timeout", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b"]);

    expect(mgr.isGrouped("a")).toBe(true);
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("held");

    vi.advanceTimersByTime(29_999);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers all records (partial=false) when the final completion arrives in time", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver);
    mgr.registerGroup("g", ["a", "b"]);

    mgr.onAgentComplete(makeRecord("a", { result: "A" }));
    expect(mgr.onAgentComplete(makeRecord("b", { result: "B" }))).toBe("delivered");

    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = deliver.mock.calls[0];
    expect(records.map((r: AgentRecord) => r.id).sort()).toEqual(["a", "b"]);
    expect(partial).toBe(false);

    // Group is cleaned up — no future deliveries can fire from these ids
    expect(mgr.isGrouped("a")).toBe(false);
    expect(mgr.isGrouped("b")).toBe(false);
  });

  it("delivers partial=true on timeout and re-arms the group for stragglers", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    mgr.onAgentComplete(makeRecord("a"));
    vi.advanceTimersByTime(30_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = deliver.mock.calls[0];
    expect(records.map((r: AgentRecord) => r.id)).toEqual(["a"]);
    expect(partial).toBe(true);

    // 'a' was delivered and is dropped from the group; 'b' and 'c' remain as stragglers
    expect(mgr.isGrouped("a")).toBe(false);
    expect(mgr.isGrouped("b")).toBe(true);
    expect(mgr.isGrouped("c")).toBe(true);
  });

  it("uses the shorter straggler timeout (15s) regardless of the configured group timeout", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    // First batch: 'a' alone, partial-delivered after 30s
    mgr.onAgentComplete(makeRecord("a"));
    vi.advanceTimersByTime(30_000);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Straggler 'b' arrives — fires at 15s, not 30s
    mgr.onAgentComplete(makeRecord("b"));
    vi.advanceTimersByTime(14_999);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(2);

    expect(deliver.mock.calls[1][0].map((r: AgentRecord) => r.id)).toEqual(["b"]);
    expect(deliver.mock.calls[1][1]).toBe(true);
    expect(mgr.isGrouped("c")).toBe(true); // 'c' is the remaining straggler now
  });

  it("delivers stragglers as a complete batch (partial=false) when all complete before their timeout", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    mgr.onAgentComplete(makeRecord("a"));
    vi.advanceTimersByTime(30_000); // partial: 'a'
    expect(deliver).toHaveBeenCalledTimes(1);

    mgr.onAgentComplete(makeRecord("b"));
    expect(mgr.onAgentComplete(makeRecord("c"))).toBe("delivered");

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0].map((r: AgentRecord) => r.id).sort()).toEqual(["b", "c"]);
    expect(deliver.mock.calls[1][1]).toBe(false);
  });

  it("returns 'pass' for late completions arriving after a group is already delivered", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver);
    mgr.registerGroup("g", ["a", "b"]);

    mgr.onAgentComplete(makeRecord("a"));
    mgr.onAgentComplete(makeRecord("b")); // full delivery
    expect(deliver).toHaveBeenCalledTimes(1);

    // A duplicate/late completion must not trigger a second delivery
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("pass");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears pending timers so a partial delivery never fires post-dispose", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b"]);

    mgr.onAgentComplete(makeRecord("a")); // arms 30s timeout
    mgr.dispose();

    vi.advanceTimersByTime(60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(mgr.isGrouped("a")).toBe(false);
    expect(mgr.isGrouped("b")).toBe(false);
  });
});
