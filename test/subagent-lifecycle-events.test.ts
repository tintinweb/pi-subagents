import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Subagent adapter convention (ADR 0012): runAgent must announce each child on
 * the pi.events bus — `session-created` synchronously BEFORE bindExtensions,
 * `bound` after a successful bind, `disposed` when the run settles (success or
 * error) — so an installed permission system can detect our in-process
 * children and forward their `ask` gates to the interactive parent instead of
 * failing closed. The harness below mirrors agent-runner.test.ts: the
 * @earendil-works/pi-coding-agent surface is mocked, so the emissions are
 * asserted against a fake `pi.events.emit` spy.
 */

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
  sessionManagerCreate: vi.fn(
    () => ({ kind: "persistent-session-manager" }) as { kind: string; getSessionId?: () => string },
  ),
  sessionManagerOpen: vi.fn(() => ({ kind: "reopened-session-manager" })),
  settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  defineTool: (definition: unknown) => definition,
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
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

import { runAgent, setRememberAgents } from "../src/agent-runner.js";

/** Child session id reported by the mocked SessionManager.create. */
const CHILD_ID = "child-123";
/** Root session id returned by the fake ctx sessionManager. */
const ROOT_ID = "root-456";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
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
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeToolNames = [...names];
    }),
    getAllTools: vi.fn(() => {
      const opts = createAgentSession.mock.calls[0]?.[0];
      return opts ? mockRegistry(opts).map((name) => ({ name })) : [];
    }),
    agent: { beforeToolCall: undefined } as {
      beforeToolCall?: (context: any, signal?: any) => Promise<any>;
    },
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

function mockRegistry(opts: any): string[] {
  return opts.tools ?? [];
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: {
    getBranch: vi.fn(() => []),
    getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
    getSessionId: vi.fn(() => ROOT_ID),
  },
} as any;

function makePi() {
  return { events: { emit: vi.fn() } } as any;
}

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  sessionManagerCreate.mockReset();
  sessionManagerOpen.mockClear();
  setRememberAgents(true);
  settingsManagerGetSessionDir.mockReset();
  settingsManagerGetSessionDir.mockReturnValue(undefined);
  settingsManagerCreate.mockClear();
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
  // The child session id is read off the LOCAL SessionManager (the one runAgent
  // creates before createAgentSession); give the mock a stable id.
  sessionManagerCreate.mockReturnValue({
    kind: "persistent-session-manager",
    getSessionId: () => CHILD_ID,
  });
});

function emitted(pi: any, channel: string): Array<Record<string, unknown>> {
  return pi.events.emit.mock.calls
    .filter((call: [string, unknown]) => call[0] === channel)
    .map((call: [string, unknown]) => call[1] as Record<string, unknown>);
}

/** The channel strings are the contract — pinned here so drift from the
 *  permission system's subagent-lifecycle-events.ts fails the suite. */
const CREATED = "subagents:child:session-created";
const BOUND = "subagents:child:bound";
const DISPOSED = "subagents:child:disposed";

describe("runAgent subagent lifecycle emissions", () => {
  it("emits session-created synchronously before bindExtensions, root-targeted", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const pi = makePi();

    // Simulate the manager root-targeting: options.parentSessionId is the
    // top-level session id, overriding the spawner ctx's own id.
    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: ROOT_ID });

    const created = emitted(pi, CREATED);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({ sessionId: CHILD_ID, parentSessionId: ROOT_ID });

    const emitOrder = pi.events.emit.mock.invocationCallOrder;
    const bindOrder = session.bindExtensions.mock.invocationCallOrder;
    expect(emitOrder[0]).toBeLessThan(bindOrder[0]);
  });

  it("emits bound after bindExtensions and disposed after the run settles", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const pi = makePi();

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: ROOT_ID });

    const bound = emitted(pi, BOUND);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toEqual({ sessionId: CHILD_ID, parentSessionId: ROOT_ID });

    const disposed = emitted(pi, DISPOSED);
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toEqual({ sessionId: CHILD_ID });

    const emitOrder = pi.events.emit.mock.invocationCallOrder;
    const bindOrder = session.bindExtensions.mock.invocationCallOrder;
    const promptOrder = session.prompt.mock.invocationCallOrder;
    expect(emitOrder[1]).toBeGreaterThan(bindOrder[0]);
    expect(emitOrder[2]).toBeGreaterThan(promptOrder[0]);
  });

  it("falls back to the spawner ctx's session id when no parentSessionId is threaded", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const pi = makePi();

    await runAgent(ctx, "Explore", "go", { pi });

    const created = emitted(pi, CREATED);
    expect(created[0]).toEqual({ sessionId: CHILD_ID, parentSessionId: ROOT_ID });
  });

  it("emits the exact channel strings from the permission-system contract, in order", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const pi = makePi();

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: ROOT_ID });

    expect(pi.events.emit.mock.calls.map((call: [string, unknown]) => call[0])).toEqual([
      CREATED,
      BOUND,
      DISPOSED,
    ]);
  });

  it("emits disposed when the run throws", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    session.prompt.mockRejectedValueOnce(new Error("provider exploded"));
    const pi = makePi();

    await expect(runAgent(ctx, "Explore", "go", { pi, parentSessionId: ROOT_ID })).rejects.toThrow("provider exploded");

    expect(emitted(pi, CREATED)).toHaveLength(1);
    expect(emitted(pi, BOUND)).toHaveLength(1);
    const disposed = emitted(pi, DISPOSED);
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toEqual({ sessionId: CHILD_ID });
  });

  it("emits disposed (and no bound) when bindExtensions throws, and rethrows", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    session.bindExtensions.mockRejectedValueOnce(new Error("extension load failed"));
    const pi = makePi();

    await expect(runAgent(ctx, "Explore", "go", { pi, parentSessionId: ROOT_ID })).rejects.toThrow("extension load failed");

    expect(emitted(pi, CREATED)).toHaveLength(1);
    expect(emitted(pi, BOUND)).toHaveLength(0);
    const disposed = emitted(pi, DISPOSED);
    expect(disposed).toHaveLength(1);
    expect(disposed[0]).toEqual({ sessionId: CHILD_ID });
  });

  it("is a no-op when the events bus is absent", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });

    // Same bare `pi` the rest of the suite uses: no `events` surface at all.
    const result = await runAgent(ctx, "Explore", "go", { pi: {} as any });

    expect(result.responseText).toBe("DONE");
  });
});
