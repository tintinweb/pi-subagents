// maxConcurrentNested (#352) — caps running nested children by refusing nested
// spawns over it; see the guard in AgentManager.spawn.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

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

const LIMIT_MESSAGE = /Concurrent nested subagent limit reached\. You can run 2 nested subagents at once\. Do not retry\./;

describe("maxConcurrentNested", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("defaults to 10", () => {
    manager = new AgentManager();
    expect(manager.getMaxConcurrentNested()).toBe(10);
  });

  it("refuses a nested spawn once the running nested children reach the limit, and creates no record", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(2);
    nested(manager, "child-1");
    nested(manager, "child-2");

    expect(() => nested(manager, "child-3")).toThrow(LIMIT_MESSAGE);
    expect(manager.listAgents().map(a => a.description).sort()).toEqual(["child-1", "child-2"]);
  });

  it("does not count top-level agents", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(2);
    for (const p of ["a", "b", "c"]) top(manager, p);

    expect(() => nested(manager, "child-1")).not.toThrow();
    expect(() => nested(manager, "child-2")).not.toThrow();
  });

  it("never refuses a top-level spawn, even with nested children at the limit", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(2);
    nested(manager, "child-1");
    nested(manager, "child-2");

    const id = top(manager, "a");
    expect(manager.getRecord(id)?.status).toBe("running");
  });

  it("neither counts nor refuses a workflow's agents, which have their own cap", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(2);
    // Workflow agents can carry a parentAgentId; the workflowId is what exempts them.
    nested(manager, "wf-1", { workflowId: "wf" });
    nested(manager, "wf-2", { workflowId: "wf" });
    nested(manager, "wf-3", { workflowId: "wf" });

    expect(() => nested(manager, "child-1")).not.toThrow();
    expect(() => nested(manager, "child-2")).not.toThrow();
    // Nested children are at the limit, and a workflow agent still starts.
    expect(() => nested(manager, "wf-4", { workflowId: "wf" })).not.toThrow();
  });

  it("is unlimited at 0", () => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(0);
    for (const p of ["child-1", "child-2", "child-3"]) nested(manager, p);

    expect(() => nested(manager, "child-4")).not.toThrow();
  });

  it("admits a nested spawn again once a nested child settles", async () => {
    const runs = controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(2);
    nested(manager, "child-1");
    nested(manager, "child-2");
    await flush();
    expect(() => nested(manager, "child-3")).toThrow(LIMIT_MESSAGE);

    runs.get("child-1")?.();
    await flush();
    expect(() => nested(manager, "child-3")).not.toThrow();
  });

  it.each([false, true])("reaches the parent as a tool error from the nested Agent tool (run_in_background: %s)", async (runInBackground) => {
    controllableRuns();
    manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentNested(2);
    nested(manager, "child-1");
    nested(manager, "child-2");
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
      description: "child-3",
      prompt: "child-3",
      run_in_background: runInBackground,
    }, undefined, undefined, { cwd: "/tmp", model: undefined, modelRegistry: { find: () => undefined, getAvailable: () => [], getAll: () => [] } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(LIMIT_MESSAGE);
    expect(manager.listAgents()).toHaveLength(2);
  });
});
