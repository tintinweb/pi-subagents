/**
 * usage-reporting.test.ts — proves subagent spend actually reaches the parent
 * session (#193), through the real registered tools.
 *
 * Pi folds `toolResult.usage` into `getSessionStats()`, which is what the
 * footer, the statusline and `/cost` read. So the observable contract is not
 * "we tracked a number" but "the tool result carries a complete pi `Usage`" —
 * and every assertion here is about that object: that it appears, that it
 * appears exactly once per message of spend, that it never appears when the
 * user did not ask for it, and that it is complete enough for pi to consume
 * without throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { addUsage } from "../src/usage.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Drive one foreground run that spends `usage` on a single assistant message. */
function runSpending(usage: { input: number; output: number; cacheWrite: number; cacheRead?: number; cost?: number }) {
  vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
    opts.onAssistantUsage?.(usage);
    return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
  });
}

/** Nothing spent — the agent errored before any message_end fired. */
function runSpendingNothing() {
  vi.mocked(runAgent).mockImplementation(async () => (
    { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false }
  ));
}

const spawn = (tools: Map<string, any>, toolCallId: string | undefined) =>
  tools.get("Agent").execute(
    toolCallId,
    { prompt: "go", description: "spend", subagent_type: "general-purpose", run_in_background: false },
    undefined, undefined, ctx(),
  );

