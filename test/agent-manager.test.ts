import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    manager = new AgentManager(() => {
      onCompleteCalled = true;
    });
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

describe("AgentManager — outputCleanup", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("dispose() calls outputCleanup on all records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    const cleanupSpy = vi.fn();
    record.outputCleanup = cleanupSpy;

    await record.promise;
    // The .then handler also calls outputCleanup on completion
    // Reset and set it again for dispose test
    record.outputCleanup = vi.fn();
    const disposeSpy = record.outputCleanup as ReturnType<typeof vi.fn>;

    manager.dispose();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("removeRecord (via clearCompleted) calls outputCleanup", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    // Set outputCleanup after completion (simulates it surviving the .then handler)
    const cleanupSpy = vi.fn();
    record.outputCleanup = cleanupSpy;

    manager.clearCompleted();
    expect(cleanupSpy).toHaveBeenCalledOnce();
  });

  it("outputCleanup errors are swallowed in dispose", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    record.outputCleanup = () => { throw new Error("cleanup failed"); };

    // Should not throw
    expect(() => manager.dispose()).not.toThrow();
  });
});

describe("AgentManager — abortController lifecycle", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("abortController is nulled after successful completion", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.abortController).toBeDefined();

    await record.promise;
    expect(record.abortController).toBeUndefined();
  });

  it("abortController is nulled after error", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("fail"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.abortController).toBeDefined();

    await record.promise;
    expect(record.abortController).toBeUndefined();
  });
});

describe("AgentManager — waitForAll", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("resolves immediately when no agents are running", async () => {
    manager = new AgentManager();
    await expect(manager.waitForAll()).resolves.toBeUndefined();
  });

  it("resolves after all agents complete", async () => {
    manager = new AgentManager();
    resolvedRun();

    manager.spawn(mockPi, mockCtx, "general-purpose", "t1", {
      description: "a",
      isBackground: true,
    });
    manager.spawn(mockPi, mockCtx, "general-purpose", "t2", {
      description: "b",
      isBackground: true,
    });

    await expect(manager.waitForAll()).resolves.toBeUndefined();
  });

  it("rejects on timeout when agents never complete", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "general-purpose", "t1", {
      description: "hangs",
      isBackground: true,
    });

    await expect(manager.waitForAll(50)).rejects.toThrow("timed out");

    // Clean up hanging agent
    manager.abortAll();
  });

  it("drains queued agents before resolving", async () => {
    manager = new AgentManager(undefined, 1);
    resolvedRun();

    manager.spawn(mockPi, mockCtx, "general-purpose", "t1", {
      description: "first",
      isBackground: true,
    });
    manager.spawn(mockPi, mockCtx, "general-purpose", "t2", {
      description: "queued",
      isBackground: true,
    });

    await expect(manager.waitForAll()).resolves.toBeUndefined();

    // Both should be completed
    const agents = manager.listAgents();
    expect(agents.every(a => a.status === "completed")).toBe(true);
  });
});
