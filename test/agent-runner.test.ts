import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerInMemory,
  sessionManagerCreate,
  sessionManagerOpen,
  settingsManagerCreate,
  settingsManagerGetSessionDir,
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
  sessionManagerCreate: vi.fn(() => ({ kind: "persistent-session-manager" })),
  sessionManagerOpen: vi.fn(() => ({ kind: "reopened-session-manager" })),
  settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
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
      // Mirror the real loader: `noExtensions: true` zeros out the discovered set
      // entirely. Otherwise tests pre-register the extensions a path should
      // resolve to; an unregistered path simply yields no extension (a failed load).
      if (this.opts.noExtensions) {
        loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
        return;
      }
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory, create: sessionManagerCreate, open: sessionManagerOpen },
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

vi.mock("../src/nested-tools.js", () => ({
  getMaxSubagentDepth: vi.fn(() => 2),
  createNestedSubagentTools: vi.fn(() => [
    { name: "Agent" },
    { name: "get_subagent_result" },
    { name: "steer_subagent" },
  ]),
}));

import {
  extensionCanonicalName,
  extensionCanonicalNames,
  getAgentConversation,
  getDefaultMaxTurns,
  getGraceTurns,
  parseExtensionsSpec,
  parseExtSelectors,
  resolveDefaultModel,
  resolveEffectiveMaxTurns,
  resumeAgent,
  runAgent,
  SUBAGENT_TOOL_NAMES,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "../src/agent-runner.js";

/** The most recent session built by `createSession` — read by `lastToolsPassed()`. */
let lastSession: ReturnType<typeof createSession>["session"] | undefined;

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  // pi activates only these four by default when no allowlist is given
  // (agent-session.js `defaultActiveToolNames`).
  let activeToolNames: string[] = ["read", "bash", "edit", "write"];
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
    // Stateful, so the active set reflects what the scope installer actually did
    // and `renarrow`'s no-op guard behaves as it does against real pi.
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeToolNames = [...names];
    }),
    // pi's tool REGISTRY (`_toolDefinitions`), read live so tests can simulate an
    // extension registering after bind by mutating `loaderExtensionsRef`.
    getAllTools: vi.fn(() => {
      const opts = createAgentSession.mock.calls[0]?.[0];
      return opts ? mockRegistry(opts).map((name) => ({ name })) : [];
    }),
    // pi's Agent; `beforeToolCall` is an optional, assignable hook the scope
    // installer wraps to block out-of-scope calls on turn 1.
    agent: { beforeToolCall: undefined } as {
      beforeToolCall?: (context: any, signal?: any) => Promise<any>;
    },
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  lastSession = session;
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
  },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  sessionManagerCreate.mockClear();
  sessionManagerOpen.mockClear();
  // The setting is process-global; a test that flips it must not leak the
  // flip into the next one.
  setRememberAgents(true);
  settingsManagerGetSessionDir.mockReset();
  settingsManagerGetSessionDir.mockReturnValue(undefined);
  settingsManagerCreate.mockClear();
  vi.mocked(createNestedSubagentTools).mockClear();
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
  lastSession = undefined;
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
    // Same claim as before `rememberAgents` flipped the default — the effective
    // cwd reaches the session manager — now via the persistent constructor.
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp/worktree", undefined, expect.anything());
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("forwards worktree isolation details to the prompt builder, and omits them otherwise", async () => {
    const { buildAgentPrompt } = await import("../src/prompts.js");
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", {
      pi,
      cwd: "/wt/copy",
      worktreeBase: "/repo",
      worktreeBackend: "jj",
    });
    expect(vi.mocked(buildAgentPrompt).mock.lastCall![4]).toMatchObject({
      worktreeBase: "/repo",
      worktreeBackend: "jj",
    });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });
    expect(vi.mocked(buildAgentPrompt).mock.lastCall![4]).not.toHaveProperty("worktreeBase");
    expect(vi.mocked(buildAgentPrompt).mock.lastCall![4]).not.toHaveProperty("worktreeBackend");
  });

  it("passes the parent model runtime while retaining the legacy model registry", async () => {
    const { session } = createSession("AUTHENTICATED");
    createAgentSession.mockResolvedValue({ session });
    const modelRuntime = { getAuth: vi.fn(), hasConfiguredAuth: vi.fn() };
    const context = {
      ...ctx,
      modelRegistry: { ...ctx.modelRegistry, runtime: modelRuntime },
    };

    await runAgent(context, "Explore", "Say AUTHENTICATED", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      modelRegistry: context.modelRegistry,
      modelRuntime,
    }));
  });

  it("omits modelRuntime when the legacy registry does not expose one", async () => {
    const { session } = createSession("LEGACY");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say LEGACY", { pi });

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("modelRuntime");
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

    expect(result.text).toBe("RESUMED");
    expect(result.failure).toBeUndefined();
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

// #144 — a failed FINAL assistant turn (stopReason "error") must surface as
// `failure`; how the turn STOPPED decides, never whether it produced text.
describe("agent-runner failed-final-turn detection (#144)", () => {
  /** Session whose prompt() appends the given messages to history. */
  function sessionEnding(...messages: any[]) {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(...messages);
    }) as any;
    return session;
  }

  const errorFinal = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "retries exhausted: 529 overloaded",
  };

  it("flags a run whose final turn is an empty provider error", async () => {
    const session = sessionEnding(errorFinal);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("flags the failure even when an EARLIER turn produced text (no masking)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "partial progress" }] },
      { role: "toolResult", content: [] },
      errorFinal,
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    // The earlier text stays available as context — status honesty, not data loss.
    expect(result.responseText).toBe("partial progress");
  });

  it("flags a provider error that left partial text in the SAME final message", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated answ" }],
      stopReason: "error",
      errorMessage: "stream ended before message_stop",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("stream ended before message_stop");
    expect(result.responseText).toBe("truncated answ");
  });

  it("flags a run whose final turn hit the token limit with no text (#144 residual)", async () => {
    // stopReason "length" with empty content is a silent max-token death — it
    // reproduces the #144 "completed with No output." symptom, so it must fail.
    const session = sessionEnding({ role: "assistant", content: [], stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("run hit the output token limit before producing any text");
  });

  it("does NOT flag a length stop that produced text (truncated answer completes)", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated but useful answer" }],
      stopReason: "length",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("truncated but useful answer");
  });

  it("does NOT flag an empty final turn that stopped cleanly (no false failures)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "did the work" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [], stopReason: "stop" },
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("did the work"); // walk-back fallback preserved
  });

  it("resumeAgent applies the same rule", async () => {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "Continue");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("resume whose new turn fails empty does NOT return the previous turn's answer (#144)", async () => {
    // The session already carries a completed prior turn; the resume prompt then
    // fails empty. The walk-back must be bounded to this resume — result "".
    const { session } = createSession("");
    session.messages.push(
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "user", content: "follow-up" }, errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "follow-up");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe(""); // NOT "PREVIOUS ANSWER"
  });

  it("resume that produces partial text before failing returns only THIS resume's text", async () => {
    const { session } = createSession("");
    session.messages.push(
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push(
        { role: "assistant", content: [{ type: "text", text: "new partial" }] },
        { role: "toolResult", content: [] },
        errorFinal,
      );
    }) as any;

    const result = await resumeAgent(session as any, "go");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe("new partial"); // this resume's progress, not the prior answer
  });

  it("collector: a toolResult/user message_start no longer wipes collected assistant text", async () => {
    const { session, listeners } = createSession("");
    createAgentSession.mockResolvedValue({ session });
    session.prompt = vi.fn(async () => {
      for (const l of listeners) {
        l({ type: "message_start", message: { role: "assistant" } });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "STREAMED" } });
        // pi emits message_start for tool results and queued user messages too.
        l({ type: "message_start", message: { role: "toolResult" } });
        l({ type: "message_start", message: { role: "user" } });
      }
    }) as any;

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.responseText).toBe("STREAMED");
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

    const seen: Array<{ input: number; output: number; cacheWrite: number; cost?: number }> = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: { total: 0.002 } });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: { total: 0.004 } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    // cacheRead rides along even though the display total drops it (#38): the
 // prefix is genuinely re-billed per call, and the parent-session report needs it.
    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.002 },
      { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.004 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite, cacheRead, cost missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    // An unpriced model reports no `cost` object at all — 0, never undefined,
    // so accumulators never have to special-case it.
    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }]);
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
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5, cacheRead: 90, cost: { total: 0.001 } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5, cacheRead: 90, cost: 0.001 }]);
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

