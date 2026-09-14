/**
 * workflow-effective-config.test.ts — the host half of #168/#182 for workflows.
 *
 * Every other subagent surface names the model the child ACTUALLY ran on, read
 * back from its session onto `AgentRecord.invocation` once pi has resolved its
 * defaults and clamped the thinking level. Workflow rows used to be the
 * exception: they showed `payload.model`, the raw string the script wrote, so a
 * fuzzy `"haiku"` stayed `"haiku"` and an `agent()` that named no model showed
 * nothing at all for the whole run.
 *
 * The runtime side — that a reported value updates the row in place, mid-run —
 * is covered in `test/workflow-runtime.test.ts`. This file covers the seam that
 * feeds it: the host reading the record's snapshot and handing it over.
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

/**
 * Collect only the reports that say something about the child's EFFECTIVE
 * configuration.
 *
 * The host fires `onResolved` once more than these tests are about: the moment
 * the manager issues a record id it reports that id and nothing else, ahead of
 * any session, so a child that dies before one exists is still openable in the
 * inspector. Every test below is about the configuration half, so the id is
 * stripped and an id-only report is dropped; that it fires at all has its own
 * test at the bottom.
 */
function configCollector(into: Record<string, unknown>[]) {
  return (info: Record<string, unknown>) => {
    const { recordId: _recordId, ...rest } = info;
    if (Object.keys(rest).length > 0) into.push(rest);
  };
}

/**
 * Stand in for pi resolving the child's session.
 *
 * The real `runAgent` invokes the `onSessionCreated` the manager hands it, and
 * the manager's own handler is what writes `describeModel(session.model)` onto
 * the record before passing the session along — so firing this is what makes
 * `record.invocation` populated by the time the host reads it.
 */
function childSessionReports(session: { model?: unknown; thinkingLevel?: string }) {
  vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
    opts.onSessionCreated?.({ dispose: vi.fn(), ...session } as any);
    return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
  });
}

describe("the workflow host reports a child's effective configuration", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    registerAgents(new Map());
    manager = new AgentManager();
  });

  it("hands over the model the session actually resolved to, not the script's spelling", async () => {
    // `name` too: resolveModel fuzzy-matches across id, name and provider/id.
    const haiku = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" };
    childSessionReports({ model: haiku });
    // The registry has to resolve the script's fuzzy spelling, or the spawn is
    // refused before it ever reaches a session — which is the correct behaviour
    // for an unresolvable model, and not what this test is about.
    const host = createWorkflowHost({
      pi,
      ctx: ctx({ modelRegistry: { find: vi.fn(() => haiku), getAvailable: vi.fn(() => [haiku]) } }),
      manager,
    });
    const reported: unknown[] = [];

    // The script asked fuzzily; the row must not keep saying "haiku".
    await host.spawnAgent(spawnRequest({ model: "haiku", onResolved: configCollector(reported) }));

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ modelId: "anthropic/claude-haiku-4-5" });
    expect((reported[0] as { modelName?: string }).modelName).toBeTruthy();
  });

  it("reports for an agent that named no model — the inherited case", async () => {
    childSessionReports({ model: { provider: "anthropic", id: "claude-sonnet-4-6" } });
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });
    const reported: { modelId?: string }[] = [];

    await host.spawnAgent(spawnRequest({ onResolved: configCollector(reported) }));

    // This is the one #168 was filed about: nothing was requested, so without
    // the read-back there is nothing at all to render.
    expect(reported[0]?.modelId).toBe("anthropic/claude-sonnet-4-6");
  });

  it("discloses a thinking level pi clamped below what was asked for (#182)", async () => {
    childSessionReports({ model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" });
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });
    const reported: { thinking?: string; requestedThinking?: string }[] = [];

    await host.spawnAgent(spawnRequest({ effort: "max", onResolved: configCollector(reported) }));

    // Both halves, or the row cannot say "low (asked max)" — and without the
    // seeded request there would be nothing for the manager to compare against.
    expect(reported[0]?.thinking).toBe("low");
    expect(reported[0]?.requestedThinking).toBe("max");
  });

  // Why the workflow path never discloses a model override at all: unlike the
  // Agent tool (`agentConfig?.model ?? params.model`), this path resolves
  // `request.model ?? config?.model`, so the script outranks the agent file and
  // therefore always got the model it asked for. Seeding a `requestedModel` here
  // would describe a precedence that does not exist.
  it("lets the script's model outrank the agent file's, so there is nothing to disclose", async () => {
    const haiku = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5" };
    const opus = { provider: "anthropic", id: "claude-opus-4-6", name: "Opus 4.6" };
    registerAgents(new Map([["pinned", { name: "pinned", model: "anthropic/claude-opus-4-6" } as any]]));
    childSessionReports({ model: haiku });
    const host = createWorkflowHost({
      pi,
      ctx: ctx({
        modelRegistry: {
          // Resolves by what it was ASKED for — a stub that answers `haiku` to
          // everything would let the assertion below pass whichever model won.
          find: vi.fn((provider: string, id: string) =>
            [haiku, opus].find(m => m.provider === provider && m.id === id),
          ),
          getAvailable: vi.fn(() => [haiku, opus]),
        },
      }),
      manager,
    });
    const reported: { requestedModel?: string }[] = [];

    await host.spawnAgent(
      spawnRequest({ agentType: "pinned", model: "haiku", onResolved: configCollector(reported) }),
    );

    // The script's "haiku" won over the file's pinned opus...
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({ model: haiku });
    // ...so nothing was overridden, and nothing is disclosed.
    expect(reported[0]?.requestedModel).toBeUndefined();
  });

  it("says nothing about a level that was honoured", async () => {
    childSessionReports({ model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" });
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });
    const reported: { requestedThinking?: string }[] = [];

    await host.spawnAgent(spawnRequest({ effort: "low", onResolved: configCollector(reported) }));

    expect(reported[0]?.requestedThinking).toBeUndefined();
  });

  it("does not fire when the session never reports a model", async () => {
    // A stubbed or older session must degrade to "nothing to say" rather than
    // firing an empty report, which would cost the row a pointless redraw.
    // Deliberately requests no model: passing an unresolvable one would refuse
    // the spawn outright and this would pass without reaching a session at all.
    childSessionReports({});
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });
    const reported: Record<string, unknown>[] = [];

    await host.spawnAgent(spawnRequest({ onResolved: configCollector(reported) }));

    expect(reported).toEqual([]);
  });

  it("reports the record id ahead of any session, so the row is openable either way", async () => {
    // The inspector's `c` key opens the manager's record for this child. The
    // id is knowable as soon as the manager issues it, and gating it on the
    // session — as the configuration half is — would leave exactly the
    // children worth reading, the ones that died in startup, unopenable.
    childSessionReports({});
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager });
    const reported: { recordId?: string }[] = [];

    await host.spawnAgent(spawnRequest({ onResolved: info => reported.push(info) }));

    expect(reported).toHaveLength(1);
    // The id the manager issued, and not the run's own `wf-agent-0` handle,
    // which means nothing outside the runtime.
    const recordId = reported[0]?.recordId;
    expect(recordId).toBeTruthy();
    expect(recordId).not.toBe("wf-agent-0");
    expect(manager.getRecord(recordId!)).toBeDefined();
  });
});
