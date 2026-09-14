/**
 * agent-model-display.test.ts — the model and thinking level the surfaces claim
 * an agent ran with must be the ones it actually ran with.
 *
 * Three ways they used to drift: a subagent that inherited the parent's model
 * showed no model at all, a level pi clamped or an agent file overrode was
 * reported as though it had been honored (#182), and a resume rendered the
 * parameters of the call rather than the session it reopened.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

/** A parent session on a model of its own, so "inherited" is a real case. */
function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        MODELS.find(m => m.provider === provider && m.id === id)),
      getAvailable: vi.fn(() => MODELS),
    },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

/** What a child session reports about itself once pi has resolved it. */
function session(provider: string, id: string, thinkingLevel: string, name?: string) {
  return { model: { provider, id, name: name ?? MODEL_NAMES[id] }, thinkingLevel, dispose: vi.fn() } as never;
}

const MODELS = [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

const MODEL_NAMES: Record<string, string> = Object.fromEntries(MODELS.map(m => [m.id, m.name]));

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

function render(tool: any, result: any, expanded = false): string {
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded, isPartial: false },
    theme,
    { isError: false },
  ).render(200).join("\n");
}

/**
 * Write a real agent file. In-memory registration is not enough: the Agent tool
 * reloads the registry from `process.cwd()` on every call, so a pinned setting
 * only survives if it is on disk where that reload will find it.
 */
function pinnedAgent(frontmatter: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pinned.md"), `---\ndescription: pins its own settings\n${frontmatter}---\n\nPinned.\n`);
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "agent-model-display-"));
  process.chdir(cwd);
  // A developer's own ~/.pi agents and settings would otherwise leak in.
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(originalCwd);
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalHome == null) delete process.env.HOME;
  else process.env.HOME = originalHome;
  registerAgents(new Map());
  rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Agent tool result — effective model", () => {
  it("names the model even when the child inherited the parent's", async () => {
    // The old rule was "show it only when it differs from the parent", which
    // left `thinking: high` attached to nothing on the common path.
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-1",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.modelName).toBe("opus 4.6");
    expect(render(tool, result)).toContain("opus 4.6");
    expect(render(tool, result, true)).toContain("opus 4.6");
  });

  it("names the inherited model while streaming, before a session exists", async () => {
    // The streaming row renders from the pre-session snapshot, which the old
    // "only when it differs from the parent" rule left empty for every agent
    // that inherited — the level had nothing to attach itself to.
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      options.onToolActivity?.({ type: "start", toolName: "Read" });
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();
    const onUpdate = vi.fn();

    await tool.execute(
      "tc-1b",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      onUpdate,
      ctx(),
    );

    const streamed = onUpdate.mock.calls[0][0];
    expect(streamed.details.modelName).toBe("opus 4.6");
    expect(tool.renderResult(streamed, { expanded: false, isPartial: true }, theme, { isError: false })
      .render(200).join("\n")).toContain("opus 4.6");
  });

  it("keeps the twin label beside the model", async () => {
    // The mode label hangs off the agent type, not the invocation, so anything
    // that rebuilds tags from the invocation alone silently drops it.
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-2",
      { prompt: "go", description: "d", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.tags).toContain("twin");
    expect(render(tool, result)).toContain("twin");
  });

  it("reports the session's level, and what was asked for, when pi clamps it", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-haiku-4-5", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-3",
      { prompt: "go", description: "d", subagent_type: "general-purpose", thinking: "max", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.tags).toContain("thinking: high (asked max)");
  });

  // Asserted on the immediate background result, which renders BEFORE a session
  // exists. That is the only place the two causes of a mismatch are separable:
  // a clamp cannot have happened yet, so "(asked max)" here can only come from
  // the agent file outranking the parameter.
  it("discloses a level an agent file pinned over the caller's (#182)", async () => {
    pinnedAgent("thinking: low\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-4",
      { prompt: "go", description: "d", subagent_type: "pinned", thinking: "max", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.tags).toContain("thinking: low (asked max)");
  });

  it("discloses a model an agent file pinned over the caller's (#182)", async () => {
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-5",
      {
        prompt: "go",
        description: "d",
        subagent_type: "pinned",
        model: "anthropic/claude-opus-4-6",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.modelName).toBe("haiku 4.5 (asked anthropic/claude-opus-4-6)");
  });

  it("stays quiet when the caller's spelling names the model that won", async () => {
    // Model input is fuzzy: `"haiku"` and `"anthropic/claude-haiku-4-5"` are the
    // same model, and the frontmatter did not take anything away from the
    // caller. Comparing the raw strings would print "haiku 4.5 (asked haiku)".
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-5b",
      { prompt: "go", description: "d", subagent_type: "pinned", model: "haiku", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.modelName).toBe("haiku 4.5");
  });

  it("discloses a spelling that names no available model at all", async () => {
    pinnedAgent("model: anthropic/claude-haiku-4-5\n");
    const tool = agentTool();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as never);

    const result = await tool.execute(
      "tc-5c",
      { prompt: "go", description: "d", subagent_type: "pinned", model: "gpt-9", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );

    expect(result.details.modelName).toBe("haiku 4.5 (asked gpt-9)");
  });

  it("says nothing about a request that was honored", async () => {
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      const s = session("anthropic", "claude-opus-4-6", "high");
      options.onSessionCreated?.(s);
      return { responseText: "done", session: s, aborted: false, steered: false } as never;
    });
    const tool = agentTool();

    const result = await tool.execute(
      "tc-6",
      { prompt: "go", description: "d", subagent_type: "general-purpose", thinking: "high", run_in_background: false },
      undefined,
      vi.fn(),
      ctx(),
    );

    expect(result.details.tags).toContain("thinking: high");
    expect(render(tool, result)).not.toContain("asked");
  });
});

describe("Agent tool result — resume", () => {
  it("renders the reopened session's settings, not the resume call's", async () => {
    // resumeAgent only prompts the existing session: model and thinking on a
    // resume call cannot take effect, so rendering them advertises a
    // configuration the run never had.
    const s = session("anthropic", "claude-haiku-4-5", "low");
    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, options: any) => {
      options.onSessionCreated?.(s);
      return { responseText: "first", session: s, aborted: false, steered: false } as never;
    });
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second" } as never);
    const tool = agentTool();
    const context = ctx();

    const first = await tool.execute(
      "tc-7",
      { prompt: "go", description: "original", subagent_type: "general-purpose", run_in_background: false },
      undefined,
      vi.fn(),
      context,
    );

    const resumed = await tool.execute(
      "tc-8",
      {
        prompt: "continue",
        description: "changed",
        subagent_type: "general-purpose",
        run_in_background: false,
        model: "anthropic/claude-opus-4-6",
        thinking: "max",
        resume: first.details.agentId,
      },
      undefined,
      vi.fn(),
      context,
    );

    expect(resumed.details.modelName).toBe("haiku 4.5");
    expect(resumed.details.tags).toContain("thinking: low");
    expect(render(tool, resumed)).not.toContain("opus 4.6");
  });
});
