/**
 * group-settle-flush.test.ts — Settle-time flush for grouped completion
 * notifications (#273).
 *
 * Wiring test through the REAL extension (same harness as
 * wait-queued.test.ts): two background agents spawned back-to-back register
 * as one smart-join group. While the parent run is active the group batch is
 * parked in-process and the delivery decision is deferred to
 * `agent_settled`, where `resultConsumed` is re-checked per record:
 *
 * - sequential full consumption before settle → no notification at all
 * - partial consumption before settle → only remaining members, count recomputed
 * - no consumption → delivered at settle (arrival time unchanged vs the old
 *   followUp queue, which also landed at run end)
 * - idle parent → immediate delivery, behavior unchanged
 * - consumption inside the 200ms hold window on the idle path → still
 *   suppressed by the fire-time re-check
 * - real teardown order (before_switch → abort's agent_settled → shutdown) →
 *   parked batches never deliver, even though agent_settled fires first
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
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function spawnBackground(tools: Map<string, any>, description: string): Promise<string> {
  const r = await tools
    .get("Agent")
    .execute(
      "tc-spawn",
      { prompt: "go", description, subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

/**
 * Spawn two background agents back-to-back so they land in the same 100ms
 * batch window and register as one smart-join group, then wait out the
 * debounce so the group exists before completions arrive.
 */
async function spawnGroup(tools: Map<string, any>) {
  const [alpha, beta] = await Promise.all([
    spawnBackground(tools, "group-alpha-agent"),
    spawnBackground(tools, "group-beta-agent"),
  ]);
  await sleep(150); // batch debounce is 100ms after the last spawn
  return { alpha, beta };
}

/** Notification payloads pi.sendMessage received. */
const sentBodies = (pi: ReturnType<typeof makePi>["pi"]): string[] =>
  pi.sendMessage.mock.calls.map((c: any[]) => String(c[0]?.content ?? ""));

describe("group completion notifications: settle-time flush (#273)", () => {
  it("parks while the parent runs and sends nothing when both results are consumed before settle", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    const { alpha, beta } = await spawnGroup(tools);

    lifecycle.get("agent_start")?.(); // parent mid-run
    resolvers[0]();
    resolvers[1]();
    await flush();
    await sleep(300); // outlive the 200ms nudge hold → batch parks
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Parent fetches both results across separate tool calls (the repro's
    // sequential-join pattern, seconds apart in production).
    await tools.get("get_subagent_result").execute("tc-a", { agent_id: alpha }, undefined, undefined, ctx());
    await tools.get("get_subagent_result").execute("tc-b", { agent_id: beta }, undefined, undefined, ctx());
    expect(pi.sendMessage).not.toHaveBeenCalled();

    lifecycle.get("agent_settled")?.();
    await sleep(10); // deferred flush fires and finds nothing to send
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  }, 15_000);

  it("delivers only remaining members with a recomputed count when one result was consumed", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    const { alpha, beta } = await spawnGroup(tools);

    lifecycle.get("agent_start")?.();
    resolvers[0]();
    resolvers[1]();
    await flush();
    await sleep(300); // parked

    await tools.get("get_subagent_result").execute("tc-a", { agent_id: alpha }, undefined, undefined, ctx());

    lifecycle.get("agent_settled")?.();
    await sleep(10); // deferred flush delivers the remaining members

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const body = sentBodies(pi)[0];
    expect(body).toContain("Background agent group completed: 1 agent(s) finished");
    expect(body).toContain(beta);
    expect(body).toContain("group-beta-agent");
    expect(body).not.toContain(alpha);
    expect(body).not.toContain("group-alpha-agent");
    expect(body).not.toContain("2 agent(s) finished");

    await lifecycle.get("session_shutdown")?.();
  }, 15_000);

  it("delivers parked batches at settle when nothing was consumed (arrival time unchanged)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    const { alpha, beta } = await spawnGroup(tools);

    lifecycle.get("agent_start")?.();
    resolvers[0]();
    resolvers[1]();
    await flush();
    await sleep(300); // parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    lifecycle.get("agent_settled")?.();
    await sleep(10); // deferred flush delivers the parked batches

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = pi.sendMessage.mock.calls[0];
    expect(String(message.content)).toContain("Background agent group completed: 2 agent(s) finished");
    expect(String(message.content)).toContain(alpha);
    expect(String(message.content)).toContain(beta);
    expect(options).toMatchObject({ deliverAs: "followUp", triggerTurn: true });

    await lifecycle.get("session_shutdown")?.();
  }, 15_000);

  it("delivers immediately when the parent is idle (behavior unchanged)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    const { alpha, beta } = await spawnGroup(tools);

    // No agent_start: parent is settled/idle.
    resolvers[0]();
    resolvers[1]();
    await flush();
    await sleep(300);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(sentBodies(pi)[0]).toContain("Background agent group completed: 2 agent(s) finished");
    expect(sentBodies(pi)[0]).toContain(alpha);
    expect(sentBodies(pi)[0]).toContain(beta);

    await lifecycle.get("session_shutdown")?.();
  }, 15_000);

  it("still suppresses on the idle path when results are consumed inside the hold window", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    const { alpha, beta } = await spawnGroup(tools);

    resolvers[0]();
    resolvers[1]();
    await flush();
    // Consume before the 200ms hold expires — the fire-time re-check drops it.
    await tools.get("get_subagent_result").execute("tc-a", { agent_id: alpha }, undefined, undefined, ctx());
    await tools.get("get_subagent_result").execute("tc-b", { agent_id: beta }, undefined, undefined, ctx());
    await sleep(300);

    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  }, 15_000);

  it("never delivers parked batches through the real teardown order (agent_settled fires before session_shutdown)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    await spawnGroup(tools);

    lifecycle.get("agent_start")?.();
    resolvers[0]();
    resolvers[1]();
    await flush();
    await sleep(300); // parked
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Real pi teardown order on replacement paths (verified against
    // agent-session-runtime.js `teardownCurrent`): session_before_switch →
    // the in-flight run is aborted — whose settle we fire here →
    // session_shutdown. The parked batch must not deliver even though
    // agent_settled fires BEFORE the shutdown event; a synchronous flush
    // there would start a new agent turn mid-teardown.
    lifecycle.get("session_before_switch")?.({ type: "session_before_switch" });
    lifecycle.get("agent_settled")?.();
    await sleep(10); // let the deferred flush fire if it were going to
    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
    await flush();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  }, 15_000);

  it("skips delivery when a session switch begins but never completes (vetoed switch)", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    const resolvers = deferredRuns();
    await spawnGroup(tools);

    lifecycle.get("agent_start")?.();
    resolvers[0]();
    resolvers[1]();
    await flush();
    await sleep(300); // parked

    // Switch initiated (teardown marker set) but vetoed — no shutdown ever
    // fires and the run just continues to its settle. Batches parked during
    // that run are dropped; the next agent_start clears the marker.
    lifecycle.get("session_before_switch")?.({ type: "session_before_switch" });
    lifecycle.get("agent_settled")?.();
    await sleep(10);

    expect(pi.sendMessage).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.();
  }, 15_000);
});
