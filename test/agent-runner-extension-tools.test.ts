/**
 * Tests for post-bind active-tool re-filter.
 *
 * Extension-registered tools (added during `session.bindExtensions(...)`) are
 * not in the session's active tool set when the initial filter pass runs.
 * Without a post-bind re-filter, the `extensions: string[]` allowlist branch
 * never matches any extension tool, and `extensions: true` lets denylisted
 * extension tools slip through.
 *
 * This file simulates that flow by having `getActiveToolNames` return a small
 * built-in set before `bindExtensions` is called and a larger set including
 * extension tools after, then asserts that the final `setActiveToolsByName`
 * call (the post-bind re-filter) honors the agent's `extensions` and
 * `disallowedTools` config against the post-bind world.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  sessionManagerInMemory,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      defaultResourceLoaderCtor(options);
    }

    async reload() {}
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

const agentConfigMock = vi.hoisted(() => ({
  current: {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read"],
    extensions: true as boolean | string[],
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    disallowedTools: undefined as string[] | undefined,
  },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => agentConfigMock.current),
  getAgentConfig: vi.fn(() => agentConfigMock.current),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({
    isGitRepo: false,
    branch: "",
    platform: "linux",
  })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import { runAgent } from "../src/agent-runner.js";

/**
 * Build a mock session where `getActiveToolNames` returns one set before
 * `bindExtensions` is called and another set after.
 *
 * @param beforeBind  Tools active before bindExtensions (built-in only).
 * @param afterBind   Tools active after bindExtensions (built-in + extension).
 */
function createSessionWithExtensionToolRegistration(
  beforeBind: string[],
  afterBind: string[],
) {
  let bound = false;
  const session = {
    messages: [] as any[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => (bound ? afterBind : beforeBind)),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {
      bound = true;
    }),
  };
  return session;
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
  // Reset agent config to defaults
  agentConfigMock.current = {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read"],
    extensions: true,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    disallowedTools: undefined,
  };
});

describe("post-bind active-tool re-filter", () => {
  it("setActiveToolsByName is called both before and after bindExtensions", async () => {
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "extension_tool"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    // Should be called twice: once before bind, once after.
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const firstSetOrder =
      session.setActiveToolsByName.mock.invocationCallOrder[0];
    const secondSetOrder =
      session.setActiveToolsByName.mock.invocationCallOrder[1];

    // First set is before bind, second is after.
    expect(firstSetOrder).toBeLessThan(bindOrder);
    expect(secondSetOrder).toBeGreaterThan(bindOrder);
  });

  it("post-bind re-filter includes extension tool when extensions: true", async () => {
    agentConfigMock.current.extensions = true;
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "extension_tool"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    // Second (post-bind) call is the re-filter; it should include the
    // extension-registered tool since extensions: true allows everything.
    const secondCallArgs = session.setActiveToolsByName.mock.calls[1][0];
    expect(secondCallArgs).toContain("read");
    expect(secondCallArgs).toContain("extension_tool");
  });

  it("post-bind re-filter respects extensions: string[] allowlist", async () => {
    // Allowlist only "permission-system" prefix; "other_tool" must be excluded.
    agentConfigMock.current.extensions = ["permission-system"];
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "permission-system_check", "other_tool"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    // Built-in tools are always allowed.
    expect(postBindArgs).toContain("read");
    // Allowlisted extension tool included.
    expect(postBindArgs).toContain("permission-system_check");
    // Non-allowlisted extension tool excluded.
    expect(postBindArgs).not.toContain("other_tool");
  });

  it("post-bind re-filter respects disallowedTools denylist for extension tools", async () => {
    agentConfigMock.current.extensions = true;
    agentConfigMock.current.disallowedTools = ["bad_extension_tool"];
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "good_extension_tool", "bad_extension_tool"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    expect(postBindArgs).toContain("read");
    expect(postBindArgs).toContain("good_extension_tool");
    expect(postBindArgs).not.toContain("bad_extension_tool");
  });

  it("post-bind re-filter excludes our own tools (EXCLUDED_TOOL_NAMES) even when extensions: true", async () => {
    agentConfigMock.current.extensions = true;
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read", "Agent", "get_subagent_result", "steer_subagent", "external"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    expect(postBindArgs).toContain("read");
    expect(postBindArgs).toContain("external");
    // Our own subagent-dispatch tools must never reach children.
    expect(postBindArgs).not.toContain("Agent");
    expect(postBindArgs).not.toContain("get_subagent_result");
    expect(postBindArgs).not.toContain("steer_subagent");
  });

  it("extensions: false still applies disallowedTools to built-in tools (post-bind re-filter)", async () => {
    agentConfigMock.current.extensions = false;
    agentConfigMock.current.disallowedTools = ["read"];
    const session = createSessionWithExtensionToolRegistration(
      ["read", "write"],
      ["read", "write"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(2);
    const postBindArgs = session.setActiveToolsByName.mock.calls[1][0];
    // Denylisted built-in is removed.
    expect(postBindArgs).not.toContain("read");
    // Non-denylisted built-in survives.
    expect(postBindArgs).toContain("write");
  });

  it("extensions: false with no disallowedTools skips the filter (no setActiveToolsByName call)", async () => {
    agentConfigMock.current.extensions = false;
    agentConfigMock.current.disallowedTools = undefined;
    const session = createSessionWithExtensionToolRegistration(
      ["read"],
      ["read"],
    );
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "test-agent", "go", { pi });

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});
