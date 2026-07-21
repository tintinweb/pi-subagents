import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentModePrompt,
  clearAgentMode,
  enterAgentMode,
  getAgentMode,
  resolveAgentModeModel,
  resolveAgentModeTools,
  setAgentMode,
} from "../src/agent-mode.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

beforeEach(() => {
  clearAgentMode();
  registerAgents(new Map());
});

const baseConfig = (overrides: Partial<AgentConfig>): AgentConfig => ({
  name: "test-agent",
  description: "Test agent",
  systemPrompt: "You are a test agent.",
  promptMode: "replace",
  builtinToolNames: ["read", "bash"],
  extensions: true,
  skills: false,
  ...overrides,
});

describe("agent mode state", () => {
  it("starts empty", () => {
    const state = getAgentMode();
    expect(state).toEqual({});
  });

  it("sets and gets active agent", () => {
    setAgentMode({ activeAgent: "worker", displayName: "Worker" });
    expect(getAgentMode()).toEqual({ activeAgent: "worker", displayName: "Worker" });
  });

  it("clears state", () => {
    setAgentMode({ activeAgent: "worker", displayName: "Worker" });
    clearAgentMode();
    expect(getAgentMode()).toEqual({});
  });
});

describe("resolveAgentModeModel", () => {
  const registry = {
    find: vi.fn((provider: string, modelId: string) => ({ id: modelId, provider })),
    getAvailable: vi.fn(() => [
      { id: "sonnet", name: "Sonnet", provider: "anthropic" },
      { id: "haiku", name: "Haiku", provider: "anthropic" },
    ]),
  };

  beforeEach(() => {
    registry.find.mockClear();
    registry.getAvailable.mockClear();
  });

  it("returns parent model when config.model is absent", () => {
    const config = baseConfig({ model: undefined });
    const parent = { id: "parent", provider: "openai" };
    expect(resolveAgentModeModel(config, parent, registry)).toBe(parent);
  });

  it("returns resolved model when config.model is present", () => {
    const config = baseConfig({ model: "anthropic/sonnet" });
    const result = resolveAgentModeModel(config, null, registry);
    expect(result).toEqual({ id: "sonnet", provider: "anthropic" });
  });

  it("returns error string when model cannot be resolved", () => {
    const config = baseConfig({ model: "unknown/model" });
    const result = resolveAgentModeModel(config, null, registry);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Model not found");
  });
});

describe("resolveAgentModeTools", () => {
  function fakeTool(name: string, origin?: string, source?: string, path?: string) {
    return { name, sourceInfo: origin ? { origin, source, path } : undefined };
  }

  function fakeCtx(tools: ReturnType<typeof fakeTool>[]) {
    return { getAllTools: () => tools };
  }

  it("includes built-ins only when extensions is false", async () => {
    const config = baseConfig({ extensions: false });
    const ctx = fakeCtx([
      fakeTool("ext-tool", "package", "some-ext"),
      fakeTool("read"),
      fakeTool("bash"),
    ]);
    const tools = await resolveAgentModeTools({} as ExtensionAPI, config, ctx);
    expect(tools.sort()).toEqual(["bash", "read"]);
  });

  it("includes all extension tools when extensions is true", async () => {
    const config = baseConfig({ extensions: true });
    const ctx = fakeCtx([
      fakeTool("read"),
      fakeTool("bash"),
      fakeTool("ext-tool", "package", "some-ext"),
      fakeTool("top-tool", "top-level", "top-ext"),
    ]);
    const tools = await resolveAgentModeTools({} as ExtensionAPI, config, ctx);
    expect(tools.sort()).toEqual(["bash", "ext-tool", "read", "top-tool"]);
  });

  it("includes no extension tools when extensions is false", async () => {
    const config = baseConfig({ extensions: false });
    const ctx = fakeCtx([
      fakeTool("read"),
      fakeTool("bash"),
      fakeTool("ext-tool", "package", "some-ext"),
    ]);
    const tools = await resolveAgentModeTools({} as ExtensionAPI, config, ctx);
    expect(tools.sort()).toEqual(["bash", "read"]);
  });

  it("filters extension tools by allowlist when extensions is a string array", async () => {
    const config = baseConfig({ extensions: ["allowed-ext"] });
    const ctx = fakeCtx([
      fakeTool("read"),
      fakeTool("bash"),
      fakeTool("good-tool", "package", "allowed-ext", "allowed-ext/good-tool.ts"),
      fakeTool("bad-tool", "package", "other-ext"),
    ]);
    const tools = await resolveAgentModeTools({} as ExtensionAPI, config, ctx);
    expect(tools.sort()).toEqual(["bash", "good-tool", "read"]);
  });

  it("excludes disallowed tools", async () => {
    const config = baseConfig({ extensions: false, disallowedTools: ["bash"] });
    const ctx = fakeCtx([fakeTool("read"), fakeTool("bash")]);
    const tools = await resolveAgentModeTools({} as ExtensionAPI, config, ctx);
    expect(tools.sort()).toEqual(["read"]);
  });

  it("drops unknown tools", async () => {
    const config = baseConfig({ extensions: false, builtinToolNames: ["read", "unknown-tool"] });
    const ctx = fakeCtx([fakeTool("read"), fakeTool("bash")]);
    const tools = await resolveAgentModeTools({} as ExtensionAPI, config, ctx);
    expect(tools.sort()).toEqual(["read"]);
  });
});

