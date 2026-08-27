/**
 * rpc-result-consumption.test.ts — pi-tasks#62.
 *
 * An RPC-spawned background agent (pi-tasks' `TaskExecute`) is not part of any
 * join group, so it nudges the parent individually when it finishes. The caller
 * joins it on the `subagents:completed` event instead — and used to have no way
 * to say the result had been read, because `get_subagent_result`, the only
 * consuming path, is a tool the *parent model* calls, not something reachable
 * over the bus. The held notification therefore landed on top of an answer the
 * parent had already given, costing a turn to dismiss.
 *
 * `subagents:rpc:consume` closes that: it is the bus-side half of what
 * `get_subagent_result` does when it hands a result back. These tests drive the
 * real extension, so what they pin is the actual delivery path — the notification
 * fires for an unjoined agent, and does not for a consumed one.
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

/** pi-subagents holds a completion notification for NUDGE_HOLD_MS (200ms). */
const PAST_THE_HOLD_MS = 400;

/**
 * Like `boot-extension.ts`'s `makePi`, but with a bus that actually dispatches:
 * these tests are about what a second extension sees and sends on it.
 */
function makePi() {
  const lifecycle = new Map<string, any>();
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const bus = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler));
    }),
  };
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: bus,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle, bus };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
    // Idle unless a test is pinning the mid-run hold.
    isIdle: () => true,
    ...overrides,
  } as any;
}

const notifications = (pi: any): unknown[] =>
  pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");

describe("subagents:rpc:consume", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-consume-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-consume-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false }),
    );
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Boot the real extension with its RPC handlers bound, as session_start does. */
  async function boot(ctxOverrides?: Record<string, unknown>) {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx(ctxOverrides));
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    return booted;
  }

  /** Spawn a background agent over the bus, the way pi-tasks' TaskExecute does. */
  async function spawnOverRpc(bus: ReturnType<typeof makePi>["bus"], requestId: string): Promise<string> {
    let id = "";
    bus.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: any) => { id = reply.data.id; });
    bus.emit("subagents:rpc:spawn", {
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "task #1", isBackground: true },
    });
    await vi.waitFor(() => expect(id).toBeTruthy());
    return id;
  }

  it("notifies for an RPC-spawned agent nobody consumed", async () => {
    // The behaviour that makes the notification worth keeping: an unread result
    // is the caller's only signal that the agent finished.
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    await spawnOverRpc(bus, "req-spawn-1");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toHaveLength(1);
  });

  it("suppresses the notification once the caller consumes the result", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus } = await boot();

    // Join the agent the way pi-tasks does — off the lifecycle event, not the tool.
    bus.on("subagents:completed", (data: unknown) => {
      bus.emit("subagents:rpc:consume", { requestId: "req-consume", agentId: (data as { id: string }).id });
    });

    await spawnOverRpc(bus, "req-spawn-2");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));

    expect(notifications(pi)).toEqual([]);
  });

  it("refuses to consume an agent that is still running", async () => {
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const { bus } = await boot();

    const id = await spawnOverRpc(bus, "req-spawn-3");
    const reply = vi.fn();
    bus.on("subagents:rpc:consume:reply:req-consume-running", reply);
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-running", agentId: id });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
  });

  it("reports an unknown agent rather than silently succeeding", async () => {
    const { bus } = await boot();
    const reply = vi.fn();
    bus.on("subagents:rpc:consume:reply:req-consume-unknown", reply);
    bus.emit("subagents:rpc:consume", { requestId: "req-consume-unknown", agentId: "no-such-agent" });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
  });

  it("holds the notification while the parent run is still in progress", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    let idle = false;
    const { pi, bus, lifecycle } = await boot({ isIdle: () => idle });

    await spawnOverRpc(bus, "req-spawn-hold");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications(pi)).toEqual([]);

    idle = true;
    await lifecycle.get("agent_settled")();
    expect(notifications(pi)).toHaveLength(1);
  });

  it("still suppresses a parked notification after consume", async () => {
    vi.mocked(runAgent).mockResolvedValue({ responseText: "TASK_EXECUTE_AGENT_OK" } as any);
    const { pi, bus, lifecycle } = await boot({ isIdle: () => false });

    const id = await spawnOverRpc(bus, "req-spawn-parked");
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications(pi)).toEqual([]);

    bus.emit("subagents:rpc:consume", { requestId: "req-consume-parked", agentId: id });
    await lifecycle.get("agent_settled")();
    expect(notifications(pi)).toEqual([]);
  });
});
