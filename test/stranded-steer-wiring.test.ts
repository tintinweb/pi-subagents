/**
 * A steer stranded in a foreground agent's queue, as the Agent tool wires it:
 * the inline caller reads the result first and wakes the agent after, so the
 * tool result is the run's answer, never "No output.". The manager half is in
 * stranded-steer.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let env: Hermetic | undefined;
beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});
afterEach(() => {
  env?.restore();
  env = undefined;
});

/** A session whose queue holds whatever was steered into it until drained. */
function queueingSession() {
  const queued: string[] = [];
  return {
    queued,
    steer: vi.fn(async (text: string) => { queued.push(text); }),
    clearQueue: vi.fn(() => ({ steering: queued.splice(0), followUp: [] })),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

const call = (tools: Map<string, any>, params: Record<string, unknown>) =>
  tools.get("Agent").execute("tc-1", { description: "d", subagent_type: "general-purpose", ...params }, undefined, undefined, ctx());

describe("stranded steer on a foreground Agent call", () => {
  it("a spawn returns its answer, then the agent is woken with the steer", async () => {
    env = hermeticDir();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const session = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      opts.onSessionCreated?.(session);
      await session.steer("late news");
      return { responseText: "the answer", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second", aborted: false, steered: false });

    const result = await call(tools, { prompt: "go", run_in_background: false });
    expect(textOf(result)).toContain("the answer");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(resumeAgent).mock.calls[0][1]).toBe("late news");
  });

  it("a resume returns its answer, then the agent is woken with the steer", async () => {
    env = hermeticDir();
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const session = queueingSession();
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      opts.onSessionCreated?.(session);
      return { responseText: "first", session, aborted: false, steered: false };
    });
    const spawned = await call(tools, { prompt: "go", run_in_background: false });
    const id = (spawned as any).details.agentId as string;

    vi.mocked(resumeAgent).mockImplementationOnce(async () => {
      await session.steer("late news");
      return { text: "the answer", aborted: false, steered: false };
    }).mockResolvedValue({ text: "third", aborted: false, steered: false });
    const result = await call(tools, { prompt: "again", resume: id, run_in_background: false });
    expect(textOf(result)).toBe("the answer");
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(2));
    expect(vi.mocked(resumeAgent).mock.calls[1][1]).toBe("late news");
  });
});

describe("stranded steer on a background agent", () => {
  it("main gets the first result, told a resume follows, and then the second", async () => {
    env = hermeticDir();
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    // A main turn is in flight, so notifications are held until its turn_end.
    await lifecycle.get("session_start")({}, ctx({ signal: new AbortController().signal }));
    const session = queueingSession();
    let finish!: () => void;
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      opts.onSessionCreated?.(session);
      await new Promise<void>(resolve => { finish = resolve; });
      return { responseText: "the answer", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "the follow-up", aborted: false, steered: false });

    const spawned = await call(tools, { prompt: "go", run_in_background: true });
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))![1];
    await vi.waitFor(() => expect(session.steer).not.toHaveBeenCalled());
    // Lands after the run's last poll.
    await session.steer("late news");
    finish();
    await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
    await new Promise(r => setTimeout(r, 0));

    lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } });
    const sent = vi.mocked(pi.sendMessage).mock.calls
      .filter(([m]: any[]) => m.customType === "subagent-notification")
      .map(([m]: any[]) => m.content as string)
      .join("\n");
    expect(sent).toContain(`<task-id>${id}</task-id>`);
    expect(sent).toContain("the answer");
    expect(sent).toContain("One or more messages sent to this agent arrived after this run's last step, too late for the result below. " +
      "The agent is being resumed with them and will notify again. Wait for that notification before resending.");
    expect(sent).toContain("the follow-up");
  });
});
