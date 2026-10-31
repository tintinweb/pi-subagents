/**
 * send-message-wiring.test.ts — SendMessage as the real extension wires it:
 * the opt-in gate, delivery to the main session, the handback of a woken
 * agent's completion to the agent that woke it, and the wake budget reset.
 * The send logic itself is covered in send-message.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import {
  createSendMessageTool,
  getMessagingHost,
  resetPeerWakes,
  setAgentMessagingEnabled,
  setAgentMessagingMaxWakes,
} from "../src/send-message.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let env: Hermetic | undefined;
beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});
afterEach(() => {
  env?.restore();
  env = undefined;
  // Module state the extension set from settings; reset for the next file.
  setAgentMessagingEnabled(false);
  setAgentMessagingMaxWakes(5);
  resetPeerWakes();
});

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

/** Each spawn gets its own session; a run settles only when its `finish` is called. */
function controllableRuns() {
  const runs: { session: any; finish: (text?: string) => void }[] = [];
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, opts: any) => {
    const session = fakeSession();
    opts.onSessionCreated?.(session);
    return new Promise((resolve) => {
      runs.push({ session, finish: (text = "done") => resolve({ responseText: text, session, aborted: false, steered: false }) });
    }) as any;
  });
  return runs;
}

async function spawn(tools: Map<string, any>, description: string): Promise<string> {
  const r = await tools.get("Agent").execute(
    `tc-${description}`,
    { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
    undefined, undefined, ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

describe("agentMessaging gate", () => {
  it("off by default: the main session has no SendMessage", () => {
    env = hermeticDir();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    expect(tools.has("SendMessage")).toBe(false);
  });

  it("on: the main session gets SendMessage", () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    expect(tools.has("SendMessage")).toBe(true);
  });
});

describe("delivery to the main session", () => {
  it("queues a subagent's message as a steer that starts a turn, rendered by sender", async () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    controllableRuns();
    const id = await spawn(tools, "worker");
    await flush();

    const result = await createSendMessageTool(getMessagingHost()!, id).execute("tc-send", { to: "main", message: "halfway there" } as any, undefined, undefined, ctx());
    expect(textOf(result)).toBe("Message queued for the main conversation's next turn.");
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-message",
        display: true,
        content: expect.stringContaining('<agent-message from="general-purpose">\nhalfway there\n</agent-message>'),
        details: { messages: [{ fromId: id, fromName: "general-purpose", text: "halfway there" }] },
      }),
      { deliverAs: "steer", triggerTurn: true },
    ));
    await lifecycle.get("session_shutdown")?.();
  });

  it("drops what a stopped agent queued before it went out", async () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const id = await spawn(tools, "worker");
    await flush();

    await createSendMessageTool(getMessagingHost()!, id).execute("tc-send", { to: "main", message: "never mind" } as any, undefined, undefined, ctx());
    getMessagingHost()!.getRecord(id)!.abortController?.abort();
    // The way `/agents` stop and Esc reach it: the manager marks it stopped, then the run settles.
    getMessagingHost()!.getRecord(id)!.status = "stopped";
    runs[0].finish();
    await flush();
    await new Promise(r => setTimeout(r, 300));

    const sent = vi.mocked(pi.sendMessage).mock.calls.filter(([m]: any[]) => m.customType === "subagent-message");
    expect(sent).toEqual([]);
    await lifecycle.get("session_shutdown")?.();
  });
});

describe("handback", () => {
  it("a woken agent's completion goes to the agent that woke it, not to the main session", async () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const target = await spawn(tools, "target");
    await flush();
    runs[1].finish("first result");
    await flush();
    // Let the first completion's notification go out before watching for a second.
    await new Promise(r => setTimeout(r, 300));
    vi.mocked(pi.sendMessage).mockClear();

    let finishResume!: () => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => {
      finishResume = () => resolve({ text: "second result", aborted: false, steered: false });
    }) as any);

    const host = getMessagingHost()!;
    const targetHandle = host.getRecord(target)!.handle!;
    const result = await createSendMessageTool(host, sender).execute("tc-send", { to: targetHandle, message: "redo it" } as any, undefined, undefined, ctx());
    expect(textOf(result)).toBe(`Resuming agent ${targetHandle}`);
    expect(host.getRecord(target)!.handbackRecipient).toBe(sender);

    // A resume the main session cannot start yet is refused.
    const refused = await tools.get("Agent").execute("tc-early", { prompt: "x", description: "d", subagent_type: "general-purpose", resume: target, run_in_background: true }, undefined, undefined, ctx());
    expect(textOf(refused)).toContain("it can only be resumed once its current run finishes");
    expect(host.getRecord(target)!.handbackRecipient).toBe(sender);

    finishResume();
    await flush();
    await new Promise(r => setTimeout(r, 300));

    const senderSteers = runs[0].session.steer.mock.calls.map(([m]: any[]) => m);
    expect(senderSteers.some((m: string) => m.includes("second result"))).toBe(true);
    // Not also notified to the main session.
    const notifications = vi.mocked(pi.sendMessage).mock.calls.filter(([m]: any[]) => m.customType === "subagent-notification");
    expect(notifications).toEqual([]);

    // The main session resuming it does not take it back: only an agent's
    // resume moves ownership (Claude Code's `b5`).
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}) as any);
    await tools.get("Agent").execute("tc-resume", { prompt: "again", description: "d", subagent_type: "general-purpose", resume: target, run_in_background: true }, undefined, undefined, ctx());
    expect(host.getRecord(target)!.handbackRecipient).toBe(sender);
    await lifecycle.get("session_shutdown")?.();
  });
});

