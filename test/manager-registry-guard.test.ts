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
