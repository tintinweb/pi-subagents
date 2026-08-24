// sendToBackground — handing a LIVE blocking run to the background without
// restarting it (the `b` key in the conversation viewer).
//
// The invariant under test is that nothing about the run changes except who is
// waiting for it: same session, same promise, same abort controller, same
// in-flight turn. What DOES change is accounting — the run stops being charged
// to whatever pool a blocking spawn occupies and starts being charged to the
// background one — and ownership: the tool call that armed the parent-abort
// listeners no longer owns the agent, so its Esc must not reach it.
//
// The dangerous failures here are hangs and counter leaks, not wrong text. A
// waiter that never resolves blocks a tool `execute` forever (pi has no
// tool-execution timeout), and a slot released twice or never silently lifts or
// permanently lowers a concurrency limit. Both are asserted directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() }) as any;

/** Runs that settle only when their returned resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, (aborted?: boolean) => void>();
  const sessions = new Map<string, any>();
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any, options: any) =>
    new Promise<any>(resolve => {
      const session = mockSession();
      sessions.set(prompt as string, session);
      options.onSessionCreated?.(session);
      resolvers.set(prompt as string, (aborted = false) => resolve({
        responseText: `${prompt}-result`,
        session,
        aborted,
        steered: false,
      }));
    }),
  );
  return { resolvers, sessions };
}

/** Let queued microtasks (gate resolution, settle handlers) run. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const fg = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawnAndWait(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    ...options,
  });

const bg = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    isBackground: true,
    ...options,
  });

const recordFor = (manager: AgentManager, prompt: string) =>
  manager.listAgents().find(a => a.description === prompt)!;

describe("AgentManager.sendToBackground", () => {
  let manager: AgentManager;
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
    vi.mocked(resumeAgent).mockClear();
    onComplete = vi.fn();
  });

  afterEach(async () => {
    await manager?.dispose();
  });

  it("returns the blocked caller while the same run keeps going", async () => {
    const { resolvers } = controllableRuns();
    manager = new AgentManager(onComplete);

    let settled = false;
    const waiting = fg(manager, "live").then(r => { settled = true; return r; });
    await flush();

    const record = recordFor(manager, "live");
    const { promise, session, abortController } = record;

    expect(settled).toBe(false);
    expect(manager.sendToBackground(record.id)).toBe(true);

    const { record: returned } = await waiting;
    expect(settled).toBe(true);
    // Nothing about the RUN changed — only who is waiting on it.
    expect(returned).toBe(record);
    expect(record.status).toBe("running");
    expect(record.promise).toBe(promise);
    expect(record.session).toBe(session);
    expect(record.abortController).toBe(abortController);
    expect(abortController?.signal.aborted).toBe(false);
    // ...and the record now describes a background agent.
    expect(record.isBackground).toBe(true);
    expect(record.blocking).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    resolvers.get("live")!();
    await flush();
    expect(record.status).toBe("completed");
    expect(record.result).toBe("live-result");
    // resultConsumed false = the completion notification is NOT suppressed, so
    // the handed-off run reports like any other background agent.
    expect(record.resultConsumed).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("takes the parent's Esc off a run it no longer owns", async () => {
    controllableRuns();
    manager = new AgentManager(onComplete);
    const parent = new AbortController();

    const waiting = fg(manager, "live", { signal: parent.signal });
    await flush();
    const record = recordFor(manager, "live");

    expect(manager.sendToBackground(record.id)).toBe(true);
    await waiting;

    parent.abort();
    expect(record.status).toBe("running");
    expect(record.abortController?.signal.aborted).toBe(false);
  });

  it("also takes off the listener armed while it was QUEUED", async () => {
    // A blocking spawn that waited for a foreground slot carries TWO parent
    // listeners: one armed at enqueue, one armed at start. Releasing only the
    // second leaves the caller's Esc able to kill a handed-off run.
    const { resolvers } = controllableRuns();
    manager = new AgentManager(onComplete);
    manager.setMaxConcurrentForeground(1);
    const parent = new AbortController();

    const first = fg(manager, "holder");
    await flush();
    const queued = fg(manager, "queued", { signal: parent.signal });
    await flush();
    expect(recordFor(manager, "queued").status).toBe("queued");

    resolvers.get("holder")!();
    await first;
    await flush();

    const record = recordFor(manager, "queued");
    expect(record.status).toBe("running");
    expect(manager.sendToBackground(record.id)).toBe(true);
    await queued;

    parent.abort();
    expect(record.status).toBe("running");
    expect(record.abortController?.signal.aborted).toBe(false);
  });

  it("leaves a parent Esc BEFORE the handoff as a normal foreground stop", async () => {
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) =>
      new Promise<any>(resolve => {
        options.onSessionCreated?.(mockSession());
        options.signal.addEventListener("abort", () => resolve({
          responseText: "partial", session: mockSession(), aborted: true, steered: false,
        }));
      }),
    );
    manager = new AgentManager(onComplete);
    const parent = new AbortController();

    const waiting = fg(manager, "stopped", { signal: parent.signal });
    await flush();
    const record = recordFor(manager, "stopped");

    parent.abort();
    expect(manager.sendToBackground(record.id)).toBe(false);

    await waiting;
    expect(record.status).toBe("stopped");
    expect(record.isBackground).toBe(false);
    // Inline surface consumed the result, so the callback skips notifying.
    expect(record.resultConsumed).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("is single-use", async () => {
    controllableRuns();
    manager = new AgentManager(onComplete);
    const waiting = fg(manager, "live");
    await flush();
    const record = recordFor(manager, "live");

    expect(manager.sendToBackground(record.id)).toBe(true);
    expect(manager.sendToBackground(record.id)).toBe(false);
    await waiting;
    expect(manager.sendToBackground(record.id)).toBe(false);
  });

  it("refuses a foreground RESUME, which has no inline waiter to release", async () => {
    // The regression that makes eligibility hinge on a registered waiter rather
    // than on `isBackground === false`. A resumed foreground agent is "running"
    // with `isBackground: false`, but resume() awaits inline WITHOUT registering
    // a waiter and settles WITHOUT releasing a pool slot — so handing it off
    // would leak a background slot for the life of the process and report a
    // handoff that never happened.
    const { resolvers } = controllableRuns();
    manager = new AgentManager(onComplete);

    const waiting = fg(manager, "reusable");
    await flush();
    const record = recordFor(manager, "reusable");
    resolvers.get("reusable")!();
    await waiting;
    expect(record.status).toBe("completed");

    let finishResume!: () => void;
    vi.mocked(resumeAgent).mockImplementation(() =>
      new Promise<any>(resolve => { finishResume = () => resolve({ text: "resumed" }); }),
    );
    const resuming = manager.resume(record.id, "keep going");
    await flush();

    expect(record.status).toBe("running");
    expect(record.isBackground).toBe(false);
    expect(manager.sendToBackground(record.id)).toBe(false);

    finishResume();
    await resuming;

    // The background pool is untouched, so a background spawn still starts.
    manager.setMaxConcurrent(1);
    bg(manager, "after");
    await flush();
    expect(recordFor(manager, "after").status).toBe("running");
  });

  it("refuses a nested child and a detached non-blocking spawn", async () => {
    controllableRuns();
    manager = new AgentManager(onComplete);

    const parentWait = fg(manager, "owner");
    await flush();
    const owner = recordFor(manager, "owner");

    // Nested children report only through their owner — never to the session.
    manager.spawn(mockPi, mockCtx, "general-purpose", "child", {
      description: "child",
      isBackground: false,
      parentAgentId: owner.id,
    });
    await flush();
    expect(manager.sendToBackground(recordFor(manager, "child").id)).toBe(false);

    // Detached `isBackground: false` (RPC / @handle / registry): nobody is
    // blocked on it, so there is nothing to hand back.
    manager.spawn(mockPi, mockCtx, "general-purpose", "detached", {
      description: "detached",
      isBackground: false,
    });
    await flush();
    const detached = recordFor(manager, "detached");
    expect(detached.status).toBe("running");
    expect(manager.sendToBackground(detached.id)).toBe(false);

    expect(manager.sendToBackground("no-such-agent")).toBe(false);
    expect(manager.sendToBackground(owner.id)).toBe(true);
    await parentWait;
  });

  it("moves the run from the foreground pool to the background pool", async () => {
    const { resolvers } = controllableRuns();
    manager = new AgentManager(onComplete, 1);
    manager.setMaxConcurrentForeground(1);

    const handedOff = fg(manager, "handoff");
    await flush();
    const record = recordFor(manager, "handoff");

    // Both pools are now full: this run holds the only foreground slot, and a
    // background spawn behind it must wait for the only background slot.
    const blockedFg = fg(manager, "next-blocking");
    bg(manager, "next-bg");
    await flush();
    expect(recordFor(manager, "next-blocking").status).toBe("queued");
    expect(recordFor(manager, "next-bg").status).toBe("running");
    const laterBg = bg(manager, "later-bg");
    await flush();
    expect(manager.getRecord(laterBg)?.status).toBe("queued");

    expect(manager.sendToBackground(record.id)).toBe(true);
    await handedOff;
    await flush();

    // Foreground slot released — the queued blocking spawn drains immediately.
    expect(recordFor(manager, "next-blocking").status).toBe("running");
    // ...and a background slot taken, so `later-bg` still cannot start even
    // once the background agent that was running finishes.
    resolvers.get("next-bg")!();
    await flush();
    expect(manager.getRecord(laterBg)?.status).toBe("queued");

    // Only when the handed-off run itself completes does that slot come back.
    resolvers.get("handoff")!();
    await flush();
    expect(manager.getRecord(laterBg)?.status).toBe("running");

    resolvers.get("next-blocking")!();
    await blockedFg;
  });

  it("balances the counters when the run settles during the handoff", async () => {
    // The run resolves, then the handoff lands before the settle handler does.
    // Releasing what was never re-charged (or re-charging what was released)
    // shows up as a stuck queue on the very next spawn.
    const { resolvers } = controllableRuns();
    manager = new AgentManager(onComplete, 1);

    const waiting = fg(manager, "racing");
    await flush();
    const record = recordFor(manager, "racing");

    resolvers.get("racing")!();               // resolved, settle handler pending
    expect(manager.sendToBackground(record.id)).toBe(true);
    await waiting;
    await flush();

    expect(record.status).toBe("completed");
    expect(onComplete).toHaveBeenCalledTimes(1);

    // The background pool (limit 1) is free again — proof the slot taken by the
    // handoff was released exactly once.
    bg(manager, "after");
    await flush();
    expect(recordFor(manager, "after").status).toBe("running");
  });

  it("releases a caller blocked on a wedged run when the manager is disposed", async () => {
    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.(mockSession());
      return new Promise(() => {});
    });
    manager = new AgentManager(onComplete);

    let settled = false;
    const waiting = fg(manager, "wedged").then(r => { settled = true; return r; });
    await flush();
    expect(settled).toBe(false);

    await manager.dispose();
    await waiting;
    expect(settled).toBe(true);
  });
});
