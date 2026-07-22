/**
 * wait-queued.test.ts — get_subagent_result(wait: true) lifecycle behavior.
 *
 * Queued records have no promise yet (it's created when the queue starts
 * them), so the old `status === "running" && record.promise` condition
 * skipped the wait entirely and returned "still running" — forcing the
 * caller into a poll loop against the concurrency queue.
 *
 * Wiring test through the REAL extension: spawn background agents until one
 * queues, call the real tool with wait:true, drain the queue, and assert the
 * call returns the final result.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

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
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** runAgent mock where each call blocks until we resolve it manually. */
function deferredRuns() {
  const resolvers: Array<(v: any) => void> = [];
  vi.mocked(runAgent).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          }),
        );
      }) as any,
  );
  return resolvers;
}

async function spawnBackground(tools: Map<string, any>): Promise<{ id: string; queued: boolean }> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "queued-wait test agent", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
  return { id, queued: textOf(r).includes("queued in background") };
}

describe("get_subagent_result wait:true on a queued agent", () => {
  it("waits through queue start and returns the result (no 'still running')", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();

    // Spawn until one lands in the queue (concurrency limit is config-dependent).
    let queuedId: string | undefined;
    for (let i = 0; i < 10 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 10 spawns").toBeDefined();

    // wait:true on the QUEUED agent — must not return "still running".
    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait", { agent_id: queuedId, wait: true }, undefined, undefined, ctx());

    // Drain: resolve running agents until the queued one starts and finishes.
    let settled = false;
    void waitPromise.then(() => { settled = true; });
    for (let i = 0; i < 40 && !settled; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      await new Promise((r) => setTimeout(r, 100)); // outlive one 250ms poll tick
    }

    const result = await waitPromise;
    expect(textOf(result)).toContain("THE-RESULT-PAYLOAD");
    expect(textOf(result)).not.toContain("still running");

    await new Promise((r) => setTimeout(r, 350));
    expect(JSON.stringify(pi.sendMessage.mock.calls)).not.toContain(queuedId);

    await lifecycle.get("session_shutdown")?.();
  }, 20_000);

  it("aborts a running result wait without aborting or consuming the child", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    let resolveRun: (() => void) | undefined;
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, _prompt, options) =>
        new Promise((resolve) => {
          childSignal = options.signal;
          resolveRun = () => resolve({
            responseText: "THE-RESULT-PAYLOAD",
            session: { dispose: vi.fn() } as any,
            aborted: false,
            steered: false,
          });
        }),
    );

    const { id } = await spawnBackground(tools);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-wait-abort", { agent_id: id, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    const childWasAborted = childSignal?.aborted;

    resolveRun?.();
    await flush();
    await waitOutcome;
    await new Promise((r) => setTimeout(r, 350));

    const completedResult = await tools
      .get("get_subagent_result")
      .execute("tc-result", { agent_id: id }, undefined, undefined, ctx());

    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(childWasAborted).toBe(false);
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });

  it("aborts a queued result wait before the agent starts", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    let queuedId: string | undefined;
    for (let i = 0; i < 10 && !queuedId; i++) {
      const { id, queued } = await spawnBackground(tools);
      if (queued) queuedId = id;
    }
    expect(queuedId, "expected to hit the concurrency limit within 10 spawns").toBeDefined();

    const controller = new AbortController();
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-queued-abort", { agent_id: queuedId, wait: true }, controller.signal, undefined, ctx())
      .then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.name : String(error),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    let completedResult: any;
    for (let i = 0; i < 40 && !completedResult; i++) {
      while (resolvers.length > 0) resolvers.shift()!();
      await flush();
      const result = await tools
        .get("get_subagent_result")
        .execute("tc-queued-result", { agent_id: queuedId }, undefined, undefined, ctx());
      if (textOf(result).includes("THE-RESULT-PAYLOAD")) completedResult = result;
      await new Promise((r) => setTimeout(r, 25));
    }

    await waitOutcome;
    await lifecycle.get("session_shutdown")?.();

    expect(outcome).toBe("AbortError");
    expect(textOf(completedResult)).toContain("THE-RESULT-PAYLOAD");
  });
});
