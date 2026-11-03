/**
 * When completion notifications reach the parent, through the real extension:
 * held while the parent runs and sent at its turn's end, as in Claude Code, and
 * — in `group` join mode — batched by the turn that spawned them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";
import type * as WorktreeModule from "../src/worktree.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof WorktreeModule>("../src/worktree.js");
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
    isWorktreeIsolationEnabled: vi.fn(() => true),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createWorktree } from "../src/worktree.js";
import { type BootedPi, ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let booted: BootedPi | undefined;
let hermetic: Hermetic | undefined;

afterEach(async () => {
  await booted?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(createWorktree).mockReset();
  vi.useRealTimers();
});

/** Boot the extension with a parent whose run state the test controls. */
async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false, ...settings } });
  booted = makePi();
  subagentsExtension(booted.pi);
  const parent = { running: true };
  const signal = new AbortController().signal;
  const parentCtx = ctx();
  Object.defineProperty(parentCtx, "signal", { get: () => (parent.running ? signal : undefined) });
  await booted.lifecycle.get("session_start")({ type: "session_start" }, parentCtx);
  return { ...booted, parent, parentCtx };
}

/** Runs that settle only when `settle(description)` is called. */
function controllableRuns() {
  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) =>
    new Promise<any>(resolve => {
      finishers.set(prompt, () => resolve({
        responseText: `${prompt} done`, session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false,
      }));
    }) as any,
  );
  vi.mocked(resumeAgent).mockImplementation((_s: any, prompt: string) =>
    new Promise(resolve => { finishers.set(prompt, () => resolve({ text: `${prompt} done` })); }),
  );
  return { settle: (prompt: string) => finishers.get(prompt)!() };
}