// getAgentConversation renders the subagent transcript shown in the /agents
// inspect overlay. Pure function over session.messages — no mocks needed
// beyond a literal-object session.
describe("getAgentConversation", () => {
  function fakeSession(messages: unknown[]) {
    return { messages } as never;
  }

  it("returns an empty string for a session with no messages", () => {
    expect(getAgentConversation(fakeSession([]))).toBe("");
  });

  it("formats a user-then-assistant exchange with role-prefixed lines joined by blank lines", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    );
    expect(out).toBe("[User]: hi\n\n[Assistant]: hello");
  });

  it("accepts user content as content-blocks (not just strings)", () => {
    const out = getAgentConversation(
      fakeSession([{ role: "user", content: [{ type: "text", text: "from blocks" }] }]),
    );
    expect(out).toBe("[User]: from blocks");
  });

  it("emits a [Tool Calls] block listing each toolCall by name or toolName, falling back to 'unknown'", () => {
    const out = getAgentConversation(
      fakeSession([
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tools" },
            { type: "toolCall", name: "search" },
            { type: "toolCall", toolName: "edit" },
            { type: "toolCall" },
          ],
        },
      ]),
    );
    expect(out).toContain("[Assistant]: calling tools");
    expect(out).toContain("[Tool Calls]:\n  Tool: search\n  Tool: edit\n  Tool: unknown");
  });

  it("truncates toolResult content beyond 200 chars and tags it with the tool name", () => {
    const longText = "x".repeat(300);
    const out = getAgentConversation(
      fakeSession([
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: longText }],
        },
      ]),
    );
    expect(out.startsWith("[Tool Result (bash)]: ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    // prefix + 200 chars + "..."
    expect(out.length).toBe("[Tool Result (bash)]: ".length + 200 + 3);
  });

  it("emits [Tool Calls] but no [Assistant] when the assistant only made tool calls", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
      ]),
    );
    expect(out).toContain("[User]: do it");
    expect(out).not.toContain("[Assistant]:");
    expect(out).toContain("[Tool Calls]:\n  Tool: search");
  });
});

// ─── tool scoping (issues #47, #125) ─────────────────────────────────────
// runAgent scopes a subagent's tools in one of two ways:
//   • Static allowlist (`tools:`) — ONLY for noExtensions/isolated. Nothing can
//     register asynchronously there, so pi-mono's `allowedToolNames` gating both
//     registration and the initial active set is exactly right.
//   • Live scoping — whenever extensions load. `tools:` is left unset so pi's
//     live `isAllowedTool` admits tools whenever they register (pi-mcp registers
//     on session_start, context-mode on before_agent_start); `excludeTools:`
//     carries the name-stable permanent scope; and `installExtensionToolScope`
//     narrows the ACTIVE set for `ext:` selectors, re-deriving on every turn_end
//     so late arrivals are judged too.
// `lastToolsPassed()` returns what the LLM can actually call under either shape.

