import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;
let wrapCalls = 0;
/** Bumped per `new Markdown(...)`, so a test can assert the per-message cache holds. */
let markdownConstructions = 0;
/** Bumped per Markdown render attempt, including failed ones. */
let markdownRenderCalls = 0;
/** Forces the Markdown component to throw, for the viewer's fallback path. */
let markdownThrows = false;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...original,
    Markdown: class extends original.Markdown {
      constructor(...args: ConstructorParameters<typeof original.Markdown>) {
        markdownConstructions++;
        super(...args);
      }
      render(width: number): string[] {
        markdownRenderCalls++;
        // Real trigger is ~54 nested blockquotes overflowing pi-tui's recursive
        // renderer. Forced rather than reproduced: a real overflow costs ~2.4s
        // and its depth depends on the platform's stack limit, so reproducing it
        // makes the test both slow and liable to stop triggering silently.
        if (markdownThrows) throw new RangeError("Maximum call stack size exceeded");
        return super.render(width);
      }
    },
    wrapTextWithAnsi: (...args: [string, number]) => {
      wrapCalls++;
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer, RESULT_MAX_CHARS } = await import("../src/ui/conversation-viewer.js");

// ── Helpers ────────────────────────────────────────────────────────────

function mockTui(rows = 40, columns = 80) {
  return {
    terminal: { rows, columns },
    requestRender: vi.fn(),
  } as any;
}

function mockSession(messages: any[] = []) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

function mockRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function ansiTheme() {
  return {
    fg: (_color: string, text: string) => `\x1b[38;5;240m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  } as any;
}

function assertAllLinesFit(lines: string[], width: number) {
  for (let i = 0; i < lines.length; i++) {
    const vw = visibleWidth(lines[i]);
    expect(vw, `line ${i} exceeds width (${vw} > ${width}): ${JSON.stringify(lines[i])}`).toBeLessThanOrEqual(width);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  wrapOverride = null;
  wrapCalls = 0;
  markdownConstructions = 0;
  markdownRenderCalls = 0;
  markdownThrows = false;
});

describe("ConversationViewer invocation line", () => {
  /** The `↳` metadata row for a record, or "" when the viewer renders none. */
  function invocationLine(invocation: AgentRecord["invocation"]): string {
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), mockRecord({ invocation }), undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(),
    );
    // The row arrives inside the overlay's frame, padded out to the right
    // border; what is under test is the metadata it carries.
    const row = viewer.render(200).find(l => l.includes("↳"));
    return row ? row.slice(row.indexOf("↳")).replace(/\s*│\s*$/, "") : "";
  }

  // The canonical id, not the short label the widget uses: this overlay is
  // opened to inspect one agent and has the width to disambiguate providers.
  it("names the model with its provider", () => {
    expect(invocationLine({
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      maxTurns: 60,
    })).toBe("↳ anthropic/claude-sonnet-4-6 · thinking: high · max turns: 60");
  });

  it("falls back to the short label when no canonical id was captured", () => {
    expect(invocationLine({ modelName: "sonnet 4.6", thinking: "high" }))
      .toBe("↳ sonnet 4.6 · thinking: high");
  });

  it("discloses a model and level the run did not honor", () => {
    expect(invocationLine({
      modelName: "haiku 4.5",
      modelId: "anthropic/claude-haiku-4-5",
      requestedModel: "google/gemini-3-pro",
      thinking: "low",
      requestedThinking: "max",
    })).toBe("↳ anthropic/claude-haiku-4-5 (asked google/gemini-3-pro) · thinking: low (asked max)");
  });

  it("renders no row at all for a record with no invocation", () => {
    expect(invocationLine(undefined)).toBe("");
  });
});

describe("ConversationViewer cost display", () => {
  /** The header line, with a cost of `cost` on the record and showCost `on`. */
  function header(on: boolean, cost: number): string {
    const record = mockRecord({
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
    } as Partial<AgentRecord>);
    const viewer = new ConversationViewer(
      mockTui(30, 200), mockSession([]), record, undefined,
      { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any,
      vi.fn(), undefined, undefined, undefined, on,
    );
    return viewer.render(200).join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    // The viewer opens on finished agents, whose live activity entry is gone —
    // so this reads the record, and would show nothing if it did not.
    const out = header(true, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const out = header(false, 0.0042);
    expect(out).toContain("1.2k token");
    expect(out).not.toContain("$");
  });

  it("shows no cost for a model with no pricing data", () => {
    expect(header(true, 0)).not.toContain("$");
  });
});

describe("ConversationViewer", () => {
  describe("active tool calls", () => {
    const activeViewers: Array<InstanceType<typeof ConversationViewer>> = [];
    const strip = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

    function activeViewer(
      calls: Array<{
        id: string;
        name: string;
        args: unknown;
        startedAt?: number;
        partialResult?: unknown;
      }>,
      rows = 200,
    ) {
      const activeToolCalls = new Map(calls.map(call => [call.id, {
        toolName: call.name,
        args: call.args,
        startedAt: call.startedAt ?? Date.now() - 1_000,
        partialResult: call.partialResult,
      }]));
      const activity = {
        activeTools: new Map(calls.map(call => [call.id, call.name])),
        activeToolCalls,
        toolUses: 0,
        responseText: "",
        turnCount: 1,
      };
      const messages = [{
        role: "assistant",
        content: calls.map(call => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args })),
      }];
      const tui = mockTui(rows, 120);
      const viewer = new ConversationViewer(
        tui, mockSession(messages), mockRecord(), activity, ansiTheme(), vi.fn(),
      );
      activeViewers.push(viewer);
      return { viewer, tui, activeToolCalls };
    }

    afterEach(() => {
      for (const viewer of activeViewers) viewer.dispose();
      activeViewers.length = 0;
      vi.useRealTimers();
    });

    it("shows a bash command, dynamic elapsed time, and configured timeout", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:12.400Z"));
      const { viewer, tui } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "npm test", timeout: 30 },
        startedAt: Date.now() - 12_400,
      }]);

      expect(strip(viewer.render(120).join("\n"))).toContain("[Tool: bash · 12.4s · timeout 30s]");
      expect(strip(viewer.render(120).join("\n"))).toContain("$ npm test");

      vi.advanceTimersByTime(600);
      expect(tui.requestRender).toHaveBeenCalled();
      expect(strip(viewer.render(120).join("\n"))).toContain("[Tool: bash · 13.0s · timeout 30s]");
      viewer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("explicitly says when bash has no timeout", () => {
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "sleep 10" },
      }]);

      expect(strip(viewer.render(120).join("\n"))).toContain("[Tool: bash · 1.0s · no timeout]");
    });

    it("summarizes primary file/search arguments and bounds a fallback", () => {
      const { viewer } = activeViewer([
        { id: "read-1", name: "read", args: { path: "src/index.ts", offset: 10 } },
        { id: "grep-1", name: "grep", args: { pattern: "needle", path: "src" } },
        { id: "other-1", name: "custom", args: { payload: "x".repeat(1_000) } },
      ]);
      const out = strip(viewer.render(120).join("\n"));

      expect(out).toContain("path: src/index.ts");
      expect(out).toContain("pattern: needle");
      expect(out).toContain("path: src");
      expect(out).toContain('{"payload":"');
      expect(out).not.toContain("x".repeat(500));
    });

    it("shows a compact live tail and ctrl+o expands it within a bound", () => {
      const output = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "npm test" },
        partialResult: { content: [{ type: "text", text: output }] },
      }]);

      const compact = strip(viewer.render(120).join("\n"));
      expect(compact).toContain("77 earlier lines");
      expect(compact).toContain("ctrl+o to expand");
      expect(compact).toContain("line 79");
      expect(compact).not.toContain("line 0");

      viewer.handleInput("\x0f");
      const expanded = strip(viewer.render(120).join("\n"));
      expect(expanded).toContain("line 40");
      expect(expanded).toContain("line 79");
      expect(expanded).toContain("line 0");
      expect(expanded).toContain("ctrl+o compact");
    });

    it("keeps both ends of oversized live output in the expanded view", () => {
      const output = `LIVE HEAD\n${"x".repeat(RESULT_MAX_CHARS)}\nLIVE TAIL`;
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "long" },
        partialResult: { content: [{ type: "text", text: output }] },
      }]);

      viewer.handleInput("\x0f");
      const expanded = strip(((viewer as any).buildContentLines(116) as string[]).join("\n"));

      expect(expanded).toContain("LIVE HEAD");
      expect(expanded).toContain("LIVE TAIL");
      expect(expanded).toContain("output omitted");
    });

    it("refreshes a partial result mutated in place on dirty frames", () => {
      const partialResult = { content: [{ type: "text", text: "first chunk" }] };
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "npm test" },
        partialResult,
      }]);

      expect(strip(viewer.render(120).join("\n"))).toContain("first chunk");
      partialResult.content[0].text = "second chunk";
      (viewer as any).contentDirty = true;

      const updated = strip(viewer.render(120).join("\n"));
      expect(updated).toContain("second chunk");
      expect(updated).not.toContain("first chunk");
    });

    it("keeps active arguments and output bounded at narrow widths", () => {
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "custom",
        args: { payload: "a".repeat(10_000) },
        partialResult: { content: [{ type: "text", text: "b".repeat(20_000) }] },
      }]);

      const content = (viewer as any).buildContentLines(36) as string[];
      assertAllLinesFit(content, 36);
      expect(content.length).toBeLessThan(20);
      expect(strip(content.join("\n"))).toContain("earlier output");
    });

    it("strips terminal control sequences from arguments and partial output", () => {
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "printf '\u001b[31mred\u001b[0m\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\u001b\u0000[6n\u001b\u007fc'" },
        partialResult: { content: [{ type: "text", text: "wipe\u001b[\u00072Jokstart\u001b\u0000[6nmid\u001b\u007fcend\u001b\u0000Psecret\u001b\\safe output\u001b]unterminatedTAILnested\u001b\u001bPdrop\u001b\\]0;repwn\u0007safe" }] },
      }]);
      const raw = viewer.render(120).join("\n");
      const out = strip(raw);

      expect(out).toContain("redlink");
      expect(out).toContain("wipeokstartmidendsafe output]unterminatedTAILnestedsafe");
      expect(raw).not.toContain("evil.test");
      expect(raw).not.toContain("secret");
      expect(raw).not.toContain("repwn");
      expect(raw).not.toContain("owned");
      expect(raw).not.toContain("\u001b[6n");
      expect(raw).not.toContain("\u001bc");
    });

    it("strips terminal control sequences from orphan and bash outputs", () => {
      const messages = [
        { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "orphan\x1b[2J output" }] },
        { role: "bashExecution", command: "safe\x1b[2J command", output: "bash\x1b[2J output" },
      ];
      const raw = new ConversationViewer(
        mockTui(200, 120), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(),
      ).render(120).join("\n");

      expect(raw).not.toContain("\x1b[2J");
      expect(strip(raw)).toContain("orphan output");
      expect(strip(raw)).toContain("safe command");
      expect(strip(raw)).toContain("bash output");
    });

    it("does not re-wrap unchanged history on elapsed-time renders", () => {
      const history = Array.from({ length: 50 }, (_, i) => ({
        role: "toolResult",
        toolCallId: `old-${i}`,
        content: [{ type: "text", text: `historical output ${i}` }],
      }));
      const active = {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 10" } }],
      };
      const activity = {
        activeTools: new Map([["call-1", "bash"]]),
        activeToolCalls: new Map([["call-1", {
          toolName: "bash",
          args: { command: "sleep 10" },
          startedAt: Date.now() - 1_000,
        }]]),
        toolUses: 50,
        responseText: "",
        turnCount: 1,
      };
      const viewer = new ConversationViewer(
        mockTui(200, 120), mockSession([...history, active]), mockRecord(), activity,
        ansiTheme(), vi.fn(),
      );
      activeViewers.push(viewer);

      viewer.render(120);
      const afterFirst = wrapCalls;
      viewer.render(120);

      expect(afterFirst).toBeGreaterThanOrEqual(history.length);
      expect(wrapCalls).toBe(afterFirst);
    });

    it("recovers bounded text before a long run of non-text blocks", () => {
      const content: unknown[] = Array.from({ length: 100 }, () => ({ type: "image", data: "ignored" }));
      content.unshift({ type: "text", text: "older text" });
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "custom",
        args: {},
        partialResult: { content },
      }]);
      const out = strip(viewer.render(120).join("\n"));

      expect(out).toContain("older text");
      expect(out).toContain("earlier output");
      expect(out).toContain("ctrl+o");
    });

    it("tracks concurrent same-name calls independently and settles one", () => {
      const { viewer, activeToolCalls } = activeViewer([
        { id: "call-1", name: "read", args: { path: "one.ts" } },
        { id: "call-2", name: "read", args: { path: "two.ts" } },
      ]);

      expect(strip(viewer.render(120).join("\n"))).toContain("path: one.ts");
      expect(strip(viewer.render(120).join("\n"))).toContain("path: two.ts");

      activeToolCalls.delete("call-1");
      const after = strip(viewer.render(120).join("\n"));
      expect(after).toContain("path: one.ts");
      expect(after).toContain("path: two.ts");
      expect(after).toContain("[Tool: read]");
    });

    it("ignores stale active state after the record settles", () => {
      vi.useFakeTimers();
      const { viewer } = activeViewer([{
        id: "call-1",
        name: "bash",
        args: { command: "sleep 10" },
      }]);
      const record = (viewer as any).record as AgentRecord;
      record.status = "completed";

      expect(strip(viewer.render(120).join("\n"))).toContain("[Tool: bash]");
      const settled = strip(viewer.render(120).join("\n"));
      expect(settled).not.toContain("no timeout");
      expect(settled).not.toContain("ctrl+o");
      vi.advanceTimersByTime(100);
      expect(vi.getTimerCount()).toBe(0);
      (viewer as any).ensureElapsedTimer();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves the completed result display", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "PASS" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(200, 120), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(),
      );
      const out = strip(viewer.render(120).join("\n"));

      expect(out).toContain("[Tool: bash]");
      expect(out).not.toContain("[Result]");
      expect(out).toContain("PASS");
    });
  });

  describe("durable tool transcript blocks", () => {
    const strip = (text: string) => text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

    function viewerForTools(messages: any[], status: AgentRecord["status"] = "completed") {
      const tui = mockTui(200, 120);
      const viewer = new ConversationViewer(tui, mockSession(messages), mockRecord({ status }), undefined, ansiTheme(), vi.fn());
      return { viewer, tui };
    }

    it("renders start, multiple updates, and end as one live block", () => {
      const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "stream" } }] }];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];

      listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "stream" } });
      listener({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "stream" }, partialResult: { content: [{ type: "text", text: "first output" }] } });
      expect(strip(viewer.render(120).join("\n"))).toContain("first output");

      listener({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "stream" }, partialResult: { content: [{ type: "text", text: "first output\nsecond output" }] } });
      expect(strip(viewer.render(120).join("\n"))).toContain("second output");

      listener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "final" }] }, isError: false });
      const out = strip(viewer.render(120).join("\n"));
      expect(out).toContain("final");
      expect(out).not.toContain("[Result]");
    });

    it("bounds retained starts that never receive an end event", () => {
      const session = mockSession([{ role: "user", content: "start" }]);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      for (let i = 0; i < 500; i++) {
        listener({ type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "bash", args: { command: "sleep" } });
      }

      expect((viewer as any).toolExecutions.size).toBeLessThanOrEqual(64);
    });

    it("bounds retained updates that arrive without start events", () => {
      const session = mockSession([{ role: "user", content: "start" }]);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      for (let i = 0; i < 500; i++) {
        listener({
          type: "tool_execution_update",
          toolCallId: `call-${i}`,
          toolName: "bash",
          args: {},
          partialResult: { content: [{ type: "text", text: "output" }] },
        });
      }

      expect((viewer as any).toolExecutions.size).toBeLessThanOrEqual(64);
    });

    it("retains a start event that arrives before its transcript call", () => {
      const messages: any[] = [{ role: "user", content: "start" }];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 30" } });
      viewer.render(120);

      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 30" } }] });
      expect(strip(viewer.render(120).join("\n"))).toContain("no timeout]");
    });

    it("shows messages appended while a tool is active", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 30" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep 30" } });
      viewer.render(120);

      messages.push({ role: "user", content: "STEERING MESSAGE" });
      messages.push({ role: "assistant", content: [{ type: "text", text: "NEW ASSISTANT TEXT" }] });
      const out = strip(viewer.render(120).join("\n"));

      expect(out).toContain("STEERING MESSAGE");
      expect(out).toContain("NEW ASSISTANT TEXT");
    });

    it("pairs calls and results appended while another tool remains active", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "live", name: "bash", arguments: { command: "sleep" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "live", toolName: "bash", args: { command: "sleep" } });
      viewer.render(120);

      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "fast", name: "bash", arguments: { command: "fast" } }] });
      listener({ type: "tool_execution_start", toolCallId: "fast", toolName: "bash", args: { command: "fast" } });
      listener({ type: "tool_execution_end", toolCallId: "fast", toolName: "bash", result: { content: [{ type: "text", text: "FAST UNIQUE" }] }, isError: false });
      messages.push({ role: "toolResult", toolCallId: "fast", content: [{ type: "text", text: "FAST UNIQUE" }] });
      let out = strip(viewer.render(120).join("\n"));
      expect(out.match(/FAST UNIQUE/g)).toHaveLength(1);
      expect(out).not.toContain("[Result]");

      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "silent", name: "bash", arguments: { command: "silent" } }] });
      messages.push({ role: "toolResult", toolCallId: "silent", content: [{ type: "text", text: "SILENT UNIQUE" }] });
      out = strip(viewer.render(120).join("\n"));
      expect(out.match(/SILENT UNIQUE/g)).toHaveLength(1);
      expect(out).not.toContain("[Result]");
    });

    it("pairs a result that appears before its tool call without duplicating it", () => {
      const messages = [
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "UNIQUE RESULT" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "one" } }] },
      ];
      const out = strip(viewerForTools(messages).viewer.render(120).join("\n"));

      expect(out.match(/UNIQUE RESULT/g)).toHaveLength(1);
      expect(out).not.toContain("[Result]");
      expect(out.indexOf("$ one")).toBeLessThan(out.indexOf("UNIQUE RESULT"));
    });

    it("pairs final results by toolCallId despite parallel completion order and reopens them", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "first", name: "read", arguments: { path: "first.ts" } }, { type: "toolCall", id: "second", name: "read", arguments: { path: "second.ts" } }] },
        { role: "toolResult", toolCallId: "second", content: [{ type: "text", text: "SECOND RESULT" }] },
        { role: "toolResult", toolCallId: "first", content: [{ type: "text", text: "FIRST RESULT" }] },
      ];
      const out = strip(viewerForTools(messages).viewer.render(120).join("\n"));
      expect(out.indexOf("first.ts")).toBeLessThan(out.indexOf("FIRST RESULT"));
      expect(out.indexOf("FIRST RESULT")).toBeLessThan(out.indexOf("second.ts"));
      expect(out.indexOf("second.ts")).toBeLessThan(out.indexOf("SECOND RESULT"));
      expect(out).not.toContain("[Result]");
    });

    it("pairs repeated toolCallId values in occurrence order", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "SECOND RESULT" }] },
      ];
      const out = strip(viewerForTools(messages).viewer.render(120).join("\n"));

      expect(out.indexOf("$ one")).toBeLessThan(out.indexOf("FIRST RESULT"));
      expect(out.indexOf("FIRST RESULT")).toBeLessThan(out.indexOf("$ two"));
      expect(out.indexOf("$ two")).toBeLessThan(out.indexOf("SECOND RESULT"));
    });

    it("keeps a reused identifier's active output separate from its history", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_update", toolCallId: "dup", toolName: "bash", args: { command: "two" }, partialResult: { content: [{ type: "text", text: "LIVE RESULT" }] } });
      const out = strip(viewer.render(120).join("\n"));

      expect(out.indexOf("$ one")).toBeLessThan(out.indexOf("FIRST RESULT"));
      expect(out.indexOf("FIRST RESULT")).toBeLessThan(out.indexOf("$ two"));
      expect(out.indexOf("$ two")).toBeLessThan(out.indexOf("LIVE RESULT"));
    });

    it("syncs an appended result before a reused identifier updates without a start", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      messages.push({ role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }] });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] });
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_update", toolCallId: "dup", toolName: "bash", args: { command: "two" }, partialResult: { content: [{ type: "text", text: "SECOND LIVE" }] } });
      const out = strip(viewer.render(120).join("\n"));

      expect(out.indexOf("$ one")).toBeLessThan(out.indexOf("FIRST RESULT"));
      expect(out.indexOf("FIRST RESULT")).toBeLessThan(out.indexOf("$ two"));
      expect(out.indexOf("$ two")).toBeLessThan(out.indexOf("SECOND LIVE"));
    });

    it("keeps occurrence counts exact across start, end, and no-start reuse", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "first" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      viewer.render(120);
      messages.push({ role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }] });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "second" } }] });
      listener({ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "second" } });
      listener({ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: { content: [{ type: "text", text: "SECOND DONE" }] }, isError: false });
      viewer.render(120);
      messages.push({ role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "SECOND RESULT" }] });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "third" } }] });
      listener({ type: "tool_execution_update", toolCallId: "dup", toolName: "bash", args: { command: "third" }, partialResult: { content: [{ type: "text", text: "THIRD LIVE" }] } });
      const out = strip(viewer.render(120).join("\n"));

      expect((viewer as any).finalToolResultCounts.get("dup")).toBe(2);
      expect(out.indexOf("SECOND RESULT")).toBeLessThan(out.indexOf("$ third"));
      expect(out.indexOf("$ third")).toBeLessThan(out.indexOf("THIRD LIVE"));
    });

    it("drops completed state before an identifier is reused without a new event", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: { content: [{ type: "text", text: "STALE-OUTPUT-OF-CALL-ONE" }] }, isError: true });
      messages.push({ role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }], isError: true });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] });
      const out = strip(viewer.render(120).join("\n"));

      expect(out).toContain("$ two");
      expect(out).not.toContain("STALE-OUTPUT-OF-CALL-ONE");
      expect(out.match(/· error]/g)).toHaveLength(1);
    });

    it("pairs a reused identifier that finishes before the next render", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }], isError: true },
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "two" } });
      listener({ type: "tool_execution_end", toolCallId: "dup", toolName: "bash", result: { content: [{ type: "text", text: "SECOND RESULT" }] }, isError: false });
      const out = strip(viewer.render(120).join("\n"));

      expect(out.indexOf("FIRST RESULT")).toBeLessThan(out.indexOf("$ two"));
      expect(out.indexOf("$ two")).toBeLessThan(out.indexOf("SECOND RESULT"));
      expect(out.match(/· error]/g)).toHaveLength(1);
    });

    it("keeps live output after the transcript array shrinks", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      viewer.render(120);
      session.messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] },
      ] as any;
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "two" } });
      listener({ type: "tool_execution_update", toolCallId: "dup", toolName: "bash", args: { command: "two" }, partialResult: { content: [{ type: "text", text: "LIVE AFTER COMPACTION" }] } });

      expect(strip(viewer.render(120).join("\n"))).toContain("LIVE AFTER COMPACTION");
    });

    it("keeps live output after an equal-length in-place transcript replacement", () => {
      const messages: any[] = [
        { role: "user", content: "keep first" },
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "one" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: "FIRST RESULT" }] },
        { role: "user", content: "keep last" },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      viewer.render(120);
      messages[1] = { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "two" } }] };
      messages[2] = { role: "user", content: "replacement" };
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "dup", toolName: "bash", args: { command: "two" } });
      listener({ type: "tool_execution_update", toolCallId: "dup", toolName: "bash", args: { command: "two" }, partialResult: { content: [{ type: "text", text: "LIVE AFTER IN-PLACE REPLACEMENT" }] } });

      expect(strip(viewer.render(120).join("\n"))).toContain("LIVE AFTER IN-PLACE REPLACEMENT");
    });

    it("sanitizes completed tool names", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "safe\x1b[2Junsafe", arguments: {} }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "done" }] },
      ];
      const content = viewerForTools(messages).viewer.render(120).join("\n");

      expect(content).not.toContain("\x1b[2J");
      expect(strip(content)).toContain("[Tool: safeunsafe]");
    });

    it("marks failed tools and keeps the marker on cached frames", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "failed", name: "bash", arguments: { command: "false" } }] },
        { role: "toolResult", toolCallId: "failed", content: [{ type: "text", text: "boom" }], isError: true },
        { role: "assistant", content: [{ type: "toolCall", id: "active", name: "bash", arguments: { command: "sleep 30" } }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "active", toolName: "bash", args: { command: "sleep 30" } });

      expect(strip(viewer.render(120).join("\n"))).toContain("[Tool: bash · error]");
      expect(strip(viewer.render(120).join("\n"))).toContain("[Tool: bash · error]");
    });

    it("keeps an ended event finalized while another tool drives cached frames", () => {
      const messages = [
        { role: "assistant", content: [
          { type: "toolCall", id: "ended", name: "first_tool", arguments: {} },
          { type: "toolCall", id: "active", name: "second_tool", arguments: {} },
        ] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "ended", toolName: "first_tool", args: {} });
      listener({ type: "tool_execution_end", toolCallId: "ended", toolName: "first_tool", result: { content: [{ type: "text", text: "done" }] }, isError: false });
      listener({ type: "tool_execution_start", toolCallId: "active", toolName: "second_tool", args: {} });

      viewer.render(120);
      const cached = strip(viewer.render(120).join("\n"));
      expect(cached).toContain("[Tool: first_tool]");
      expect(cached).not.toContain("[Tool: first_tool ·");
      expect(cached).toContain("[Tool: second_tool ·");
    });

    it("reconciles a cached ended event with its later transcript result", () => {
      const messages: any[] = [
        { role: "assistant", content: [{ type: "toolCall", id: "ended", name: "first_tool", arguments: {} }] },
      ];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "ended", toolName: "first_tool", args: {} });
      listener({ type: "tool_execution_end", toolCallId: "ended", toolName: "first_tool", result: { content: [{ type: "text", text: "TRANSIENT" }] }, isError: false });
      messages.push({ role: "assistant", content: [{ type: "toolCall", id: "active", name: "second_tool", arguments: {} }] });
      listener({ type: "tool_execution_start", toolCallId: "active", toolName: "second_tool", args: {} });
      viewer.render(120);

      messages.push({ role: "toolResult", toolCallId: "ended", content: [{ type: "text", text: "STORED" }], isError: true });
      const reconciled = strip(viewer.render(120).join("\n"));

      expect(reconciled).toContain("[Tool: first_tool · error]");
      expect(reconciled).toContain("STORED");
      expect(reconciled).not.toContain("TRANSIENT");
    });

    it("does not advertise expansion before a tool has output", () => {
      const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "active", name: "bash", arguments: { command: "sleep 30" } }] }];
      const session = mockSession(messages);
      const viewer = new ConversationViewer(mockTui(200, 120), session, mockRecord(), undefined, ansiTheme(), vi.fn());
      const listener = session.subscribe.mock.calls[0][0];
      listener({ type: "tool_execution_start", toolCallId: "active", toolName: "bash", args: { command: "sleep 30" } });

      const content = strip(viewer.render(120).join("\n"));
      expect(content).not.toContain("ctrl+o");
    });

    it("does not pre-expand future calls for an orphan result", () => {
      const messages = [
        { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "one\ntwo\nthree\nfour" }] },
      ];
      const viewer = viewerForTools(messages).viewer;

      viewer.handleInput("\x0f");

      expect((viewer as any).activeOutputExpanded).toBe(false);
      expect(strip(((viewer as any).buildContentLines(116) as string[]).join("\n"))).not.toContain("ctrl+o");
    });

    it("keeps the newest tail after tab expansion", () => {
      const output = Array.from({ length: 4_000 }, (_, i) => `\t\t\tline ${i}`).join("\n");
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "stream" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: output }] },
      ];
      const content = strip(((viewerForTools(messages).viewer as any).buildContentLines(116) as string[]).join("\n"));

      expect(content).toContain("... earlier output");
      expect(content).toContain("line 3999");
      expect(content).not.toContain("line 3109");
    });

    it("uses an unknown omission label after tail slicing", () => {
      const output = Array.from({ length: 4_000 }, (_, i) => `line ${i}`).join("\n");
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "stream" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: output }] },
      ];
      const content = strip(((viewerForTools(messages).viewer as any).buildContentLines(116) as string[]).join("\n"));

      expect(content).toContain("... earlier output");
      expect(content).toContain("line 3999");
      expect(content).not.toContain("chars elided]");
    });

    it("shows an omission, three visual output lines, and a separate expand hint", () => {
      const output = Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n");
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "printf" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: output }] },
      ];
      const { viewer } = viewerForTools(messages);
      const lines = ((viewer as any).buildContentLines(116) as string[]).map(line => strip(line).trimEnd());
      const toolIndex = lines.findIndex(line => line.includes("[Tool: bash]"));
      const omissionIndex = lines.findIndex(line => line.includes("3 earlier lines"));
      expect(lines[toolIndex]).toMatch(/^ {2}\[Tool: bash\]/);
      expect(lines[toolIndex + 1]).toMatch(/^ {2}\$ printf/);
      expect(lines[omissionIndex]).toMatch(/^ {4}\.\.\. 3 earlier lines/);
      expect(lines.slice(omissionIndex + 1, omissionIndex + 4)).toEqual([
        "    line 3",
        "    line 4",
        "    line 5",
      ]);
      expect(lines[omissionIndex + 4]).toBe("    ctrl+o to expand");
    });

    it("toggles every completed tool block and ends expanded blocks with collapse", () => {
      const output = Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n");
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "one", name: "bash", arguments: { command: "one" } }, { type: "toolCall", id: "two", name: "bash", arguments: { command: "two" } }] },
        { role: "toolResult", toolCallId: "one", content: [{ type: "text", text: output }] },
        { role: "toolResult", toolCallId: "two", content: [{ type: "text", text: output }] },
      ];
      const { viewer } = viewerForTools(messages);
      viewer.handleInput("\x0f");
      const out = strip(viewer.render(120).join("\n"));
      expect(out).toContain("line 0");
      expect(out.match(/ctrl\+o to collapse/g)).toHaveLength(2);
    });

    it("makes the full bounded completed result reachable when expanded", () => {
      const output = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "long" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: output }] },
      ];
      const { viewer } = viewerForTools(messages);
      viewer.handleInput("\x0f");
      const content = strip(((viewer as any).buildContentLines(116) as string[]).join("\n"));

      expect(content).toContain("line 0");
      expect(content).toContain("line 499");
      expect(content).toContain("ctrl+o to collapse");
    });

    it("keeps the bounded head reachable when a completed result exceeds the cap", () => {
      const output = `HEAD\n${"x".repeat(RESULT_MAX_CHARS)}\nTAIL`;
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.txt" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: output }] },
      ];
      const { viewer } = viewerForTools(messages);

      expect(strip(((viewer as any).buildContentLines(116) as string[]).join("\n"))).toContain("TAIL");
      viewer.handleInput("\x0f");
      const expanded = strip(((viewer as any).buildContentLines(116) as string[]).join("\n"));

      expect(expanded).toContain("HEAD");
      expect(expanded).toContain("TAIL");
      expect(expanded).toContain("output omitted");
    });

    it("does not advertise text expansion for an image-only result", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "image.png" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "image", data: "ignored", mimeType: "image/png" }] },
      ];
      const content = strip(viewerForTools(messages).viewer.render(120).join("\n"));

      expect(content).toContain("path: image.png");
      expect(content).not.toContain("earlier output");
      expect(content).not.toContain("ctrl+o");
    });

    it("keeps the viewed tool at its screen offset while toggling", () => {
      const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const messages = [
        ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `before ${i}` })),
        { role: "assistant", content: [{ type: "toolCall", id: "anchored", name: "bash", arguments: { command: "anchor" } }] },
        { role: "toolResult", toolCallId: "anchored", content: [{ type: "text", text: output }] },
        ...Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `after ${i}` })),
      ];
      const { viewer } = viewerForTools(messages);
      viewer.render(120);
      const content = (viewer as any).buildContentLines(116) as string[];
      const toolLine = content.findIndex(line => strip(line).includes("[Tool: bash]"));
      (viewer as any).scrollOffset = toolLine - 1;
      (viewer as any).autoScroll = false;
      viewer.handleInput("\x0f");
      const expanded = (viewer as any).buildContentLines(116) as string[];
      expect(strip(expanded[(viewer as any).scrollOffset + 1])).toContain("[Tool: bash]");

      viewer.handleInput("\x0f");
      const compact = (viewer as any).buildContentLines(116) as string[];
      expect(strip(compact[(viewer as any).scrollOffset + 1])).toContain("[Tool: bash]");
      expect((viewer as any).scrollOffset).toBeLessThanOrEqual(Math.max(0, compact.length - (viewer as any).viewportHeight()));
    });

    it("keeps the viewed occurrence when identifiers repeat", () => {
      const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
      const messages = [
        ...Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `before ${i}` })),
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "first" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: output }] },
        ...Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `middle ${i}` })),
        { role: "assistant", content: [{ type: "toolCall", id: "dup", name: "bash", arguments: { command: "second" } }] },
        { role: "toolResult", toolCallId: "dup", content: [{ type: "text", text: output }] },
        ...Array.from({ length: 100 }, (_, i) => ({ role: "user", content: `after ${i}` })),
      ];
      const { viewer } = viewerForTools(messages);
      viewer.render(120);
      const content = (viewer as any).buildContentLines(116) as string[];
      const toolLines = content.flatMap((line, index) => strip(line).includes("[Tool: bash]") ? [index] : []);
      (viewer as any).scrollOffset = toolLines[1] - 1;
      (viewer as any).autoScroll = false;

      viewer.handleInput("\x0f");
      let toggled = (viewer as any).buildContentLines(116) as string[];
      expect(strip(toggled[(viewer as any).scrollOffset + 1])).toContain("[Tool: bash]");
      expect(strip(toggled[(viewer as any).scrollOffset + 2])).toContain("$ second");

      viewer.handleInput("\x0f");
      toggled = (viewer as any).buildContentLines(116) as string[];
      expect(strip(toggled[(viewer as any).scrollOffset + 1])).toContain("[Tool: bash]");
      expect(strip(toggled[(viewer as any).scrollOffset + 2])).toContain("$ second");
    });
  });

  it("renders the complete empty-transcript placeholder", () => {
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(),
    );

    const content = ((viewer as any).buildContentLines(80) as string[]).join("").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    expect(content).toBe("(waiting for first message...)");
  });

  it("closes with Ctrl+C when not composing", () => {
    const done = vi.fn();
    const viewer = new ConversationViewer(
      mockTui(), mockSession(), mockRecord(), undefined, ansiTheme(), done,
    );

    viewer.handleInput("\x03");

    expect(done).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(undefined);
  });

  describe("render width safety", () => {
    const widths = [40, 80, 120, 216];

    it("no line exceeds width with empty messages", () => {
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession([]), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with plain text messages", () => {
      const messages = [
        { role: "user", content: "Hello, how are you?" },
        { role: "assistant", content: [{ type: "text", text: "I am fine, thank you for asking." }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("keeps bordered rows exact-width at a double-width truncation boundary", () => {
      const width = 40;
      for (let prefixLength = 0; prefixLength < width; prefixLength++) {
        const viewer = new ConversationViewer(
          mockTui(30, width),
          mockSession([]),
          mockRecord({ description: `${"a".repeat(prefixLength)}界more` }),
          undefined,
          ansiTheme(),
          vi.fn(),
        );

        for (const line of viewer.render(width)) {
          expect(
            visibleWidth(line),
            `prefix ${prefixLength} produced an under-width bordered row: ${JSON.stringify(line)}`,
          ).toBe(width);
        }
      }
    });

    it("no line exceeds width when text is longer than viewport", () => {
      const longLine = "A".repeat(500);
      const messages = [
        { role: "user", content: longLine },
        { role: "assistant", content: [{ type: "text", text: longLine }] },
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: longLine }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with embedded ANSI escape codes in content", () => {
      const ansiText = `\x1b[1mBold heading\x1b[22m and \x1b[31mred text\x1b[0m ${"X".repeat(300)}`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: ansiText }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with long URLs", () => {
      const url = "https://example.com/" + "a/b/c/d/e/".repeat(30) + "?q=" + "x".repeat(100);
      const messages = [
        { role: "assistant", content: [{ type: "text", text: `Check this link: ${url}` }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with wide table-like content", () => {
      const header = "| " + Array.from({ length: 20 }, (_, i) => `Column${i}`).join(" | ") + " |";
      const dataRow = "| " + Array.from({ length: 20 }, () => "value123").join(" | ") + " |";
      const table = [header, dataRow, dataRow, dataRow].join("\n");
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: table }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with bashExecution messages", () => {
      const messages = [
        {
          role: "bashExecution", command: "cat " + "/very/long/path/".repeat(20) + "file.txt",
          output: "O".repeat(600),
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with running activity indicator", () => {
      const activity = {
        activeTools: new Map([["read", "file.ts"], ["grep", "pattern"]]),
        activeToolCalls: new Map(),
        toolUses: 5, tokens: "10k", responseText: "R".repeat(400),
        session: { getSessionStats: () => ({ tokens: { total: 50000 } }) },
      };
      const messages = [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: [{ type: "text", text: "working on it" }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord({ status: "running" }), activity as any, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width with tool calls", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check that." },
            { type: "toolCall", toolUseId: "t1", name: "very_long_tool_name_" + "x".repeat(200), input: {} },
          ],
        },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("no line exceeds width at narrow terminal", () => {
      const messages = [
        { role: "user", content: "Hello world, this is a normal sentence." },
        { role: "assistant", content: [{ type: "text", text: "Sure, here's the answer." }] },
      ];
      for (const w of [8, 10, 15, 20]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });

    it("renders a paired tool result at the minimum terminal width", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "printf output" } }] },
        { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, 6), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );

      expect(() => viewer.render(6)).not.toThrow();
      assertAllLinesFit(viewer.render(6), 6);
    });

    it("no line exceeds width with mixed ANSI + unicode content", () => {
      const text = `\x1b[32m✓\x1b[0m Test passed — 日本語テスト ${"あ".repeat(50)} \x1b[33m⚠\x1b[0m`;
      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] },
      ];
      for (const w of widths) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });

  describe("Markdown rendering", () => {
    /** ANSI stripped, so an assertion is about the text and not the styling. */
    const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

    function viewerFor(
      messages: any[],
      mode?: "off" | "assistant" | "all",
      onMode?: (m: any) => void,
      /** Tall enough that the assertion reads the whole transcript, not the scrolled window. */
      rows = 200,
    ) {
      return new ConversationViewer(
        mockTui(rows, 80), mockSession(messages), mockRecord({ status: "completed" }), undefined,
        ansiTheme(), vi.fn(), undefined, undefined, undefined, false,
        mode ? () => mode : undefined, onMode,
      );
    }

    const assistant = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];
    const result = (text: string) => [{ role: "toolResult", toolUseId: "t1", content: [{ type: "text", text }] }];

    it("renders assistant Markdown by default instead of raw source markers", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n- first\n- second\n\n**bold**")).render(80).join("\n"));

      expect(out).toContain("Heading");
      expect(out).not.toContain("# Heading");
      expect(out).not.toContain("**bold**");
      expect(out).toContain("bold");
    });

    it("leaves assistant text verbatim under `off`", () => {
      const out = strip(viewerFor(assistant("# Heading\n\n**bold**"), "off").render(80).join("\n"));

      expect(out).toContain("# Heading");
      expect(out).toContain("**bold**");
    });

    // The reason `all` is not the default: a tool result is arbitrary bytes, and
    // a Markdown pass rewrites several constructs that occur constantly in real
    // command output. Each line here is a rewrite reproduced against pi-tui.
    it("leaves tool results byte-exact under the default mode", () => {
      const raw = [
        "#!/bin/sh",
        "# section",
        "3) alpha",
        "7) beta",
        "9) gamma",
        "Section",
        "---",
        "next",
      ].join("\n");
      const out = strip(viewerFor(result(raw)).render(80).join("\n"));

      for (const line of raw.split("\n")) expect(out).toContain(line);
    });

    it("renders tool-result Markdown under `all`", () => {
      const out = strip(viewerFor(result("## ctx_execute\n\n- one\n- two"), "all").render(80).join("\n"));

      expect(out).toContain("ctx_execute");
      expect(out).not.toContain("## ctx_execute");
    });

    it("renders paired tool-result Markdown under `all`", () => {
      const messages = [
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "result.md" } }] },
        { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "## Heading" }] },
      ];
      const out = strip(viewerFor(messages, "all").render(80).join("\n"));

      expect(out).toContain("Heading");
      expect(out).not.toContain("## Heading");
    });

    it("does not renumber ordered lists even when it does render them", () => {
      const out = strip(viewerFor(result("3) alpha\n7) beta\n9) gamma"), "all").render(80).join("\n"));

      expect(out).toContain("3) alpha");
      expect(out).not.toContain("4. beta");
    });

    it("`m` cycles the mode, persists it, and shows it in the footer", () => {
      const onMode = vi.fn();
      const viewer = viewerFor(assistant("# Heading"), "assistant", onMode);

      expect(strip(viewer.render(80).join("\n"))).toContain("m md");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("all");
      expect(strip(viewer.render(80).join("\n"))).toContain("m md+");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("off");
      const off = strip(viewer.render(80).join("\n"));
      expect(off).toContain("m raw");
      // The override, not just the label, is what took effect.
      expect(off).toContain("# Heading");

      viewer.handleInput("m");
      expect(onMode).toHaveBeenLastCalledWith("assistant");
    });

    it("`m` still cycles when no persist hook is wired", () => {
      const viewer = viewerFor(assistant("# Heading"), "assistant");
      viewer.handleInput("m");
      viewer.handleInput("m");

      expect(strip(viewer.render(80).join("\n"))).toContain("# Heading");
    });

    it("`m` disarms a pending stop rather than confirming it", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");
      viewer.handleInput("m");
      viewer.handleInput("x");

      expect(onStop).not.toHaveBeenCalled();
    });

    it("keeps the footer's navigation hints intact at 80 columns", () => {
      const viewer = new ConversationViewer(
        mockTui(200, 80), mockSession(assistant("hi")), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), vi.fn(), undefined, vi.fn(),
      );
      const lines = viewer.render(80);
      const footer = strip(lines[lines.length - 2]);

      expect(footer).toContain("Enter steer");
      expect(footer).toContain("x stop");
      expect(footer).toContain("m md");
      expect(footer).toContain("Esc close");
    });

    it("caps a tool result at RESULT_MAX_CHARS, not 500, and says what it dropped", () => {
      const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
      const out = strip(viewerFor(result(lines.join("\n")), undefined, undefined, 4000).render(80).join("\n"));

      expect(out).toContain("line 100");                       // far past the old 500-char cut
      expect(out).not.toContain("line 2999");                  // but still bounded
      expect(out).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("puts the truncation notice outside the code fence it cut into", () => {
      const text = `\`\`\`js\n${"const a = 1;\n".repeat(2000)}\`\`\``;
      const viewer = viewerFor(result(text), "all", undefined, 4000);
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);
      const note = content.find(l => l.includes("... (truncated"));

      // Appended into the content it lands inside the unterminated fence, where
      // it picks up the code-block indent and reads as a line of the tool's source.
      expect(note).toMatch(/^\.\.\. \(truncated, [\d.]+[kM]? more characters\)$/);
    });

    it("reports the exact omitted character count", () => {
      // UTF-16 code units, so the astral character here counts as two.
      const text = `${"x".repeat(RESULT_MAX_CHARS)}😀x`;
      const viewer = viewerFor(result(text));
      const content = ((viewer as any).buildContentLines(76) as string[]).map(strip);

      expect(content).toContain("... (truncated, 3 more characters)");
    });

    it("abbreviates a large omitted count so the notice fits a narrow frame", () => {
      // The notice goes through truncateToWidth at innerW (width - 4). An exact
      // count runs to seven digits on a multi-megabyte result and pushes the
      // notice past 46, where the unit is cut off and only a number survives.
      const text = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(1_100_000)}`;
      const note = viewerFor(result(text)).render(50).map(strip).find(l => l.includes("truncated,"));

      expect(note).toContain("1.1M more characters)");
    });

    it("rounds into the M bracket rather than reporting 1000k", () => {
      // 999,999 / 1000 rounds to 1000.0 — the bracket has to be picked against
      // the rounded value, not the raw one.
      const text = `${"x".repeat(RESULT_MAX_CHARS)}${"y".repeat(999_999)}`;
      const note = strip(viewerFor(result(text)).render(80).join("\n")).split("\n").find(l => l.includes("truncated,"));

      expect(note).toContain("1M more characters");
    });

    it("falls back to literal wrapping once for an unsafe streaming prefix", () => {
      // render() is on the TUI's critical path, so a parser throw must degrade
      // rather than take the overlay down with it.
      const messages = result("# heading");
      const viewer = viewerFor(messages, "all");
      markdownThrows = true;

      expect(() => viewer.render(80)).not.toThrow();
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");

      // An append-only delta keeps the unsafe prefix, so it must stay literal
      // without retrying the recursive parser on every streamed update.
      messages[0].content[0].text += "\nmore";
      expect(strip(viewer.render(80).join("\n"))).toContain("more");
      expect(markdownRenderCalls).toBe(1);

      markdownThrows = false;
      expect(strip(viewer.render(80).join("\n"))).toContain("# heading");
      expect(markdownRenderCalls).toBe(1);

      // Replacing the failed content can remove the unsafe prefix, so it gets
      // one fresh Markdown attempt instead of staying literal forever.
      messages[0].content[0].text = "## safe";
      const replaced = strip(viewer.render(80).join("\n"));
      expect(markdownRenderCalls).toBe(2);
      expect(replaced).toContain("safe");
      expect(replaced).not.toContain("## safe");
    });

    it("tracks a tool result that keeps growing past the cap", () => {
      // The live case: the capped prefix never changes, so the parse is reused,
      // but the character count being held back has to keep moving.
      const msg = { role: "toolResult", toolUseId: "t", content: [{ type: "text", text: `${"row\n".repeat(4500)}` }] };
      const viewer = viewerFor([msg]);
      const elided = () => {
        const m = strip(((viewer as any).buildContentLines(76) as string[]).join("\n"))
          .match(/truncated, ([\d.]+)([kM]?) more/);
        return Number(m?.[1]) * (m?.[2] === "M" ? 1e6 : m?.[2] === "k" ? 1e3 : 1);
      };

      const before = elided();
      msg.content[0].text += "row\n".repeat(1000);
      const after = elided();

      expect(before).toBeGreaterThan(0);
      expect(after).toBeGreaterThan(before);
      expect(markdownConstructions).toBe(0); // default mode: results take the literal path
    });

    it("leaves a result under the cap untouched", () => {
      // Deliberately between the old 500-char cap and the new one, so the test
      // discriminates the cap's value and not merely its existence.
      const text = `head\n${"filler line\n".repeat(200)}tail`;
      const out = strip(viewerFor(result(text), undefined, undefined, 600).render(80).join("\n"));

      expect(text.length).toBeLessThan(RESULT_MAX_CHARS);
      expect(out).toContain("head");
      expect(out).toContain("tail");
      expect(out).not.toContain("truncated");
    });

    it("caps bash output with the same rule as a tool result", () => {
      const messages = [{ role: "bashExecution", command: "yes", output: "y\n".repeat(20000) }];
      const out = strip(viewerFor(messages).render(80).join("\n"));

      expect(out).toMatch(/\.\.\. \(truncated, [\d.]+[kM]? more characters\)/);
    });

    it("keeps tool results dim even when rendering them as Markdown", () => {
      // Reads the content line directly: every bordered row carries the theme's
      // escape on its `│`, so asserting on rendered output would pass either way.
      const viewer = viewerFor(result("plain result text"), "all");
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("keeps tool results dim on the literal path too", () => {
      const viewer = viewerFor(result("plain result text"));
      const line = (viewer as any).buildContentLines(76)
        .find((l: string) => strip(l).includes("plain result text"));

      expect(line).toContain("\x1b[38;5;240m");
    });

    it("reuses one Markdown per message across renders", () => {
      const viewer = viewerFor(assistant("# Heading"));
      viewer.render(80);
      const afterFirst = markdownConstructions;
      viewer.render(80);
      viewer.render(80);

      expect(afterFirst).toBe(1);
      expect(markdownConstructions).toBe(afterFirst);
    });

    it("re-renders a message whose text is still streaming", () => {
      const messages = assistant("# One");
      const viewer = viewerFor(messages);
      expect(strip(viewer.render(80).join("\n"))).toContain("One");

      messages[0].content[0].text = "# Two";
      const out = strip(viewer.render(80).join("\n"));

      expect(out).toContain("Two");
      expect(out).not.toContain("One");
      expect(markdownConstructions).toBe(1);
    });

    it("renders Markdown to fit, so the overwidth clamp never has to cut it", () => {
      const text = `# ${"Heading ".repeat(20)}\n\n| a | b |\n|---|---|\n| ${"x".repeat(90)} | 2 |\n\n\`\`\`js\nconst x = ${"1".repeat(120)};\n\`\`\``;
      // From 20 up: below that the `[Assistant]` role label is itself wider than
      // the viewport, so the clamp legitimately fires on chrome rather than content.
      // Narrower widths stay covered by the wrapTextWithAnsi safety net above.
      for (const w of [20, 40, 80, 120]) {
        const viewer = new ConversationViewer(
          mockTui(30, w), mockSession(assistant(text)), mockRecord(), undefined, ansiTheme(), vi.fn(),
        );
        const content = (viewer as any).buildContentLines(w) as string[];

        assertAllLinesFit(content, w);
        // `truncateToWidth` is the #7 backstop, not what keeps these in bounds —
        // if it fires on Markdown output, content is being silently cut.
        expect(content.filter(l => strip(l).endsWith("..."))).toEqual([]);
      }
    });
  });

  describe("safety net against upstream wrapTextWithAnsi bugs", () => {
    // These tests call buildContentLines() directly (via the private method)
    // because render() has its own truncation via row(). The safety net in
    // buildContentLines is what prevents the TUI crash — it must clamp
    // independently of render().

    /** Call the private buildContentLines method directly. */
    function callBuildContentLines(viewer: InstanceType<typeof ConversationViewer>, width: number): string[] {
      return (viewer as any).buildContentLines(width);
    }

    it("mock is intercepting wrapTextWithAnsi", async () => {
      const { wrapTextWithAnsi } = await import("@earendil-works/pi-tui");
      wrapOverride = () => ["MOCK_SENTINEL"];
      expect(wrapTextWithAnsi("anything", 10)).toEqual(["MOCK_SENTINEL"]);
      wrapOverride = null;
    });

    it("clamps overwidth lines from toolResult content", () => {
      const w = 80;
      wrapOverride = () => ["X".repeat(w + 50)];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from user message content", () => {
      const w = 80;
      wrapOverride = () => ["Y".repeat(w + 100)];

      const messages = [{ role: "user", content: "hello" }];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from assistant message content", () => {
      const w = 80;
      wrapOverride = () => ["Z".repeat(w + 100)];

      const messages = [
        { role: "assistant", content: [{ type: "text", text: "response" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines from bashExecution output", () => {
      const w = 80;
      wrapOverride = () => ["B".repeat(w + 100)];

      const messages = [
        {
          role: "bashExecution", command: "ls", output: "out",
          exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now(),
        },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });

    it("clamps overwidth lines that also contain ANSI codes", () => {
      const w = 80;
      wrapOverride = () => [`\x1b[1m\x1b[31m${"W".repeat(w + 30)}\x1b[0m`];

      const messages = [
        { role: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "output" }] },
      ];
      const viewer = new ConversationViewer(
        mockTui(30, w), mockSession(messages), mockRecord(), undefined, ansiTheme(), vi.fn(),
      );
      assertAllLinesFit(callBuildContentLines(viewer, w), w);
    });
  });

  describe("stop key", () => {
    const W = 80;

    it("two-press x stops a running agent (first arms, second aborts)", () => {
      const onStop = vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      // Idle footer offers the stop affordance.
      expect(viewer.render(W).join("\n")).toContain("x stop");

      // First press arms (no abort yet) and re-renders.
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
      expect(tui.requestRender).toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");

      // Second press aborts.
      viewer.handleInput("x");
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it("any other key disarms the confirm", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      viewer.handleInput("x");                       // arm
      viewer.handleInput("j");                       // scroll → disarm
      expect(viewer.render(W).join("\n")).toContain("x stop");
      expect(viewer.render(W).join("\n")).not.toContain("x again to STOP");

      viewer.handleInput("x");                       // arms again, does NOT stop
      expect(onStop).not.toHaveBeenCalled();
    });

    it("ctrl+o disarms the confirm when no output can expand", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession([{ role: "user", content: "hi" }]), mockRecord({ status: "running" }), undefined,
        ansiTheme(), vi.fn(), onStop,
      );

      viewer.render(W);
      viewer.handleInput("x");
      viewer.handleInput("\x0f");
      viewer.handleInput("x");

      expect(onStop).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).toContain("x again to STOP");
    });

    it("does not offer or perform stop once the agent is no longer running", () => {
      const onStop = vi.fn();
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "completed" }), undefined, ansiTheme(), vi.fn(), onStop,
      );

      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      viewer.handleInput("x");
      viewer.handleInput("x");
      expect(onStop).not.toHaveBeenCalled();
    });

    it("no stop affordance when no onStop handler is provided (read-only history)", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("x stop");
      expect(() => { viewer.handleInput("x"); viewer.handleInput("x"); }).not.toThrow();
    });
  });

  describe("steer composer", () => {
    const W = 80;

    function makeViewer(opts: { status?: AgentRecord["status"]; onSteer?: (m: string) => void } = {}) {
      const onSteer = opts.onSteer ?? vi.fn();
      const tui = mockTui(30, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: opts.status ?? "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, onSteer,
      );
      return { viewer, tui, onSteer };
    }

    it("offers the steer affordance for a running agent and opens on Enter", () => {
      const { viewer } = makeViewer();
      expect(viewer.render(W).join("\n")).toContain("Enter steer");

      viewer.handleInput("\r"); // Enter
      // Composer is shown (its prompt + send/cancel hint), idle footer is gone.
      const out = viewer.render(W).join("\n");
      expect(out).toContain("Enter send · Esc cancel");
      expect(out).not.toContain("Enter steer");
    });

    it("typing then Enter sends the trimmed message and closes the composer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "  hello  ") viewer.handleInput(ch);
      viewer.handleInput("\r"); // send

      expect(onSteer).toHaveBeenCalledWith("hello");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("Esc cancels the composer without sending", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      for (const ch of "draft") viewer.handleInput(ch);
      viewer.handleInput("\x1b"); // Esc

      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
    });

    it("an empty submit just returns (like Esc), without calling onSteer", () => {
      const { viewer, onSteer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      viewer.handleInput("\r"); // empty submit
      expect(onSteer).not.toHaveBeenCalled();
      expect(viewer.render(W).join("\n")).not.toContain("Enter send"); // composer closed
    });

    it("scroll keys are inert while composing (input owns them)", () => {
      const { viewer } = makeViewer();
      viewer.handleInput("\r"); // open composer
      // 'j' would normally scroll, but here it types into the composer.
      viewer.handleInput("j");
      expect(viewer.render(W).join("\n")).toContain("Enter send · Esc cancel");
    });

    it("no steer affordance once the agent is no longer running", () => {
      const { viewer, onSteer } = makeViewer({ status: "completed" });
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      viewer.handleInput("\r");
      expect(viewer.render(W).join("\n")).not.toContain("Enter send");
      expect(onSteer).not.toHaveBeenCalled();
    });

    it("no steer affordance when no onSteer handler is provided", () => {
      const viewer = new ConversationViewer(
        mockTui(30, W), mockSession(), mockRecord({ status: "running" }), undefined, ansiTheme(), vi.fn(),
      );
      expect(viewer.render(W).join("\n")).not.toContain("Enter steer");
      expect(() => viewer.handleInput("\r")).not.toThrow();
    });

    it("composer rows never exceed width", () => {
      for (const w of [40, 80, 120]) {
        const tui = mockTui(30, w);
        const viewer = new ConversationViewer(
          tui, mockSession(), mockRecord({ status: "running" }),
          undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
        );
        viewer.handleInput("\r"); // open composer
        for (const ch of "x".repeat(200)) viewer.handleInput(ch);
        assertAllLinesFit(viewer.render(w), w);
      }
    });
  });
});
