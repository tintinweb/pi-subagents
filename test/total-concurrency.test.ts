// maxConcurrentTotal (#352) — a hard cap on running agents that refuses nested
// spawns instead of queueing them.
//
// Nested children skip both pools: their parent holds a slot while it waits on
// them, so queueing a child behind its own parent would deadlock. Refusing has
// no such risk, which is how Claude Code bounds nested fan-out too
// (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS). Top-level spawns keep queueing on
// `maxConcurrent` and are never refused.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

/** Runs that settle only when their returned resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockClear();
  vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, prompt: any) =>
    new Promise<any>(resolve => {
      resolvers.set(prompt as string, () => resolve({
        responseText: `${prompt}-result`,
        session: { dispose: vi.fn() },
        aborted: false,
        steered: false,
      }));
    }),
  );
  return resolvers;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const top = (manager: AgentManager, prompt: string) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", prompt, { description: prompt, isBackground: true });

const nested = (manager: AgentManager, prompt: string, options: any = {}) =>
  manager.spawn(mockPi, mockCtx, "general-purpose", prompt, {
    description: prompt,
    isBackground: true,
    parentAgentId: "parent",
    depth: 2,
    ...options,
  });

const LIMIT_MESSAGE = /Concurrent subagent limit reached\. You can run 2 subagents at once\. Do not retry\./;

describe("maxConcurrentTotal", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("defaults to 20, as Claude Code's CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS does", () => {
    manager = new AgentManager();
    expect(manager.getMaxConcurrentTotal()).toBe(20);
  });

  it("refuses a nested spawn once the running count reaches the limit, and creates no record", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(2);
    top(manager, "a");
    top(manager, "b");

    expect(() => nested(manager, "child")).toThrow(LIMIT_MESSAGE);
    expect(manager.listAgents().map(a => a.description).sort()).toEqual(["a", "b"]);
  });

  it("counts nested agents too, so a parent's fan-out stops at the limit", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(2);
    top(manager, "parent");
    nested(manager, "child-1");

    expect(() => nested(manager, "child-2")).toThrow(LIMIT_MESSAGE);
  });

  it("never refuses a top-level spawn: it queues on maxConcurrent as before", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 2);
    manager.setMaxConcurrentTotal(2);
    top(manager, "a");
    top(manager, "b");

    const id = top(manager, "c");
    expect(manager.getRecord(id)?.status).toBe("queued");
  });

  it("starts a top-level spawn above the limit when its own pool has room", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(2);
    top(manager, "a");
    top(manager, "b");

    const id = top(manager, "c");
    expect(manager.getRecord(id)?.status).toBe("running");
  });

  it("neither counts nor refuses a workflow's agents, which have their own cap", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(2);
    nested(manager, "wf-1", { parentAgentId: undefined, workflowId: "wf" });
    nested(manager, "wf-2", { parentAgentId: undefined, workflowId: "wf" });
    nested(manager, "wf-3", { parentAgentId: undefined, workflowId: "wf" });
    top(manager, "parent");

    // Three workflow agents and one top-level agent run, but only one counts.
    expect(() => nested(manager, "child")).not.toThrow();
    // Now two count, so the cap is reached, and a workflow agent still starts.
    expect(() => nested(manager, "wf-4", { parentAgentId: undefined, workflowId: "wf" })).not.toThrow();
  });

  it("does not count queued agents, which are not running", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 1);
    manager.setMaxConcurrentTotal(2);
    top(manager, "running");
    const queued = top(manager, "queued");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(() => nested(manager, "child")).not.toThrow();
  });

  it("is unlimited at 0", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(0);
    for (const p of ["a", "b", "c"]) top(manager, p);

    expect(() => nested(manager, "child")).not.toThrow();
  });

  it("admits a nested spawn again once a running agent settles", async () => {
    const runs = controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(2);
    top(manager, "a");
    top(manager, "b");
    await flush();
    expect(() => nested(manager, "child")).toThrow(LIMIT_MESSAGE);

    runs.get("a")?.();
    await flush();
    expect(() => nested(manager, "child")).not.toThrow();
  });

  it.each([false, true])("reaches the parent as a tool error from the nested Agent tool (run_in_background: %s)", async (runInBackground) => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentTotal(2);
    top(manager, "a");
    top(manager, "b");
    const [agent] = createNestedSubagentTools({
      manager,
      pi: mockPi,
      parentAgentId: "parent",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: "/tmp",
    });

    const result = await (agent as any).execute("call-1", {
      subagent_type: "general-purpose",
      description: "child",
      prompt: "child",
      run_in_background: runInBackground,
    }, undefined, undefined, { cwd: "/tmp", model: undefined, modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(LIMIT_MESSAGE);
    expect(manager.listAgents()).toHaveLength(2);
  });
});
