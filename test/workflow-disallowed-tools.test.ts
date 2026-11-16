/**
 * workflow-disallowed-tools.test.ts — `agent({ disallowedTools })` reaches the
 * runner through the real workflow host and the real manager.
 *
 * Each hop is a one-line spread, and a dropped one fails quietly: the child
 * runs with the tools the script meant to take away. The worker-side shape and
 * the runner's union with the agent file's list are tested where they live;
 * this pins the hops between them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const pi = {} as any;

const spawnRequest = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "do the thing",
  label: "impl",
  agentType: "general-purpose",
  ...overrides,
});

describe("the workflow host forwards a spawn's disallowedTools", () => {
  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    registerAgents(new Map());
  });

  it("hands the list to the runner, and nothing when the script set none", async () => {
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager: new AgentManager() });

    await host.spawnAgent(spawnRequest({ disallowedTools: ["Bash", "Write"] }));
    await host.spawnAgent(spawnRequest({ agentId: "wf-agent-1", index: 1 }));

    const options = vi.mocked(runAgent).mock.calls.map(call => call[3] as Record<string, unknown>);
    expect(options[0].disallowedTools).toEqual(["Bash", "Write"]);
    expect(options[1].disallowedTools).toBeUndefined();
  });
});