import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
} from "../src/agent-types.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";

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

/**
 * The tool REGISTRY pi would build for a given `createAgentSession` call —
 * mirroring `_refreshToolRegistry`'s `isAllowedTool`:
 *   - `tools:` set   → the allowlist gates the registry (nothing else registers).
 *   - `tools:` unset → every built-in plus every loaded extension tool, minus
 *     `excludeTools`, and it keeps growing as extensions register later.
 * Read live from `loaderExtensionsRef`, so a test can simulate late registration.
 */
function mockRegistry(opts: Record<string, any>): string[] {
  const excluded = new Set<string>(opts.excludeTools ?? []);
  // pi registers customTools into the same registry, subject to the same gate.
  const customNames: string[] = (opts.customTools ?? []).map((t: any) => t.name);
  const all: string[] = opts.tools
    ? [...opts.tools, ...customNames]
    : [
        ...BUILTINS_7,
        ...loaderExtensionsRef.current.extensions.flatMap((e) => [...e.tools.keys()]),
        ...customNames,
      ];
  return [...new Set(all)].filter((t) => !excluded.has(t));
}

/**
 * What the LLM can actually call.
 *
 * Under the static allowlist (`noExtensions`/`isolated`) that is `tools:` verbatim.
 * Otherwise the registry is scoped by `excludeTools` and then narrowed to the ACTIVE
 * set by `installExtensionToolScope` — so the active set is the real answer, and
 * asserting on it means these tests exercise the narrowing rather than a
 * reimplementation of pi's gate.
 */
function lastToolsPassed(): string[] {
  const opts = createAgentSession.mock.calls[0][0];
  if (opts.tools) return opts.tools;
  return lastSession?.getActiveToolNames() ?? [];
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0][0];
}

