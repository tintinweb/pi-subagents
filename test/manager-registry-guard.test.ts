/**
 * manager-registry-guard.test.ts — the Symbol.for("pi-subagents:manager")
 * global registry across multiple activations in one process.
 *
 * Subagent sessions re-activate this extension in the same process
 * (session.bindExtensions in agent-runner.ts). The old code let every
 * activation overwrite the global slot — pointing cross-package consumers at
 * a short-lived child manager — and every child's session_shutdown DELETED
 * the slot, so the root session's entry was lost as soon as any subagent ran.
 *
 * The fix: the first activation claims the slot, later activations leave it
 * alone, and only the owner's shutdown releases it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
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

const textOf = (r: any): string => r.content[0].text;

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "registry test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

// Restore the global slot around every test.
const priorGlobal = (globalThis as any)[MANAGER_KEY];
afterEach(() => {
  if (priorGlobal === undefined) delete (globalThis as any)[MANAGER_KEY];
  else (globalThis as any)[MANAGER_KEY] = priorGlobal;
  vi.mocked(runAgent).mockReset();
});

describe("Symbol.for manager registry across activations", () => {
  it("child activation does not overwrite the root entry; child shutdown does not delete it", async () => {
    delete (globalThis as any)[MANAGER_KEY];

    // Root session activates first and owns the registry.
    const root = makePi();
    subagentsExtension(root.pi);
    const rootEntry = (globalThis as any)[MANAGER_KEY];
    expect(rootEntry).toBeDefined();

    // Spawn a background agent through the ROOT so its record is findable.
    const id = await spawnBackground(root.tools);
    expect(rootEntry.getRecord(id)).toBeDefined();

    // A child agent session re-activates the extension in-process.
    const child = makePi();
    subagentsExtension(child.pi);

    // Registry still points at the root's entry (child did not clobber it) …
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);
    expect((globalThis as any)[MANAGER_KEY].getRecord(id)).toBeDefined();

    // … and the child's shutdown does not delete the root's entry.
    await child.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBe(rootEntry);

    // The root's own shutdown releases the slot.
    await root.lifecycle.get("session_shutdown")?.();
    expect((globalThis as any)[MANAGER_KEY]).toBeUndefined();
  });
});

// The registry's `spawn` is reachable from any package in the process, so its
// options are attacker-controlled in the only sense that matters here: nothing
// downstream re-checks them. Four are internal capabilities the extension
// issues to itself, and a forged value for each buys something real.
describe("the registry spawn strips internal capabilities", () => {
  /** Boot a fresh owner and spawn through the registry with forged options. */
  function forge(options: Record<string, unknown>) {
    delete (globalThis as any)[MANAGER_KEY];
    const root = makePi();
    subagentsExtension(root.pi);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);
    const entry = (globalThis as any)[MANAGER_KEY];
    const id = entry.spawn(root.pi, ctx(), "general-purpose", "go", {
      description: "forged", isBackground: true, ...options,
    });
    return { entry, id, root, runOpts: () => vi.mocked(runAgent).mock.calls[0][3] as any };
  }

  it("refuses a forged nesting, so the agent cannot hide under someone else's id", async () => {
    // A nested record is filtered out of every top-level surface and inherits
    // its parent's delegation budget.
    const { entry, id, root } = forge({ parentAgentId: "victim-agent-id", depth: 9, maxSubagentDepth: 99 });

    expect(entry.getRecord(id)).toMatchObject({
      parentAgentId: undefined, depth: 1, maxSubagentDepth: undefined,
    });
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("refuses a forged transcript directory and config root", async () => {
    // rootSessionId names a directory the transcript is written into, and
    // configCwd names where agent files and memory are resolved from.
    const { entry, id, root, runOpts } = forge({ rootSessionId: "../../elsewhere", configCwd: "/etc" });

    expect(entry.getRecord(id).rootSessionId).toBeUndefined();
    expect(runOpts().configCwd).toBeUndefined();
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("refuses forged session files, which would open or replay someone else's conversation", async () => {
    const { root, runOpts } = forge({
      resumeSessionFile: "/home/victim/.pi/agent/sessions/private.jsonl",
      sessionFile: "/home/victim/.pi/agent/sessions/lane.jsonl",
    });

    expect(runOpts().resumeSessionFile).toBeUndefined();
    expect(runOpts().sessionFile).toBeUndefined();
    await root.lifecycle.get("session_shutdown")?.();
  });

  it("refuses a forged reclaim and allocates a handle the ordinary way", async () => {
    // reclaim bypasses assignHandle, so a forged value could duplicate a live
    // agent's name and make `@handle` resolve to either of two records.
    const { entry, id, root } = forge({ reclaim: { handle: "explore", alias: "auth-audit" } });

    expect(entry.getRecord(id)).toMatchObject({ handle: "general-purpose", alias: undefined });
    await root.lifecycle.get("session_shutdown")?.();
  });
});
