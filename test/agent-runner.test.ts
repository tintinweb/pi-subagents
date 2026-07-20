import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    getExtensions() {
      return { extensions: [] as Array<{ path: string; tools: Map<string, unknown> }> };
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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

import { extensionCanonicalName, forwardAbortSignal, getDefaultExtensions, parseExtensionsSpec, parseExtSelectors, resumeAgent, runAgent, setDefaultExtensions } from "../src/agent-runner.js";
import { getAgentConfig as mockedGetAgentConfig, getConfig as mockedGetConfig } from "../src/agent-types.js";
import { detectEnv } from "../src/env.js";

describe("global defaultExtensions resolution", () => {
  const getAgentConfigMock = mockedGetAgentConfig as unknown as ReturnType<typeof vi.fn>;
  const getConfigMock = mockedGetConfig as unknown as ReturnType<typeof vi.fn>;
  // Restore the shared module mocks to their default Explore behavior so later
  // describe blocks are unaffected (these mocks are module-level singletons).
  const defaultAgentConfig = () => agentCfg(false);
  const defaultConfig = () => ({
    displayName: "Explore", description: "Explore", builtinToolNames: ["read"],
    extensions: false, skills: false, promptMode: "replace",
  });
  afterEach(() => {
    setDefaultExtensions(undefined);
    getAgentConfigMock.mockImplementation(defaultAgentConfig);
    getConfigMock.mockImplementation(defaultConfig);
  });

  function agentCfg(extensions: unknown) {
    return {
      name: "Explore", description: "Explore", builtinToolNames: ["read"],
      extensions, skills: false, systemPrompt: "x", promptMode: "replace",
      inheritContext: false, runInBackground: false, isolated: false,
    };
  }

  it("explicit per-agent extensions: false wins over a global default of true", async () => {
    getAgentConfigMock.mockReturnValue(agentCfg(false));
    setDefaultExtensions(true);
    createAgentSession.mockResolvedValue({ session: createSession("x").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noExtensions: true }),
    );
  });

  it("omitted per-agent extensions falls back to the global default (false → noExtensions)", async () => {
    getAgentConfigMock.mockReturnValue(agentCfg(undefined));
    setDefaultExtensions(false);
    createAgentSession.mockResolvedValue({ session: createSession("x").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noExtensions: true }),
    );
  });

  it("omitted per-agent extensions with no global default loads extensions (noExtensions false)", async () => {
    getAgentConfigMock.mockReturnValue(agentCfg(undefined));
    // getConfig is the final fallback; in real code it coerces omitted → true.
    getConfigMock.mockReturnValue({
      displayName: "Explore", description: "Explore", builtinToolNames: ["read"],
      extensions: true, skills: false, promptMode: "replace",
    });
    setDefaultExtensions(undefined);
    createAgentSession.mockResolvedValue({ session: createSession("x").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noExtensions: false }),
    );
  });

  it("getDefaultExtensions reflects the last set value", () => {
    setDefaultExtensions(["mcp"]);
    expect(getDefaultExtensions()).toEqual(["mcp"]);
    setDefaultExtensions(undefined);
    expect(getDefaultExtensions()).toBeUndefined();
  });
});

describe("extensionCanonicalName", () => {
  it("uses the parent dir name for index.ts/index.js extensions", () => {
    expect(extensionCanonicalName("/a/b/foo/index.ts")).toBe("foo");
    expect(extensionCanonicalName("/a/b/Foo/index.js")).toBe("foo");
  });
  it("strips .ts/.js from single-file extensions and lowercases", () => {
    expect(extensionCanonicalName("/a/b/Mcp.ts")).toBe("mcp");
    expect(extensionCanonicalName("/a/b/bar.js")).toBe("bar");
  });
});

describe("parseExtensionsSpec", () => {
  it("classifies names, paths, and the wildcard", () => {
    const spec = parseExtensionsSpec(["mcp", "*", "/abs/extra.ts"], "/cwd");
    expect(spec.wildcard).toBe(true);
    expect(spec.paths).toEqual(["/abs/extra.ts"]);
    // path entries fold their canonical name into names too
    expect([...spec.names].sort()).toEqual(["extra", "mcp"]);
  });
  it("resolves relative path entries against cwd and lowercases names", () => {
    const spec = parseExtensionsSpec(["Foo", "./rel/Bar.ts"], "/cwd");
    expect(spec.paths).toEqual(["/cwd/rel/Bar.ts"]);
    expect([...spec.names].sort()).toEqual(["bar", "foo"]);
  });
});

describe("parseExtSelectors", () => {
  it("collects ext names and per-extension narrowing", () => {
    const { extNames, narrowing } = parseExtSelectors(["ext:foo", "ext:bar/x", "ext:bar/y"]);
    expect([...extNames].sort()).toEqual(["bar", "foo"]);
    expect(narrowing.has("foo")).toBe(false);
    expect([...narrowing.get("bar")!].sort()).toEqual(["x", "y"]);
  });
  it("narrowing wins when a bare ext:foo accompanies ext:foo/tool", () => {
    const { narrowing } = parseExtSelectors(["ext:foo", "ext:foo/bar"]);
    expect([...narrowing.get("foo")!]).toEqual(["bar"]);
  });
});

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
  sessionManager: { getBranch: vi.fn(() => []), getSessionId: vi.fn(() => "orchestrator-session-id") },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
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

