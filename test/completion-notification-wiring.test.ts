import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ReturnType<typeof makeHeadlessCtx>,
  ) => Promise<unknown>;
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: never[]) => unknown>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as never,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as never;
}

function completedRun() {
  return {
    responseText: "done",
    session: { dispose: vi.fn() },
    aborted: false,
    steered: false,
  } as Awaited<ReturnType<typeof runAgent>>;
}

async function spawnBackground(
  tool: RegisteredTool,
  toolCallId: string,
  description: string,
): Promise<void> {
  await tool.execute(
    toolCallId,
    {
      prompt: "reply done",
      description,
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    makeHeadlessCtx(),
  );
}

describe("background completion notification wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("requests steering for an individual completion after the result-consumption hold", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);

    await spawnBackground(tools.get("Agent")!, "individual-call", "individual child");
    await vi.advanceTimersByTimeAsync(300); // 100ms smart-batch debounce + 200ms hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("individual child"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });

  it("requests steering for a grouped completion after the result-consumption hold", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;

    await Promise.all([
      spawnBackground(agentTool, "group-call-1", "first grouped child"),
      spawnBackground(agentTool, "group-call-2", "second grouped child"),
    ]);
    await vi.advanceTimersByTimeAsync(300); // 100ms smart-batch debounce + 200ms group hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("Background agent group completed"),
        details: expect.objectContaining({
          description: expect.stringMatching(/grouped child/),
          others: expect.arrayContaining([
            expect.objectContaining({ description: expect.stringMatching(/grouped child/) }),
          ]),
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });
});
