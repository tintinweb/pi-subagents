import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";

// ── Mock wrapTextWithAnsi ──────────────────────────────────────────────
// We need to control what wrapTextWithAnsi returns to simulate the
// upstream bug (returning lines wider than requested width).
// vi.mock is hoisted and intercepts before conversation-viewer.ts binds
// its import.

let wrapOverride: ((text: string, width: number) => string[]) | null = null;

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const original = await importOriginal<typeof import("@earendil-works/pi-tui")>();
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
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ConversationViewer } = await import("../src/ui/conversation-viewer.js");

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
  describe("safe conversation rendering", () => {
    function renderedText(messages: unknown[], activity?: any, record: Partial<AgentRecord> = {}): string[] {
      const viewer = new ConversationViewer(
        mockTui(), mockSession(messages), mockRecord(record), activity, ansiTheme(), vi.fn(),
      );
      const lines = viewer.render(80).map((line) => stripVTControlCharacters(line));
      expect(lines.every((line) => !line.includes("\n"))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
      return lines;
    }

    function expectWarningBeforeEscape(lines: string[], escaped: string): void {
      const warningRow = lines.findIndex((line) => line.includes("[unsafe terminal content escaped]"));
      const escapedRow = lines.findIndex((line) => line.includes(escaped));
      expect(warningRow).toBeGreaterThanOrEqual(0);
      expect(escapedRow).toBe(warningRow + 1);
    }

    it("classifies a sparse replacement character exactly as istextorbinary does", () => {
      const lines = renderedText([{
        role: "toolResult",
        toolCallId: "tool-sparse-replacement",
        toolName: "read",
        content: [{ type: "text", text: "safe�after" }],
        isError: false,
        timestamp: Date.now(),
      }]);

      expect(lines.filter((line) => line.includes("[binary content]"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("\\u{FFFD}");
    });

    it("classifies binary content over the final limited display text", () => {
      const payload = `\u009D${"�".repeat(60)}${"a".repeat(439)}${"b".repeat(5_000)}`;
      const lines = renderedText([{
        role: "toolResult",
        toolCallId: "tool-limited-binary",
        toolName: "read",
        content: [{ type: "text", text: payload }],
        isError: false,
        timestamp: Date.now(),
      }]);

      expect(lines.filter((line) => line.includes("[binary content]"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("\\u{FFFD}");
    });

    it("replaces recording-like dense replacement text without exposing its contents", () => {
      const payload = "RIFF�\u{9D}�\u{81}随机�\u{A4}�audio�\u{90}�tail";
      const lines = renderedText([{
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: payload }],
        isError: false,
        timestamp: Date.now(),
      }]);
      const contentRows = lines.filter((line) => line.includes("binary content") || line.includes("RIFF") || line.includes("audio"));

      expect(contentRows).toHaveLength(1);
      expect(contentRows[0]?.replace(/^│\s*|\s*│$/g, "").trim()).toBe("[binary content]");
      expect(lines.join("\n")).not.toContain("RIFF");
      expect(lines.join("\n")).not.toContain("audio");
    });

    it("keeps NUL-bearing content classified as binary", () => {
      const lines = renderedText([{
        role: "toolResult",
        toolCallId: "tool-nul",
        toolName: "read",
        content: [{ type: "text", text: "safe\u0000after" }],
        isError: false,
        timestamp: Date.now(),
      }]);

      expect(lines.filter((line) => line.includes("[binary content]"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("safe");
    });

    it.each([
      ["ESC", "safe\u001b[2Jafter", "safe\\u{1B}[2Jafter"],
      ["C1", "safe\u0085after", "safe\\u{85}after"],
      ["bidi", "safe\u202Eafter", "safe\\u{202E}after"],
      ["private use", "safe\uE000after", "safe\\u{E000}after"],
    ])("secondarily escapes %s text that istextorbinary classifies as text", (_kind, raw, escaped) => {
      const lines = renderedText([{
        role: "toolResult",
        toolCallId: "tool-unsafe",
        toolName: "read",
        content: [{ type: "text", text: raw }],
        isError: false,
        timestamp: Date.now(),
      }]);

      expectWarningBeforeEscape(lines, escaped);
      expect(lines.join("\n")).not.toContain(raw);
      expect(lines.join("\n")).not.toContain("[binary content]");
    });

    it("passes ordinary text including tabs through without a warning", () => {
      const wrappedTexts: string[] = [];
      wrapOverride = (text) => {
        wrappedTexts.push(text);
        return [text];
      };
      const lines = renderedText([
        { role: "user", content: "Hello,\t世界 👩‍💻" },
        { role: "assistant", content: [{ type: "text", text: "Ordinary response" }] },
      ]);

      expect(wrappedTexts).toContain("Hello,\t世界 👩‍💻");
      expect(wrappedTexts).toContain("Ordinary response");
      expect(lines.join("\n")).not.toContain("[unsafe terminal content escaped]");
    });

    it("renders safe multiline tool names, bash commands, and activity as separate rows without warnings", () => {
      const messageLines = renderedText([
        { role: "assistant", content: [{ type: "toolCall", name: "tool\nname" }] },
        { role: "bashExecution", command: "printf first\nprintf second", output: "" },
      ]);
      expect(messageLines.join("\n")).not.toContain("[unsafe terminal content escaped]");
      expect(messageLines.some((line) => line.includes("[Tool: tool]"))).toBe(true);
      expect(messageLines.some((line) => line.includes("[Tool: name]"))).toBe(true);
      expect(messageLines.some((line) => line.includes("$ printf first"))).toBe(true);
      expect(messageLines.some((line) => line.includes("$ printf second"))).toBe(true);

      const activityLines = renderedText([{ role: "user", content: "prompt" }], {
        activeTools: new Map([["call-1", "custom first\ncustom second"]]), toolUses: 1, responseText: "", turnCount: 0,
        lifetimeUsage: {},
      });
      expect(activityLines.join("\n")).not.toContain("[unsafe terminal content escaped]");
      expect(activityLines.some((line) => line.includes("custom first"))).toBe(true);
      expect(activityLines.some((line) => line.includes("custom second"))).toBe(true);
    });

    it("warns before unsafe multiline tool names, bash commands, and activity and renders safe rows", () => {
      const messageLines = renderedText([
        { role: "assistant", content: [{ type: "toolCall", name: "tool\u001b[2J\nname" }] },
        { role: "bashExecution", command: "printf '\u001b[2J'\nprintf safe", output: "" },
      ]);
      expectWarningBeforeEscape(messageLines, "[Tool: tool\\u{1B}[2J]");
      expect(messageLines.some((line) => line.includes("[Tool: name]"))).toBe(true);
      const warningRows = messageLines
        .map((line, index) => line.includes("[unsafe terminal content escaped]") ? index : -1)
        .filter((index) => index >= 0);
      expect(warningRows).toHaveLength(2);
      expect(messageLines[warningRows[1] + 1]).toContain("$ printf '\\u{1B}[2J'");
      expect(messageLines.some((line) => line.includes("$ printf safe"))).toBe(true);

      const activityLines = renderedText([{ role: "user", content: "prompt" }], {
        activeTools: new Map(), toolUses: 0, responseText: "stream\u001b[2J\nsafe", turnCount: 0,
        lifetimeUsage: {},
      });
      expectWarningBeforeEscape(activityLines, "stream\\u{1B}[2J");
      expect(activityLines.some((line) => line.includes("safe"))).toBe(true);

      expect(messageLines.join("\n") + activityLines.join("\n")).not.toMatch(/[\u001b\u0007]/);
    });

    it("renders unsafe multiline invocation tags as structural warning and escaped rows", () => {
      const lines = renderedText([], undefined, {
        invocation: {
          thinking: "high\u001b[2J\nforged" as NonNullable<AgentRecord["invocation"]>["thinking"],
        },
      });
      const warningRow = lines.findIndex((line) => line.includes("[unsafe terminal content escaped]"));

      expect(warningRow).toBeGreaterThanOrEqual(0);
      expect(lines[warningRow + 1]).toContain("thinking: high\\u{1B}[2J");
      expect(lines[warningRow + 2]).toContain("forged");
      expect(lines.join("\n")).not.toContain("\u001b[2J");
      expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    });

    it("gates external display name, description, and invocation model in header-adjacent rows", () => {
      const config: AgentConfig = {
        name: "unsafe-header",
        displayName: "Display\u001b[2J\nName",
        description: "Description\u001b[31m\nDetail",
        extensions: false,
        skills: false,
        systemPrompt: "",
        promptMode: "replace",
      };
      registerAgents(new Map([[config.name, config]]));
      const lines = renderedText([], undefined, {
        type: config.name,
        description: config.description,
        invocation: { modelName: "Model\u001b[H\nVariant" },
      });
      const rendered = lines.join("\n");

      expect(lines.filter((line) => line.includes("[unsafe terminal content escaped]"))).toHaveLength(3);
      expect(rendered).toContain("Display\\u{1B}[2J");
      expect(rendered).toContain("Description\\u{1B}[31m");
      expect(rendered).toContain("Model\\u{1B}[H");
      expect(rendered).not.toContain("\u001b[2J");
      expect(rendered).not.toContain("\u001b[31m");
      expect(rendered).not.toContain("\u001b[H");
    });

    it.each([40, 12])("bounds multiline header chrome to the 70%% overlay height at %i rows", (rows) => {
      const config: AgentConfig = {
        name: `overflow-header-${rows}`,
        displayName: ["Primary display", ...Array.from({ length: 12 }, (_, i) => `Name ${i}\u001b[2J`)].join("\n"),
        description: Array.from({ length: 12 }, (_, i) => `Description ${i}\u001b[31m`).join("\n"),
        extensions: false,
        skills: false,
        systemPrompt: "",
        promptMode: "replace",
      };
      registerAgents(new Map([[config.name, config]]));
      const tui = mockTui(rows, 80);
      const viewer = new ConversationViewer(
        tui,
        mockSession([{ role: "user", content: "meaningful content" }]),
        mockRecord({
          type: config.name,
          description: config.description,
          invocation: {
            modelName: Array.from({ length: 12 }, (_, i) => `Model ${i}\u001b[H`).join("\n"),
          },
        }),
        undefined,
        ansiTheme(),
        vi.fn(),
      );

      const rendered = viewer.render(80);
      const plain = rendered.map((line) => stripVTControlCharacters(line));
      expect(rendered.length).toBeLessThanOrEqual(Math.floor((rows * 70) / 100));
      expect(plain[0]).toContain("╭");
      expect(plain.at(-1)).toContain("╰");
      expect(plain.at(-2)).toContain("Esc close");
      expect(plain.join("\n")).toContain("Primary display");
      expect(plain.join("\n")).toContain("meaningful content");
      expect(plain.join("\n")).toContain("…");
      expect(plain.every((line) => !line.includes("\n"))).toBe(true);
      assertAllLinesFit(rendered, 80);
    });

    it("escapes unsafe active tool names before they reach the terminal", () => {
      const lines = renderedText([{ role: "user", content: "prompt" }], {
        activeTools: new Map([["call-1", "tool\u001b[2Jname"]]),
        toolUses: 1, responseText: "", turnCount: 0, lifetimeUsage: {},
      });

      expectWarningBeforeEscape(lines, "tool\\u{1B}[2Jname…");
      expect(lines.join("\n")).not.toContain("\u001b[2J");
    });

    it("applies the 500-code-point limit before the terminal safety gate", () => {
      const preparedTexts: string[] = [];
      wrapOverride = (text) => {
        preparedTexts.push(text);
        return [text];
      };
      const lines = renderedText([
        { role: "toolResult", content: [{ type: "text", text: `${"a".repeat(500)}\0hidden` }] },
        { role: "toolResult", content: [{ type: "text", text: `${"b".repeat(499)}\u001b[2J` }] },
      ]);

      expect(preparedTexts[0]).toBe(`${"a".repeat(500)}... (truncated)`);
      expect(preparedTexts[0]).not.toContain("[binary content]");
      expect(preparedTexts[0]).not.toContain("[unsafe terminal content escaped]");
      expect(preparedTexts.some((text) => text.includes("\\u{1B}... (truncated)"))).toBe(true);
      expect(lines.some((line) => line.includes("[unsafe terminal content escaped]"))).toBe(true);
    });

    it("truncates raw tool output by code point before escaping", () => {
      const preparedTexts: string[] = [];
      wrapOverride = (text) => {
        preparedTexts.push(text);
        return [text];
      };
      const astralAtBoundary = `${"a".repeat(499)}👩\u001b[2J`;
      const unsafeAtBoundary = `${"b".repeat(499)}\u001b[2J`;
      renderedText([
        { role: "toolResult", content: [{ type: "text", text: astralAtBoundary }] },
        { role: "toolResult", content: [{ type: "text", text: unsafeAtBoundary }] },
      ]);
      const prepared = preparedTexts.join("\n");

      expect(prepared).toContain(`👩... (truncated)`);
      expect(prepared).not.toContain("�");
      expect(prepared).toContain("\\u{1B}... (truncated)");
      expect(prepared).not.toMatch(/\\u\{1B(?:$|\.\.\.)/m);
    });

    it("escapes unsafe user and assistant text without exposing raw controls", () => {
      const userRendered = renderedText([{ role: "user", content: "user\u001b[2J" }]).join("\n");
      const assistantRendered = renderedText([{
        role: "assistant", content: [{ type: "text", text: "assistant\u001b[2J" }],
      }]).join("\n");

      expect(userRendered).toContain("user\\u{1B}[2J");
      expect(assistantRendered).toContain("assistant\\u{1B}[2J");
      expect(userRendered + assistantRendered).not.toContain("\u001b[2J");
    });
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

    it("keeps composer chrome within the small-terminal height cap", () => {
      const rows = 10;
      const cap = Math.floor(rows * 0.7);
      const tui = mockTui(rows, W);
      const viewer = new ConversationViewer(
        tui, mockSession(), mockRecord({ status: "running" }),
        undefined, ansiTheme(), vi.fn(), undefined, undefined, vi.fn(),
      );
      viewer.handleInput("\r");

      const rendered = viewer.render(W).map((line) => stripVTControlCharacters(line));
      expect(rendered.length).toBeLessThanOrEqual(cap);
      if (rendered.length > 0) {
        expect(rendered.some((line) => line.includes("Enter send · Esc cancel"))).toBe(true);
        expect(rendered[rendered.length - 1]).toMatch(/^╰─+╯$/);
      }
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
