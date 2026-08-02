import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
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
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("Agent session name top-level wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-session-name-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-session-name-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    process.chdir(cwd);
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("advertises name and passes it through foreground and background Agent calls", async () => {
    writeFileSync(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false, defaultJoinMode: "async" }),
    );
    const { pi, tools, lifecycle } = makePi();
    const ctx = makeCtx(cwd);
    subagentsExtension(pi);
    const agent = tools.get("Agent");

    expect(agent.parameters.properties.name.description).toContain("human-readable session name");

    await agent.execute(
      "foreground-call",
      { prompt: "foreground", description: "Run foreground", name: "Foreground review", subagent_type: "general-purpose" },
      undefined,
      undefined,
      ctx,
    );
    expect(vi.mocked(runAgent).mock.calls[0][3].sessionName).toBe("Foreground review");

    await agent.execute(
      "background-call",
      { prompt: "background", description: "Run background", name: "Background review", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx,
    );
    expect(vi.mocked(runAgent).mock.calls[1][3].sessionName).toBe("Background review");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("stores name when a top-level Agent call creates a scheduled job", async () => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false }));
    const { pi, tools, lifecycle } = makePi();
    const ctx = makeCtx(cwd);
    subagentsExtension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    await tools.get("Agent").execute(
      "scheduled-call",
      {
        prompt: "scheduled",
        description: "Run scheduled",
        name: "Scheduled review",
        subagent_type: "general-purpose",
        schedule: "1h",
      },
      undefined,
      undefined,
      ctx,
    );

    const stored = JSON.parse(
      readFileSync(join(cwd, ".pi", "subagent-schedules", "session-1.json"), "utf-8"),
    );
    expect(stored.jobs[0].sessionName).toBe("Scheduled review");
    expect(runAgent).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
