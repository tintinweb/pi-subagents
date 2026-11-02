import { createBashToolDefinition, createEditToolDefinition, initTheme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
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

/**
 * A session stub whose tool registry holds pi's builtin definitions, plus any
 * `extra` ones, resolved through a pass-through extension runner, as pi does.
 */
function session(messages: unknown[], extra: Record<string, ToolRenderers> = {}) {
  const cwd = process.cwd();
  const tools: Record<string, ToolRenderers> = {
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    ...extra,
  };
  return {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    sessionManager: { getCwd: () => cwd },
    getToolDefinition: (name: string) => tools[name],
    extensionRunner: {
      resolveToolRenderers: (_name: string, base: () => ToolRenderers | undefined) => base(),
    },
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
function rows(messages: unknown[], extra: Record<string, ToolRenderers> = {}): string[] {
  const v = new ConversationViewer(tui(), session(messages, extra), record(), undefined, theme, vi.fn());
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

    // `bash` because its renderer keeps the tail of the output; the bounded
    // fallback for a tool without a renderer is covered further down.
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

  function viewerFor(messages: unknown[], extra: Record<string, ToolRenderers> = {}): ConversationViewer {
    return new ConversationViewer(tui(80), session(messages, extra), record(), undefined, theme, vi.fn());
  }

  // Blocks are built inside render(), so building one must not schedule another
  // frame. pi's replay of a saved session builds settled calls the same way: no
  // setArgsComplete() / markExecutionStarted(), both of which request a render
  // (and the former makes the edit renderer re-read the file from disk).
  it("builds tool blocks without requesting another render", () => {
    const t = tui(80);
    const v = new ConversationViewer(
      t,
      session([
        { role: "assistant", content: [callPart("e1", "edit", { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] })] },
        resultMessage("e1", "edit", "Edited a.txt", { details: { diff: "-1 old\n+1 new" } }),
      ]),
      record(),
      undefined,
      theme,
      vi.fn(),
    );
    const requestRender = (t as unknown as { requestRender: ReturnType<typeof vi.fn> }).requestRender;
    requestRender.mockClear();
    const out = v.render(120).map(stripTerminalSequences).join("\n");
    expect(out).toContain("+1 new");
    expect(requestRender).not.toHaveBeenCalled();
  });

  // A tool no registry knows still renders bounded: the viewer capped tool
  // output before tool blocks existed, and the expand key must reach it.
  it("bounds an unregistered tool's output and expands it on the expand key", () => {
    const output = Array.from({ length: 30 }, (_, i) => `row-${i}`).join("\n");
    const v = viewerFor([
      { role: "assistant", content: [callPart("u1", "mcp__demo__dump", { query: "all" })] },
      resultMessage("u1", "mcp__demo__dump", output),
    ]);
    const collapsed = v.render(120).map(stripTerminalSequences).join("\n");
    expect(collapsed).toContain("row-0");
    expect(collapsed).not.toContain("row-29");
    expect(collapsed).toContain("more lines");
    v.handleInput(CTRL_O);
    expect(v.render(120).map(stripTerminalSequences).join("\n")).toContain("row-29");
  });

  // An aborted or failed response never runs its tool calls, so no result ever
  // arrives. pi's session replay marks such a call failed rather than leaving it
  // drawn as if it were still running; the viewer does the same.
  it("marks a call from an aborted or failed response as not run", () => {
    const out = rows([
      { role: "assistant", stopReason: "aborted", content: [callPart("a1", "bash", { command: "sleep 100" })] },
      { role: "assistant", stopReason: "error", errorMessage: "provider exploded", content: [callPart("a2", "bash", { command: "sleep 200" })] },
    ]).join("\n");
    expect(out).toContain("sleep 100");
    expect(out).toContain("Operation aborted");
    expect(out).toContain("provider exploded");
  });

  // Renderers come from the agent's own session, so an extension tool that ships
  // a renderer is drawn by it, as in pi's main transcript.
  it("draws an extension tool with the renderer its session registered", () => {
    const out = rows([{ role: "assistant", content: [callPart("x1", "my_ext_tool", { q: 1 })] }], {
      my_ext_tool: { renderCall: () => new Text("custom-renderer-marker", 0, 0) },
    }).join("\n");
    expect(out).toContain("custom-renderer-marker");
  });
});
