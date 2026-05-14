import { homedir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerInMemory,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  loaderExtensionsRef: {
    current: { extensions: [], errors: [], runtime: {} } as {
      extensions: Array<{ path: string; tools: Map<string, unknown> }>;
      errors: Array<{ path: string; error: string }>;
      runtime: Record<string, unknown>;
    },
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession,
  // Mock loader simulates pi-mono: reload() applies additionalExtensionPaths
  // (an unknown path becomes an error row, mirroring a failed load) and then
  // runs extensionsOverride over the result.
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
      // Tests pre-register the extensions a path should resolve to; an
      // unregistered path simply yields no extension (a failed load).
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
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

import {
  extensionCanonicalName,
  parseExtensionsSpec,
  parseExtSelectors,
  resumeAgent,
  runAgent,
} from "../src/agent-runner.js";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
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
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { pi, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp/worktree");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0][0];
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });

  it("sets the agent name as session name before binding extensions", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore");
    const setOrder = session.setSessionName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(bindOrder);
  });

  it("suffixes the session name with a short agentId so parallel spawns are distinguishable", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore#a1b2c3d4");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10 },
      { input: 200, output: 80, cacheWrite: 20 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5 }]);
  });

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      // Successful compaction — should fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      // Aborted compaction — should NOT fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        reason: "manual",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

// ─── master tool allowlist (issue #47) ──────────────────────────────────
// Tool gating happens at `createAgentSession` time via the `tools:`
// parameter. pi-mono's `allowedToolNames` is the master gate: it controls
// BOTH which tools get registered and which enter the initial active set.
// No post-construction `setActiveToolsByName` filter is needed.

import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
} from "../src/agent-types.js";

const BUILTINS_7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    skills: false as boolean | string[],
    systemPrompt: "Test.",
    promptMode: "replace" as const,
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    skills: false as boolean | string[],
    promptMode: "replace" as const,
    ...overrides,
  };
}

/** Register extensions for the mock loader, keyed by extension path → tool names. */
function withExtensions(spec: Record<string, string[]>) {
  loaderExtensionsRef.current = {
    extensions: Object.entries(spec).map(([path, tools]) => ({
      path,
      tools: new Map(tools.map((n) => [n, {}])),
    })),
    errors: [],
    runtime: {},
  };
}

function lastToolsPassed(): string[] {
  return createAgentSession.mock.calls[0][0].tools;
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0][0];
}

describe("agent-runner master tool allowlist", () => {
  it("extensions: true with extension tools — all 7 built-ins plus extension tools land in the allowlist", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Order is not semantically meaningful (pi-mono dedupes via Set);
    // assert membership and exact size instead.
    const tools = lastToolsPassed();
    expect(tools).toHaveLength(BUILTINS_7.length + 2);
    expect(new Set(tools)).toEqual(new Set([...BUILTINS_7, "mcp", "mcp_call"]));
  });

  it("enumerates tools across multiple loaded extensions", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/a.ts": ["tool_a"], "/ext/b.ts": ["tool_b"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
  });

  it("disallowedTools removes both built-ins and extension tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash", "mcp"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("bash");
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).toContain("read");
  });

  it("EXCLUDED_TOOL_NAMES never reach the allowlist even if an extension registers them", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({
      "/ext/evil.ts": ["Agent", "get_subagent_result", "steer_subagent", "ok_ext"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("Agent");
    expect(tools).not.toContain("get_subagent_result");
    expect(tools).not.toContain("steer_subagent");
    expect(tools).toContain("ok_ext");
  });

  it("extensions: false with disallowedTools — denylist applies to built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("bash");
    expect(tools).toEqual(BUILTINS_7.filter((t) => t !== "bash"));
  });

  it("does not call setActiveToolsByName post-construction (gating is at construction)", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });
});

// ─── extensions: string[] as a loader-level extension filter ────────────
// An array entry is a bare name (filters default-discovered extensions),
// a path (loads that extension fresh), or "*" (keep all defaults).
// Filtering happens at the loader via additionalExtensionPaths +
// extensionsOverride — excluded extensions never bind handlers or register
// tools.

