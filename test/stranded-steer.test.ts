/**
 * A steer that lands after the run's last steering poll stays in pi's queue of
 * a session that has stopped looping. Nothing drains it, so the message is lost.
 * Claude Code resumes such an agent with the stranded message as its prompt
 * (`agentStrandedMessages`); the manager does the same at settle time.
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
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { cleanupWorktree, createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/** A session whose pi queue keeps whatever was steered into it, like the real one once the loop has exited. */
function queueingSession() {
  const queued: string[] = [];
  return {
    queued,
    session: {
      dispose: vi.fn(),
      steer: vi.fn(async (text: string) => { queued.push(text); }),
      clearQueue: vi.fn(() => ({ steering: queued.splice(0), followUp: [] })),
    } as any,
  };
}

describe("stranded steers", () => {
  let manager: AgentManager;
  afterEach(() => { manager?.dispose(); vi.mocked(resumeAgent).mockReset(); vi.mocked(runAgent).mockReset(); });

  it("resumes the agent with a steer that landed after its last poll", async () => {
    const { session, queued } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));

    // The run has polled for the last time; this steer goes into a dead queue.
    expect(manager.steer(id, "late news")).toBe(true);
    finish();
    await manager.getRecord(id)!.promise;

    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
    expect(queued).toEqual([]);
  });

  it("joins several stranded steers into one resume prompt, in order", async () => {
    const { session } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    manager.steer(id, "one");
    manager.steer(id, "two");
    finish();

    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("one\n\ntwo");
  });

  it("catches a steer pi queued only after the run had settled", async () => {
    // pi runs its input handlers before queueing, so the enqueue can land after settle.
    const { session, queued } = queueingSession();
    let enqueue!: () => void;
    session.steer = vi.fn((text: string) => new Promise<void>(resolve => {
      enqueue = () => { queued.push(text); resolve(); };
    }));
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    manager.steer(id, "late news");
    finish();
    await manager.getRecord(id)!.promise;
    expect(resumeAgent).not.toHaveBeenCalled();

    enqueue();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("does not resume an agent the user stopped", async () => {
    const { session, queued } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    manager.steer(id, "late news");
    manager.abort(id);
    finish();
    await manager.getRecord(id)!.promise;
    await new Promise(r => setTimeout(r, 10));

    expect(resumeAgent).not.toHaveBeenCalled();
    // Dropped, not left to ride along with whatever resumes the agent next.
    expect(queued).toEqual([]);
  });

  it("does not resume an agent that hit its turn limit, not even with the runner's own wrap-up steer", async () => {
    // observeRun steers the wrap-up at the limit's turn_end; pi can queue it
    // after that turn's poll, and a final text-only turn then ends the loop.
    const { session, queued } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
      return { responseText: "final answer", session, aborted: false, steered: true };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await manager.getRecord(id)!.promise;
    await new Promise(r => setTimeout(r, 10));

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.status).toBe("steered");
    expect(queued).toEqual([]);
  });

  it("a foreground spawn keeps its result; the caller wakes the agent once it has read it", async () => {
    const { session } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      // Lands after the run's last poll, while the caller still waits inline.
      await session.steer("late news");
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    manager = new AgentManager();
    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "go", { description: "d" });
    expect(record.result).toBe("first");
    expect(record.status).toBe("completed");
    expect(resumeAgent).not.toHaveBeenCalled();

    manager.releaseInline(record.id);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("a foreground resume keeps its result; the caller wakes the agent once it has read it", async () => {
    const { session } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      return { responseText: "first", session, aborted: false, steered: false };
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await manager.getRecord(id)!.promise;

    vi.mocked(resumeAgent).mockImplementationOnce(async () => {
      await session.steer("late news");
      return { text: "second", aborted: false, steered: false };
    }).mockResolvedValue({ text: "third", aborted: false, steered: false });
    const record = await manager.resume(id, "again");
    expect(record!.result).toBe("second");
    expect(record!.status).toBe("completed");
    expect(resumeAgent).toHaveBeenCalledTimes(1);

    manager.releaseInline(id);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(resumeAgent).mock.calls[1][1]).toBe("late news");
  });

  it("a steer queued after a foreground settle waits for the caller to read the result", async () => {
    // Claude Code defers a stranded resume while the agent is finalizing.
    const { session, queued } = queueingSession();
    let enqueue!: () => void;
    session.steer = vi.fn((text: string) => new Promise<void>(resolve => {
      enqueue = () => { queued.push(text); resolve(); };
    }));
    let id!: string;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await Promise.resolve(); // onSpawned runs after the run has started
      expect(manager.steer(id, "late news")).toBe(true);
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    // pi queues the steer just after the run settles, before the caller resumes.
    manager = new AgentManager(() => enqueue());
    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "go", { description: "d" },
      spawnedId => { id = spawnedId; });
    expect(record.result).toBe("first");
    expect(resumeAgent).not.toHaveBeenCalled();

    manager.releaseInline(record.id);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("a steer queued after a foreground resume settles waits for the caller too", async () => {
    const { session, queued } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      return { responseText: "first", session, aborted: false, steered: false };
    });
    let enqueue: (() => void) | undefined;
    manager = new AgentManager(() => enqueue?.());
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await manager.getRecord(id)!.promise;

    session.steer = vi.fn((text: string) => new Promise<void>(resolve => {
      enqueue = () => { queued.push(text); resolve(); };
    }));
    vi.mocked(resumeAgent).mockImplementationOnce(async () => {
      expect(manager.steer(id, "late news")).toBe(true);
      return { text: "second", aborted: false, steered: false };
    }).mockResolvedValue({ text: "third", aborted: false, steered: false });
    // pi queues the steer just after the resume settles, before the caller reads it.
    const record = await manager.resume(id, "again").finally(() => enqueue?.());
    expect(record!.result).toBe("second");
    await new Promise(r => setTimeout(r, 0));
    expect(resumeAgent).toHaveBeenCalledTimes(1);

    manager.releaseInline(id);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(resumeAgent).mock.calls[1][1]).toBe("late news");
  });

  it("a foreground run handed to the background is woken at its own settle", async () => {
    const { session } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    manager = new AgentManager();
    let id!: string;
    void manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "go", { description: "d" }, spawnedId => { id = spawnedId; });
    await vi.waitFor(() => expect(manager.getRecord(id)?.promise).toBeDefined());
    expect(manager.sendToBackground(id)).toBe(true);
    manager.steer(id, "late news");
    finish();

    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("leaves an agent alone when nothing is queued", async () => {
    const { session } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      return { responseText: "first", session, aborted: false, steered: false };
    });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await manager.getRecord(id)!.promise;
    await new Promise(r => setTimeout(r, 10));

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.status).toBe("completed");
  });

  it("a wake that does not happen leaves no stranded-wake mark", async () => {
    const { session } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });
    manager = new AgentManager();
    const wake = vi.fn(async () => undefined);
    manager.setWaker({ admit: () => true, wake });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    manager.steer(id, "late news");
    finish();
    await manager.getRecord(id)!.promise;
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 0));
    expect(manager.getRecord(id)!.strandedWake).toBeUndefined();
  });

  /** A background agent that settles with "late news" stranded in its queue, under `waker`. */
  async function settleWithStrandedSteer(waker: Parameters<AgentManager["setWaker"]>[0]) {
    const { session } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "first", session, aborted: false, steered: false };
    });
    manager = new AgentManager();
    manager.setWaker(waker);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    manager.steer(id, "late news");
    finish();
    await manager.getRecord(id)!.promise;
    return { id, session };
  }

  it("a wake another caller beat steers the messages into that run", async () => {
    const notWoken = vi.fn();
    const wake = vi.fn(async (record: any) => { record.status = "running"; return undefined; });
    const { id, session } = await settleWithStrandedSteer({ admit: () => true, wake, notWoken });
    await vi.waitFor(() => expect(notWoken).toHaveBeenCalledTimes(1));
    expect(notWoken).toHaveBeenCalledWith(manager.getRecord(id), ["late news"], true);
    expect(session.steer).toHaveBeenLastCalledWith("late news");
  });

  it("a wake that fails reports its messages undelivered", async () => {
    const notWoken = vi.fn();
    const wake = vi.fn(async () => { throw new Error("no session"); });
    const { id } = await settleWithStrandedSteer({ admit: () => true, wake, notWoken });
    await vi.waitFor(() => expect(notWoken).toHaveBeenCalledTimes(1));
    expect(notWoken).toHaveBeenCalledWith(manager.getRecord(id), ["late news"], false);
  });

  it("a foreground resume of a running agent is refused, leaving the live run alone", async () => {
    const { session } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      return new Promise(() => {}) as any;
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    const controller = manager.getRecord(id)!.abortController;
    expect(await manager.resume(id, "again")).toBeUndefined();
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(manager.getRecord(id)!.abortController).toBe(controller);
    expect(manager.getRecord(id)!.inlinePending).toBeFalsy();
  });

  it("a stranded wake stopped while queued leaves no stranded-wake mark", async () => {
    const target = queueingSession();
    const blocker = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated(target.session);
        await new Promise<void>(resolve => { finish = resolve; });
        return { responseText: "first", session: target.session, aborted: false, steered: false };
      })
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated(blocker.session);
        return new Promise(() => {}) as any;
      });
    manager = new AgentManager(undefined, 1);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(target.session));
    // Queued behind the target; its settle starts this one, so the wake queues.
    const next = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    manager.steer(id, "late news");
    await new Promise(r => setTimeout(r, 0));
    finish();
    await vi.waitFor(() => expect(manager.getRecord(next)!.session).toBe(blocker.session));
    await vi.waitFor(() => expect(manager.getRecord(id)!.status).toBe("queued"));
    expect(manager.getRecord(id)!.strandedWake).toBe(true);
    manager.abort(id);
    expect(manager.getRecord(id)!.strandedWake).toBeUndefined();
  });

  it("a stranded wake whose queued start fails leaves no stranded-wake mark", async () => {
    const target = queueingSession();
    const blocker = queueingSession();
    let finishTarget!: () => void;
    let finishBlocker!: () => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated(target.session);
        await new Promise<void>(resolve => { finishTarget = resolve; });
        return { responseText: "first", session: target.session, aborted: false, steered: false };
      })
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated(blocker.session);
        await new Promise<void>(resolve => { finishBlocker = resolve; });
        return { responseText: "blocked", session: blocker.session, aborted: false, steered: false };
      });
    vi.mocked(resumeAgent).mockImplementation(() => { throw new Error("cannot start"); });
    const completions: Array<{ id: string; strandedWake: boolean | undefined }> = [];
    manager = new AgentManager(r => { completions.push({ id: r.id, strandedWake: r.strandedWake }); }, 1);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(target.session));
    const next = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    manager.steer(id, "late news");
    await new Promise(r => setTimeout(r, 0));
    finishTarget();
    await vi.waitFor(() => expect(manager.getRecord(id)!.status).toBe("queued"));
    finishBlocker();
    await vi.waitFor(() => expect(manager.getRecord(id)!.status).toBe("error"));
    // Its own completion follows the earlier one; the mark is gone after it.
    expect(completions.at(-1)).toEqual({ id, strandedWake: true });
    expect(manager.getRecord(id)!.strandedWake).toBeUndefined();
    expect(manager.getRecord(next)!.status).toBe("completed");
  });

  it("hands the stranded messages of an agent that cannot be woken to the waker", async () => {
    const { session } = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finish = resolve; });
      throw new Error("provider down");
    });
    manager = new AgentManager();
    const dropped = vi.fn();
    const wake = vi.fn();
    manager.setWaker({ admit: () => true, wake, dropped });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(id)!.session).toBe(session));
    manager.steer(id, "late news");
    await new Promise(r => setTimeout(r, 0));
    finish();
    await manager.getRecord(id)!.promise;
    expect(dropped).toHaveBeenCalledWith(manager.getRecord(id), ["late news"]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("a foreground spawn that fails to start releases the record", async () => {
    vi.mocked(runAgent).mockImplementation(async () => ({ responseText: "x", session: queueingSession().session, aborted: false, steered: false }));
    manager = new AgentManager();
    vi.spyOn(manager, "awaitStartup").mockRejectedValueOnce(new Error("worktree"));
    let spawnedId: string | undefined;
    await expect(manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "go", { description: "d" }, id => { spawnedId = id; }))
      .rejects.toThrow("worktree");
    expect(manager.getRecord(spawnedId!)!.inlinePending).toBe(false);
  });

  it("a queued resume the user stops drops what was steered into it", async () => {
    const running = queueingSession();
    const target = queueingSession();
    vi.mocked(runAgent)
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated(target.session);
        return { responseText: "first", session: target.session, aborted: false, steered: false };
      })
      .mockImplementationOnce(async (_ctx, _type, _prompt, opts: any) => {
        opts.onSessionCreated(running.session);
        return new Promise(() => {}) as any;
      });
    manager = new AgentManager(undefined, 1);
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await manager.getRecord(id)!.promise;
    const blocker = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    await vi.waitFor(() => expect(manager.getRecord(blocker)!.session).toBe(running.session));

    await manager.resume(id, "again", undefined, { isBackground: true });
    expect(manager.getRecord(id)!.status).toBe("queued");
    manager.steer(id, "stale");
    await new Promise(r => setTimeout(r, 0));
    manager.abort(id);
    expect(target.queued).toEqual([]);
  });
});