describe("reporting subagent usage back to the parent session", () => {
  let hermetic: Hermetic;

  function boot(settings: Record<string, unknown>) {
    hermetic = hermeticDir({ settings });
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    registerAgents(new Map());
    hermetic?.restore();
  });

  it("attaches a complete pi Usage to the tool result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

    const result = await spawn(tools, "tc-1");

    // Every field pi's `addUsageToTotals` touches must exist: it reads
    // `usage.cost.total` with no guard, so a partial object throws inside pi.
    expect(result.usage).toEqual({
      input: 100,
      output: 50,
      // Included, unlike our own display total (#38): pi sums cacheRead across
      // the parent's own messages into this same figure, so withholding it
      // would make a subagent's rows count differently from every other row.
      cacheRead: 900,
      cacheWrite: 10,
      totalTokens: 1060,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
    });
  });

  it("reports each message's spend exactly once", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    await spawn(tools, "tc-1");
    runSpendingNothing();
    const second = await spawn(tools, "tc-2");

    // Not "the second result is smaller" — a pool that failed to reset would
    // re-report the first run's spend here, and the parent's totals would climb
    // on every later tool call for work that happened once.
    expect(second.usage).toBeUndefined();
  });

  it("carries what a later run spends on the later result", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });
    await spawn(tools, "tc-1");

    runSpending({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
    const second = await spawn(tools, "tc-2");

    expect(second.usage.totalTokens).toBe(10);
    expect(second.usage.cost.total).toBe(0.002);
  });

  it("attaches nothing when the setting is off", async () => {
    const { tools } = boot({ reportUsage: false });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const result = await spawn(tools, "tc-1");

    expect(result.usage).toBeUndefined();
    // And the text result is untouched — the setting must not change what the
    // orchestrator reads.
    expect(result.content[0].text).toContain("Agent completed");
  });

  it("defaults to off", async () => {
    const { tools } = boot({});
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    expect((await spawn(tools, "tc-1")).usage).toBeUndefined();
  });

  it("attaches nothing to a call with no tool-call id, and loses none of it", async () => {
    // The `@handle` mention path: a fork of the conversation calls the
    // registered tool with `undefined`, and its session is discarded. Usage hung
    // on that result is spend the user paid for and nobody counted.
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    const cloned = await spawn(tools, undefined);
    expect(cloned.usage).toBeUndefined();

    // It was not dropped — the next result the real session gets carries it.
    runSpendingNothing();
    const real = await spawn(tools, "tc-2");
    expect(real.usage.cost.total).toBe(0.0123);
    expect(real.usage.totalTokens).toBe(160);
  });

  it("attaches nothing when a run produced no usage at all", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpendingNothing();

    expect((await spawn(tools, "tc-1")).usage).toBeUndefined();
  });

  it("reports an unpriced model's tokens with a zero cost rather than dropping them", async () => {
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

    const result = await spawn(tools, "tc-1");

    expect(result.usage.totalTokens).toBe(160);
    expect(result.usage.cost.total).toBe(0);
  });

  it("reports what a background resume spends, on the next call", async () => {
    // Resuming detached is the default since #237, and it runs through a
    // different manager path again — one whose result is an ID, not the spend.
    // The next tool call is what has to carry it.
    const { pi, tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
    await spawn(tools, "tc-1");
    await flush();
    const id = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed")?.[1]?.id;

    vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
      return { text: "resumed" };
    });

    const started = await tools.get("Agent").execute(
      "tc-2",
      { prompt: "more", description: "spend", subagent_type: "general-purpose", resume: id, run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();
    runSpendingNothing();
    const next = await spawn(tools, "tc-3");

    // Which of the two carries it depends on how fast the detached run
    // finishes, so the invariant is that it is reported once and in full —
    // not that it lands on a particular call.
    const reported = [started.usage, next.usage].filter(Boolean);
    expect(reported).toHaveLength(1);
    expect(reported[0].cost.total).toBe(0.002);
    expect(reported[0].totalTokens).toBe(10);
  });

  it("counts a nested child's spend once, on the top-level agent's report", async () => {
    // Nested agents are hidden from every reporting surface, so their spend is
    // deliberately double-booked into every ancestor record to stay visible
    // somewhere. Anything that summed those records would bill this session
    // twice for one child message — which is why the pool is fed from the
    // manager hook instead.
    const { pi, tools } = boot({ reportUsage: true });
    let nested = false;

    vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
      if (!nested) {
        nested = true;
        // `nestedRuntime` is exactly what nested-tools.ts is handed: the real
        // manager and the id of the agent that owns the child.
        const { manager, parentAgentId } = opts.nestedRuntime;
        const childId = manager.spawn(pi, ctx(), "general-purpose", "sub", {
          description: "nested",
          isBackground: false,
          parentAgentId,
          // The ancestor walk, verbatim from nested-tools.
          onAssistantUsage: (u: any) => addUsage(manager.getRecord(parentAgentId).lifetimeUsage, u),
        });
        await manager.getRecord(childId).promise;
      }
      return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
    });

    const result = await spawn(tools, "tc-1");

    // Two messages, one per agent — not three, which is what summing the
    // double-booked parent record would have produced.
    expect(nested).toBe(true);
    expect(result.usage.totalTokens).toBe(300);
    expect(result.usage.cost.total).toBeCloseTo(0.02, 10);
  });

  it("reports what a resume spends, not only the first run", async () => {
    // A resumed agent runs through a different manager path from a spawn, with
    // its own usage wiring. Miss it and every continuation of an agent is free
    // as far as the parent session is concerned.
    const { pi, tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
    await spawn(tools, "tc-1");
    await flush();

    vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: any, opts: any) => {
      opts.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 0, cost: 0.002 });
      return { text: "resumed" };
    });

    const id = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed")?.[1]?.id;
    const result = await tools.get("Agent").execute(
      "tc-2",
      { prompt: "more", description: "spend", subagent_type: "general-purpose", resume: id, run_in_background: false },
      undefined, undefined, ctx(),
    );

    expect(result.usage.totalTokens).toBe(10);
    expect(result.usage.cost.total).toBe(0.002);
  });

  describe("the lifecycle event payload", () => {
    /** The payload `subagents:completed` was emitted with. */
    async function completedPayload(pi: any) {
      await flush();
      const call = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed");
      return call?.[1];
    }

    it("carries the run's spend as a pi Usage", async () => {
      // pi's convention for handing spend to a consumer: every extension-facing
      // payload that carries it takes the whole object. Following it means
      // `usage.cost.total` is where a listener already looks, and whatever pi
      // adds to `Usage` later needs no change here.
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).usage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 10,
        totalTokens: 1060,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
      });
    });

    it("carries it regardless of either setting", async () => {
      // Both settings govern what a human is shown or what the session counts.
      // A listener subscribed to the event asked for the data itself.
      const { pi, tools } = boot({ reportUsage: false, showCost: false });
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).usage.cost.total).toBe(0.01);
    });

    it("keeps `tokens` as the display total it has always been", async () => {
      // The other convention — a flat view model like pi's own SessionStats,
      // excluding cacheRead (#38). It is not derived from `usage` and must not
      // start matching it.
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await spawn(tools, "tc-1");

      expect((await completedPayload(pi)).tokens).toEqual({ input: 100, output: 50, total: 160 });
    });

    it("omits usage entirely when nothing was spent", async () => {
      // So a listener can tell "spent nothing" from "never ran".
      const { pi, tools } = boot({});
      runSpendingNothing();

      await spawn(tools, "tc-1");

      const payload = await completedPayload(pi);
      expect(payload.usage).toBeUndefined();
      expect(payload.tokens).toBeUndefined();
    });

    it("reports an unpriced model's tokens with a zero cost", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0 });

      await spawn(tools, "tc-1");

      const usage = (await completedPayload(pi)).usage;
      expect(usage.totalTokens).toBe(150);
      expect(usage.cost.total).toBe(0);
    });
  });

  describe("the per-message `subagents:usage` event", () => {
    const usageEvents = (pi: any) =>
      pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:usage").map((c: any[]) => c[1]);

    it("carries each message's spend with the agent's type and thinking level", async () => {
      // The ledger a footer needs: what was spent, by which kind of agent, at
      // which level — per message, so a running agent is not free until it stops.
      const { pi, tools } = boot({});
      runSpending({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.0123 });

      await tools.get("Agent").execute(
        "tc-1",
        { prompt: "go", description: "spend", subagent_type: "general-purpose", thinking: "low", run_in_background: false },
        undefined, undefined, ctx(),
      );

      const events = usageEvents(pi);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "general-purpose",
        description: "spend",
        thinking: "low",
        depth: 1,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 900,
          cacheWrite: 10,
          totalTokens: 1060,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
        },
      });
      expect(typeof events[0].id).toBe("string");
    });

    it("is emitted regardless of reportUsage", async () => {
      // reportUsage decides whether the parent's own totals include the spend.
      // A listener keeping its own ledger asked for the data itself.
      const { pi, tools } = boot({ reportUsage: false, showCost: false });
      runSpending({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });

      await spawn(tools, "tc-1");

      expect(usageEvents(pi).map((e: any) => e.usage.cost.total)).toEqual([0.01]);
    });

    it("is not emitted for a message that spent nothing", async () => {
      const { pi, tools } = boot({});
      runSpending({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });

      await spawn(tools, "tc-1");

      expect(usageEvents(pi)).toHaveLength(0);
    });

    it("carries the requested level when the agent did not get it", async () => {
      // A workflow asking for `minimal` on a model whose lowest level is `low`
      // runs at `low`; the ledger should be able to say so, not relabel it.
      const { pi, tools } = boot({});
      let spawned = false;
      vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
        opts.onAssistantUsage?.({ input: 10, output: 5, cacheWrite: 0, cost: 0.001 });
        if (!spawned) {
          spawned = true;
          const { manager, parentAgentId } = opts.nestedRuntime;
          const childId = manager.spawn(pi, ctx(), "general-purpose", "sub", {
            description: "clamped",
            isBackground: false,
            parentAgentId,
            depth: 2,
            invocation: { thinking: "low", requestedThinking: "minimal" },
          });
          await manager.getRecord(childId).promise;
        }
        return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
      });

      await spawn(tools, "tc-1");

      const events = usageEvents(pi);
      expect(events.find((e: any) => e.description === "clamped")).toMatchObject({ thinking: "low", requestedThinking: "minimal" });
      // An agent that got what it asked for carries no request.
      expect(events.find((e: any) => e.description === "spend").requestedThinking).toBeUndefined();
    });

    it("announces subagents:disposed after shutdown has stopped every agent", async () => {
      // A ledger's own session_shutdown can run before this extension aborts
      // the agents; this is its signal that no more usage can arrive.
      const { pi, lifecycle } = boot({});
      await lifecycle.get("session_shutdown")?.({}, ctx());
      const names = pi.events.emit.mock.calls.map((c: any[]) => c[0]);
      expect(names.at(-1)).toBe("subagents:disposed");
    });

    it("reports a nested child's message once, as the child's own", async () => {
      // The lifecycle events never fire for a nested child, and its spend is
      // double-booked into the ancestor records. A ledger summing this event
      // must see each message exactly once, under the agent that spent it.
      const { pi, tools } = boot({});
      let nested = false;

      vi.mocked(runAgent).mockImplementation(async (_c: any, _t: any, _p: any, opts: any) => {
        opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 0, cost: 0.01 });
        if (!nested) {
          nested = true;
          const { manager, parentAgentId } = opts.nestedRuntime;
          const childId = manager.spawn(pi, ctx(), "general-purpose", "sub", {
            description: "nested",
            isBackground: false,
            parentAgentId,
            depth: 2,
            onAssistantUsage: (u: any) => addUsage(manager.getRecord(parentAgentId).lifetimeUsage, u),
          });
          await manager.getRecord(childId).promise;
        }
        return { responseText: "done", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false };
      });

      await spawn(tools, "tc-1");

      const events = usageEvents(pi);
      expect(events).toHaveLength(2);
      const child = events.find((e: any) => e.description === "nested");
      const parent = events.find((e: any) => e.description === "spend");
      expect(child).toMatchObject({ depth: 2, parentAgentId: parent.id });
      expect(events.reduce((sum: number, e: any) => sum + e.usage.cost.total, 0)).toBeCloseTo(0.02, 10);
    });
  });

  it("reports spend through get_subagent_result too", async () => {
    // Background agents finish with no tool result of their own to ride on;
    // whichever of our tools is called next has to carry them.
    const { tools } = boot({ reportUsage: true });
    runSpending({ input: 100, output: 50, cacheWrite: 10, cost: 0.0123 });

    await spawn(tools, undefined);   // spend accumulates, nothing attached
    await flush();

    const result = await tools.get("get_subagent_result").execute(
      "tc-2", { agent_id: "nope" }, undefined, undefined, ctx(),
    );

    expect(result.usage.cost.total).toBe(0.0123);
  });
});
