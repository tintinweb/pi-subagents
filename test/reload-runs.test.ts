import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagents from "../src/index.js";
import { runWorkflow } from "../src/workflow/runtime.js";

vi.mock("../src/workflow/runtime.js", () => ({ runWorkflow: vi.fn() }));
type Handler = (event: { type: string; reason?: string }, ctx: ExtensionContext) => unknown;

function host(cwd: string, sessionId = "reload-test") {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const inputUnsub = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: vi.fn(), registerFlag: vi.fn(), getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(), registerEntryRenderer: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    sendMessage: vi.fn(), appendEntry: vi.fn(),
    getAllTools: () => [], getActiveTools: () => [],
  };
  const ctx = {
    cwd, hasUI: true, mode: "rpc", model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: () => [] },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    getSystemPrompt: () => "parent",
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
      onTerminalInput: vi.fn(() => inputUnsub), getEditorText: () => "", custom: vi.fn() },
  };
  return { pi, ctx, tools, inputUnsub,
    async emit(type: string, reason: string) {
      for (const handler of handlers.get(type) ?? []) await handler({ type, reason }, ctx as unknown as ExtensionContext);
    },
  };
}
const active: ReturnType<typeof host>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of active.splice(0)) await h.emit("session_shutdown", "quit");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("workflow reload handoff", () => {
  it.each([false, true])("keeps a workflow alive and restores delivery (completion during reload: %s)", async (duringReload) => {
    vi.mocked(runWorkflow).mockReset();
    const cwd = mkdtempSync(join(tmpdir(), "pi-reload-")); dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    let resolveRun!: (value: Awaited<ReturnType<typeof runWorkflow>>) => void;
    vi.mocked(runWorkflow).mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));
    const first = host(cwd); active.push(first);
    subagents(first.pi as unknown as ExtensionAPI);
    await first.emit("session_start", "startup");
    const tool = first.tools.get("SubagentWorkflow")!;
    const result = await tool.execute("test-call", { script: 'export const meta = { name: "Reload proof", description: "reload test" }; return "ok";' }, undefined, undefined, first.ctx as unknown as ExtensionContext);
    expect(result.details, JSON.stringify(result.content)).toBeDefined();
    const runOptions = vi.mocked(runWorkflow).mock.calls[0][0];
    expect(first.ctx.ui.setWidget).toHaveBeenCalledWith("fleet", expect.any(Function), { placement: "belowEditor" });
    const oldMessageCount = first.pi.sendMessage.mock.calls.length;
    await first.emit("session_shutdown", "reload");
    active.splice(active.indexOf(first), 1);
    expect(runOptions.signal?.aborted).toBe(false);
    const complete = () => resolveRun({ status: "completed", value: "ok", meta: { name: "Reload proof", description: "reload test" }, agentCount: 0, replayedCount: 0 } as Awaited<ReturnType<typeof runWorkflow>>);
    if (duringReload) {
      complete();
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(first.pi.sendMessage).toHaveBeenCalledTimes(oldMessageCount);
    }

    const second = host(cwd); active.push(second);
    subagents(second.pi as unknown as ExtensionAPI);
    await second.emit("session_start", "reload");
    expect(second.ctx.ui.setWidget).toHaveBeenCalledWith("fleet", expect.any(Function), { placement: "belowEditor" });
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    if (!duringReload) complete();
    await vi.waitFor(() => expect(second.pi.sendMessage).toHaveBeenCalled());
    expect(first.pi.sendMessage).toHaveBeenCalledTimes(oldMessageCount);
    await second.emit("session_shutdown", "quit");
    expect(runOptions.signal?.aborted).toBe(true);
  });
});
