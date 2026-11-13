/**
 * rpc-lifecycle-gating.test.ts — issue #142.
 *
 * pi runs every extension factory BEFORE applying an agent's `extensions:`
 * filter, and only delivers lifecycle events (session_start, …) to the
 * survivors — but the `pi.events` bus is shared with the filtered-out
 * activations. The old code registered the RPC handlers and emitted
 * `subagents:ready` at factory time, so a child session that excluded
 * pi-subagents still saw `subagents:ready` + a working `subagents:rpc:ping`,
 * yet every spawn failed with "No active session" (its session_start never
 * fired, so currentCtx stayed undefined).
 *
 * The fix defers BOTH the RPC registration and the readiness broadcast to the
 * first bound session_start. These tests drive the real extension factory with
 * a mock ExtensionAPI and assert the timing: nothing is wired at factory time;
 * everything is wired (once) on session_start.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const RPC_CHANNELS = ["subagents:rpc:ping", "subagents:rpc:spawn", "subagents:rpc:stop", "subagents:rpc:consume", "subagents:rpc:steer", "subagents:rpc:get", "subagents:rpc:list"] as const;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_shutdown, …
  const busHandlers = new Map<string, (raw: any) => unknown>(); // pi.events.on(...) — rpc channels
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        busHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, busHandlers };
}

function ctx(hasUI = false, setWidget = vi.fn()) {
  return {
    hasUI,
    ui: {
      setStatus: vi.fn(),
      setWidget,
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const readyEmits = (pi: any): unknown[] =>
  pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:ready");
const onCallsFor = (pi: any, channel: string): unknown[] =>
  pi.events.on.mock.calls.filter((c: any[]) => c[0] === channel);

describe("issue #142: RPC handlers + subagents:ready are gated on session_start", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir with scheduling off, so session_start doesn't
    // spin a scheduler or touch the dev's filesystem — isolates the RPC wiring.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-142-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-142-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does NOT advertise or register RPC at factory time (the filtered-out case)", () => {
    const { pi, busHandlers } = makePi();

    // A filtered-out activation only ever gets the factory run — its
    // session_start never fires. So after the factory alone, nothing should
    // be on the shared bus.
    subagentsExtension(pi);

    expect(readyEmits(pi), "no subagents:ready before session_start").toHaveLength(0);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} must not be registered at factory time`).toBe(false);
    }
  });

  it("advertises and registers RPC on session_start, and spawn works once bound", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    // Readiness broadcast once, every channel now live.
    expect(readyEmits(pi), "subagents:ready fires once bound").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} registered on session_start`).toBe(true);
    }

    // spawn no longer hits the "No active session" trap — currentCtx is set.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
    const requestId = "req-142";
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc gating test" },
    });

    const reply = pi.events.emit.mock.calls.find(
      (c: any[]) => c[0] === `subagents:rpc:spawn:reply:${requestId}`,
    );
    expect(reply, "spawn emitted a reply").toBeTruthy();
    expect(reply![1].success, `spawn succeeded, got: ${JSON.stringify(reply![1])}`).toBe(true);
    expect(reply![1].data.id).toBeTruthy();
  });

  // The RPC handler emits nothing itself: the event comes from the manager's
  // onSteered callback wired in src/index.ts. This pins that the bus path
  // reaches it, so observers do not miss bus-originated steers.
  it("subagents:rpc:steer emits subagents:steered for an RPC-spawned agent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-steer-spawn",
        type: "general-purpose",
        prompt: "go",
        options: { description: "rpc steer test" },
      });
      const spawnReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:spawn:reply:req-steer-spawn",
      );
      const id: string = spawnReply![1].data.id;

      await busHandlers.get("subagents:rpc:steer")!({ requestId: "req-steer", agentId: id, message: "also fix the lint" });

      const steerReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:steer:reply:req-steer",
      );
      expect(steerReply![1]).toEqual({ success: true });
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:steered", expect.objectContaining({ id, message: "also fix the lint" }));
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("subagents:rpc:get and :list answer for an RPC-spawned agent and its nested child", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
    const reply = (channel: string, requestId: string) =>
      pi.events.emit.mock.calls.find((c: any[]) => c[0] === `${channel}:reply:${requestId}`)?.[1];
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-get-spawn", type: "general-purpose", prompt: "go", options: { description: "snapshot owner" },
      });
      const topId: string = reply("subagents:rpc:spawn", "req-get-spawn").data.id;
      // The nested child, spawned the way the parent's scoped Agent tool does.
      const { manager, parentAgentId } = vi.mocked(runAgent).mock.lastCall![3].nestedRuntime;
      const childId: string = manager.spawn(pi, ctx(), "general-purpose", "dig", {
        description: "nested dig", isBackground: true, parentAgentId, depth: 2, maxSubagentDepth: 2,
      });

      await busHandlers.get("subagents:rpc:get")!({ requestId: "req-get", agentId: childId });
      expect(reply("subagents:rpc:get", "req-get")).toEqual({ success: true, data: { agent: expect.objectContaining({
        id: childId, status: "running", description: "nested dig", parentAgentId: topId, depth: 2,
      }) } });

      await busHandlers.get("subagents:rpc:get")!({ requestId: "req-get-missing", agentId: "nope" });
      expect(reply("subagents:rpc:get", "req-get-missing")).toEqual({ success: false, error: "Agent not found" });

      await busHandlers.get("subagents:rpc:list")!({ requestId: "req-list" });
      const agents = reply("subagents:rpc:list", "req-list").data.agents;
      expect(agents.map((a: any) => a.id).sort()).toEqual([childId, topId].sort());
      expect(agents.find((a: any) => a.id === topId)).not.toHaveProperty("parentAgentId");
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  // #443 over the bus: the parent stops at once, its nested child is inside a
  // write that ignores the abort. The stop reply must not arrive before that
  // write has landed, or the caller's replacement write could be overwritten.
  it("subagents:rpc:stop replies only after a stopped agent's nested child has settled", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const writes: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, prompt: any, opts: any) => {
      if (prompt === "dig") {
        await gate;
        writes.push("OLD");
      } else {
        await new Promise<void>((resolve) => opts.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return { responseText: "", session: { dispose: vi.fn() }, aborted: true, steered: false } as any;
    });
    const reply = (channel: string, requestId: string) =>
      pi.events.emit.mock.calls.find((c: any[]) => c[0] === `${channel}:reply:${requestId}`)?.[1];
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-443-spawn", type: "general-purpose", prompt: "go", options: { description: "owner" },
      });
      const topId: string = reply("subagents:rpc:spawn", "req-443-spawn").data.id;
      const { manager, parentAgentId } = vi.mocked(runAgent).mock.lastCall![3].nestedRuntime;
      manager.spawn(pi, ctx(), "general-purpose", "dig", {
        description: "nested dig", isBackground: true, parentAgentId, depth: 2, maxSubagentDepth: 2,
      });

      const stopped = busHandlers.get("subagents:rpc:stop")!({ requestId: "req-443-stop", agentId: topId });
      await new Promise((r) => setTimeout(r, 20));
      expect(reply("subagents:rpc:stop", "req-443-stop"), "no reply while the child's write is in flight").toBeUndefined();

      openGate();
      await stopped;
      expect(reply("subagents:rpc:stop", "req-443-stop")).toEqual({ success: true, data: { settled: true } });
      writes.push("NEW");
      expect(writes).toEqual(["OLD", "NEW"]);
    } finally {
      openGate();
      await lifecycle.get("session_shutdown")();
    }
  });

  // #103: an orchestrator that resumes the parent once "nothing is active"
  // must also wait out a finished agent's held notification, which starts a
  // parent turn of its own when it is sent.
  it("subagents:rpc:list marks a finished agent whose notification is still held", async () => {
    const { pi, tools, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    await lifecycle.get("session_start")({}, ctx());
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false } as any);
    const agents = async (requestId: string) => {
      await busHandlers.get("subagents:rpc:list")!({ requestId });
      return pi.events.emit.mock.calls.find((c: any[]) => c[0] === `subagents:rpc:list:reply:${requestId}`)![1].data.agents;
    };
    try {
      const spawn = async (description: string) => {
        await tools.get("Agent").execute(`tc-${description}`, { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, ctx());
        await new Promise((r) => setTimeout(r, 0));
      };
      await spawn("unread");
      const [held] = await agents("req-103-held");
      expect(held).toMatchObject({ status: "completed", notificationPending: true });

      await new Promise((r) => setTimeout(r, 300));
      expect(pi.sendMessage).toHaveBeenCalled();
      const [sent] = await agents("req-103-sent");
      expect(sent).not.toHaveProperty("notificationPending");

      // A result the caller has already read is never notified.
      await spawn("read");
      const read = (await agents("req-103-pre")).find((a: any) => a.description === "read");
      await busHandlers.get("subagents:rpc:consume")!({ requestId: "req-103-consume", agentId: read.id });
      const consumed = (await agents("req-103-read")).find((a: any) => a.id === read.id);
      expect(consumed).not.toHaveProperty("notificationPending");
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("subagents:rpc:list marks a `group` member held for its turn or its siblings, unless already read", async () => {
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "group" }));
    const { pi, tools, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);
    // A parent turn is in flight while `signal` is set: group spawns made now
    // are joined at that turn's end.
    const session = ctx();
    session.signal = new AbortController().signal;
    await lifecycle.get("session_start")({}, session);
    // "gated" finishes when the test opens the gate, after its spawn has
    // returned and joined the turn's group, as a real agent always does.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, prompt: any) => {
      if (prompt === "slow") await new Promise(() => {});
      if (prompt === "gated") await gate;
      return { responseText: "done", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false } as any;
    });
    const spawn = async (description: string, prompt: string) => {
      const result = await tools.get("Agent").execute(`tc-${description}`, { prompt, description, subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, session);
      await new Promise((r) => setTimeout(r, 0));
      return result.content[0].text.match(/Agent ID: (\S+)/)![1] as string;
    };
    let n = 0;
    const pending = async (id: string) => {
      const requestId = `req-103-g${n++}`;
      await busHandlers.get("subagents:rpc:get")!({ requestId, agentId: id });
      return pi.events.emit.mock.calls.find((c: any[]) => c[0] === `subagents:rpc:get:reply:${requestId}`)![1].data.agent.notificationPending;
    };
    try {
      // Finished before its turn ended: deferred until the turn's group exists.
      const read = await spawn("read", "gated");
      await spawn("first-slow", "slow");
      openGate();
      await new Promise((r) => setTimeout(r, 0));
      expect(await pending(read)).toBe(true);
      await busHandlers.get("subagents:rpc:consume")!({ requestId: "req-103-consume", agentId: read });
      expect(await pending(read), "a read result is never notified").toBeUndefined();
      await lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, session);

      // Finished, while its group waits for a sibling still running.
      const held = await spawn("held", "fast");
      await spawn("second-slow", "slow");
      await lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, session);
      expect(await pending(held)).toBe(true);
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("renders an RPC-spawned agent in the native widget while it is running", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    const activeCtx = ctx(true);
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, activeCtx);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // keep agent running
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-widget",
        type: "general-purpose",
        prompt: "go",
        options: { description: "visible RPC agent" },
      });

      await vi.waitFor(() => {
        expect(activeCtx.ui.setWidget).toHaveBeenCalledWith(
          "agents",
          expect.any(Function),
          { placement: "aboveEditor" },
        );
        expect(activeCtx.ui.setStatus).toHaveBeenCalledWith("subagents", "1 running agent");
      });
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("shows live tool activity for an RPC-spawned background agent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    let widgetFactory: any;
    const setWidget = vi.fn((key: string, content: any) => {
      if (key === "agents" && content) widgetFactory = content;
    });
    const extensionCtx = ctx(true, setWidget);
    let onToolActivity: ((activity: { type: "start" | "end"; toolName: string }) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      onToolActivity = options.onToolActivity;
      options.onSessionCreated?.({ subscribe: () => vi.fn() });
      return new Promise(() => {}) as any;
    });
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, extensionCtx);
    // TaskExecute runs inside a root tool call, so the extension already has
    // the UI context before pi-tasks sends its cross-extension spawn request.
    await lifecycle.get("tool_execution_start")({}, extensionCtx);
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId: "req-activity",
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc activity test", isBackground: true },
    });
    await vi.waitFor(() => expect(onToolActivity).toBeTypeOf("function"));
    onToolActivity!({ type: "start", toolName: "bash" });

    expect(widgetFactory).toBeTypeOf("function");
    const lines = widgetFactory(
      { terminal: { columns: 120 }, requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    ).render().join("\n");
    expect(lines).toContain("running command…");
    expect(lines).not.toContain("thinking…");
  });

  it("is idempotent — a second session_start does not re-advertise or double-register", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    await lifecycle.get("session_start")({}, ctx());

    expect(readyEmits(pi), "subagents:ready emitted exactly once across two session_starts").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(onCallsFor(pi, channel), `${channel} registered exactly once`).toHaveLength(1);
    }
  });
});
