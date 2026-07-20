import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makeHarness() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const responseText = (result: any) => result.content[0].text as string;

async function shutdown(harness: ReturnType<typeof makeHarness>) {
  await harness.lifecycle.get("session_shutdown")?.({}, ctx());
}

describe("Agent tool goal mode wiring", () => {
  let harness: ReturnType<typeof makeHarness> | undefined;

  afterEach(async () => {
    vi.mocked(runAgent).mockReset();
    if (harness) await shutdown(harness);
    harness = undefined;
  });

  it("publishes goal in the schema and passes it through foreground runs", async () => {
    harness = makeHarness();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "Goal complete: verified",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const agent = harness.tools.get("Agent");

    expect(agent.parameters.properties.goal).toBeDefined();
    const result = await agent.execute(
      "tc-goal-fg",
      { prompt: "go", description: "verified work", subagent_type: "general-purpose", goal: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "go",
      expect.objectContaining({ goal: true }),
    );
    expect(responseText(result)).toContain("Goal complete: verified");
  });

  it("reports a non-complete foreground goal as a failure without duplicating its result", async () => {
    harness = makeHarness();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "Goal blocked: dependency missing",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      failure: "Goal blocked: dependency missing",
    });

    const result = await harness.tools.get("Agent").execute(
      "tc-goal-blocked",
      { prompt: "go", description: "blocked work", subagent_type: "general-purpose", goal: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(responseText(result)).toContain("Agent failed: Goal blocked: dependency missing");
    expect(responseText(result)).not.toContain("Partial output before the failure");
  });

  it("passes goal mode through background runs", async () => {
    harness = makeHarness();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "Goal blocked: dependency missing",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      failure: "Goal blocked: dependency missing",
    });
    const result = await harness.tools.get("Agent").execute(
      "tc-goal-bg",
      {
        prompt: "go",
        description: "blocked work",
        subagent_type: "general-purpose",
        goal: true,
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(responseText(result)).toMatch(/Agent ID:/);
    await new Promise((resolve) => setImmediate(resolve));
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "go",
      expect.objectContaining({ goal: true }),
    );
    expect(harness.pi.events.emit).toHaveBeenCalledWith(
      "subagents:failed",
      expect.objectContaining({ status: "error" }),
    );
  });

  it("rejects a later ordinary resume of a goal-mode record", async () => {
    harness = makeHarness();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "Goal complete: verified",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const agent = harness.tools.get("Agent");
    const started = await agent.execute(
      "tc-goal-start",
      {
        prompt: "go",
        description: "goal work",
        subagent_type: "general-purpose",
        goal: true,
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );
    const id = responseText(started).match(/Agent ID: ([\w-]+)/)?.[1];
    expect(id).toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));

    const resumed = await agent.execute(
      "tc-goal-resume",
      { prompt: "continue", description: "resume", subagent_type: "general-purpose", resume: id },
      undefined,
      undefined,
      ctx(),
    );

    expect(responseText(resumed)).toMatch(/Cannot resume goal-mode agent/);
  });

  it.each([
    [{ goal: true, isolated: true }, /isolated: true/],
    [{ goal: true, resume: "agent-1" }, /resume/],
    [{ goal: true, schedule: "+1h" }, /schedule/],
  ])("rejects unsupported combinations before spawning", async (extra, message) => {
    harness = makeHarness();
    const result = await harness.tools.get("Agent").execute(
      "tc-goal-invalid",
      { prompt: "go", description: "invalid goal", subagent_type: "general-purpose", ...extra },
      undefined,
      undefined,
      ctx(),
    );

    expect(responseText(result)).toMatch(message);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