describe("owner gone: the completion goes to the main session (Claude Code's t2t)", () => {
  /** Sends that the main session received as completion notifications, by agent id. */
  const notified = (pi: any, id: string) => vi.mocked(pi.sendMessage).mock.calls
    .filter(([m]: any[]) => m.customType === "subagent-notification" && m.content.includes(`<task-id>${id}</task-id>`));

  it("a nested agent woken after its parent settled reports to main, which can read it", async () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const parent = await spawn(tools, "parent");
    const child = await spawn(tools, "child");
    await flush();
    runs[1].finish();
    runs[2].finish("first");
    await flush();
    await new Promise(r => setTimeout(r, 300)); // the first completions go out
    const host = getMessagingHost()!;
    // The child now belongs to the parent, which has settled.
    host.getRecord(child)!.parentAgentId = parent;
    vi.mocked(pi.sendMessage).mockClear();
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    const result = await createSendMessageTool(host, sender).execute("tc", { to: child, message: "redo" } as any, undefined, undefined, ctx());
    expect(textOf(result)).toBe(`Resuming agent ${host.getRecord(child)!.handle}; it reports to the main conversation, not to you.`);
    await vi.waitFor(() => expect(notified(pi, child)).toHaveLength(1), { timeout: 1000 });
    expect(notified(pi, child)[0][0].content).toContain("second");
    const read = await tools.get("get_subagent_result").execute("tc-r", { agent_id: child }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("second");
    await lifecycle.get("session_shutdown")?.();
  });

  it("a nested agent stopped along with its settling parent stays silent", async () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const parent = await spawn(tools, "parent");
    const child = await spawn(tools, "child");
    await flush();
    const host = getMessagingHost()!;
    host.getRecord(child)!.parentAgentId = parent;
    runs[0].finish(); // stops the parent's children
    await flush();
    expect(host.getRecord(child)!.status).toBe("stopped");
    runs[1].finish("late");
    await flush();
    await new Promise(r => setTimeout(r, 300));
    expect(notified(pi, child)).toEqual([]);
    await lifecycle.get("session_shutdown")?.();
  });

  it("an agent whose takeover recipient settled first reports to main, not to its old owner", async () => {
    env = hermeticDir({ settings: { agentMessaging: true } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const parent = await spawn(tools, "parent");
    const child = await spawn(tools, "child");
    await flush();
    runs[2].finish("first");
    await flush();
    await new Promise(r => setTimeout(r, 300)); // the first completion goes out
    const host = getMessagingHost()!;
    const childRecord = host.getRecord(child)!;
    childRecord.parentAgentId = parent;
    childRecord.resultConsumed = true; // its owner read the first result, so a peer may take it over
    let finishResume!: () => void;
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => {
      finishResume = () => resolve({ text: "second", aborted: false, steered: false });
    }) as any);
    await createSendMessageTool(host, sender).execute("tc", { to: child, message: "redo" } as any, undefined, undefined, ctx());
    expect(childRecord.handbackRecipient).toBe(sender);
    vi.mocked(pi.sendMessage).mockClear();
    runs[0].finish();
    await flush();
    finishResume();

    await vi.waitFor(() => expect(notified(pi, child)).toHaveLength(1), { timeout: 1000 });
    const parentSteers = runs[1].session.steer.mock.calls.map(([m]: any[]) => m as string);
    expect(parentSteers.some(m => m.includes("second"))).toBe(false);
    await lifecycle.get("session_shutdown")?.();
  });
});

