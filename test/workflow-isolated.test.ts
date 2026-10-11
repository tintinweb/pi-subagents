/**
 * workflow-isolated.test.ts — an agent file's `isolated: true` survives the
 * SubagentWorkflow spawn path.
 *
 * The Agent tool resolves `isolated` off the agent definition and hands it to
 * the manager as a spawn option. The workflow host resolves the same config
 * for its model precedence but never forwarded the flag, so a hermetic agent
 * spawned by a script loaded every host extension and picked up its MCP and
 * web tools. The builtin-tool allowlist still applied, which is what made the
 * leak quiet: the child looked restricted until it listed its tools.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => false),
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

/** The spawn options the manager handed to `runAgent` for the first child. */
function runAgentOptions(): Record<string, unknown> {
  return vi.mocked(runAgent).mock.calls[0]?.[3] as Record<string, unknown>;
}

describe("the workflow host forwards an agent's `isolated`", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    registerAgents(new Map());
    manager = new AgentManager();
  });

  it("passes `isolated: true` from the agent file through to the runner", async () => {
    registerAgents(new Map([["hermit", { name: "hermit", isolated: true } as any]]));
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });

    await host.spawnAgent(spawnRequest({ agentType: "hermit" }));

    expect(runAgentOptions()).toMatchObject({ isolated: true });
  });

  it("passes an explicit `isolated: false` too, rather than only truthy values", async () => {
    registerAgents(new Map([["open", { name: "open", isolated: false } as any]]));
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });

    await host.spawnAgent(spawnRequest({ agentType: "open" }));

    expect(runAgentOptions()).toMatchObject({ isolated: false });
  });

  it("leaves `isolated` undefined when the agent file does not set it", async () => {
    // The runner's own default must decide here. Forwarding `false` for an
    // unset flag would be a different, unrequested behaviour.
    registerAgents(new Map([["plain", { name: "plain" } as any]]));
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });

    await host.spawnAgent(spawnRequest({ agentType: "plain" }));

    expect(runAgentOptions().isolated).toBeUndefined();
  });
});
