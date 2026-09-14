/**
 * #242 — `runAgent` calls `session.bindExtensions()` so `session_start` fires and
 * extensions can set up per-session state, but nothing ever closed that lifecycle:
 * both eviction (`removeRecord`) and quit (`dispose`) called `session.dispose()`,
 * which in pi only calls `ExtensionRunner.invalidate()` — it does NOT emit
 * `session_shutdown`. So anything an extension armed in `session_start` (timers, fs
 * watchers, sockets) leaked once per spawn, and its next tick threw `assertActive()`
 * from a bare `Timeout._onTimeout` — an uncaughtException that killed interactive pi.
 *
 * pi emits the event itself in `AgentSessionRuntime.dispose()` before disposing; these
 * tests pin that we do the same, that quit actually waits for the handlers, and that a
 * hung handler can't strand the user at a dead terminal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { runAgent } from "../src/agent-runner.js";
import { pruneWorktrees } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/** A child session as `runAgent` leaves it: extensions bound, so a runner with handlers. */
function boundSession(emit: (...args: any[]) => any = vi.fn(async () => {})) {
  return {
    dispose: vi.fn(),
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(emit),
    },
  } as any;
}

/** Spawn one background agent that resolves with `session`, and wait for it to complete. */
async function spawnCompleted(manager: AgentManager, session: any) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session,
    aborted: false,
    steered: false,
  } as any);
  const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
    description: "test",
    isBackground: true,
  });
  await manager.getRecord(id)!.promise;
  return id;
}

describe("child session shutdown (#242)", () => {
  let manager: AgentManager;

  afterEach(async () => {
    await manager?.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("emits session_shutdown before disposing an evicted session", async () => {
    manager = new AgentManager();
    const session = boundSession();
    await spawnCompleted(manager, session);

    manager.clearCompleted();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalled());

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: "session_shutdown",
      reason: "quit",
    });
    // Order is the whole point: after `dispose()` the runner is invalidated and
    // every `ctx` getter throws, so a handler emitted afterwards is useless.
    expect(session.extensionRunner.emit.mock.invocationCallOrder[0])
      .toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });

  it("quit waits for the child's shutdown handlers to finish", async () => {
    manager = new AgentManager();
    let releaseHandler!: () => void;
    const session = boundSession(() => new Promise<void>(r => { releaseHandler = r; }));
    await spawnCompleted(manager, session);

    const disposed = manager.dispose();
    let settled = false;
    void disposed.then(() => { settled = true; });
    // Several microtask turns: enough for a fire-and-forget implementation to have
    // resolved, not enough for a correctly awaited one.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(settled).toBe(false);
    expect(session.dispose).not.toHaveBeenCalled();

    releaseHandler();
    await disposed;
    expect(settled).toBe(true);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("quit is not hostage to a handler that never resolves", async () => {
    manager = new AgentManager();
    const session = boundSession(() => new Promise<void>(() => {}));
    await spawnCompleted(manager, session);

    vi.useFakeTimers();
    // `pi` is what reaches `pruneWorktrees` now that it shells out through
    // `pi.exec`; without it dispose skips the prune and proves nothing here.
    const disposed = manager.dispose(mockPi);
    // Past the internal ceiling. Without it the TUI is already torn down and the
    // user is left at a dead terminal with only Ctrl-C.
    await vi.advanceTimersByTimeAsync(5_000);
    await disposed;

    expect(session.dispose).toHaveBeenCalledOnce();
    // Teardown continues past the timeout rather than unwinding.
    expect(pruneWorktrees).toHaveBeenCalled();
  });

  it("skips the emit when no extension handles session_shutdown", async () => {
    manager = new AgentManager();
    const session = boundSession();
    session.extensionRunner.hasHandlers = vi.fn(() => false);
    await spawnCompleted(manager, session);

    manager.clearCompleted();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalled());

    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
  });

  it("degrades on a stubbed session instead of throwing", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      manager = new AgentManager();
      // No extensionRunner at all — an older pi, or a partial `onSessionCreated` stub.
      const noRunner = { dispose: vi.fn() } as any;
      await spawnCompleted(manager, noRunner);
      manager.clearCompleted();
      await vi.waitFor(() => expect(noRunner.dispose).toHaveBeenCalled());

      // Nothing at all — not even dispose.
      const empty = {} as any;
      await spawnCompleted(manager, empty);
      manager.clearCompleted();
      await expect(manager.dispose()).resolves.toBeUndefined();

      await new Promise(r => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