describe("peer wake budget", () => {
  it("counts a stranded wake carrying a peer's message, so agents cannot ping-pong past it", async () => {
    env = hermeticDir({ settings: { agentMessaging: true, agentMessagingMaxWakes: 1 } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const target = await spawn(tools, "target");
    await flush();
    // The target's queue keeps what is steered into it: the steer lands after its last poll.
    const queued: string[] = [];
    const targetSession = runs[1].session;
    targetSession.steer.mockImplementation(async (m: string) => { queued.push(m); });
    targetSession.clearQueue.mockImplementation(() => ({ steering: queued.splice(0), followUp: [] }));
    const resumes: (() => void)[] = [];
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(resolve => {
      resumes.push(() => resolve({ text: "again", aborted: false, steered: false }));
    }) as any);
    const host = getMessagingHost()!;
    const send = () => createSendMessageTool(host, sender).execute("tc", { to: target, message: "ping" } as any, undefined, undefined, ctx());

    expect(textOf(await send())).toContain("Message queued for delivery");
    runs[1].finish();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 300)); // the first completion goes out on its own

    // Round two: the woken run strands another peer message; the budget is spent.
    expect(textOf(await send())).toContain("Message queued for delivery");
    await flush();
    resumes[0]();
    await flush();
    await new Promise(r => setTimeout(r, 20));
    expect(resumeAgent).toHaveBeenCalledTimes(1);
    const notes = vi.mocked(pi.sendMessage).mock.calls.map(([m]: any[]) => m.content as string);
    expect(notes.some(n => n.includes("peer wake budget spent"))).toBe(true);
    // Its completion does not announce a resume that is not coming.
    await new Promise(r => setTimeout(r, 300));
    const lastNotification = vi.mocked(pi.sendMessage).mock.calls
      .filter(([m]: any[]) => m.customType === "subagent-notification").at(-1)![0].content as string;
    expect(lastNotification).toContain("again");
    expect(lastNotification).not.toContain("arrived after this run's last step");
    await lifecycle.get("session_shutdown")?.();
  });

  it("a peer message delivered earlier in the same run does not make a stranded user steer a peer wake", async () => {
    env = hermeticDir({ settings: { agentMessaging: true, agentMessagingMaxWakes: 0 } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const target = await spawn(tools, "target");
    await flush();
    const queued: string[] = [];
    const targetSession = runs[1].session;
    targetSession.steer.mockImplementation(async (m: string) => { queued.push(m); });
    targetSession.clearQueue.mockImplementation(() => ({ steering: queued.splice(0), followUp: [] }));
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}) as any);
    const host = getMessagingHost()!;

    await createSendMessageTool(host, sender).execute("tc", { to: target, message: "ping" } as any, undefined, undefined, ctx());
    await flush();
    queued.splice(0); // the run's next tool round delivers it
    await tools.get("steer_subagent").execute("tc-s", { agent_id: target, message: "from main" }, undefined, undefined, ctx());
    runs[1].finish();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("from main");
    await lifecycle.get("session_shutdown")?.();
  });

  it("a peer message delivered in time does not make a later run's stranded user steer a peer wake", async () => {
    env = hermeticDir({ settings: { agentMessaging: true, agentMessagingMaxWakes: 0 } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const target = await spawn(tools, "target");
    await flush();
    const host = getMessagingHost()!;
    // Delivered at the target's next tool round: nothing strands.
    await createSendMessageTool(host, sender).execute("tc", { to: target, message: "ping" } as any, undefined, undefined, ctx());
    runs[1].finish();
    await flush();

    // The main session resumes it; a steer from main then strands in the new run.
    const queued: string[] = [];
    const targetSession = runs[1].session;
    targetSession.steer.mockImplementation(async (m: string) => { queued.push(m); });
    targetSession.clearQueue.mockImplementation(() => ({ steering: queued.splice(0), followUp: [] }));
    let finishResume!: () => void;
    vi.mocked(resumeAgent).mockImplementationOnce(() => new Promise(resolve => {
      finishResume = () => resolve({ text: "again", aborted: false, steered: false });
    }) as any).mockImplementation(() => new Promise(() => {}) as any);
    await tools.get("Agent").execute("tc-r", { prompt: "again", description: "d", subagent_type: "general-purpose", resume: target, run_in_background: true }, undefined, undefined, ctx());
    await tools.get("steer_subagent").execute("tc-s", { agent_id: target, message: "from main" }, undefined, undefined, ctx());
    finishResume();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(resumeAgent).mock.calls[1][1]).toBe("from main");
    await lifecycle.get("session_shutdown")?.();
  });

  it("a user input resets it", async () => {
    env = hermeticDir({ settings: { agentMessaging: true, agentMessagingMaxWakes: 1 } });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const runs = controllableRuns();
    const sender = await spawn(tools, "sender");
    const t1 = await spawn(tools, "t1");
    const t2 = await spawn(tools, "t2");
    await flush();
    runs[1].finish();
    runs[2].finish();
    await flush();
    vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}) as any);

    const host = getMessagingHost()!;
    const send = (to: string) => createSendMessageTool(host, sender).execute("tc", { to, message: "hi" } as any, undefined, undefined, ctx());
    expect(textOf(await send(host.getRecord(t1)!.handle!))).toContain("Resuming agent");
    expect(textOf(await send(host.getRecord(t2)!.handle!))).toContain("Paused until the user's next message");

    await lifecycle.get("input")?.({ type: "input", text: "carry on", source: "interactive" }, ctx());
    expect(textOf(await send(host.getRecord(t2)!.handle!))).toContain("Resuming agent");
    await lifecycle.get("session_shutdown")?.();
  });
});
