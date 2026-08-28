// maxConcurrentForeground (#253) — a second, independent concurrency pool for
// agents a caller is blocking on inline (`spawnAndWait`).
//
// pi dispatches a message's tool calls through `Promise.all`, so N blocking
// `Agent` calls in one message have always started at once. This pool bounds
// that. It is OFF by default, and the first test in this file is what keeps it
// off: it fails the moment the default path grows an await, a counter or a
// queue entry.
//
// The hangs are the dangerous failures here, not the assertion failures: a
// queued record has no promise to await, and pi has no tool-execution timeout
// anywhere, so a release() that never fires waits forever. Every test that
// exercises a path out of the queue therefore asserts the waiter RESOLVES.

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

import { runAgent } from "../src/agent-runner.js";
import { createWorktree } from "../src/worktree.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() }) as any;

/** Runs that settle only when their returned resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  // History, not just the implementation: these tests assert on call COUNTS,
  // and vitest shares the module mock across the file.
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
    new Promise<any>(resolve => {
      resolvers.set(prompt as string, () => resolve({
        responseText: `${prompt}-result`,
        session: mockSession(),
        aborted: false,
        steered: false,
      }));
    }),
  );
  return resolvers;
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

/** The record a spawnAndWait created, before it has necessarily started. */
const recordFor = (manager: AgentManager, prompt: string) =>
  manager.listAgents().find(a => a.description === prompt)!;