describe("buildAgentModePrompt", () => {
  it("returns a prompt containing the agent system prompt and active_agent tag", async () => {
    const config = baseConfig({ name: "test-agent", systemPrompt: "You are a test agent." });
    const pi = {
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes("--is-inside-work-tree")) {
          return { code: 0, stdout: "true\n", stderr: "", killed: false };
        }
        if (args.includes("--show-current")) {
          return { code: 0, stdout: "main\n", stderr: "", killed: false };
        }
        return { code: 0, stdout: "", stderr: "", killed: false };
      }),
    } as unknown as ExtensionAPI;

    const prompt = await buildAgentModePrompt(pi, config, "/workspace");
    expect(prompt).toContain("test-agent");
    expect(prompt).toContain("<active_agent name=\"test-agent\"/>");
    expect(prompt).toContain("You are a test agent.");
  });
});

describe("enterAgentMode", () => {
  function fakeCtx(overrides: Partial<ExtensionCommandContext> & { confirmValue?: boolean } = {}): ExtensionCommandContext {
    const sentMessages: any[] = [];
    const setupCalls: any[] = [];
    const ctx = {
      cwd: "/workspace",
      model: { id: "parent", provider: "openai" },
      modelRegistry: {
        find: vi.fn((provider: string, modelId: string) => ({ id: modelId, provider })),
        getAvailable: vi.fn(() => [{ id: "sonnet", provider: "anthropic", name: "Sonnet" }]),
      },
      sessionManager: { getSessionFile: vi.fn(() => "/session/parent") },
      newSession: vi.fn(async ({ setup, withSession }: { setup?: (sm: any) => Promise<void>; withSession: (replacementCtx: any) => Promise<void> }) => {
        const fakeSm = {
          appendModelChange: vi.fn((provider: string, modelId: string) => setupCalls.push({ type: "model_change", data: { provider, modelId } })),
          appendCustomEntry: vi.fn((type: string, data: any) => setupCalls.push({ type, data })),
          appendCustomMessageEntry: vi.fn((type: string, content: any, display: boolean) => setupCalls.push({ type, content, display })),
        };
        if (setup) await setup(fakeSm);
        const replacementCtx = fakeReplacementCtx(sentMessages);
        await withSession(replacementCtx);
        return { cancelled: false };
      }),
      ui: {
        confirm: vi.fn(async () => overrides.confirmValue ?? true),
        notify: vi.fn(),
        setEditorText: vi.fn(),
      },
      _sentMessages: sentMessages,
      ...overrides,
    };
    return ctx as unknown as ExtensionCommandContext;
  }

  function fakeReplacementCtx(sentMessages: any[]) {
    return {
      ui: {
        setEditorText: vi.fn(),
        notify: vi.fn(),
      },
      sendMessage: vi.fn(async (msg: any, _opts: any) => {
        sentMessages.push(msg);
      }),
    };
  }

  function fakePi() {
    return {
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes("--is-inside-work-tree")) return { code: 0, stdout: "true\n", stderr: "", killed: false };
        if (args.includes("--show-current")) return { code: 0, stdout: "main\n", stderr: "", killed: false };
        return { code: 0, stdout: "", stderr: "", killed: false };
      }),
      setModel: vi.fn(async () => true),
      setThinkingLevel: vi.fn(),
      setActiveTools: vi.fn(),
      appendEntry: vi.fn(),
      getAllTools: vi.fn(() => [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
      ]),
    } as unknown as ExtensionAPI;
  }

  it("errors for unknown agent", async () => {
    const pi = fakePi();
    const ctx = fakeCtx();
    await enterAgentMode(pi, ctx, "does-not-exist");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown agent type"), "error");
  });

  it("warns for disabled agent", async () => {
    const userAgents = new Map<string, AgentConfig>([
      ["disabled-agent", baseConfig({ name: "disabled-agent", enabled: false })],
    ]);
    registerAgents(userAgents);

    const pi = fakePi();
    const ctx = fakeCtx();
    await enterAgentMode(pi, ctx, "disabled-agent");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "warning");
  });

  it("returns early when user cancels", async () => {
    const userAgents = new Map<string, AgentConfig>([
      ["test-agent", baseConfig({ name: "test-agent" })],
    ]);
    registerAgents(userAgents);

    const pi = fakePi();
    const ctx = fakeCtx({ confirmValue: false });
    await enterAgentMode(pi, ctx, "test-agent");
    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancelled"), "info");
    expect(ctx.newSession).not.toHaveBeenCalled();
    expect(pi.setModel).not.toHaveBeenCalled();
  });

  it("confirms the prompt warns about a fresh session", async () => {
    const userAgents = new Map<string, AgentConfig>([
      ["test-agent", baseConfig({ name: "test-agent" })],
    ]);
    registerAgents(userAgents);

    const pi = fakePi();
    const ctx = fakeCtx();
    await enterAgentMode(pi, ctx, "test-agent");
    const confirmCall = (ctx.ui.confirm as any).mock.calls[0] as string[];
    const message = confirmCall.join(" ");
    expect(message).toContain("brand-new session");
    expect(message).toContain("NOT be carried over");
  });

  it("success path configures replacement session", async () => {
    const userAgents = new Map<string, AgentConfig>([
      ["test-agent", baseConfig({ name: "test-agent", model: "anthropic/sonnet", thinking: "low" as any })],
    ]);
    registerAgents(userAgents);

    const pi = fakePi();
    const setupCalls: any[] = [];
    const ctx = fakeCtx({
      newSession: vi.fn(async ({ setup, withSession }: { setup: (sm: any) => Promise<void>; withSession: (replacementCtx: any) => Promise<void> }) => {
        if (setup) {
          const fakeSm = {
            appendModelChange: vi.fn((provider: string, modelId: string) => setupCalls.push({ type: "model_change", data: { provider, modelId } })),
            appendCustomEntry: vi.fn((type: string, data: any) => setupCalls.push({ type, data })),
            appendCustomMessageEntry: vi.fn((type: string, content: any, display: boolean) => setupCalls.push({ type, content, display })),
          };
          await setup(fakeSm);
        }
        const replacementCtx = fakeReplacementCtx([]);
        await withSession(replacementCtx);
        return { cancelled: false };
      }),
    });
    await enterAgentMode(pi, ctx, "test-agent");

    const modelCalls = setupCalls.filter(c => c.type === "model_change");
    expect(modelCalls.length).toBe(1);
    expect(modelCalls[0].data).toEqual({ provider: "anthropic", modelId: "sonnet" });

    const thinkingCalls = setupCalls.filter(c => c.type === "agent-mode-thinking");
    expect(thinkingCalls.length).toBe(1);
    expect(thinkingCalls[0].data).toEqual({ level: "low" });

    const toolCalls = setupCalls.filter(c => c.type === "agent-mode-tools");
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].data.tools.sort()).toEqual(["bash", "read"]);

    const configCalls = setupCalls.filter(c => c.type === "agent-mode-config");
    expect(configCalls.length).toBe(1);
    expect(configCalls[0].data).toMatchObject({ agentName: "test-agent" });

    const instructionCalls = setupCalls.filter(c => c.type === "agent-mode-instructions");
    expect(instructionCalls.length).toBe(1);
    expect(instructionCalls[0].content).toEqual([{ type: "text", text: expect.stringContaining("You are a test agent") }]);
    expect(instructionCalls[0].display).toBe(false);

    expect(getAgentMode()).toEqual({ activeAgent: "test-agent", displayName: "test-agent" });
  });
});