describe("an agent whose worktree is still being cleaned up", () => {
  let manager: AgentManager;
  afterEach(() => {
    manager?.dispose();
    vi.mocked(resumeAgent).mockReset();
    vi.mocked(runAgent).mockReset();
    vi.mocked(createWorktree).mockReset();
    vi.mocked(cleanupWorktree).mockReset().mockImplementation(() => ({ hasChanges: false }) as any);
  });

  /** A finished run whose worktree cleanup waits for `cleaned()`. */
  function heldCleanup() {
    const { session } = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated(session);
      return { responseText: "first", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });
    vi.mocked(createWorktree).mockResolvedValue({ path: "/wt", branch: "b", baseSha: "s", workPath: "/wt" } as any);
    const held = { cleaned: () => {} };
    vi.mocked(cleanupWorktree).mockImplementation(() => new Promise(resolve => {
      held.cleaned = () => resolve({ hasChanges: true, branch: "b" });
    }) as any);
    return held;
  }

  it("is completed but busy: not resumed, not stopped, and a message waits for the settle", async () => {
    const held = heldCleanup();
    const completions: string[] = [];
    manager = new AgentManager(r => { completions.push(r.result ?? ""); });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.waitFor(() => expect(cleanupWorktree).toHaveBeenCalled());
    const record = manager.getRecord(id)!;
    // Claude Code's `finalizing`: the outcome is final, the settle is not.
    expect(record.status).toBe("completed");
    expect(record.settling).toBe(true);

    // A wake (SendMessage, Agent resume) during the cleanup await must not start a run.
    expect(await manager.resume(id, "too soon", undefined, { isBackground: true })).toBeUndefined();
    // Nor can a stop undo a run that finished.
    expect(manager.abort(id)).toBe(false);
    expect(record.status).toBe("completed");
    // A message is accepted and delivered once the settle is done.
    expect(manager.steer(id, "late news")).toBe(true);
    expect(resumeAgent).not.toHaveBeenCalled();

    held.cleaned();
    await record.promise;
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    // The first run's completion, with its branch note, then the resumed run's.
    expect(completions[0]).toContain("first");
    expect(completions[0]).toContain("Changes saved to branch `b`");
    expect(completions[1]).toBe("second");
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("in the foreground: a message waits until the caller has read the result", async () => {
    const held = heldCleanup();
    manager = new AgentManager();
    let id!: string;
    const waiting = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "go", { description: "d", isolation: "worktree" },
      spawnedId => { id = spawnedId; });
    await vi.waitFor(() => expect(cleanupWorktree).toHaveBeenCalled());
    expect(manager.steer(id, "late news")).toBe(true);

    held.cleaned();
    const { record } = await waiting;
    expect(record.result).toContain("first");
    await new Promise(r => setTimeout(r, 0));
    expect(resumeAgent).not.toHaveBeenCalled();

    manager.releaseInline(record.id);
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("only a completed run settles: a failed one refuses a message instead of dropping it later", async () => {
    const held = heldCleanup();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const { session } = queueingSession();
      opts.onSessionCreated(session);
      return { responseText: "", session, aborted: false, steered: false, failure: "provider error" };
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.waitFor(() => expect(cleanupWorktree).toHaveBeenCalled());
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.settling).toBeUndefined();
    expect(manager.steer(id, "late news")).toBe(false);
    held.cleaned();
  });

  it("stopping everything drops what was steered into a settling agent, so its settle wakes nothing", async () => {
    const held = heldCleanup();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.waitFor(() => expect(cleanupWorktree).toHaveBeenCalled());
    expect(manager.steer(id, "late news")).toBe(true);
    await new Promise(r => setTimeout(r, 0)); // pi queues the steer

    manager.abortAll();
    held.cleaned();
    await manager.getRecord(id)!.promise;
    await new Promise(r => setTimeout(r, 0));
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("is not cleared at a session boundary while it settles", async () => {
    const held = heldCleanup();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true, isolation: "worktree" });
    await vi.waitFor(() => expect(cleanupWorktree).toHaveBeenCalled());
    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeDefined();
    held.cleaned();
  });
});

describe("a settling parent's children", () => {
  let manager: AgentManager;
  afterEach(() => { manager?.dispose(); vi.mocked(runAgent).mockReset(); });

  it("are stopped, unless another agent has taken one over", async () => {
    const finishes: (() => void)[] = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const { session } = queueingSession();
      opts.onSessionCreated(session);
      await new Promise<void>(resolve => { finishes.push(resolve); });
      return { responseText: "done", session, aborted: false, steered: false };
    });
    manager = new AgentManager();
    const spawn = () => manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "d", isBackground: true });
    const parent = spawn();
    const other = spawn();
    const plain = spawn();
    const takenOver = spawn();
    await vi.waitFor(() => expect(finishes).toHaveLength(4));
    manager.getRecord(plain)!.parentAgentId = parent;
    manager.getRecord(takenOver)!.parentAgentId = parent;
    manager.getRecord(takenOver)!.handbackRecipient = other;

    finishes[0]();
    await manager.getRecord(parent)!.promise;
    expect(manager.getRecord(plain)!.status).toBe("stopped");
    expect(manager.getRecord(takenOver)!.status).toBe("running");
  });
});
