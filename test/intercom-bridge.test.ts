import { afterEach, describe, expect, it } from "vitest";
import {
  applySubagentBridgeEnv,
  snapshotIntercomSessionId,
  withIntercomBridgeLock,
} from "../src/intercom-bridge.js";

const BRIDGE_KEYS = [
  "PI_SUBAGENT_ORCHESTRATOR_TARGET",
  "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_CHILD_INDEX",
  "PI_SUBAGENT_INTERCOM_SESSION_NAME",
] as const;

const ALL_KEYS = [...BRIDGE_KEYS, "PI_INTERCOM_SESSION_ID"] as const;

function snapshotAll(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ALL_KEYS) snap[k] = process.env[k];
  return snap;
}

function restore(snap: Record<string, string | undefined>): void {
  for (const k of ALL_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

afterEach(() => {
  for (const k of ALL_KEYS) delete process.env[k];
});

describe("applySubagentBridgeEnv", () => {
  it("sets all PI_SUBAGENT_* keys and restores prior values", () => {
    const snap = snapshotAll();
    try {
      process.env.PI_INTERCOM_SESSION_ID = "parent-broker-id";
      const restore = applySubagentBridgeEnv({
        orchestratorSessionId: "parent-broker-id",
        runId: "run-123",
        agent: "worker",
        index: "1",
        sessionName: "worker#run-12345",
      });
      expect(process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET).toBe("parent-broker-id");
      expect(process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID).toBe("parent-broker-id");
      expect(process.env.PI_SUBAGENT_RUN_ID).toBe("run-123");
      expect(process.env.PI_SUBAGENT_CHILD_AGENT).toBe("worker");
      expect(process.env.PI_SUBAGENT_CHILD_INDEX).toBe("1");
      expect(process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBe("worker#run-12345");

      restore();
      expect(process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET).toBeUndefined();
      expect(process.env.PI_SUBAGENT_RUN_ID).toBeUndefined();
    } finally {
      restore(snap);
    }
  });

  it("preserves pre-existing values on restore", () => {
    const snap = snapshotAll();
    try {
      process.env.PI_SUBAGENT_RUN_ID = "previous";
      const restore = applySubagentBridgeEnv({
        orchestratorSessionId: "p",
        runId: "new",
        agent: "Explore",
        index: "0",
      });
      expect(process.env.PI_SUBAGENT_RUN_ID).toBe("new");
      restore();
      expect(process.env.PI_SUBAGENT_RUN_ID).toBe("previous");
    } finally {
      restore(snap);
    }
  });

  it("omits sessionName when not provided", () => {
    const snap = snapshotAll();
    try {
      const restore = applySubagentBridgeEnv({
        orchestratorSessionId: "p",
        runId: "r",
        agent: "a",
        index: "0",
      });
      expect(process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME).toBeUndefined();
      restore();
    } finally {
      restore(snap);
    }
  });
});

describe("snapshotIntercomSessionId", () => {
  it("restores prior value after child overwrites it", () => {
    const snap = snapshotAll();
    try {
      process.env.PI_INTERCOM_SESSION_ID = "parent-id";
      const restore = snapshotIntercomSessionId();
      // Simulate the child's intercom session_start overwriting it.
      process.env.PI_INTERCOM_SESSION_ID = "child-id";
      restore();
      expect(process.env.PI_INTERCOM_SESSION_ID).toBe("parent-id");
    } finally {
      restore(snap);
    }
  });

  it("removes the var when it was absent before bind", () => {
    const snap = snapshotAll();
    try {
      delete process.env.PI_INTERCOM_SESSION_ID;
      const restore = snapshotIntercomSessionId();
      process.env.PI_INTERCOM_SESSION_ID = "child-only";
      restore();
      expect(process.env.PI_INTERCOM_SESSION_ID).toBeUndefined();
    } finally {
      restore(snap);
    }
  });
});

describe("withIntercomBridgeLock", () => {
  it("serializes tasks in order", async () => {
    const order: number[] = [];
    const t1 = withIntercomBridgeLock(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const t2 = withIntercomBridgeLock(async () => {
      order.push(3);
      await Promise.resolve();
      order.push(4);
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("does not block the chain after a rejected task", async () => {
    const boom = withIntercomBridgeLock(async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    const after: number[] = [];
    await withIntercomBridgeLock(async () => {
      after.push(1);
    });
    expect(after).toEqual([1]);
  });
});