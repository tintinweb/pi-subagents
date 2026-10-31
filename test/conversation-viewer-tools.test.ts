import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

/**
 * Tool blocks are drawn by pi's own `ToolExecutionComponent`, which reads pi's
 * global theme, so the suite has to initialize one. That is also the only reason
 * this file is separate from `conversation-viewer.test.ts`: those viewer rows are
 * drawn with the injected theme stub alone, and a test that needs pi's real theme
 * loaded would be indistinguishable from one that quietly depends on it.
 */
/**
 * pi publishes its theme on `globalThis` (a `Symbol.for` key), which outlives
 * this file: vitest reuses worker threads, so leaving it installed would put
 * every later file in the same worker on the rich tool path and change the rows
 * they assert. Save the previous value and put it back.
 */
const THEME_KEYS = [
  Symbol.for("@earendil-works/pi-coding-agent:theme"),
  Symbol.for("@mariozechner/pi-coding-agent:theme"),
];
const previousThemes = new Map<symbol, unknown>();

beforeAll(() => {
  for (const key of THEME_KEYS) previousThemes.set(key, Reflect.get(globalThis, key));
  initTheme("dark");
});

afterAll(() => {
  for (const key of THEME_KEYS) {
    const previous = previousThemes.get(key);
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

/** The viewer's own chrome, kept plain so assertions read the text, not escapes. */
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function tui(rows = 40, columns = 120) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as never;
}

function session(messages: unknown[]) {
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    sessionManager: { getCwd: () => process.cwd() },
  } as never;
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-tools",
    type: "general-purpose",
    description: "tool rendering",
    status: "completed",
    toolUses: 1,
    startedAt: Date.now(),
    ...overrides,
  } as AgentRecord;
}

function callPart(id: string, name: string, args: Record<string, unknown>) {
  return { type: "toolCall", id, name, arguments: args };
}

function resultMessage(id: string, name: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
    durationMs: 12,
    ...overrides,
  };
}

/** Raw terminal input for ctrl+o, the default `app.tools.expand` key. */
const CTRL_O = "";

/** The viewer's visible rows, ANSI stripped. */
function rows(messages: unknown[], viewer?: ConversationViewer): string[] {
  const v = viewer ?? new ConversationViewer(tui(), session(messages), record(), undefined, theme, vi.fn());
  return v.render(120).map(stripTerminalSequences);
}

describe("ConversationViewer tool blocks", () => {
  // The bug in #277: the call row named the tool and dropped everything else, so
  // a viewer could not show what the agent actually ran.
  it("renders the call's arguments, not just the tool name", () => {
    const out = rows([{ role: "assistant", content: [callPart("c1", "bash", { command: "ls -la /tmp" })] }]).join("\n");
    expect(out).toContain("ls -la /tmp");
    expect(out).not.toContain("[Tool: bash]");
  });

  it("folds the matching result into the call's block", () => {
    const out = rows([
      { role: "assistant", content: [callPart("c1", "bash", { command: "ls -la /tmp" })] },
      resultMessage("c1", "bash", "file-a\nfile-b"),
    ]).join("\n");
    // One block: the result appears, and nothing renders the old standalone
    // `[Result]` header for a result that has been folded.
    expect(out).toContain("file-a");
    expect(out).not.toContain("[Result]");
  });

  it("renders a tool pi has no renderer for through the generic fallback", () => {
    const out = rows([
      { role: "assistant", content: [callPart("c1", "mcp__demo__lookup", { query: "needle" })] },
      resultMessage("c1", "mcp__demo__lookup", "haystack"),
    ]).join("\n");
    expect(out).toContain("mcp__demo__lookup");
    expect(out).toContain("needle");
    expect(out).toContain("haystack");
  });

  // A compacted prefix or a reopened session can leave a result with no call row
  // above it; it must still be readable rather than dropped.
  it("keeps a result whose call is not in the transcript", () => {
    const out = rows([resultMessage("gone", "bash", "orphan output")]).join("\n");
    expect(out).toContain("orphan output");
    expect(out).toContain("[Result]");
  });

  describe("expansion", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n");

    // `bash` because its renderer is the one that elides output and names the
    // key: a tool with no renderer prints its whole output and ignores the flag.
    // Tall enough that the expanded block is on screen rather than scrolled past.
    function viewer(): ConversationViewer {
      return new ConversationViewer(
        tui(80),
        session([
          { role: "assistant", content: [callPart("c1", "bash", { command: "seq 30" })] },
          resultMessage("c1", "bash", longOutput),
        ]),
        record(),
        undefined,
        theme,
        vi.fn(),
      );
    }

    it("shows the tail of a long output and names the expand key", () => {
      const collapsed = viewer().render(120).map(stripTerminalSequences).join("\n");
      expect(collapsed).toContain("line-29");
      expect(collapsed).not.toContain("line-0");
      expect(collapsed).toContain("earlier lines");
    });

    it("shows the whole output once the expand key is pressed", () => {
      const v = viewer();
      v.handleInput(CTRL_O);
      expect(v.render(120).map(stripTerminalSequences).join("\n")).toContain("line-0");
    });

    it("collapses again on a second press", () => {
      const v = viewer();
      v.handleInput(CTRL_O);
      expect(v.render(120).map(stripTerminalSequences).join("\n")).toContain("line-0");
      v.handleInput(CTRL_O);
      expect(v.render(120).map(stripTerminalSequences).join("\n")).not.toContain("line-0");
    });
  });
});