describe("agent-runner session persistence", () => {
  it("persists by default, so a handle can reopen the conversation later", async () => {
    // `rememberAgents` defaults on: the session file is the only thing an
    // evicted agent leaves behind, so without it `@explore` after cleanup
    // could only ever start a fresh agent.
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "persistent-session-manager" },
    }));
  });

  it("keeps the session in memory when rememberAgents is off", async () => {
    setRememberAgents(false);
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp");
    expect(sessionManagerCreate).not.toHaveBeenCalled();
  });

  it("lets frontmatter override rememberAgents in both directions", async () => {
    // The setting is only a default. An agent that declares itself ephemeral
    // stays ephemeral with the setting on...
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: false }));
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(sessionManagerInMemory).toHaveBeenCalled();
    expect(sessionManagerCreate).not.toHaveBeenCalled();

    // ...and one that declares itself persistent still persists with it off.
    sessionManagerInMemory.mockClear();
    setRememberAgents(false);
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });
    await runAgent(ctx, "Explore", "go", { pi });
    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
  });

  it("leaves a nested child in memory, since nothing can address it later", async () => {
    // The default exists so `@handle` can reopen a conversation. A nested agent
    // never gets a handle, so its transcript would be unreachable by anything —
    // pure disk and /resume clutter.
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });

    await runAgent(ctx, "Explore", "go", { pi, nested: true });

    expect(sessionManagerInMemory).toHaveBeenCalled();
    expect(sessionManagerCreate).not.toHaveBeenCalled();
  });

  it("still persists a nested child that asks for it in frontmatter", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    createAgentSession.mockResolvedValue({ session: createSession("OK").session });

    await runAgent(ctx, "Explore", "go", { pi, nested: true });

    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
  });

  it("reopens an existing session file instead of starting a new conversation", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "carry on", { pi, resumeSessionFile: "/sessions/explore.jsonl" });

    // Neither create nor inMemory: both would start an empty conversation, and
    // the point of a resume is that the history is already there.
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerOpen).toHaveBeenCalledWith("/sessions/explore.jsonl", "/normal/pi/sessions");
  });

  it("uses pi's normal persistent session location and links to the parent session", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/tmp",
      "/normal/pi/sessions",
      { parentSession: "/sessions/parent.jsonl" },
    );
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "persistent-session-manager" },
    }));
  });

  it("uses a frontmatter sessionDir when persistSession is true and sessionDir is configured", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ persistSession: true, sessionDir: ".seams/pi-sessions/seam-plan-reviewer" }),
    );
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/repo",
      "/repo/.seams/pi-sessions/seam-plan-reviewer",
      { parentSession: "/sessions/parent.jsonl" },
    );
  });
});

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

  it("keeps nested tools unavailable without explicit opt-in", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
    });

    expect(createNestedSubagentTools).not.toHaveBeenCalled();
    expect(lastToolsPassed()).not.toContain("Agent");
    expect(createAgentSession.mock.calls[0][0].customTools).toEqual([]);
  });

  it("injects scoped nested tools for an opted-in non-isolated agent", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: ["scout"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const manager = {} as any;

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
    });

    expect(createNestedSubagentTools).toHaveBeenCalledWith(expect.objectContaining({
      manager,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: ["scout"],
      configCwd: "/tmp",
    }));
    expect(lastToolsPassed()).toEqual(expect.arrayContaining([
      "Agent", "get_subagent_result", "steer_subagent",
    ]));
    expect(createAgentSession.mock.calls[0][0].customTools).toHaveLength(3);
  });

  it("keeps opt-in nested tools active UNDER EXTENSIONS despite the EXCLUDED-name collision", async () => {
    // The nested tool names ARE EXCLUDED_TOOL_NAMES. Under the denylist mechanism
    // they must (a) not be excluded from the registry, and (b) survive the live
    // installExtensionToolScope renarrow that strips EXCLUDED_TOOL_NAMES.
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, allowedSubagents: "all" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/ok.ts": ["ok_ext"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
    });

    const opts = createAgentSession.mock.calls[0][0];
    // (a) not denied at the registry gate, and passed as customTools.
    expect(opts.excludeTools ?? []).not.toContain("Agent");
    expect(opts.customTools).toHaveLength(3);
    // (b) survive the active-set renarrow alongside a real extension tool.
    const active = lastToolsPassed();
    expect(active).toEqual(expect.arrayContaining(["Agent", "get_subagent_result", "steer_subagent"]));
    expect(active).toContain("ok_ext");
  });

  // Opt-in nested tools are re-admitted at three separate places because their
  // names collide with EXCLUDED_TOOL_NAMES. Every one of those re-admissions
  // carries a `disallowedTools` check, and no test set `disallowed_tools` and
  // `allowed_subagents` together — so dropping any of the three checks would
  // hand `Agent` back to an agent whose author explicitly denied it, with the
  // suite still green.
  describe("disallowed_tools beats opt-in nested delegation", () => {
    it("denies the tool under the isolated static allowlist", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({ extensions: false, allowedSubagents: "all", disallowedTools: ["Agent"] }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
      });

      const tools = lastToolsPassed();
      expect(tools).not.toContain("Agent");
      // The siblings the agent did NOT deny stay available.
      expect(tools).toEqual(expect.arrayContaining(["get_subagent_result", "steer_subagent"]));
    });

    it("denies the tool at the registry gate under extensions", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({ extensions: true, allowedSubagents: "all", disallowedTools: ["Agent"] }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      withExtensions({ "/ext/ok.ts": ["ok_ext"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
      });

      expect(createAgentSession.mock.calls[0][0].excludeTools ?? []).toContain("Agent");
      expect(lastToolsPassed()).not.toContain("Agent");
    });

    it("blocks the tool at runtime even though it was injected as a customTool", async () => {
      // The registry gate and the active set are static snapshots; this is the
      // live gate that judges a call as it happens. A nested tool is handed to
      // the session as a customTool, so this is the last line of defense.
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({ extensions: true, allowedSubagents: "all", disallowedTools: ["Agent"] }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      withExtensions({ "/ext/ok.ts": ["ok_ext"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
      });

      await expect(
        session.agent.beforeToolCall?.({ toolCall: { name: "Agent" } }),
      ).resolves.toMatchObject({ block: true });
      // ...while a nested tool that was NOT denied still passes the same gate.
      await expect(
        session.agent.beforeToolCall?.({ toolCall: { name: "steer_subagent" } }),
      ).resolves.not.toMatchObject({ block: true });
    });

    it("a partial denial does not take down the whole nested set", async () => {
      vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
      vi.mocked(getAgentConfig).mockReturnValueOnce(
        makeAgentConfig({
          extensions: false,
          allowedSubagents: ["scout"],
          disallowedTools: ["get_subagent_result"],
        }),
      );
      vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", {
        pi,
        nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
      });

      const tools = lastToolsPassed();
      expect(tools).not.toContain("get_subagent_result");
      expect(tools).toContain("Agent");
      expect(tools).toContain("steer_subagent");
    });
  });

  it("still strips the orchestration tools under extensions when nesting is OFF", async () => {
    // Guards the negative: without allowed_subagents the EXCLUDED names stay denied
    // and inactive even though an extension registers tools with those very names.
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/evil.ts": ["Agent", "get_subagent_result", "steer_subagent", "ok_ext"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const active = lastToolsPassed();
    expect(active).not.toContain("Agent");
    expect(active).not.toContain("get_subagent_result");
    expect(active).not.toContain("steer_subagent");
    expect(active).toContain("ok_ext");
  });

  it("suppresses nested tools in isolated mode even when opted in", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: "all" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      isolated: true,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1 },
    });

    expect(createNestedSubagentTools).not.toHaveBeenCalled();
    expect(lastToolsPassed()).not.toContain("Agent");
  });

  it("passes the inherited depth cap through to the nested tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: "all" }),
    );
    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
    });
    expect(createNestedSubagentTools).toHaveBeenLastCalledWith(expect.objectContaining({ maxSubagentDepth: 3 }));
  });

  it("injects no nested tools once the effective cap is reached", async () => {
    // At the cap the agent can never spawn — and so can never own a child to
    // fetch from or steer. Three always-erroring tools would just cost context.
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, allowedSubagents: "all" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", {
      pi,
      nestedRuntime: { manager: {} as any, parentAgentId: "parent", depth: 1, maxSubagentDepth: 1 },
    });

    expect(createNestedSubagentTools).not.toHaveBeenCalled();
    expect(lastToolsPassed()).not.toContain("Agent");
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

  it("dynamic mode: leaves the allowlist unset, denies via excludeTools, activates post-bind", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, disallowedTools: ["bash"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Allowlist unset so async tools (e.g. MCP on session_start) can register;
    // scope is a denylist of this extension's own tools plus `disallowedTools`.
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toBeUndefined();
    expect(new Set(opts.excludeTools)).toEqual(
      new Set([...Object.values(SUBAGENT_TOOL_NAMES), "bash"]),
    );

    // The active set is repaired AFTER bindExtensions (tools may register during
    // session_start), activating the full allowed registry — the extension tool
    // included, the denied built-in excluded.
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    const setOrder = session.setActiveToolsByName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeGreaterThan(bindOrder);
    const activated = new Set(session.setActiveToolsByName.mock.calls[0][0]);
    expect(activated.has("mcp")).toBe(true);
    expect(activated.has("read")).toBe(true);
    expect(activated.has("bash")).toBe(false);
  });
});

