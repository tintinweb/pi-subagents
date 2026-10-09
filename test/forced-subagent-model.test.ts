import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { setForcedSubagentModel } from "../src/forced-model.js";

const FABLE = {
  provider: "openrouter",
  id: "anthropic/claude-fable-5",
  name: "Claude Fable 5",
};
const OPUS_LATEST = {
  provider: "openrouter",
  id: "~anthropic/claude-opus-latest",
  name: "Claude Opus Latest",
};
const MODELS = [FABLE, OPUS_LATEST];

function context() {
  return {
    cwd: "/tmp",
    model: FABLE,
    modelRegistry: {
      find: (provider: string, id: string) =>
        MODELS.find(model => model.provider === provider && model.id === id),
      getAll: () => MODELS,
      getAvailable: () => MODELS,
    },
  } as never;
}

function resolvedRun() {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: { dispose: vi.fn() },
    aborted: false,
    steered: false,
  } as never);
}

describe("forceSubagentModel", () => {
  let manager: AgentManager;

  beforeEach(() => {
    setForcedSubagentModel("openrouter/~anthropic/claude-opus-latest");
    resolvedRun();
    manager = new AgentManager();
  });

  afterEach(async () => {
    setForcedSubagentModel(undefined);
    await manager.dispose();
    vi.clearAllMocks();
  });

  it("overrides an explicit caller model and records what was requested", async () => {
    const id = manager.spawn({} as never, context(), "worker", "review", {
      description: "review",
      model: FABLE,
      invocation: {
        modelName: "fable 5",
        modelId: "openrouter/anthropic/claude-fable-5",
      },
    });
    await manager.getRecord(id)?.promise;

    const options = vi.mocked(runAgent).mock.lastCall?.[3];
    expect(options?.model).toBe(OPUS_LATEST);
    expect(manager.getRecord(id)?.invocation).toEqual(expect.objectContaining({
      modelName: "opus latest",
      modelId: "openrouter/~anthropic/claude-opus-latest",
      requestedModel: "openrouter/anthropic/claude-fable-5",
    }));
  });

  it("overrides parent inheritance at the manager funnel used by owned children", async () => {
    const id = manager.spawn({} as never, context(), "worker", "review", {
      description: "review",
      parentAgentId: "parent-1",
    });
    await manager.getRecord(id)?.promise;

    expect(vi.mocked(runAgent).mock.lastCall?.[3].model).toBe(OPUS_LATEST);
    expect(manager.getRecord(id)?.invocation?.requestedModel)
      .toBe("openrouter/anthropic/claude-fable-5");
  });

  it("fails before creating a record when the forced model is unavailable", () => {
    setForcedSubagentModel("openrouter/~anthropic/does-not-exist");

    expect(() => manager.spawn({} as never, context(), "worker", "review", {
      description: "review",
    })).toThrow(/Forced subagent model .* is unavailable/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("preserves ordinary model selection when the policy is unset", async () => {
    setForcedSubagentModel(undefined);
    const id = manager.spawn({} as never, context(), "worker", "review", {
      description: "review",
      model: FABLE,
    });
    await manager.getRecord(id)?.promise;

    expect(vi.mocked(runAgent).mock.lastCall?.[3].model).toBe(FABLE);
  });
});
