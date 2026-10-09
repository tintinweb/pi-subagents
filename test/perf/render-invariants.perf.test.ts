/**
 * render-invariants.perf.test.ts — the shape of the render paths, asserted as
 * operation counts rather than as time.
 *
 * These run in the normal suite, which means they run three times per CI push
 * (build, floor-Pi, latest-Pi) on shared runners. A wall-clock threshold there
 * would be a flake generator: two runs of identical code in this repo differed
 * by 7% on ordering alone. So nothing here is timed. Counting how many times a
 * render reaches a leaf is deterministic, costs milliseconds, and catches the
 * regression that actually hurts — work that stops being linear, or a frame
 * that starts touching the disk.
 *
 * Absolute numbers live in `test/perf/*.bench.ts`, where a human reads them.
 *
 * Every bound here is an upper bound, never an equality: making one of these
 * paths cheaper must not turn a test red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Counters for the pi-tui leaves the viewer wraps its text with. */
const counts = { wrap: 0, markdownNew: 0, markdownRender: 0 };

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  class CountingMarkdown extends (actual.Markdown as any) {
    constructor(...args: any[]) {
      super(...args);
      counts.markdownNew++;
    }
    render(...args: any[]) {
      counts.markdownRender++;
      return super.render(...args);
    }
  }
  return {
    ...actual,
    Markdown: CountingMarkdown,
    wrapTextWithAnsi: (...args: [string, number]) => {
      counts.wrap++;
      return actual.wrapTextWithAnsi(...args);
    },
  };
});

// After the mock, so the subjects bind the counting versions.
const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeActivity, makeFleet, makeSession, mountViewer, perfTheme, perfTui } = await import(
  "../helpers/perf-fixtures.js"
);

beforeEach(() => {
  counts.wrap = 0;
  counts.markdownNew = 0;
  counts.markdownRender = 0;
});