describe("maxConcurrentForeground", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockClear();
  });

  afterEach(() => {
    manager?.dispose();
    vi.mocked(createWorktree).mockReset();
  });

  // The governing constraint: a user who never sets this must see exactly the
  // behaviour that shipped before it existed.
  it("is unlimited by default, and the default path stays synchronous", () => {
    controllableRuns();
    manager = new AgentManager();

    expect(manager.getMaxConcurrentForeground()).toBe(0);

    void fg(manager, "a");
    void fg(manager, "b");
    void fg(manager, "c");

    // Synchronously — not after a flush. A gate, a counter check that awaits,
    // or a queue entry would all defer at least one of these. (The `> 0` guard
    // inside poolFor is deliberately NOT pinned here: it is a belt-and-braces
    // optimisation with no observable effect, since an unlimited pool always
    // reports room anyway.)
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const p of ["a", "b", "c"]) expect(recordFor(manager, p).status).toBe("running");
  });

  it("queues blocking spawns past the limit and starts them as slots free, in order", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    const first = fg(manager, "a");
    const second = fg(manager, "b");
    const third = fg(manager, "c");

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(recordFor(manager, "b").status).toBe("queued");
    expect(recordFor(manager, "c").status).toBe("queued");

    resolvers.get("a")!();
    expect(await first).toMatchObject({ record: { status: "completed", result: "a-result" } });

    // FIFO: "b" was queued first, so "b" runs — not "c".
    expect(recordFor(manager, "b").status).toBe("running");
    expect(recordFor(manager, "c").status).toBe("queued");

    resolvers.get("b")!();
    expect(await second).toMatchObject({ record: { result: "b-result" } });
    resolvers.get("c")!();
    expect(await third).toMatchObject({ record: { result: "c-result" } });
  });

  // The deadlock guard. A nested child's parent is blocked AWAITING it, so
  // queueing the child behind its own parent can never make progress. Remove
  // the parentAgentId clause from occupiesForegroundSlot and this test hangs.
  it("never queues a nested child, however full the pool is", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "parent");
    expect(recordFor(manager, "parent").status).toBe("running");

    void fg(manager, "child", { parentAgentId: recordFor(manager, "parent").id, depth: 2 });

    expect(recordFor(manager, "child").status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  // A workflow's children go out through `spawnAndWait`, so they are `blocking`
  // too — but the run already caps how many of its agents are in flight, and it
  // is that cap, not the session's, that a fan-out is meant to obey. Charge them
  // here as well and `maxConcurrentForeground: 1` serializes every workflow on
  // the machine, one agent at a time, however wide the script asked to fan out.
  // Same exemption, and the same `isTopLevelAgent` test, as the background pool.
  it("never queues a workflow's children, which the run already bounds", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "wf-a", { workflowId: "wf1" });
    void fg(manager, "wf-b", { workflowId: "wf1" });
    void fg(manager, "wf-c", { workflowId: "wf1" });

    expect(recordFor(manager, "wf-a").status).toBe("running");
    expect(recordFor(manager, "wf-b").status).toBe("running");
    expect(recordFor(manager, "wf-c").status).toBe("running");
    expect(runAgent).toHaveBeenCalledTimes(3);

    // The session's own blocking work is still bounded — the exemption is for
    // the workflow's children, not a hole in the limit.
    void fg(manager, "mine-1");
    void fg(manager, "mine-2");
    expect(recordFor(manager, "mine-1").status).toBe("running");
    expect(recordFor(manager, "mine-2").status).toBe("queued");
  });

  // The requirement from #253: the two pools must not be able to starve each
  // other. The whole reason foreground was exempt from maxConcurrent is that a
  // full background pool must never block the main session's blocking work.
  it("is independent of the background pool, in both directions", async () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1); // maxConcurrent = 1
    manager.setMaxConcurrentForeground(1);

    bg(manager, "bg1");
    bg(manager, "bg2");
    expect(recordFor(manager, "bg1").status).toBe("running");
    expect(recordFor(manager, "bg2").status).toBe("queued"); // background pool full

    // A blocking spawn is not charged to the saturated background pool.
    void fg(manager, "fg1");
    expect(recordFor(manager, "fg1").status).toBe("running");

    // ...and the now-saturated foreground pool does not queue anything else.
    void fg(manager, "fg2");
    expect(recordFor(manager, "fg2").status).toBe("queued");
    expect(recordFor(manager, "bg2").status).toBe("queued"); // still only bg1's slot
  });

  // Detached spawns block nobody, so bounding them buys nothing — and would
  // park a record with no one waiting to release it. README documents RPC
  // spawns as starting immediately whatever isBackground says.
  it("does not queue a detached spawn, even one flagged isBackground: false", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "holder");
    manager.spawn(mockPi, mockCtx, "general-purpose", "rpc", {
      description: "rpc",
      isBackground: false,
    });

    expect(recordFor(manager, "rpc").status).toBe("running");
  });

  it("starts a bypassQueue spawn at the limit, and still counts its slot", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "holder");
    void fg(manager, "scheduled", { bypassQueue: true });
    expect(recordFor(manager, "scheduled").status).toBe("running");

    // Counted, not invisible: the pool is now over its limit, so the next
    // ordinary blocking spawn queues.
    void fg(manager, "next");
    expect(recordFor(manager, "next").status).toBe("queued");
  });

  describe("cancellation", () => {
    // A rejection here would escape into the caller's tool `execute` and reject
    // pi's Promise.all for the entire tool batch, killing unrelated tool calls.
    it("resolves — never rejects — when a queued agent is aborted", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const queued = fg(manager, "victim");
      const victimId = recordFor(manager, "victim").id;

      expect(manager.abort(victimId)).toBe(true);

      const { record } = await queued;
      expect(record.status).toBe("stopped");
      expect(record.promise).toBeUndefined();
      expect(record.completedAt).toBeDefined();

      // Freeing the slot must not resurrect it.
      resolvers.get("holder")!();
      await flush();
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it("releases a queued agent when the caller's signal aborts (Esc)", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const controller = new AbortController();
      const queued = fg(manager, "victim", { signal: controller.signal });
      expect(recordFor(manager, "victim").status).toBe("queued");

      controller.abort();
      expect((await queued).record.status).toBe("stopped");
    });

    // addEventListener never fires on an already-aborted signal, so enqueueing
    // here would wait forever — pi has no tool-execution timeout to bail out.
    it("never enqueues a spawn whose signal is already aborted", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const controller = new AbortController();
      controller.abort();

      const { record } = await fg(manager, "victim", { signal: controller.signal });
      expect(record.status).toBe("stopped");
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    // The one behaviour change that is NOT gated on the setting. Before the
    // pool, an already-aborted signal was still wired with addEventListener —
    // which never fires — so the agent ran to completion beyond the reach of
    // Esc or /agents. A queued spawn made that reachable often enough to fix;
    // this pins it for the UNQUEUED path too, with the pool off.
    it("stops an immediate spawn whose signal is already aborted, pool off", async () => {
      controllableRuns();
      manager = new AgentManager();
      expect(manager.getMaxConcurrentForeground()).toBe(0);

      const controller = new AbortController();
      controller.abort();
      void fg(manager, "doomed", { signal: controller.signal });

      // A running attempt (the slot was charged) passes through "stopping";
      // the never-settling mock keeps it there until the grace expiry.
      expect(recordFor(manager, "doomed").status).toBe("stopping");
      expect(recordFor(manager, "doomed").abortController?.signal.aborted).toBe(true);
    });

    it("releases queued waiters on abortAll()", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const queued = fg(manager, "victim");

      manager.abortAll();
      expect((await queued).record.status).toBe("stopped");
    });

    // Without this, `afterEach(() => manager.dispose())` turns any failing test
    // in this file into a hung suite instead of a red one.
    it("releases queued waiters on dispose()", async () => {
      controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      void fg(manager, "holder");
      const queued = fg(manager, "victim");

      await manager.dispose();
      await expect(queued).resolves.toBeDefined();
    });
  });

  describe("slot accounting", () => {
    it("frees the slot when a foreground agent fails", async () => {
      const rejectors = new Map<string, (e: unknown) => void>();
      vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
        new Promise<any>((_resolve, reject) => { rejectors.set(prompt as string, reject); }),
      );
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      const first = fg(manager, "a");
      void fg(manager, "b");
      expect(recordFor(manager, "b").status).toBe("queued");

      rejectors.get("a")!(new Error("boom"));
      expect((await first).record.status).toBe("error");
      expect(recordFor(manager, "b").status).toBe("running");
    });

    // Decrementing in abort() as well as in the settle path is a double-free
    // that permanently lifts the limit. Three at a limit of one catches it: a
    // double-free would start the third immediately.
    it("frees the slot exactly once when a running agent is aborted", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      const first = fg(manager, "a");
      void fg(manager, "b");
      void fg(manager, "c");

      manager.abort(recordFor(manager, "a").id);
      resolvers.get("a")!(); // the aborted run still settles normally
      await first;

      expect(recordFor(manager, "b").status).toBe("running");
      expect(recordFor(manager, "c").status).toBe("queued");
    });
  });

  // #179: a strict worktree-isolation failure throws out of spawnAndWait on the
  // immediate path. Queue pressure must not silently turn that into a result.
  it("rethrows a drain-time startup failure, and keeps draining", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    vi.mocked(createWorktree).mockReturnValue(undefined as any);

    const first = fg(manager, "holder");
    const doomed = fg(manager, "doomed", { isolation: "worktree" });
    const after = fg(manager, "after");
    expect(recordFor(manager, "doomed").status).toBe("queued");

    resolvers.get("holder")!();
    await first;

    await expect(doomed).rejects.toThrow(/worktree/i);
    expect(recordFor(manager, "doomed").status).toBe("error");
    // The throw above IS the caller's report. Left unconsumed, the record would
    // also nudge the session — the same failure delivered twice, and only for
    // spawns unlucky enough to have queued.
    expect(recordFor(manager, "doomed").resultConsumed).toBe(true);

    // The failure freed nothing, but it also blocked nothing.
    expect(recordFor(manager, "after").status).toBe("running");
    resolvers.get("after")!();
    await after;
  });

  it("drains immediately when the limit is raised or cleared", async () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "a");
    void fg(manager, "b");
    void fg(manager, "c");
    expect(runAgent).toHaveBeenCalledTimes(1);

    manager.setMaxConcurrentForeground(0); // back to unlimited
    expect(runAgent).toHaveBeenCalledTimes(3);
  });

  // The acquire/release pair must agree even though the limit between them is
  // user-editable at runtime (`/agents → Settings`, and applySettings on load).
  // Recomputing the pool at settle time made the release disagree with the
  // acquire in both directions.
  describe("a limit changed mid-run", () => {
    it("releases the slot a cleared limit no longer describes", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();
      manager.setMaxConcurrentForeground(1);

      const a = fg(manager, "a");
      manager.setMaxConcurrentForeground(0); // unlimited, while "a" holds a slot
      resolvers.get("a")!();
      await a;
      await flush();

      // The slot must have come back. If it leaked, nothing can ever free it
      // again and every later blocking spawn queues forever.
      manager.setMaxConcurrentForeground(1);
      void fg(manager, "b");
      await flush();
      expect(recordFor(manager, "b").status).toBe("running");
    });

    it("does not release a slot a newly-set limit was never charged", async () => {
      const resolvers = controllableRuns();
      manager = new AgentManager();

      const a = fg(manager, "a"); // unlimited — takes no slot
      manager.setMaxConcurrentForeground(1);
      resolvers.get("a")!();
      await a;
      await flush();

      // The counter must still be 0, not -1: a -1 silently lifts the limit by one.
      void fg(manager, "b");
      void fg(manager, "c");
      await flush();
      expect(recordFor(manager, "b").status).toBe("running");
      expect(recordFor(manager, "c").status).toBe("queued");
    });
  });

  it("clamps a negative limit to unlimited rather than to 1", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(-3);
    expect(manager.getMaxConcurrentForeground()).toBe(0);
  });

  it("counts a queued foreground agent as active, and waitForAll waits it out", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "a");
    void fg(manager, "b");
    expect(manager.hasRunning()).toBe(true);

    const all = manager.waitForAll();
    resolvers.get("a")!();
    await flush();
    resolvers.get("b")!();
    await all;

    expect(recordFor(manager, "b").status).toBe("completed");
  });

  // spawnAndWait used to park this callback on the manager and restore it in a
  // `finally` right after spawn() — which only worked because spawn() reached
  // startAgent() synchronously. A deferred start would fire it into whatever
  // hook happened to be installed at drain time, or into none at all, silently
  // costing the caller its output transcript.
  it("fires each caller's onSpawned hook when its own deferred spawn starts", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    const firstHook = vi.fn();
    const secondHook = vi.fn();

    const first = manager.spawnAndWait(
      mockPi, mockCtx, "general-purpose", "a", { description: "a" }, firstHook,
    );
    const second = manager.spawnAndWait(
      mockPi, mockCtx, "general-purpose", "b", { description: "b" }, secondHook,
    );

    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).not.toHaveBeenCalled();

    resolvers.get("a")!();
    await first;

    expect(secondHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledWith(recordFor(manager, "b").id);
    expect(firstHook).toHaveBeenCalledTimes(1);

    resolvers.get("b")!();
    await second;
  });

  it("reports how many are ahead when a spawn is queued", () => {
    controllableRuns();
    manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);

    const onQueued = vi.fn();
    void fg(manager, "holder");
    void fg(manager, "b", { onQueued });
    void fg(manager, "c", { onQueued });

    expect(onQueued).toHaveBeenNthCalledWith(1, recordFor(manager, "b").id, 0);
    expect(onQueued).toHaveBeenNthCalledWith(2, recordFor(manager, "c").id, 1);
  });

  // One queue serves both pools, so a saturated foreground pool sitting at the
  // head must not stall background agents behind it.
  it("does not let a full foreground queue head-of-line-block the background pool", async () => {
    const resolvers = controllableRuns();
    manager = new AgentManager(undefined, 1);
    manager.setMaxConcurrentForeground(1);

    void fg(manager, "fg-holder");
    void fg(manager, "fg-queued");
    bg(manager, "bg-holder");
    bg(manager, "bg-queued");

    expect(recordFor(manager, "fg-queued").status).toBe("queued");
    expect(recordFor(manager, "bg-queued").status).toBe("queued");

    // Free a BACKGROUND slot while the foreground queue is still stuck.
    resolvers.get("bg-holder")!();
    await flush();

    expect(recordFor(manager, "bg-queued").status).toBe("running");
    expect(recordFor(manager, "fg-queued").status).toBe("queued");
  });
});
