import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantUsageRecord } from "../src/usage.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const usageRecord: AssistantUsageRecord = {
  timestamp: 123,
  provider: "openai-codex",
  model: "gpt-5.4",
  usage: {
    input: 120,
    output: 40,
    cacheRead: 1000,
    cacheWrite: 20,
    totalTokens: 1180,
    cost: { input: 0.12, output: 0.08, cacheRead: 0.03, cacheWrite: 0.02, total: 0.25 },
  },
};

type TestTool = {
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ExtensionContext,
  ) => Promise<unknown>;
};
type LifecycleHandler = (event: unknown, context: ExtensionContext) => Promise<void> | void;

function makePi() {
  const tools = new Map<string, TestTool>();
  const lifecycle = new Map<string, LifecycleHandler>();
  const piMock = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      const candidate = tool as { name?: unknown };
      if (typeof candidate.name === "string") tools.set(candidate.name, tool as TestTool);
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: LifecycleHandler) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi: piMock as unknown as ExtensionAPI, piMock, tools, lifecycle };
}

function makeContext(): ExtensionContext {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "usage-session"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as unknown as ExtensionContext;
}

function getAgentTool(tools: Map<string, TestTool>): TestTool {
  const tool = tools.get("Agent");
  if (!tool) throw new Error("Agent tool was not registered");
  return tool;
}

describe("structured usage completion wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits and persists complete usage records without changing billed token totals", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.(usageRecord);
      return {
        responseText: "done",
        session: { dispose: vi.fn() } as unknown as AgentSession,
        aborted: false,
        steered: false,
      };
    });
    const { pi, piMock, tools, lifecycle } = makePi();
    const context = makeContext();
    subagentsExtension(pi);

    await getAgentTool(tools).execute(
      "usage-tool-call",
      { prompt: "go", description: "Collect usage", subagent_type: "general-purpose" },
      undefined,
      undefined,
      context,
    );

    expect(piMock.events.emit).toHaveBeenCalledWith("subagents:completed", expect.objectContaining({
      tokens: { input: 120, output: 40, total: 180 },
      usageRecords: [usageRecord],
    }));
    expect(piMock.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      usageRecords: [usageRecord],
    }));

    await lifecycle.get("session_shutdown")?.({}, context);
  });

  it("emits and persists usage collected before a failed run", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.(usageRecord);
      throw new Error("provider disconnected");
    });
    const { pi, piMock, tools, lifecycle } = makePi();
    const context = makeContext();
    subagentsExtension(pi);

    await getAgentTool(tools).execute(
      "failed-usage-tool-call",
      { prompt: "go", description: "Collect failed usage", subagent_type: "general-purpose" },
      undefined,
      undefined,
      context,
    );

    expect(piMock.events.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({
      status: "error",
      usageRecords: [usageRecord],
    }));
    expect(piMock.appendEntry).toHaveBeenCalledWith("subagents:record", expect.objectContaining({
      status: "error",
      usageRecords: [usageRecord],
    }));

    await lifecycle.get("session_shutdown")?.({}, context);
  });
});
