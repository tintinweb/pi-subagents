/**
 * fleet-wiring.test.ts — end-to-end wiring of the FleetView through the REAL
 * extension (src/index.ts), not the FleetList class in isolation.
 *
 * The unit tests in fleet-list.test.ts drive FleetList with a fake ui/manager.
 * These prove the bits only the extension can: that `tool_execution_start`
 * hands the fleet the live UI (so it captures input), that spawning a background
 * agent actually registers the `belowEditor` widget once the agent has a session,
 * and that `session_shutdown` tears it down. runAgent is mocked (no LLM); the
 * manager, settings load, completion routing, and lifecycle handlers are real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/workflow/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/workflow/runtime.js")>("../src/workflow/runtime.js");
  return { ...actual, runWorkflow: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { runWorkflow } from "../src/workflow/runtime.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

/** A UI context with the surfaces the widget + fleet touch; setWidget is spied. */
function uiCtx() {
  return {
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    notify: vi.fn(),
    onTerminalInput: vi.fn(() => vi.fn()),
    getEditorText: vi.fn(() => ""),
    custom: vi.fn(),
  };
}

function ctxWith(ui: ReturnType<typeof uiCtx>) {
  return {
    hasUI: true,
    ui,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    getSystemPrompt: () => "parent",
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

describe("FleetView wiring (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-fleet-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-fleet-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    // async join → completion routes straight to sendIndividualNudge (no batch
    // debounce), so fleet.onAgentFinished fires synchronously on the result.
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async" }));
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

  it("reports independent Herdr activity until the last agent finishes", async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("HC_TERMINAL_ID", "test-terminal");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const finishes: Array<() => void> = [];
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      finishes.push(() => resolve({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false }));
    }));
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = ctxWith(uiCtx());
      await lifecycle.get("session_start")?.({}, ctx);
      for (const description of ["first", "second"]) {
        await tools.get("Agent").execute(description, { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, ctx);
      }
      expect(write.mock.calls.map(call => call[0])).toEqual(["\x1b]7501;state=working:id=pi-subagents\x1b\\"]);
      finishes[0]();
      await flush();
      expect(write).toHaveBeenCalledTimes(1);
      finishes[1]();
      await flush();
      expect(write.mock.calls.map(call => call[0])).toEqual([
        "\x1b]7501;state=working:id=pi-subagents\x1b\\",
        "\x1b]7501;state=clear:id=pi-subagents\x1b\\",
      ]);
      await lifecycle.get("session_shutdown")?.({}, ctx);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      vi.unstubAllEnvs();
    }
  });

  it("keeps activity until a running agent settles after a queued cancellation", async () => {
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, maxConcurrentForeground: 1 }));
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("HC_TERMINAL_ID", "test-terminal");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let finish!: () => void;
    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
    }));
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = ctxWith(uiCtx());
      await lifecycle.get("session_start")?.({}, ctx);
      const tool = tools.get("Agent");
      const params = { prompt: "go", description: "work", subagent_type: "general-purpose", run_in_background: false };
      const first = tool.execute("first", params, undefined, undefined, ctx);
      await flush();
      const abort = new AbortController();
      const second = tool.execute("second", params, abort.signal, undefined, ctx);
      await flush();
      abort.abort();
      await second;
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
      finish();
      await first;
      await flush();
      expect(write.mock.calls.map(call => call[0])).toEqual([
        "\x1b]7501;state=working:id=pi-subagents\x1b\\",
        "\x1b]7501;state=clear:id=pi-subagents\x1b\\",
      ]);
      await lifecycle.get("session_shutdown")?.({}, ctx);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      vi.unstubAllEnvs();
    }
  });

  it("reports a workflow even before it starts an agent", async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("HC_TERMINAL_ID", "test-terminal");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    let finish!: () => void;
    vi.mocked(runWorkflow).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ status: "completed", meta: { name: "test", description: "test" }, agentCount: 0, replayedCount: 0, failures: [] } as any);
    }));
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = ctxWith(uiCtx());
      await lifecycle.get("session_start")?.({}, ctx);
      await tools.get("SubagentWorkflow").execute("workflow", { script: 'export const meta = { name: "test", description: "test" };' }, undefined, undefined, ctx);
      expect(write.mock.calls.map(call => call[0])).toEqual(["\x1b]7501;state=working:id=pi-subagents\x1b\\"]);
      finish();
      await flush();
      expect(write.mock.calls.map(call => call[0])).toEqual([
        "\x1b]7501;state=working:id=pi-subagents\x1b\\",
        "\x1b]7501;state=clear:id=pi-subagents\x1b\\",
      ]);
      await lifecycle.get("session_shutdown")?.({}, ctx);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      vi.unstubAllEnvs();
    }
  });

  it("clears the record on shutdown while work remains", async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.stubEnv("HC_TERMINAL_ID", "test-terminal");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = ctxWith(uiCtx());
      await lifecycle.get("session_start")?.({}, ctx);
      await tools.get("Agent").execute("spawn", { prompt: "go", description: "work", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, ctx);
      await lifecycle.get("session_shutdown")?.({}, ctx);
      expect(write.mock.calls.map(call => call[0])).toEqual([
        "\x1b]7501;state=working:id=pi-subagents\x1b\\",
        "\x1b]7501;state=clear:id=pi-subagents\x1b\\",
      ]);
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else Reflect.deleteProperty(process.stdout, "isTTY");
      vi.unstubAllEnvs();
    }
  });

  it("does not write OSC reports in noninteractive mode", async () => {
    vi.stubEnv("HC_TERMINAL_ID", "test-terminal");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
    try {
      const { pi, tools, lifecycle } = makePi();
      subagentsExtension(pi);
      const ctx = { ...ctxWith(uiCtx()), hasUI: false };
      await lifecycle.get("session_start")?.({}, ctx);
      await tools.get("Agent").execute("spawn", { prompt: "go", description: "work", subagent_type: "general-purpose", run_in_background: true }, undefined, undefined, ctx);
      await flush();
      await lifecycle.get("session_shutdown")?.({}, ctx);
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("captures terminal input on tool_execution_start (fleet hooked into the UI)", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui));
    expect(ui.onTerminalInput).toHaveBeenCalled();
  });

  it("registers the belowEditor widget once a spawned agent has a session, then clears it on shutdown", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const ui = uiCtx();
    await lifecycle.get("tool_execution_start")?.({}, ctxWith(ui)); // fleet captures THIS ui

    const spawn = await tools.get("Agent").execute(
      "tc",
      { prompt: "go", description: "live one", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctxWith(uiCtx()),
    );
    expect(textOf(spawn)).toMatch(/Agent ID:/);
    await flush(); // completion → fleet.onAgentFinished → update → widget registers

    const fleetRegs = ui.setWidget.mock.calls.filter(c => c[0] === "fleet" && typeof c[1] === "function");
    expect(fleetRegs.length, "fleet widget should register with a render factory").toBeGreaterThan(0);

    await lifecycle.get("session_shutdown")?.({}, ctxWith(uiCtx()));
    expect(ui.setWidget).toHaveBeenCalledWith("fleet", undefined); // dispose cleared it
  });
});