describe("extensionCanonicalName", () => {
  it("strips .ts/.js from a single-file extension basename", () => {
    expect(extensionCanonicalName("/x/foo.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo.js")).toBe("foo");
  });
  it("uses the parent directory name for index.{ts,js} extensions", () => {
    expect(extensionCanonicalName("/x/foo/index.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo/index.js")).toBe("foo");
  });
});

describe("parseExtensionsSpec", () => {
  it("classifies bare entries as names", () => {
    const spec = parseExtensionsSpec(["mcp", "logger"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
    expect(spec.paths).toEqual([]);
    expect(spec.wildcard).toBe(false);
  });
  it("treats '*' as the wildcard", () => {
    const spec = parseExtensionsSpec(["*"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names.size).toBe(0);
    expect(spec.paths).toEqual([]);
  });
  it("resolves a relative path against cwd and adds its canonical name", () => {
    const spec = parseExtensionsSpec(["./rel/foo.ts"], "/work");
    expect(spec.paths).toEqual(["/work/rel/foo.ts"]);
    expect(spec.names).toEqual(new Set(["foo"]));
  });
  it("keeps an absolute path as-is", () => {
    const spec = parseExtensionsSpec(["/abs/bar.ts"], "/work");
    expect(spec.paths).toEqual(["/abs/bar.ts"]);
    expect(spec.names).toEqual(new Set(["bar"]));
  });
  it("expands a leading ~ to the home directory", () => {
    const spec = parseExtensionsSpec(["~/ext/baz.ts"], "/work");
    expect(spec.paths[0]).toBe(`${homedir()}/ext/baz.ts`);
    expect(spec.names).toEqual(new Set(["baz"]));
  });
  it("composes wildcard, names, and paths", () => {
    const spec = parseExtensionsSpec(["*", "mcp", "/abs/foo.ts"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names).toEqual(new Set(["mcp", "foo"]));
    expect(spec.paths).toEqual(["/abs/foo.ts"]);
  });
});

describe("agent-runner extension allowlist", () => {
  function setupArrayAgent(extensions: string[]) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }

  it("['*'] short-circuits — no extensionsOverride, behaves like extensions: true", async () => {
    setupArrayAgent(["*"]);
    withExtensions({ "/ext/a.ts": ["tool_a"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.extensionsOverride).toBeUndefined();
    expect(opts.additionalExtensionPaths).toBeUndefined();
    expect(lastToolsPassed()).toContain("tool_a");
  });

  it("['mcp'] keeps only the mcp-named extension, drops others", async () => {
    setupArrayAgent(["mcp"]);
    withExtensions({
      "/ext/mcp.ts": ["mcp", "mcp_call"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).not.toContain("other_tool");
  });

  it("an absolute path is added to additionalExtensionPaths and its extension survives", async () => {
    setupArrayAgent(["/abs/foo.ts"]);
    // Pre-register the path so the mock loader treats it as a successful load.
    withExtensions({ "/abs/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    expect(lastToolsPassed()).toContain("foo_tool");
  });

  it("['*', path] keeps all defaults plus the extra path", async () => {
    setupArrayAgent(["*", "/abs/foo.ts"]);
    withExtensions({
      "/ext/default.ts": ["default_tool"],
      "/abs/foo.ts": ["foo_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("default_tool");
    expect(tools).toContain("foo_tool");
  });

  it("disallowedTools still applies to tools from an allowlisted extension", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: ["mcp"] }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: ["mcp"], disallowedTools: ["mcp"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
  });

  it("warns but proceeds when a bare name matches no loaded extension", async () => {
    setupArrayAgent(["mcp", "typo"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "typo"'),
      }),
    );
  });

  it("warns but proceeds when a path entry fails to load", async () => {
    setupArrayAgent(["/abs/missing.ts"]);
    // Not pre-registered → the mock loader records a load error; the path's
    // canonical name ("missing") is what the unmatched-name check reports.
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "missing"'),
      }),
    );
  });
});

// ─── ext: tool selectors in `tools:` (opt-in flip) ──────────────────────
describe("parseExtSelectors", () => {
  it("bare ext:foo → name only, no narrowing", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.size).toBe(0);
  });
  it("ext:foo/bar → name plus a narrowing entry", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo/bar"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.get("foo")).toEqual(new Set(["bar"]));
  });
  it("multiple ext:foo/* entries union", () => {
    expect(parseExtSelectors(["ext:foo/a", "ext:foo/b"]).narrowing.get("foo")).toEqual(
      new Set(["a", "b"]),
    );
  });
  it("ext:foo + ext:foo/bar → narrowing wins", () => {
    const { narrowing } = parseExtSelectors(["ext:foo", "ext:foo/bar"]);
    expect(narrowing.get("foo")).toEqual(new Set(["bar"]));
  });
  it("splits on the first / so tool names may contain /", () => {
    expect(parseExtSelectors(["ext:foo/bar/baz"]).narrowing.get("foo")).toEqual(
      new Set(["bar/baz"]),
    );
  });
  it("skips empty name and empty tool halves", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:", "ext:foo/"]);
    expect(extNames).toEqual(new Set(["foo"]));
    expect(narrowing.size).toBe(0);
  });
});

describe("agent-runner ext: tool selectors", () => {
  function setupExtAgent(o: {
    extensions: boolean | string[];
    builtinToolNames: string[];
    extSelectors?: string[];
    disallowedTools?: string[];
  }) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: o.extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({
        extensions: o.extensions,
        extSelectors: o.extSelectors,
        disallowedTools: o.disallowedTools,
      }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames);
  }

  it("any ext: entry flips extension tools to an allowlist — non-selected extensions muted", async () => {
    // `tools: ext:foo` → zero built-ins, opt-in flip active.
    setupExtAgent({ extensions: true, builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool"); // loaded but muted
    expect(tools).not.toContain("read"); // tools: ext:foo → no built-ins
    // both extensions still load — no loader override needed under extensions: true
    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
  });

  it("'*' alongside ext: keeps all built-ins while the flip still applies", async () => {
    // `tools: *, ext:foo` → all built-ins, opt-in flip active.
    setupExtAgent({ extensions: true, builtinToolNames: BUILTINS_7, extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    for (const b of BUILTINS_7) expect(tools).toContain(b);
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
  });

  it("ext:foo/bar narrows foo to a single tool", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"] });
    withExtensions({ "/ext/foo.ts": ["bar", "baz"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).toContain("bar");
    expect(tools).not.toContain("baz");
  });

  it("ext:foo pulls a discoverable extension in even when extensions: false", async () => {
    setupExtAgent({ extensions: false, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // noExtensions must be false so foo can load; override keeps only foo.
    expect(lastLoaderOpts().noExtensions).toBe(false);
    const tools = lastToolsPassed();
    expect(tools).toEqual(expect.arrayContaining(["read", "foo_tool"]));
    expect(tools).not.toContain("other_tool");
  });

  it("ext: name joins the loader keep-set; a loaded-but-unselected extension is muted", async () => {
    setupExtAgent({ extensions: ["a"], builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/a.ts": ["a_tool"], "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("a_tool"); // a loads (handlers fire) but is muted
  });

  it("['*'] short-circuit survives ext: narrowing", async () => {
    setupExtAgent({ extensions: ["*"], builtinToolNames: ["read"], extSelectors: ["ext:foo/bar"] });
    withExtensions({ "/ext/foo.ts": ["bar", "baz"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined(); // pure-["*"] short-circuit holds
    const tools = lastToolsPassed();
    expect(tools).toContain("bar");
    expect(tools).not.toContain("baz");
    expect(tools).not.toContain("other_tool"); // flip mutes the unselected extension
  });

  it("warns but proceeds when an ext: name never loads", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:ghost"] });
    withExtensions({ "/ext/real.ts": ["real_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "ghost"'),
      }),
    );
  });

  it("isolated: true ignores extSelectors — no extension tools", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
    expect(lastLoaderOpts().noExtensions).toBe(true);
  });
});
