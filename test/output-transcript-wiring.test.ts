import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/output-file.js", () => ({
  createOutputFilePath: vi.fn(() => "/tmp/fake-subagent.output"),
  writeInitialEntry: vi.fn(),
  streamToOutputFile: vi.fn(() => vi.fn()),
}));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const events = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        events.set(event, handler);
        return vi.fn();
      }),
    },
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

describe("output_transcript agent wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-output-transcript-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-output-transcript-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    process.chdir(cwd);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      await Promise.resolve();
      const session = { messages: [], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn() } as any;
      options.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false };
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

  it("creates no transcript when a custom agent sets output_transcript false", async () => {
    writeFileSync(join(agentDir, "agents", "sensitive.md"), `---\ndescription: Sensitive in-memory agent\noutput_transcript: false\n---\n\nKeep data in memory.`);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "process sensitive data", description: "Process sensitive data", subagent_type: "sensitive" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(streamToOutputFile).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("also suppresses the background transcript", async () => {
    writeFileSync(join(agentDir, "agents", "sensitive.md"), `---\ndescription: Sensitive in-memory agent\noutput_transcript: false\nrun_in_background: true\n---\n\nKeep data in memory.`);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "process sensitive data", description: "Process sensitive data", subagent_type: "sensitive" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(streamToOutputFile).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("keeps transcript creation as the default", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "ordinary work", description: "Do ordinary work", subagent_type: "general-purpose" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).toHaveBeenCalledOnce();
    expect(writeInitialEntry).toHaveBeenCalledOnce();
    expect(streamToOutputFile).toHaveBeenCalledOnce();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("suppresses the transcript project-wide when subagents.json sets outputTranscript false", async () => {
    // A plain default agent (no frontmatter) inherits the project default.
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false }));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "ordinary work", description: "Do ordinary work", subagent_type: "general-purpose" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).not.toHaveBeenCalled();
    expect(writeInitialEntry).not.toHaveBeenCalled();
    expect(streamToOutputFile).not.toHaveBeenCalled();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });

  it("lets agent frontmatter output_transcript true override a project outputTranscript false", async () => {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: false }));
    writeFileSync(join(agentDir, "agents", "audited.md"), `---\ndescription: Always keeps a transcript\noutput_transcript: true\n---\n\nWrite a transcript regardless of the project default.`);
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    await tools.get("Agent").execute(
      "tool-call",
      { prompt: "audited work", description: "Do audited work", subagent_type: "audited" },
      undefined,
      undefined,
      makeCtx(cwd),
    );

    expect(createOutputFilePath).toHaveBeenCalledOnce();
    expect(writeInitialEntry).toHaveBeenCalledOnce();
    expect(streamToOutputFile).toHaveBeenCalledOnce();
    await lifecycle.get("session_shutdown")?.({}, makeCtx(cwd));
  });
});