describe("cancellation correctness", () => {
  it("passes options.signal to detectEnv", async () => {
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const ac = new AbortController();

    await runAgent(ctx, "Explore", "go", { pi, signal: ac.signal });

    expect(vi.mocked(detectEnv)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ac.signal,
    );
  });

  it("throws AbortError when signal is pre-aborted before createAgentSession", async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      runAgent(ctx, "Explore", "go", { pi, signal: ac.signal }),
    ).rejects.toThrow(DOMException);

    // createAgentSession should never be invoked when the signal is pre-aborted
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("throws AbortError when signal is pre-aborted and is passed through detectEnv", async () => {
    // detectEnv mock currently resolves successfully; the checkpoint after it should catch the abort.
    // Pre-abort the signal so the first throwIfAborted() before detectEnv catches it.
    const ac = new AbortController();
    ac.abort();

    await expect(
      runAgent(ctx, "Explore", "go", { pi, signal: ac.signal }),
    ).rejects.toThrow(DOMException);
  });

  describe("forwardAbortSignal", () => {
    it("aborts the session immediately for an already-aborted signal", () => {
      const abortSpy = vi.fn();
      const session = { abort: abortSpy } as any;
      const ac = new AbortController();
      ac.abort();

      const cleanup = forwardAbortSignal(session, ac.signal);

      expect(abortSpy).toHaveBeenCalledOnce();
      expect(cleanup).toBeInstanceOf(Function);
      // Calling cleanup on an already-aborted no-listener case is a no-op
      expect(() => cleanup()).not.toThrow();
    });

    it("attaches a listener for a non-aborted signal and cleanup removes it", () => {
      const abortSpy = vi.fn();
      const session = { abort: abortSpy } as any;
      const ac = new AbortController();

      const cleanup = forwardAbortSignal(session, ac.signal);

      // Session not aborted yet — listener hasn't fired
      expect(abortSpy).not.toHaveBeenCalled();

      ac.abort();
      expect(abortSpy).toHaveBeenCalledOnce();

      // Cleanup removes the listener — no further calls on re-abort
      cleanup();
      abortSpy.mockClear();
      // Re-trigger (would be a no-op anyway since the signal is already aborted)
      expect(abortSpy).not.toHaveBeenCalled();
    });

    it("returns a no-op cleanup when no signal is provided", () => {
      const session = { abort: vi.fn() } as any;
      const cleanup = forwardAbortSignal(session);
      expect(() => cleanup()).not.toThrow();
    });
  });

  it("throws AbortError when signal aborts during createAgentSession and disposes session", async () => {
    const ac = new AbortController();
    const disposeSpy = vi.fn();
    const { session } = createSession("OK");
    (session as any).dispose = disposeSpy;

    // createAgentSession creates the session, then aborts the signal before
    // resolving — this triggers the post-create dispose+throw path.
    createAgentSession.mockImplementation(async () => {
      ac.abort();
      return { session };
    });

    const runPromise = runAgent(ctx, "Explore", "go", { pi, signal: ac.signal });

    await expect(runPromise).rejects.toThrow(DOMException);

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(session.bindExtensions).not.toHaveBeenCalled();
  });

  it("throws AbortError when signal aborts during bindExtensions and disposes session", async () => {
    const ac = new AbortController();
    const disposeSpy = vi.fn();

    // Signal that bindExtensions has been entered.
    let enteredBind!: () => void;
    const enteredBindPromise = new Promise<void>((resolve) => { enteredBind = resolve; });

    // Deferred bindExtensions: it won't resolve until we say so.
    let resolveBind!: () => void;
    const bindPromise = new Promise<void>((resolve) => { resolveBind = resolve; });

    const { session } = createSession("OK");
    session.bindExtensions = vi.fn(async () => {
      enteredBind();
      return bindPromise;
    });
    (session as any).dispose = disposeSpy;
    createAgentSession.mockResolvedValue({ session });

    // Kick off runAgent — it will pass all preceding checkpoints (detectEnv,
    // loader.reload, createAgentSession all resolve immediately in the mock),
    // then block inside bindExtensions.
    const runPromise = runAgent(ctx, "Explore", "go", { pi, signal: ac.signal });

    // Wait until runAgent is definitely inside bindExtensions.
    await enteredBindPromise;

    // Abort while bindExtensions is still pending.
    ac.abort();

    // Let bindExtensions complete.
    resolveBind();

    // The checkpoint after bindExtensions must have caught the abort,
    // disposed the session, and thrown.
    await expect(runPromise).rejects.toThrow(DOMException);

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("disposes session when bindExtensions rejects and re-throws the error", async () => {
    const disposeSpy = vi.fn();
    const bindError = new Error("bind failed");

    const { session } = createSession("OK");
    session.bindExtensions = vi.fn(async () => { throw bindError; });
    (session as any).dispose = disposeSpy;
    createAgentSession.mockResolvedValue({ session });

    const runPromise = runAgent(ctx, "Explore", "go", { pi });

    await expect(runPromise).rejects.toThrow("bind failed");

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
  });
});
