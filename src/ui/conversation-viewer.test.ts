import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;

vi.mock("@mariozechner/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-tui")>();
  return {
    ...original,
    wrapTextWithAnsi: (...args: [string, number]) => {
      if (wrapOverride) return wrapOverride(...args);
      return original.wrapTextWithAnsi(...args);
    },
  };
});

// Must import AFTER vi.mock declaration (vitest hoists vi.mock but the
// dynamic import of the test subject must happen after)
const { visibleWidth } = await import("@mariozechner/pi-tui");
const { ConversationViewer } = await import("./conversation-viewer.js");

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
});

describe("ConversationViewer", () => {
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
      const { wrapTextWithAnsi } = await import("@mariozechner/pi-tui");
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

  // Regression for issue #38 — token semantics + context indicator
  describe("session token helpers", () => {
    it("uses billed-token semantics (input + output + cacheWrite), not inflated total", async () => {
      const { getSessionTokens } = await import("./agent-widget.js");
      const session = {
        getSessionStats: () => ({
          tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 } as any,
          contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionTokens(session)).toBe(350);
    });

    it("getSessionTokens returns 0 when session is undefined or stats throw", async () => {
      const { getSessionTokens } = await import("./agent-widget.js");
      expect(getSessionTokens(undefined)).toBe(0);
      const broken = { getSessionStats: () => { throw new Error("nope"); } } as any;
      expect(getSessionTokens(broken)).toBe(0);
    });

    it("getSessionContextPercent returns null when contextUsage is unavailable", async () => {
      const { getSessionContextPercent } = await import("./agent-widget.js");
      const session = {
        getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("getSessionContextPercent returns null when percent is null (post-compaction)", async () => {
      const { getSessionContextPercent } = await import("./agent-widget.js");
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
        }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("getSessionContextPercent returns the upstream percent when available", async () => {
      const { getSessionContextPercent } = await import("./agent-widget.js");
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });

    it("formatSessionTokens applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", async () => {
      const { formatSessionTokens } = await import("./agent-widget.js");
      const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
      expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
      expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
      expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
      expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
      expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
      expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
    });

    it("formatSessionTokens annotates compaction count alongside percent", async () => {
      const { formatSessionTokens } = await import("./agent-widget.js");
      const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
      // compactions only (e.g. immediately post-compaction, percent null)
      expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>↻1</dim>)");
      expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>↻3</dim>)");
      // percent + compactions, joined with ` · `
      expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>↻2</dim>)");
      expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>↻4</dim>)");
      // compactions=0 omitted
      expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
    });

    it("getLifetimeTotal sums components and handles undefined", async () => {
      const { getLifetimeTotal } = await import("./agent-widget.js");
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
    });

    // The accumulator survives compaction because it lives on AgentActivity /
    // AgentRecord, not on session.state.messages (which compaction replaces).
    it("a lifetime accumulator stays monotone across simulated compaction", async () => {
      const { getLifetimeTotal } = await import("./agent-widget.js");
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      const onUsage = (u: { input: number; output: number; cacheWrite: number }) => {
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheWrite += u.cacheWrite;
      };

      // 5 normal turns
      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      // Compaction would replace session.state.messages, dropping any sum
      // re-derived from it. Our accumulator is independent — no reset.
      const beforeCompaction = getLifetimeTotal(usage);

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });
});