describe("ConversationViewer — cost stays linear in transcript length", () => {
  /** Leaf calls one render makes over a transcript of `n` messages. */
  function wrapsFor(n: number, mode: string): number {
    const viewer = mountViewer(ConversationViewer, makeSession(n), undefined, () => mode);
    viewer.render(120); // prime, so caches are warm and only steady state counts
    counts.wrap = 0;
    counts.markdownRender = 0;
    viewer.render(120);
    return counts.wrap + counts.markdownRender;
  }

  it("does not re-wrap unchanged raw history on a warm frame", () => {
    expect(wrapsFor(30, "off")).toBe(0);
    expect(wrapsFor(300, "off")).toBe(0);
  });

  it("does not re-render unchanged Markdown history on a warm frame", () => {
    expect(wrapsFor(30, "assistant")).toBe(0);
    expect(wrapsFor(300, "assistant")).toBe(0);
  });

  it("keeps cold raw and Markdown rendering linear in transcript length", () => {
    function coldLeavesFor(n: number, mode: string): number {
      const before = counts.wrap + counts.markdownRender;
      mountViewer(ConversationViewer, makeSession(n), undefined, () => mode).render(120);
      return counts.wrap + counts.markdownRender - before;
    }

    for (const mode of ["off", "assistant"]) {
      const small = coldLeavesFor(30, mode);
      const large = coldLeavesFor(300, mode);
      expect(large / small).toBeLessThanOrEqual(11);
    }
  });

  // #259's WeakMap is keyed by the message object. If a refactor ever rebuilds
  // messages, or keys the cache on something that changes per frame, every frame
  // re-parses the whole transcript as Markdown — a cost this suite measured at
  // roughly 10x the warm path. Nothing else in the suite would notice.
  it("re-renders without re-parsing: the markdown cache survives a frame", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(60), undefined, () => "assistant");
    viewer.render(120);
    const afterFirst = counts.markdownNew;
    expect(afterFirst).toBeGreaterThan(0);

    viewer.render(120);
    viewer.render(120);

    expect(counts.markdownNew).toBe(afterFirst);
  });

  it("rebuilds only the live suffix across tool execution updates", () => {
    function activeWorkFor(messageCount: number): { leaves: number; messageReads: number } {
      const session = makeSession(messageCount);
      session.messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: "live-1", name: "bash", arguments: { command: "sleep 10" } }],
      } as any);
      let messageReads = 0;
      let listener = (_event: unknown) => {};
      session.messages = new Proxy(session.messages, {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) messageReads++;
          return Reflect.get(target, property, receiver);
        },
      });
      session.subscribe = (callback: (event: unknown) => void) => {
        listener = callback;
        return () => {};
      };
      const record = makeFleet({ running: 1 })[0];
      const activity = {
        activeTools: new Map([["live-1", "bash"]]),
        activeToolCalls: new Map([["live-1", {
          toolName: "bash",
          args: { command: "sleep 10" },
          startedAt: Date.now() - 1_000,
          partialResult: { content: [{ type: "text", text: "quiet build" }] },
        }]]),
        toolUses: 1,
        responseText: "",
        turnCount: 1,
      };
      const viewer = new ConversationViewer(perfTui(), session, record, activity, perfTheme, () => {}, undefined, undefined, undefined, false, () => "off");
      viewer.render(120);
      counts.wrap = 0;
      counts.markdownRender = 0;
      messageReads = 0;
      for (let i = 0; i < 10; i++) {
        listener({
          type: "tool_execution_update",
          toolCallId: "live-1",
          toolName: "bash",
          args: { command: "sleep 10" },
          partialResult: { content: [{ type: "text", text: `chunk ${i}` }] },
        });
        viewer.render(120);
      }
      viewer.dispose();
      return { leaves: counts.wrap + counts.markdownRender, messageReads };
    }

    const small = activeWorkFor(1_000);
    const large = activeWorkFor(5_000);
    expect(small.leaves).toBeLessThanOrEqual(10);
    expect(large.leaves).toBe(small.leaves);
    expect(small.messageReads).toBeLessThanOrEqual(30);
    expect(large.messageReads).toBe(small.messageReads);
  });

  it("does not reread completed results during a live output update", () => {
    let contentReads = 0;
    const messages: any[] = [];
    for (let i = 0; i < 60; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: `done-${i}`, name: "bash", arguments: { command: "true" } }],
      });
      const content = [{ type: "text", text: `completed ${i}\n`.repeat(20) }];
      const result = { role: "toolResult", toolCallId: `done-${i}` } as any;
      Object.defineProperty(result, "content", {
        enumerable: true,
        get: () => {
          contentReads++;
          return content;
        },
      });
      messages.push(result);
    }
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: "live", name: "bash", arguments: { command: "sleep 10" } }],
    });
    let listener = (_event: unknown) => {};
    const session = {
      ...makeSession(0),
      messages,
      subscribe: (callback: (event: unknown) => void) => {
        listener = callback;
        return () => {};
      },
    } as any;
    const record = makeFleet({ running: 1 })[0];
    const activity = {
      activeTools: new Map([["live", "bash"]]),
      activeToolCalls: new Map([["live", {
        toolName: "bash",
        args: { command: "sleep 10" },
        startedAt: Date.now() - 1_000,
        partialResult: { content: [{ type: "text", text: "first" }] },
      }]]),
      toolUses: 61,
      responseText: "",
      turnCount: 1,
    };
    const viewer = new ConversationViewer(perfTui(), session, record, activity as any, perfTheme, () => {});
    listener({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "sleep 10" } });
    viewer.render(120);
    contentReads = 0;

    listener({
      type: "tool_execution_update",
      toolCallId: "live",
      toolName: "bash",
      args: { command: "sleep 10" },
      partialResult: { content: [{ type: "text", text: "first\nsecond" }] },
    });
    viewer.render(120);
    viewer.dispose();

    expect(contentReads).toBe(0);
  });

  it("reads one live partial result once per dirty frame", () => {
    let contentReads = 0;
    let text = "first";
    const partialResult = {} as any;
    Object.defineProperty(partialResult, "content", {
      get: () => {
        contentReads++;
        return [{ type: "text", text }];
      },
    });
    const session = makeSession(300);
    session.messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: "live", name: "bash", arguments: { command: "sleep 10" } }],
    } as any);
    const record = makeFleet({ running: 1 })[0];
    const activity = {
      activeTools: new Map([["live", "bash"]]),
      activeToolCalls: new Map([["live", {
        toolName: "bash",
        args: { command: "sleep 10" },
        startedAt: Date.now() - 1_000,
        partialResult,
      }]]),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
    };
    const viewer = new ConversationViewer(perfTui(), session, record, activity as any, perfTheme, () => {});
    viewer.render(120);
    contentReads = 0;
    text = "second";
    (viewer as any).contentDirty = true;

    viewer.render(120);
    viewer.dispose();

    expect(contentReads).toBeLessThanOrEqual(1);
  });

  it("does not rescan transcript roles for each live event", () => {
    let roleReads = 0;
    const messages = Array.from({ length: 5_000 }, (_, i) => {
      const message = { content: `message ${i}` } as any;
      Object.defineProperty(message, "role", {
        get: () => {
          roleReads++;
          return "user";
        },
      });
      return message;
    });
    let listener = (_event: unknown) => {};
    const session = {
      ...makeSession(0),
      messages,
      subscribe: (callback: (event: unknown) => void) => {
        listener = callback;
        return () => {};
      },
    } as any;
    const viewer = new ConversationViewer(
      perfTui(), session, makeFleet({ running: 1 })[0], undefined, perfTheme, () => {},
    );
    listener({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: {} });
    roleReads = 0;

    for (let i = 0; i < 10; i++) {
      listener({
        type: "tool_execution_update",
        toolCallId: "live",
        toolName: "bash",
        args: {},
        partialResult: { content: [{ type: "text", text: `chunk ${i}` }] },
      });
    }
    viewer.dispose();

    expect(roleReads).toBeLessThanOrEqual(1);
  });
});

describe("AgentWidget — one frame does not rescan per agent", () => {
  /** Renders one frame over `n` agents; returns how often the manager was asked. */
  function listCallsPerRender(n: number): number {
    const records = makeFleet({ running: n });
    let listAgentsCalls = 0;
    const manager = {
      listAgents: () => {
        listAgentsCalls++;
        return records;
      },
    } as any;

    const widget = new AgentWidget(manager, makeActivity(records), () => "all", () => false, () => false);
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: string, c: any) => { factory = c; } } as any);
    widget.update();
    const tui = perfTui();
    factory?.(tui, perfTheme).render(); // prime
    listAgentsCalls = 0;
    factory?.(tui, perfTheme).render();
    widget.dispose?.();
    return listAgentsCalls;
  }

  // Today a render is exactly one scan (`update()` does the other). The bound is
  // "a constant, and the same constant at 100 agents as at 1" — a per-agent
  // lookup added to the row builder would break it, and collapsing the two
  // remaining scans into one would not.
  it("asks the manager for the agent list a constant number of times", () => {
    expect(listCallsPerRender(1)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBeLessThanOrEqual(2);
    expect(listCallsPerRender(100)).toBe(listCallsPerRender(1));
  });
});