// ─── asynchronously-registered extension tools (issue #125) ──────────────
// pi-mcp calls registerTool from `session_start`, context-mode from
// `before_agent_start` — both long after loader.reload(). `registerTool` writes
// into the live `extension.tools` map, which is what these tests simulate.
describe("agent-runner async extension tool registration", () => {
  /** Simulate `pi.registerTool` on an already-loaded extension. */
  function registerLate(extPath: string, toolName: string) {
    const ext = loaderExtensionsRef.current.extensions.find((e) => e.path === extPath);
    if (!ext) throw new Error(`no loaded extension at ${extPath}`);
    ext.tools.set(toolName, {});
  }

  function setup(o: { builtinToolNames?: string[]; extSelectors?: string[] } = {}) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, extSelectors: o.extSelectors }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames ?? ["read"]);
  }

  it("a tool registered during session_start reaches the active set", async () => {
    setup();
    withExtensions({ "/ext/mcp.ts": [] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    // pi-mcp's real shape: nothing at load, tools appear when bindExtensions
    // fires session_start and the MCP servers connect.
    session.bindExtensions.mockImplementation(async () => {
      registerLate("/ext/mcp.ts", "mcp_search");
    });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastToolsPassed()).toContain("mcp_search");
  });

  it("a tool registered after bind is picked up on the next turn_end", async () => {
    setup();
    withExtensions({ "/ext/mcp.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    expect(session.getActiveToolNames()).not.toContain("mcp_search");

    // A lazy MCP server connects mid-conversation (context-mode registers at
    // before_agent_start, i.e. after runAgent already installed the scope).
    registerLate("/ext/mcp.ts", "mcp_search");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("mcp_search");
  });

  it("ext: admits a late tool from the selected extension but not from others", async () => {
    setup({ extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    const active = session.getActiveToolNames();
    expect(active).toContain("foo_late");
    // This is the case the static allowlist could never express: bar_late did
    // not exist at construction, so it could not have been denied by name.
    expect(active).not.toContain("bar_late");
  });

  it("ext:foo/bar narrowing still applies to late-registered siblings", async () => {
    setup({ extSelectors: ["ext:foo/keep_me"] });
    withExtensions({ "/ext/foo.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "keep_me");
    registerLate("/ext/foo.ts", "drop_me");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("keep_me");
    expect(session.getActiveToolNames()).not.toContain("drop_me");
  });

  it("beforeToolCall blocks an out-of-scope tool and delegates otherwise", async () => {
    // Turn 1 cannot be narrowed — before_agent_start fires inside prompt() and
    // may widen the set after the turn's tools are snapshotted — so a call-time
    // guard is the only correct enforcement there.
    setup({ extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/bar.ts": ["bar_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_tool" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } }),
    ).resolves.toBeUndefined();
  });

  it("beforeToolCall preserves a hook pi installed before us", async () => {
    setup();
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    const prior = vi.fn(async () => undefined);
    session.agent.beforeToolCall = prior;
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } });

    expect(prior).toHaveBeenCalledTimes(1);
  });

  it("scope outlives runAgent so resumed turns stay narrowed", async () => {
    // runAgent tears down its own turn subscription in `finally`; the scope
    // hooks must NOT be torn down with it, or resume/steer would drift.
    setup({ extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await resumeAgent(session as any, "keep going");

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("foo_late");
    expect(session.getActiveToolNames()).not.toContain("bar_late");
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_late" } }),
    ).resolves.toMatchObject({ block: true });
  });

  it("isolated keeps the static allowlist — no live scoping installed", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read"]);
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    // A hard registry gate is the right boundary here: nothing can register
    // asynchronously, so there is no active-set narrowing to maintain.
    expect(createAgentSession.mock.calls[0][0].tools).toEqual(["read"]);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.agent.beforeToolCall).toBeUndefined();
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
  it("lowercases the result for case-insensitive matching", () => {
    expect(extensionCanonicalName("/x/MCP.ts")).toBe("mcp");
    expect(extensionCanonicalName("/x/MyExt.js")).toBe("myext");
    expect(extensionCanonicalName("/x/Foo/index.ts")).toBe("foo");
  });
});

describe("extensionCanonicalNames (#143 — package short name alias)", () => {
  const tmpDirs: string[] = [];
  function pkgDir(name: string, piExtensions: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-pkg-"));
    tmpDirs.push(dir);
    const manifest: Record<string, unknown> = { name };
    if (piExtensions !== undefined) manifest.pi = { extensions: piExtensions };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("aliases a package-declared index.ts entry to the unscoped, lowercased package name", () => {
    // Without this, `pi.extensions: ["./src/index.ts"]` only ever matches as "src".
    const dir = pkgDir("@tintinweb/Pi-Subagents", ["./src/index.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src", "pi-subagents"]);
  });

  it("adds no alias for a loose file with no enclosing package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-loose-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "foo.ts"), "export default () => {};");
    expect(extensionCanonicalNames(join(dir, "foo.ts"))).toEqual(["foo"]);
  });

  it("adds no alias when the nearest manifest does not declare this entry", () => {
    // The package.json is a real pi package but lists a *different* entry — so a
    // co-located file (e.g. our own test fixtures under this repo) is not falsely
    // stamped with the package name.
    const dir = pkgDir("@scope/other-ext", ["./src/other.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("adds no alias when the nearest package.json has no pi manifest", () => {
    const dir = pkgDir("just-a-project", undefined);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("does not climb past a node_modules boundary into a consumer's manifest", () => {
    // A consumer that *declares* a dependency's entry must not lend its name to
    // that dependency: the walk stops at node_modules before reading it.
    const root = mkdtempSync(join(tmpdir(), "subagents-consumer-"));
    tmpDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", pi: { extensions: ["./node_modules/inner-ext/index.ts"] } }),
    );
    const inner = join(root, "node_modules", "inner-ext");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "index.ts"), "export default () => {};");
    // Only the path-derived name — never "consumer".
    expect(extensionCanonicalNames(join(inner, "index.ts"))).toEqual(["inner-ext"]);
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
  it("lowercases bare-name entries — extension names match case-insensitively", () => {
    const spec = parseExtensionsSpec(["Mcp", "LOGGER"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
  });
  it("ignores empty entries (defensive — upstream parsers already strip them)", () => {
    const spec = parseExtensionsSpec(["", "mcp", ""], "/work");
    expect(spec.names).toEqual(new Set(["mcp"]));
    expect(spec.wildcard).toBe(false);
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

  it("matches a package-installed extension by its package short name, not just its src dir (#143)", async () => {
    // A package whose entry is `src/index.ts` canonicalizes to "src"; a child
    // agent must still be able to allowlist it by the package name.
    const dir = mkdtempSync(join(tmpdir(), "subagents-match-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@tintinweb/pi-subagents", pi: { extensions: ["./src/index.ts"] } }),
      );
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
      const entry = join(dir, "src", "index.ts");

      setupArrayAgent(["pi-subagents"]);
      withExtensions({ [entry]: ["pkg_tool"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      // Before the fix keepNames={pi-subagents} but the extension only answered
      // to "src", so it was filtered out and pkg_tool never reached the allowlist.
      expect(lastToolsPassed()).toContain("pkg_tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("['mcp', path] keeps exactly those two, drops other defaults (no wildcard)", async () => {
    // Changelog: `["mcp", "/abs/foo.ts"]` is *just* those two. Distinct from
    // `['*', path]` (all defaults + path) and `['mcp']` (name only).
    setupArrayAgent(["mcp", "/abs/foo.ts"]);
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/abs/foo.ts": ["foo_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    // No "*" → the loader override is in force (narrowing, not load-all).
    expect(opts.extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
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

  it("matches `extensions: [Mcp]` against `mcp.ts` (case-insensitive)", async () => {
    setupArrayAgent(["Mcp"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    // No extension-error warning — the name resolved.
    const errorCalls = onToolActivity.mock.calls.filter((c) =>
      typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
    expect(lastToolsPassed()).toContain("mcp_tool");
  });
});

// ─── exclude_extensions: denylist (#94) ──────────────────────────────────
describe("agent-runner exclude_extensions", () => {
  function setupAgent(overrides: Record<string, unknown>) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig(overrides));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig(overrides));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }
  function extensionErrors(onToolActivity: ReturnType<typeof vi.fn>): string[] {
    return onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("extension-error:"));
  }

  it("extensions: true + exclude — override installed, excluded tools dropped, others kept", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("['*'] + exclude — wildcard no longer short-circuits, exclusion applies", async () => {
    setupAgent({ extensions: ["*"], excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
  });

  it("allowlist + exclude of a listed name — subtracted, 'in both' warning fires", async () => {
    setupAgent({ extensions: ["mcp", "other"], excludeExtensions: ["other"] });
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).not.toContain("other_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('in both extensions: and exclude_extensions:'),
    ]);
  });

  it("exclude typo — warning fires, all extensions still load", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["nope"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('exclude_extensions: "nope"'),
    ]);
  });

  it("extensions: false + exclude — orphan warning, no override", async () => {
    setupAgent({ extensions: false, excludeExtensions: ["notify"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("exclude_extensions has no effect"),
    ]);
  });

  it("isolated: true + exclude — excludes nulled, no warnings", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({ "/ext/notify.ts": ["notify_send"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity, isolated: true });

    expect(lastToolsPassed()).not.toContain("notify_send");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("tools: ext:foo referencing an excluded extension — existing orphan warning fires", async () => {
    setupAgent({
      extensions: true,
      excludeExtensions: ["beta"],
      extSelectors: ["ext:beta"],
    });
    withExtensions({
      "/ext/beta.ts": ["beta_tool"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("beta_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("extension-error:ext:beta"),
    ]);
  });

  it("exclude matches case-insensitively", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["MCP"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });
});

// ─── unknown built-in tool names in `tools:` (#75) ──────────────────────
describe("agent-runner unknown built-in tools", () => {
  it("emits a tools-error warning for each plain entry not in BUILTIN_TOOL_NAMES", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "reed", "grep", "edt"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "reed", "grep", "edt"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toHaveLength(2);
    expect(errorMessages.some((m) => m.includes('"reed"'))).toBe(true);
    expect(errorMessages.some((m) => m.includes('"edt"'))).toBe(true);
  });

  it("stays quiet when all plain tool names are valid built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "grep"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "grep"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toEqual([]);
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
  it("lowercases the extension name but preserves tool-name case", () => {
    // The extension half matches the loader's canonical name (also lowercased);
    // the tool half is matched against pi-mono's registered identifiers, which
    // are case-sensitive.
    const { extNames, narrowing } = parseExtSelectors(["ext:Mcp/SomeTool", "ext:FOO"]);
    expect(extNames).toEqual(new Set(["mcp", "foo"]));
    expect(narrowing.get("mcp")).toEqual(new Set(["SomeTool"]));
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

  it("ext:foo is orphaned when extensions: false — no extension loads, warning fires", async () => {
    // `extensions:` is the sole loading authority. `ext:` selectors can only narrow
    // within the loaded set; they cannot pull an excluded extension back in.
    setupExtAgent({ extensions: false, builtinToolNames: ["read"], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().noExtensions).toBe(true);
    const tools = lastToolsPassed();
    expect(tools).toEqual(["read"]);
    expect(tools).not.toContain("foo_tool");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:foo'),
      }),
    );
  });

  it("ext: cannot pull an extension that `extensions: [...]` excludes — warns, no surfacing", async () => {
    // extensions: [a] loads only a. ext:foo references foo, which isn't loaded;
    // the opt-in flip still mutes a (it isn't named in ext:), so the agent gets
    // zero extension tools and a warning fires.
    setupExtAgent({ extensions: ["a"], builtinToolNames: [], extSelectors: ["ext:foo"] });
    withExtensions({ "/ext/a.ts": ["a_tool"], "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("foo_tool"); // foo never loaded
    expect(tools).not.toContain("a_tool");   // a loaded but muted by the ext: opt-in flip
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:foo'),
      }),
    );
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

  it("warns but proceeds when an ext: name doesn't match any loaded extension", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:ghost"] });
    withExtensions({ "/ext/real.ts": ["real_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:ext:ghost'),
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

  it("ext: composes with a path-loaded extension via its canonical name", async () => {
    // Changelog: `ext:` is name-only (matched by canonical name), so it composes
    // with extensions loaded by path through `extensions:`. The path "/abs/foo.ts"
    // has canonical name "foo", which `ext:foo` then surfaces — no orphan warning.
    setupExtAgent({
      extensions: ["/abs/foo.ts"],
      builtinToolNames: ["read"],
      extSelectors: ["ext:foo"],
    });
    withExtensions({ "/abs/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool"); // path-loaded ext surfaced via ext:foo
    expect(tools).toContain("read");
    expect(tools).not.toContain("other_tool"); // dropped at the loader (not in keepNames)
    // ext:foo resolved against the path's canonical name → not orphaned.
    const errorCalls = onToolActivity.mock.calls.filter(
      (c) => typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
  });

  it("ext:foo/Bar narrowing is case-sensitive on the tool half", async () => {
    // The extension half is canonicalised (lowercased); the tool half is matched
    // verbatim against pi-mono's registered identifiers, so `Bar` must not match `bar`.
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extSelectors: ["ext:foo/Bar"] });
    withExtensions({ "/ext/foo.ts": ["Bar", "bar"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("Bar");
    expect(tools).not.toContain("bar"); // case-sensitive: not the selected tool
  });

  it("disallowedTools removes a tool reached via an ext: selector", async () => {
    // The denylist applies uniformly to extension tools, including those surfaced
    // by the ext: opt-in flip — same construction-time `allowedTools` filter.
    setupExtAgent({
      extensions: true,
      builtinToolNames: ["read"],
      extSelectors: ["ext:foo"],
      disallowedTools: ["foo_tool"],
    });
    withExtensions({ "/ext/foo.ts": ["foo_tool", "foo_other"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).toContain("foo_other");
    expect(tools).not.toContain("foo_tool"); // denylisted even though ext:foo selects it
  });
});

// The limit a run will enforce, resolved before the run starts. The widget's
// turn counter has to predict it for agents spawned outside the Agent tool
// (mentions, cross-extension RPC), and a second copy of the expression there
// would drift from the one runAgent enforces — so both call this.
describe("resolveEffectiveMaxTurns", () => {
  let prevDefault: number | undefined;

  beforeEach(() => {
    prevDefault = getDefaultMaxTurns();
    vi.mocked(getAgentConfig).mockReturnValue(makeAgentConfig({ maxTurns: 7 }) as any);
  });

  afterEach(() => {
    setDefaultMaxTurns(prevDefault);
    vi.mocked(getAgentConfig).mockReset();
  });

  it("prefers an explicit value over the agent's own and the project default", () => {
    setDefaultMaxTurns(20);
    expect(resolveEffectiveMaxTurns("test-agent", 3)).toBe(3);
  });

  it("falls back to the agent's own max_turns", () => {
    setDefaultMaxTurns(20);
    expect(resolveEffectiveMaxTurns("test-agent")).toBe(7);
  });

  it("falls back to the project default when the agent sets none", () => {
    setDefaultMaxTurns(20);
    vi.mocked(getAgentConfig).mockReturnValue(makeAgentConfig() as any);
    expect(resolveEffectiveMaxTurns("test-agent")).toBe(20);
  });

  it("is unlimited when nothing sets a limit", () => {
    setDefaultMaxTurns(undefined);
    vi.mocked(getAgentConfig).mockReturnValue(makeAgentConfig() as any);
    expect(resolveEffectiveMaxTurns("test-agent")).toBeUndefined();
  });

  it("treats an explicit 0 as unlimited rather than as 'no opinion'", () => {
    // Not the same as omitting it: 0 is how a caller says "no limit", and
    // falling through to the default would impose one it asked not to have.
    setDefaultMaxTurns(20);
    expect(resolveEffectiveMaxTurns("test-agent", 0)).toBeUndefined();
  });
});

// The soft-limit → grace → hard-abort machine (agent-runner.ts, the `turn_end`
// branch) has never executed in a test: every consumer of the `steered`/`aborted`
// flags mocks `runAgent` outright, so the flags are asserted but never produced.
// The machine is what stops a runaway subagent, so a broken latch is either an
// agent that never wraps up and never aborts, or one that aborts on turn 1.
describe("agent-runner turn limits", () => {
  let prevMax: number | undefined;
  let prevGrace: number;

  beforeEach(() => {
    prevMax = getDefaultMaxTurns();
    prevGrace = getGraceTurns();
  });

  afterEach(() => {
    // Both are module-global; leaking them would silently retune other suites.
    setDefaultMaxTurns(prevMax);
    setGraceTurns(prevGrace);
  });

  /**
   * Run an agent whose prompt fires `turns` synthetic turn_end events before it
   * produces its final message — the same events a real session emits.
   */
  async function runWithTurns(turns: number, options: Record<string, unknown> = {}) {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session, listeners } = createSession("OK");
    session.prompt.mockImplementation(async () => {
      for (let i = 0; i < turns; i++) {
        for (const l of [...listeners]) l({ type: "turn_end" });
      }
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "go", { pi, ...options });
    return { session, result };
  }

  it("does not steer or abort below the limit", async () => {
    const { session, result } = await runWithTurns(3, { maxTurns: 5 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(false);
  });

  it("steers exactly once on reaching the limit, and does not abort", async () => {
    setGraceTurns(5);
    const { session, result } = await runWithTurns(5, { maxTurns: 5 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer.mock.calls[0][0]).toContain("turn limit");
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(true);
  });

  it("does not re-steer on every turn once the soft limit latched", async () => {
    // Without the latch the agent gets a wrap-up message every single turn,
    // which both burns tokens and drowns out its actual task.
    setGraceTurns(5);
    const { session } = await runWithTurns(8, { maxTurns: 5 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("hard-aborts once the grace turns are used up", async () => {
    setGraceTurns(2);
    const { session, result } = await runWithTurns(7, { maxTurns: 5 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
  });

  it("keeps running through the grace window without aborting", async () => {
    setGraceTurns(3);
    const { session, result } = await runWithTurns(7, { maxTurns: 5 });
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(true);
  });

  it("treats maxTurns 0 as unlimited", async () => {
    const { session } = await runWithTurns(30, { maxTurns: 0 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("is unlimited when nothing configures a limit", async () => {
    setDefaultMaxTurns(undefined);
    const { session } = await runWithTurns(30);
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("falls back to the global default when the call sets no limit", async () => {
    setDefaultMaxTurns(4);
    setGraceTurns(5);
    const { session } = await runWithTurns(4);
    expect(session.steer).toHaveBeenCalledTimes(1);
  });

  it("an explicit maxTurns beats the global default", async () => {
    setDefaultMaxTurns(2);
    setGraceTurns(5);
    const { session } = await runWithTurns(4, { maxTurns: 10 });
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("reports each turn to the caller's counter", async () => {
    const onTurnEnd = vi.fn();
    await runWithTurns(3, { maxTurns: 10, onTurnEnd });
    expect(onTurnEnd.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  });
});

// A parent Esc / interrupt reaches the child through options.signal. The only
// existing coverage asserts the RECORD flips to "stopped" with runAgent mocked —
// nothing checked that the signal actually reaches the session, so a child could
// be marked stopped while it keeps running and burning tokens.
describe("agent-runner abort signal forwarding", () => {
  it("aborts the session when the parent signal fires mid-run", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const controller = new AbortController();
    const { session } = createSession("OK");
    session.prompt.mockImplementation(async () => {
      controller.abort();
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, signal: controller.signal });

    expect(session.abort).toHaveBeenCalled();
  });

  it("removes its listener once the run settles", async () => {
    // A long-lived parent signal outlives many children; a listener left behind
    // per child is a leak that also re-aborts sessions that are already gone.
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, signal: controller.signal });

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    controller.abort();
    expect(session.abort).not.toHaveBeenCalled(); // detached, so a late abort is inert
  });

  it("registers nothing when no signal is supplied", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.abort).not.toHaveBeenCalled();
  });
});

// resolveDefaultModel picks the model a subagent runs on. Every failure here is
// SILENT BY DESIGN: an unresolvable or unavailable `model:` deliberately falls
// back to the parent's model rather than erroring, because a user's frontmatter
// pin shouldn't hard-fail a spawn. That makes the availability filter untestable
// through observed behavior — a broken check just means every model-pinned agent
// quietly runs on the parent's model, costing whatever the parent costs.
//
// Exported for this (the file already exports normalizeMaxTurns/setGraceTurns
// purely for test/agent-runner-settings.test.ts).
describe("resolveDefaultModel", () => {
  const parent = { provider: "anthropic", id: "parent-model" } as any;
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" } as any;

  /** Registry whose `find` always succeeds; `getAvailable` is what varies. */
  function registry(available?: any[]) {
    return {
      find: vi.fn((provider: string, id: string) => ({ provider, id }) as any),
      getAvailable: available ? () => available : undefined,
    };
  }

  it("returns the configured model when the registry has it available", () => {
    const r = registry([haiku]);
    expect(resolveDefaultModel(parent, r, "anthropic/claude-haiku-4-5"))
      .toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("falls back to the parent when the model is NOT in the available set", () => {
    // The branch with teeth: without this filter the subagent is handed a model
    // the user has no credentials for, and the failure surfaces as a runtime
    // auth error from deep inside createAgentSession instead of a clean fallback.
    const r = registry([haiku]);
    expect(resolveDefaultModel(parent, r, "openai/gpt-5")).toBe(parent);
  });

  it("trusts `find` when the registry cannot enumerate availability", () => {
    // getAvailable absent → no filtering possible, so a found model is used.
    const r = registry(undefined);
    expect(resolveDefaultModel(parent, r, "anthropic/claude-haiku-4-5"))
      .toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("falls back to the parent when the registry cannot find the model", () => {
    const r = { find: vi.fn(() => undefined), getAvailable: undefined };
    expect(resolveDefaultModel(parent, r as any, "anthropic/nope")).toBe(parent);
  });

  it("falls back to the parent for a model string with no provider prefix", () => {
    const r = registry([haiku]);
    expect(resolveDefaultModel(parent, r, "haiku")).toBe(parent);
    expect(r.find).not.toHaveBeenCalled();
  });

  it("returns the parent model when no model is configured", () => {
    expect(resolveDefaultModel(parent, registry([haiku]), undefined)).toBe(parent);
  });

  it("returns undefined when neither a config model nor a parent model exists", () => {
    expect(resolveDefaultModel(undefined, registry([haiku]), undefined)).toBeUndefined();
  });
});
