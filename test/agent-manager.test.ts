import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  tryCreateWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import { tryCreateWorktree } from "../src/worktree.js";

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

  it("onComplete IS called for foreground agents (lifecycle symmetry)", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("completed");
    // resultConsumed is set by spawnAndWait so onComplete skips notifications
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — spawnAndWait onSpawned + foreground output file wiring (#105)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("fields set on the record in onSpawned are visible when onSessionCreated fires", async () => {
    // The load-bearing ordering guarantee: onSpawned fires synchronously inside
    // spawn(), before runAgent's async onSessionCreated fires. index.ts relies on
    // this to set record.outputFile so streamToOutputFile can pick it up.
    manager = new AgentManager();
    let capturedId: string | undefined;
    let outputFileSeenAtSessionCreated: string | undefined;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      // Yield one microtask to mirror real behavior: in production, onSessionCreated
      // fires async (after network/session setup). onSpawned fires synchronously
      // inside spawn() before runAgent's promise even starts. This await lets the
      // remainder of startAgent (record.promise = …, onSpawned?.()) finish first.
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      outputFileSeenAtSessionCreated = capturedId
        ? manager.getRecord(capturedId)?.outputFile
        : undefined;
      return { responseText: "done", session, aborted: false, steered: false };
    });

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => {
      capturedId = fgId;
      manager.getRecord(fgId)!.outputFile = "/fake/agent.jsonl";
    });

    expect(outputFileSeenAtSessionCreated).toBe("/fake/agent.jsonl");
  });

  it("onSpawned id matches the id returned by spawnAndWait", async () => {
    manager = new AgentManager();
    let spawnedId: string | undefined;
    resolvedRun();

    const { id } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => { spawnedId = fgId; });

    expect(spawnedId).toBe(id);
  });

  it("restores the shared onSpawned callback before awaiting the foreground run", async () => {
    manager = new AgentManager();
    let finishFirst: ((value: RunResult) => void) | undefined;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({
        responseText: "second",
        session: mockSession(),
        aborted: false,
        steered: false,
      });
    const firstCallback = vi.fn();


    const first = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", {
      description: "first",
    }, firstCallback);
    const secondId = manager.spawn(mockPi, mockCtx, "general-purpose", "second", {
      description: "second",
      isBackground: true,
    });

    expect(firstCallback).toHaveBeenCalledTimes(1);
    await manager.getRecord(secondId)!.promise;
    finishFirst?.({
      responseText: "first",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    await first;
  });

  it("foreground pre-acceptance rejection removes the record without completing it", async () => {
    const onComplete = vi.fn();
    const onStart = vi.fn();
    manager = new AgentManager(onComplete, undefined, onStart);
    vi.mocked(runAgent).mockRejectedValue(new Error("agent failed"));

    await expect(manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    })).rejects.toThrow("agent failed");

    expect(onStart).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — nested runtime propagation", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("stores nesting metadata and passes the owning manager/runtime to runAgent", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "scout", "nested", {
      description: "nested",
      isBackground: true,
      depth: 2,
      parentAgentId: "parent-1",
      maxSubagentDepth: 3,
      configCwd: "/trusted/config",
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)).toEqual(expect.objectContaining({
      depth: 2,
      parentAgentId: "parent-1",
      maxSubagentDepth: 3,
    }));
    expect(runAgent).toHaveBeenLastCalledWith(
      mockCtx,
      "scout",
      "nested",
      expect.objectContaining({
        configCwd: "/trusted/config",
        nestedRuntime: {
          manager,
          parentAgentId: id,
          depth: 2,
          maxSubagentDepth: 3,
        },
      }),
    );
  });

  it("defaults top-level subagents to depth one", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "scout", "top", {
      description: "top",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)?.depth).toBe(1);
    expect(vi.mocked(runAgent).mock.lastCall?.[3].nestedRuntime).toEqual(expect.objectContaining({
      parentAgentId: id,
      depth: 1,
    }));
  });

  it("starts a nested background child even when the concurrency pool is full", async () => {
    // A parent holding the only slot and waiting on its own child would
    // otherwise deadlock: the child can never be drained from the queue.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager(undefined, 1);

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    // A second top-level background agent still queues — the pool is untouched.
    const siblingId = manager.spawn(mockPi, mockCtx, "general-purpose", "sibling", {
      description: "sibling",
      isBackground: true,
    });

    expect(manager.getRecord(childId)?.status).toBe("running");
    expect(manager.getRecord(siblingId)?.status).toBe("queued");
  });

  it("aborts owned children when the parent settles", async () => {
    let finishParent: ((value: any) => void) | undefined;
    // Children settle on abort, as a real run does when its signal fires.
    const abortable = (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ responseText: "", session: mockSession(), aborted: true, steered: false }),
        );
      });
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise(resolve => { finishParent = resolve; }))
      .mockImplementation(abortable as any);
    manager = new AgentManager();

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    const runningChild = manager.spawn(mockPi, mockCtx, "scout", "child", {
      description: "child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    const grandchild = manager.spawn(mockPi, mockCtx, "scout", "grandchild", {
      description: "grandchild",
      isBackground: true,
      depth: 3,
      parentAgentId: runningChild,
    });

    finishParent?.({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(parentId)!.promise;

    expect(manager.getRecord(runningChild)?.status).toBe("stopped");
    // The child's own settle path stops the generation below it.
    await manager.getRecord(runningChild)!.promise;
    expect(manager.getRecord(grandchild)?.status).toBe("stopped");
  });

  it("aborts children spawned during a resumed turn", async () => {
    // The spawn settle path already ran, so only resume() can stop what the
    // resumed turn launched — otherwise the child runs on, invisible.
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: mockSession(),
      aborted: false,
      steered: false,
    });
    manager = new AgentManager();

    const parentId = manager.spawn(mockPi, mockCtx, "general-purpose", "parent", {
      description: "parent",
      isBackground: true,
    });
    await manager.getRecord(parentId)!.promise;

    let childId = "";
    vi.mocked(resumeAgent).mockImplementation(async () => {
      vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
      childId = manager.spawn(mockPi, mockCtx, "scout", "child", {
        description: "child",
        isBackground: true,
        depth: 2,
        parentAgentId: parentId,
      });
      return { text: "resumed" } as any;
    });

    await manager.resume(parentId, "keep going");

    expect(manager.getRecord(childId)?.status).toBe("stopped");
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });

  it("retains an inline-delivered foreground session for same-session resume past ten minutes", async () => {
    manager = new AgentManager();
    resolvedRun();

    const { id, record } = await manager.spawnAndWait(
      mockPi,
      mockCtx,
      "general-purpose",
      "test",
      { description: "test" },
    );
    record.completedAt = Date.now() - 11 * 60_000;

    (manager as unknown as { cleanup(): void }).cleanup();

    expect(manager.getRecord(id)).toBe(record);
    expect(record.session).toBeDefined();
  });

  it("still evicts old consumed background records to bound irrelevant growth", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;
    record.completedAt = Date.now() - 11 * 60_000;

    (manager as unknown as { cleanup(): void }).cleanup();

    expect(manager.getRecord(id)).toBeUndefined();
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

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_subagent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when worktree creation fails; no orphan record left behind", async () => {
    vi.mocked(tryCreateWorktree).mockReturnValueOnce({
      ok: false,
      reason: "not_git_repo",
    });
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("spawn() error for missing worktree tells the model to retry once without isolation, not init git", async () => {
    vi.mocked(tryCreateWorktree).mockReturnValueOnce({
      ok: false,
      reason: "not_git_repo",
    });
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    let message = "";
    try {
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        isolation: "worktree",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/isolation: "worktree"/);
    expect(message.toLowerCase()).toMatch(/omit|without|retry/);
    expect(message).not.toMatch(/Initialize git and commit at least once/);
    expect(message.toLowerCase()).not.toMatch(/git init|initialize git/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("spawn() infrastructure isolation failures keep isolation and do not suggest unisolated retry", async () => {
    for (const reason of ["git_probe_failed", "repo_path_resolution_failed", "worktree_add_failed"] as const) {
      vi.mocked(tryCreateWorktree).mockReturnValueOnce({
        ok: false,
        reason,
      });
      vi.mocked(runAgent).mockClear();

      manager = new AgentManager();
      let message = "";
      try {
        manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
          description: "test",
          isolation: "worktree",
        });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }

      expect(message).toMatch(/isolation: "worktree"/);
      // Accurate class: path/probe failures are not `git worktree add`.
      if (reason === "repo_path_resolution_failed") {
        expect(message.toLowerCase()).toMatch(/resolve|repository root|path/);
        expect(message).not.toMatch(/`git worktree add` failed/);
      } else if (reason === "git_probe_failed") {
        expect(message.toLowerCase()).toMatch(/git|probe|infrastructure|worktree\/git/);
        expect(message).not.toMatch(/`git worktree add` failed/);
      } else {
        expect(message).toMatch(/`git worktree add` failed/);
      }
      // Strict: preserve isolation; fix infrastructure, then retry with isolation.
      expect(message.toLowerCase()).toMatch(/fix|retry.*isolation|then retry/);
      expect(message.toLowerCase()).toMatch(/do not drop isolation|do not fall back|preserve/);
      expect(message.toLowerCase()).not.toMatch(/retry the agent call once without/);
      expect(message.toLowerCase()).not.toMatch(/retry once without/);
      expect(message).not.toMatch(/Initialize git and commit at least once/);
      expect(manager.listAgents()).toEqual([]);
      expect(runAgent).not.toHaveBeenCalled();
      manager.dispose();
    }
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(tryCreateWorktree).mockReturnValueOnce({
      ok: true,
      worktree: {
        path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/packages/api",
      },
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    expect(tryCreateWorktree).toHaveBeenCalledWith("/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith("/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    vi.mocked(tryCreateWorktree).mockReturnValueOnce({
      ok: true,
      worktree: {
        path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/sub/dir",
      },
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    expect(queuedRecord.session).toBeUndefined();
    expect(queuedRecord.outcome).toEqual(expect.objectContaining({
      category: "user_stop",
      recovery: "none",
      freshSpawn: "forbidden",
    }));
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

// Regression for #44: ESC during a foreground Agent call must propagate to
// the child. Pi delivers parent abort via AbortSignal; the manager wires the
// signal's "abort" event to this.abort(id).
describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return new Promise(() => {});
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn() });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("refuses to steer an agent that is no longer running", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: false });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.steer(id, "too late")).toBe(false);
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("passes an already-aborted child signal to runAgent and preserves caller_stop", async () => {
    manager = new AgentManager();
    const parent = new AbortController();
    parent.abort();
    let childWasAbortedAtInvocation: boolean | undefined;
    let finish: ((value: RunResult) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      childWasAbortedAtInvocation = options.signal?.aborted;
      return new Promise((resolve) => { finish = resolve; });
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;

    expect(childWasAbortedAtInvocation).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.outcome).toEqual(expect.objectContaining({
      category: "caller_stop",
      recovery: "none",
      freshSpawn: "forbidden",
    }));

    finish?.({ responseText: "partial", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.outcome).toEqual(expect.objectContaining({
      category: "caller_stop",
      recovery: "resume_same_agent",
      freshSpawn: "forbidden",
    }));
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.session).toBeUndefined();
    expect(manager.getRecord(queued)?.outcome).toEqual(expect.objectContaining({
      category: "caller_stop",
      recovery: "none",
      freshSpawn: "forbidden",
    }));
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — accepted background runAgent rejection leaves the record visible", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the sanitized message, outcome, and completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(
      new Error("boom Authorization: Bearer secret-token?api_key=key-123"),
    );

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom Authorization: Bearer [REDACTED]?api_key=[REDACTED]");
    expect(record.session).toBeUndefined();
    expect(record.outcome).toEqual(expect.objectContaining({
      agentId: id,
      status: "error",
      phase: "startup",
      category: "startup",
      recovery: "start_fresh_after_correction",
      freshSpawn: "allowed_after_correction",
    }));
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// #144 — a run that RESOLVES with a failed final turn (pi never rejects on
// retry exhaustion) must map to status "error", not "completed".
describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("classifies a hard max-turn abort without conflating it with provider error", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial",
      session: mockSession(),
      aborted: true,
      steered: true,
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x" });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("aborted");
    expect(record.outcome).toEqual(expect.objectContaining({
      agentId: id,
      category: "max_turns",
      phase: "run",
      recovery: "resume_same_agent",
    }));
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it.each([false, true])(
    "completion callback errors do not replace an accepted runtime failure (background=%s)",
    async (isBackground) => {
      manager = new AgentManager(() => { throw new Error("completion callback failed"); });
      const session = mockSession();
      vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
        options.onSessionCreated?.(session);
        throw new Error("provider failed");
      });

      const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground });
      const record = manager.getRecord(id)!;
      await expect(record.promise).resolves.toBe("");

      expect(record.status).toBe("error");
      expect(record.error).toBe("provider failed");
      expect(record.outcome).toEqual(expect.objectContaining({
        agentId: id,
        category: "provider",
        recovery: "resume_same_agent",
      }));
    },
  );

  it("an external stop still wins over a late failure resolution", async () => {
    manager = new AgentManager();
    let resolveRun: ((v: unknown) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(manager.abort(id)).toBe(true);
    resolveRun!({ responseText: "", session, aborted: false, steered: false, failure: "late error" });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(record.error).toBeUndefined();
    expect(record.outcome).toEqual(expect.objectContaining({
      agentId: id,
      status: "stopped",
      category: "user_stop",
      recovery: "resume_same_agent",
      freshSpawn: "forbidden",
    }));
  });

  it("a delayed queued startup failure retains its accepted ID with startup recovery", async () => {
    manager = new AgentManager(undefined, 1);
    let finishBlocker: ((value: RunResult) => void) | undefined;
    vi.mocked(runAgent).mockImplementationOnce(() => new Promise(resolve => { finishBlocker = resolve; }));

    const blocker = manager.spawn(mockPi, mockCtx, "X", "block", {
      description: "block",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "queued",
      isBackground: true,
      isolation: "worktree",
    });
    expect(manager.getRecord(queued)?.status).toBe("queued");

    vi.mocked(tryCreateWorktree).mockReturnValueOnce({
      ok: false,
      reason: "not_git_repo",
    });
    finishBlocker?.({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    await manager.getRecord(blocker)?.promise;

    const record = manager.getRecord(queued);
    expect(record).toEqual(expect.objectContaining({ id: queued, status: "error" }));
    expect(record?.outcome).toEqual(expect.objectContaining({
      agentId: queued,
      category: "startup",
      recovery: "start_fresh_after_correction",
      freshSpawn: "allowed_after_correction",
    }));
  });

  it("a foreground async rejection before child-session acceptance retains no record", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("startup rejected"));

    await expect(manager.spawnAndWait(mockPi, mockCtx, "X", "p", {
      description: "x",
    })).rejects.toThrow("startup rejected");
    expect(manager.listAgents()).toEqual([]);
  });

  it("a background async rejection before child-session creation retains its accepted ID", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("runtime rejected"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.session).toBeUndefined();
    expect(record.outcome).toEqual(expect.objectContaining({
      agentId: id,
      category: "startup",
      recovery: "start_fresh_after_correction",
      freshSpawn: "allowed_after_correction",
    }));
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    // resumeAgent bounds its fallback to this invocation, so a failed empty
    // resume yields text "" — never the prior turn's answer (#144 root-fix).
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe(""); // no stale prior answer
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress"); // salvageable, this-run text
  });
});
