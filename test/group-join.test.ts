import { describe, it, expect, vi, afterEach } from "vitest";
import { GroupJoinManager, type DeliveryCallback } from "../src/group-join.js";
import type { AgentRecord } from "../src/types.js";

function makeRecord(id: string, overrides?: Partial<AgentRecord>): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status: "completed",
    toolUses: 1,
    startedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

describe("GroupJoinManager", () => {
  let manager: GroupJoinManager;

  afterEach(() => {
    manager?.dispose();
  });

  describe("registerGroup + isGrouped", () => {
    it("tracks grouped agent IDs", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);
      manager.registerGroup("g1", ["a1", "a2", "a3"]);

      expect(manager.isGrouped("a1")).toBe(true);
      expect(manager.isGrouped("a2")).toBe(true);
      expect(manager.isGrouped("a3")).toBe(true);
      expect(manager.isGrouped("a4")).toBe(false);
    });
  });

  describe("onAgentComplete", () => {
    it("returns 'pass' for ungrouped agents", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);

      const result = manager.onAgentComplete(makeRecord("unknown"));
      expect(result).toBe("pass");
      expect(cb).not.toHaveBeenCalled();
    });

    it("returns 'held' while group is incomplete", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);
      manager.registerGroup("g1", ["a1", "a2"]);

      const result = manager.onAgentComplete(makeRecord("a1"));
      expect(result).toBe("held");
      expect(cb).not.toHaveBeenCalled();
    });

    it("returns 'delivered' and calls callback when all agents complete", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);
      manager.registerGroup("g1", ["a1", "a2"]);

      manager.onAgentComplete(makeRecord("a1"));
      const result = manager.onAgentComplete(makeRecord("a2"));

      expect(result).toBe("delivered");
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "a1" }),
          expect.objectContaining({ id: "a2" }),
        ]),
        false, // not partial
      );
    });

    it("delivers single-agent groups immediately", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);
      manager.registerGroup("g1", ["a1"]);

      const result = manager.onAgentComplete(makeRecord("a1"));
      expect(result).toBe("delivered");
      expect(cb).toHaveBeenCalledOnce();
    });

    it("returns 'pass' for agents after group has already delivered", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);
      manager.registerGroup("g1", ["a1"]);

      manager.onAgentComplete(makeRecord("a1"));
      // After delivery, group is cleaned up — second call returns pass
      const result = manager.onAgentComplete(makeRecord("a1"));
      expect(result).toBe("pass");
    });
  });

  describe("timeout + partial delivery", () => {
    it("delivers partial results on timeout", () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      manager = new GroupJoinManager(cb, 100);
      manager.registerGroup("g1", ["a1", "a2", "a3"]);

      manager.onAgentComplete(makeRecord("a1"));
      expect(cb).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(
        [expect.objectContaining({ id: "a1" })],
        true, // partial
      );

      vi.useRealTimers();
    });

    it("straggler completes after partial delivery", () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      manager = new GroupJoinManager(cb, 100);
      manager.registerGroup("g1", ["a1", "a2"]);

      // First agent completes, timeout fires for partial
      manager.onAgentComplete(makeRecord("a1"));
      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenCalledOnce();

      // Second agent completes — triggers straggler delivery (all remaining done)
      const result = manager.onAgentComplete(makeRecord("a2"));
      expect(result).toBe("delivered");
      expect(cb).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("does not fire timeout if all agents complete before timeout", () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      manager = new GroupJoinManager(cb, 100);
      manager.registerGroup("g1", ["a1", "a2"]);

      manager.onAgentComplete(makeRecord("a1"));
      manager.onAgentComplete(makeRecord("a2"));

      // Timeout should be cleared, advancing time should not call again
      vi.advanceTimersByTime(200);
      expect(cb).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });
  });

  describe("dispose", () => {
    it("clears all timeouts on dispose", () => {
      vi.useFakeTimers();
      const cb = vi.fn();
      manager = new GroupJoinManager(cb, 100);
      manager.registerGroup("g1", ["a1", "a2"]);

      manager.onAgentComplete(makeRecord("a1"));
      // Timeout is now pending

      manager.dispose();

      // Advancing time should not fire the callback
      vi.advanceTimersByTime(200);
      expect(cb).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("clears group and agent mappings on dispose", () => {
      const cb = vi.fn();
      manager = new GroupJoinManager(cb);
      manager.registerGroup("g1", ["a1", "a2"]);

      expect(manager.isGrouped("a1")).toBe(true);
      manager.dispose();
      expect(manager.isGrouped("a1")).toBe(false);
    });
  });
});