const spawn = (b: BootedPi, parentCtx: any, prompt: string, extra: Record<string, unknown> = {}) =>
  b.tools.get("Agent").execute(
    `call-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: true, ...extra },
    undefined, undefined, parentCtx,
  );

const agentIdOf = (result: any): string => /Agent ID: (\S+)/.exec(result.content[0].text)![1];

const turnEnd = (b: BootedPi, stopReason = "toolUse") =>
  b.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason } });

const sentContents = (b: BootedPi): string[] => b.pi.sendMessage.mock.calls.map((c: any[]) => c[0].content);

describe("completion delivery to a running parent", () => {
  it("holds a completion until the parent's turn ends, then steers it in", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });

  it("sends a completion that landed after the run's last turn once the run ends", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop"); // the run's final turn: nothing pending yet

    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("sends a completion that landed while the ending run was still open, once the run settles", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    turnEnd(b, "stop");
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });

    runs.settle("alpha"); // lands while a later agent_end listener still holds the run open
    await vi.advanceTimersByTimeAsync(0);
    b.parent.running = false;
    b.lifecycle.get("agent_settled")?.({ type: "agent_settled", aborted: false });
    await vi.advanceTimersByTimeAsync(200);

    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);
  });

  it("drops what is still pending when the session shuts down", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    b.parent.running = false;
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.lifecycle.get("session_shutdown")();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("delivers an aborted turn's completion once the run ends, starting a turn, as Claude Code does after Esc", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    await spawn(b, b.parentCtx, "alpha");
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    turnEnd(b, "aborted");
    // Sent now, it would land in the queue pi clears on Esc.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    b.parent.running = false;
    b.lifecycle.get("agent_end")({ type: "agent_end", messages: [] });
    await vi.advanceTimersByTimeAsync(200);
    expect(b.pi.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: expect.stringContaining("alpha done") }),
      { deliverAs: "steer", triggerTurn: true },
    );
  });
  it("drops a completion whose result another extension consumed over RPC before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const [, consume] = b.pi.events.on.mock.calls.find(([channel]: any[]) => channel === "subagents:rpc:consume");
    await consume({ requestId: "r1", agentId: id });
    turnEnd(b);

    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:rpc:consume:reply:r1", expect.objectContaining({ success: true }));
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("a completion pending while its agent is resumed", () => {
  const resume = (b: BootedPi, parentCtx: any, id: string, prompt: string, background: boolean) =>
    b.tools.get("Agent").execute(
      `call-${prompt}`,
      { prompt, description: prompt, subagent_type: "general-purpose", resume: id, run_in_background: background },
      undefined, undefined, parentCtx,
    );

  it("still reports the first run when a background resume starts before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done")]);

    runs.settle("again");
    await vi.advanceTimersByTimeAsync(0);
    turnEnd(b);
    expect(sentContents(b)).toEqual([expect.stringContaining("alpha done"), expect.stringContaining("again done")]);
  });

  it("still reports the first run, not the inline result, when a foreground resume runs before the boundary", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    const inline = resume(b, b.parentCtx, id, "again", false);
    await vi.advanceTimersByTimeAsync(0);
    runs.settle("again");
    await inline;
    turnEnd(b);

    const sent = sentContents(b);
    expect(sent).toEqual([expect.stringContaining("alpha done")]);
    expect(sent[0]).not.toContain("again done");
  });

  it("does not report a run whose result was read before a background resume", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot();
    const id = agentIdOf(await spawn(b, b.parentCtx, "alpha"));
    runs.settle("alpha");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute("read", { agent_id: id }, undefined, undefined, b.parentCtx);
    await resume(b, b.parentCtx, id, "again", true);
    turnEnd(b);

    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("`group` join mode — one notification per turn's batch", () => {
  /** A worktree copy that takes `ms`, or fails after it. */
  function worktreeAfter(ms: number, ok = true) {
    vi.mocked(createWorktree).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, ms));
      return ok ? { path: "/tmp/wt", branch: "b", baseSha: "s", workPath: "/tmp/wt" } as any : undefined;
    });
  }

  it("groups a turn's worktree spawns whose copies finish far apart", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    worktreeAfter(0);
    worktreeAfter(500);

    const calls = Promise.all([
      spawn(b, b.parentCtx, "fast-copy", { isolation: "worktree" }),
      spawn(b, b.parentCtx, "slow-copy", { isolation: "worktree" }),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    await calls;
    turnEnd(b);

    runs.settle("fast-copy");
    runs.settle("slow-copy");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("Background agent group completed: 2 agent(s) finished")]);
  });

  it("delivers a batch that finished before its turn ended, once, at that turn's end", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);
    runs.settle("one");
    runs.settle("two");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.pi.sendMessage).not.toHaveBeenCalled();

    turnEnd(b);

    // The group alone — not each member again beside it.
    expect(sentContents(b)).toEqual([expect.stringMatching(/^Background agent group completed: 2 agent\(s\) finished/)]);
  });

  it("leaves out a member whose result was consumed before the group was sent", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    const [first] = await Promise.all([spawn(b, b.parentCtx, "read-early"), spawn(b, b.parentCtx, "unread")]);
    turnEnd(b);
    runs.settle("read-early");
    runs.settle("unread");
    await vi.advanceTimersByTimeAsync(0);

    await b.tools.get("get_subagent_result").execute(
      "read", { agent_id: agentIdOf(first) }, undefined, undefined, b.parentCtx,
    );
    turnEnd(b);

    const [content] = sentContents(b);
    expect(content).toContain("unread done");
    expect(content).not.toContain("read-early done");
  });

  it("reports a turn's lone spawn as a single completion, not a group of one", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await spawn(b, b.parentCtx, "solo");
    turnEnd(b);

    runs.settle("solo");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.not.stringMatching(/^Background agent group completed/)]);
    expect(sentContents(b)[0]).toContain("solo done");
  });

  it("reports a lone spawn that finished before its turn ended as a single completion", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    await spawn(b, b.parentCtx, "solo");
    runs.settle("solo");
    await vi.advanceTimersByTimeAsync(1_000);

    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.not.stringMatching(/^Background agent group completed/)]);
    expect(sentContents(b)[0]).toContain("solo done");
  });

  it("delivers a spawn made outside a parent turn, which has no turn end to wait for", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    b.parent.running = false; // e.g. an `@handle` mention's off-screen spawn
    await spawn(b, b.parentCtx, "mentioned");

    runs.settle("mentioned");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sentContents(b)).toEqual([expect.stringContaining("mentioned done")]);
  });

  it("does not hold a sibling for a spawn whose worktree failed late", async () => {
    vi.useFakeTimers();
    const runs = controllableRuns();
    const b = await boot({ defaultJoinMode: "group" });
    worktreeAfter(500, false);

    const calls = Promise.allSettled([
      spawn(b, b.parentCtx, "doomed", { isolation: "worktree" }),
      spawn(b, b.parentCtx, "sibling"),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    const [doomed] = await calls;
    expect(doomed.status).toBe("rejected");
    turnEnd(b);

    runs.settle("sibling");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    expect(sentContents(b)).toEqual([expect.stringContaining("sibling done")]);
  });
});

describe("a stranded wake in group join mode", () => {
  /** Runs settled by `settle(prompt)`; "one" has a session whose queue keeps late steers. */
  function runsWithQueue() {
    const queued: string[] = [];
    const session = {
      dispose: vi.fn(), messages: [], subscribe: vi.fn(() => () => {}), getActiveToolNames: vi.fn(() => []),
      steer: vi.fn(async (text: string) => { queued.push(text); }),
      clearQueue: vi.fn(() => ({ steering: queued.splice(0), followUp: [] })),
    } as any;
    const finishers = new Map<string, () => void>();
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any, opts: any) => {
      const s = prompt === "one" ? session : { dispose: vi.fn(), messages: [] };
      if (prompt === "one") opts.onSessionCreated?.(session);
      return new Promise<any>(resolve => {
        finishers.set(prompt, () => resolve({ responseText: `${prompt} done`, session: s, aborted: false, steered: false }));
      }) as any;
    });
    vi.mocked(resumeAgent).mockImplementation((_s: any, prompt: string) =>
      new Promise(resolve => { finishers.set(prompt, () => resolve({ text: `${prompt} done`, aborted: false, steered: false })); }),
    );
    return { session: Object.assign(session, { queued }), settle: (prompt: string) => finishers.get(prompt)!() };
  }

  it("delivers the first run's result of a member woken before its turn ended", async () => {
    vi.useFakeTimers();
    const runs = runsWithQueue();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);

    // Lands after "one"'s last poll; it settles before the spawning turn ends.
    await runs.session.steer("late news");
    runs.settle("one");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    runs.settle("two");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    runs.settle("late news");
    await vi.advanceTimersByTimeAsync(60_000);
    turnEnd(b);

    const sent = sentContents(b).join("\n");
    expect(sent).toContain("one done");
    expect(sent).toContain("arrived after this run's last step");
    expect(sent).toContain("late news done");
  });

  it("delivers the first run's result of a member woken after its group was registered", async () => {
    vi.useFakeTimers();
    const runs = runsWithQueue();
    const b = await boot({ defaultJoinMode: "group" });
    await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);
    turnEnd(b);

    // "one" finishes first, so the group holds it while its wake runs.
    await runs.session.steer("late news");
    runs.settle("one");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    runs.settle("two");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    const before = sentContents(b).join("\n");
    expect(before).toContain("one done");
    expect(before).toContain("two done");
    expect(before).toContain("arrived after this run's last step");

    runs.settle("late news");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);
    expect(sentContents(b).join("\n")).toContain("late news done");
  });
  it("delivers the first run's result of a deferred member a steer queued after it settled wakes", async () => {
    vi.useFakeTimers();
    const runs = runsWithQueue();
    const b = await boot({ defaultJoinMode: "group" });
    const [first] = await Promise.all([spawn(b, b.parentCtx, "one"), spawn(b, b.parentCtx, "two")]);

    // pi runs its input handlers before queueing, so this enqueue lands after "one" settled.
    let enqueue!: () => void;
    runs.session.steer.mockImplementationOnce((text: string) => new Promise<void>(resolve => {
      enqueue = () => { runs.session.queued.push(text); resolve(); };
    }));
    void b.tools.get("steer_subagent").execute(
      "steer", { agent_id: agentIdOf(first), message: "late news" }, undefined, undefined, b.parentCtx,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.session.steer).toHaveBeenCalledWith("late news");
    runs.settle("one");
    await vi.advanceTimersByTimeAsync(0);
    enqueue();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    runs.settle("two");
    await vi.advanceTimersByTimeAsync(1_000);
    turnEnd(b);

    runs.settle("late news");
    await vi.advanceTimersByTimeAsync(60_000);
    turnEnd(b);

    const sent = sentContents(b).join("\n");
    expect(sent).toContain("one done");
    expect(sent).toContain("late news done");
  });
});
