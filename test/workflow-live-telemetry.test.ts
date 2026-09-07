/** Real manager → host → runtime → task counters, with only model execution held offline. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { collapse, displayState } from "../src/workflow/progress.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  updateWorkflowProgressBatch,
  type WorkflowTask,
} from "../src/workflow/task.js";
import { ctx, makePi } from "./helpers/boot-extension.js";

type Callbacks = Pick<NonNullable<Parameters<typeof runAgent>[3]>, "onToolActivity" | "onAssistantUsage">;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function snapshot(task: WorkflowTask) {
  return {
    status: task.status,
    tokens: task.totalTokens,
    toolCalls: task.totalToolCalls,
    agents: collapse(task.workflowProgress).agents.map(entry => ({
      state: displayState(entry, task.status === "running"),
      tokens: entry.tokens ?? 0,
      toolCalls: entry.toolCalls ?? 0,
      attempt: entry.attempt ?? 1,
    })),
  };
}

describe("workflow live telemetry (#298)", () => {
  let manager: AgentManager;
  const releases: (() => void)[] = [];
  const runs: { task: WorkflowTask; done: Promise<unknown> }[] = [];

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
    registerAgents(new Map());
    manager = new AgentManager();
  });

  afterEach(async () => {
    for (const { task } of runs) task.abortController.abort();
    for (const release of releases.splice(0)) release();
    await Promise.all(runs.splice(0).map(run => run.done));
    await manager.waitForAll();
    await manager.dispose();
  });

  function hold(kind: "spawn" | "resume" = "spawn") {
    const ready = deferred<Callbacks>();
    const finish = deferred<{ failure?: string }>();
    releases.push(() => finish.resolve({}));
    if (kind === "spawn") {
      vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options = {}) => {
        const session = { dispose: vi.fn(), abort: vi.fn() } as unknown as AgentSession;
        options.onSessionCreated?.(session);
        ready.resolve(options);
        return { session, responseText: "done", aborted: false, steered: false, ...await finish.promise };
      });
    } else {
      vi.mocked(resumeAgent).mockImplementationOnce(async (_session, _prompt, options = {}) => {
        ready.resolve(options);
        return { text: "continued", ...await finish.promise };
      });
    }
    return { ready: ready.promise, finish: (failure?: string) => finish.resolve({ failure }) };
  }

  function start(body: string) {
    const script = `export const meta = { name: "telemetry", description: "offline counters" };\n${body}`;
    const task = createWorkflowTask({ id: "wf-telemetry", script });
    const host = createWorkflowHost({
      pi: makePi().pi, ctx: ctx(), manager, workflowId: task.id, signal: task.abortController.signal,
    });
    const requests: WorkflowSpawnRequest[] = [];
    const done = runWorkflow({
      script,
      signal: task.abortController.signal,
      host: {
        ...host,
        spawnAgent(request) {
          requests.push(request);
          return host.spawnAgent(request);
        },
      },
      onControl: control => { task.control = control; },
      onProgress: entries => updateWorkflowProgressBatch(task, entries),
    }).then(result => { completeWorkflowTask(task, result); return result; });
    runs.push({ task, done });
    return { task, done, requests };
  }

  it.each(["completed", "failed", "skipped"] as const)("updates a running spawn and settles %s without double counting", async outcome => {
    const child = hold();
    const { task, done, requests } = start("await agent('work'); return budget.spent();");
    const callbacks = await child.ready;
    // These are finalized message_end deltas, not provider streaming estimates.
    callbacks.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 5, cacheRead: 900 });
    callbacks.onToolActivity?.({ type: "start", toolName: "read" });
    expect.soft(snapshot(task)).toMatchObject({
      status: "running", tokens: 125, toolCalls: 0,
      agents: [{ state: "running", tokens: 125, toolCalls: 0 }],
    });
    callbacks.onToolActivity?.({ type: "end", toolName: "read" });
    expect.soft(snapshot(task)).toMatchObject({
      status: "running", tokens: 125, toolCalls: 1,
      agents: [{ state: "running", tokens: 125, toolCalls: 1 }],
    });
    // Drop a live report at the host seam: settlement must still reconcile the
    // manager's authoritative totals, including usage not seen by the UI.
    const reportProgress = requests[0].onProgress;
    requests[0].onProgress = undefined;
    callbacks.onAssistantUsage?.({ input: 40, output: 7, cacheWrite: 3 });
    callbacks.onToolActivity?.({ type: "end", toolName: "bash" });
    requests[0].onProgress = reportProgress;
    if (outcome === "skipped") task.control?.skip(0);
    child.finish(outcome === "failed" ? "provider failed" : undefined);
    const result = await done;
    expect.soft({ ...snapshot(task), spent: result.value }).toMatchObject({
      status: "completed", tokens: 175, toolCalls: 2, spent: 27,
      agents: [{ state: outcome === "completed" ? "done" : outcome, tokens: 175, toolCalls: 2 }],
    });
    // A delayed host callback cannot append a running entry after completion/skip.
    const version = task.progressVersion;
    requests[0].onProgress?.({ tokens: 999, toolCalls: 99 });
    expect(task.progressVersion).toBe(version);
  });

  it("counts each resume's increment while keeping the original row settled", async () => {
    const first = hold();
    const second = hold("resume");
    const third = hold("resume");
    const { task, done, requests } = start([
      "await agent('work', { label: 'a' });",
      "await agent('continue', { resume: 'a' });",
      "await agent('continue again', { resume: 'a' });",
      "return budget.spent();",
    ].join("\n"));
    const initial = await first.ready;
    initial.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 5 });
    initial.onToolActivity?.({ type: "end", toolName: "read" });
    first.finish();
    const continued = await second.ready;
    continued.onAssistantUsage?.({ input: 40, output: 7, cacheWrite: 3 });
    continued.onToolActivity?.({ type: "end", toolName: "read" });
    // Same runtime agentId is in flight again: an id-only liveness guard is insufficient.
    requests[0].onProgress?.({ tokens: 999, toolCalls: 99 });
    expect.soft(snapshot(task)).toMatchObject({
      status: "running", tokens: 175, toolCalls: 2,
      agents: [
        { state: "done", tokens: 125, toolCalls: 1 },
        { state: "running", tokens: 50, toolCalls: 1 },
      ],
    });
    second.finish();
    const continuedAgain = await third.ready;
    continuedAgain.onAssistantUsage?.({ input: 4, output: 2, cacheWrite: 1 });
    continuedAgain.onToolActivity?.({ type: "end", toolName: "read" });
    third.finish();
    const result = await done;
    expect({ ...snapshot(task), spent: result.value }).toMatchObject({
      status: "completed", tokens: 182, toolCalls: 3, spent: 29,
      agents: [
        { state: "done", tokens: 125, toolCalls: 1 },
        { state: "done", tokens: 50, toolCalls: 1 },
        { state: "done", tokens: 7, toolCalls: 1 },
      ],
    });
  });

  it("retains retry spend once and ignores the previous attempt's callback", async () => {
    const first = hold();
    const second = hold();
    const { task, done, requests } = start("await agent('work'); return budget.spent();");
    const initial = await first.ready;
    initial.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 5 });
    initial.onToolActivity?.({ type: "end", toolName: "read" });
    task.control?.retry(0);
    first.finish();
    const retried = await second.ready;
    retried.onAssistantUsage?.({ input: 40, output: 7, cacheWrite: 3 });
    retried.onToolActivity?.({ type: "end", toolName: "read" });
    requests[0].onProgress?.({ tokens: 999, toolCalls: 99 });
    expect.soft(snapshot(task)).toMatchObject({
      status: "running", tokens: 175, toolCalls: 2,
      agents: [{ state: "running", tokens: 175, toolCalls: 2, attempt: 2 }],
    });
    second.finish();
    const result = await done;
    expect({ ...snapshot(task), spent: result.value }).toMatchObject({
      status: "completed", tokens: 175, toolCalls: 2, spent: 27,
      agents: [{ state: "done", tokens: 175, toolCalls: 2, attempt: 2 }],
    });
  });
});
