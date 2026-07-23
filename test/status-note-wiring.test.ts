/**
 * status-note-wiring.test.ts — proves the status note actually reaches the
 * PARENT through the real tool handlers, not just that getStatusNote() returns
 * a string. Drives the registered `Agent` / `get_subagent_result` tools and
 * inspects the text delivered back, for a turn-limit abort and a user stop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, eventHandlers, lifecycle };
}

// The RPC channels are registered on the first bound session_start (#142), so a
// test that drives them must fire it first — as a real session always does. A
// sessionId-less ctx makes startScheduler short-circuit (no filesystem touch).
async function bind(lifecycle: Map<string, any>) {
  const bindCtx = ctx();
  bindCtx.sessionManager.getSessionId = vi.fn(() => undefined);
  await lifecycle.get("session_start")({}, bindCtx);
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("status note reaches the parent through the real handlers", () => {
  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    vi.restoreAllMocks();
  });

  it("foreground turn-limit abort → the Agent result flags an incomplete outcome", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "partial work so far",
      session: { dispose: vi.fn() } as any,
      aborted: true, // hard turn-limit abort
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const res = await tools.get("Agent").execute(
      "tc1",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("hit the turn limit");      // getStatusNote("aborted") is wired in
    expect(out).toContain("partial work so far");     // partial result still delivered
    expect(out).not.toContain("STOPPED BY THE USER"); // not mislabelled as a user stop
  });

  it("hides nested records from top-level tools, registry, transcripts, and lifecycle", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "nested result",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];

    // External registry/RPC callers cannot mint internal ownership metadata.
    const topId = registry.spawn(pi, ctx(), "general-purpose", "top", {
      description: "top-level owner",
      isBackground: false,
      parentAgentId: "forged-parent",
      depth: 99,
      maxSubagentDepth: 99,
      configCwd: "/untrusted/config",
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(registry.getRecord(topId)).toEqual(expect.objectContaining({
      parentAgentId: undefined,
      depth: 1,
    }));

    // Internal scoped tools receive the raw owning manager through nestedRuntime.
    const rawManager = vi.mocked(runAgent).mock.calls[0][3].nestedRuntime.manager;
    pi.events.emit.mockClear();
    pi.appendEntry.mockClear();
    pi.sendMessage.mockClear();
    const id = rawManager.spawn(pi, ctx(), "general-purpose", "nested", {
      description: "nested child",
      isBackground: true,
      parentAgentId: topId,
      depth: 2,
      maxSubagentDepth: 2,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(registry.getRecord(id)).toBeUndefined();
    for (const [name, params] of [
      ["get_subagent_result", { agent_id: id }],
      ["steer_subagent", { agent_id: id, message: "stop" }],
      ["Agent", { resume: id, prompt: "continue", description: "resume", subagent_type: "general-purpose" }],
    ] as const) {
      const result = await tools.get(name).execute("tc-nested", params, undefined, undefined, ctx());
      expect(textOf(result)).toContain("Agent not found");
    }
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:started", expect.objectContaining({ id }));
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:completed", expect.objectContaining({ id }));
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ id }));
    expect(pi.appendEntry).not.toHaveBeenCalledWith("subagents:record", expect.objectContaining({ id }));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("background user-stop → get_subagent_result flags STOPPED BY THE USER (not completed)", async () => {
    // A background agent that never settles on its own — only a stop ends it.
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);
    const { pi, tools, eventHandlers, lifecycle } = makePi();
    subagentsExtension(pi);
    await bind(lifecycle); // register RPC channels via session_start (#142)

    const spawn = await tools.get("Agent").execute(
      "tc2",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
    expect(id, "background spawn should surface an agent id").toBeTruthy();

    // The user stops it — same path the viewer's stop key uses (manager.abort).
    eventHandlers.get("subagents:rpc:stop")?.({ requestId: "r1", agentId: id });

    const res = await tools.get("get_subagent_result").execute(
      "tc3", { agent_id: id }, undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("STOPPED BY THE USER");
    expect(out).toContain("the task was NOT finished");
    expect(out).not.toContain("Done"); // not surfaced as a normal completion
  });
});
