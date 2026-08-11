import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("Agent");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(tool: any, result: any): string {
  return tool.renderResult(
    { content: result.content, details: result.details },
    { expanded: false, isPartial: false },
    theme,
    { isError: result.isError },
  ).render(120).join("\n");
}

describe("Agent tool invocation error rendering", () => {
  it("shows a Pi tool error instead of structured terminal status", () => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: 'Cannot run with isolation: "worktree" — Git probe failed.' }],
      isError: true,
      details: { status: "aborted" },
    });

    expect(output).toContain('Cannot run with isolation: "worktree" — Git probe failed.');
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });

  it.each([
    ["missing details", undefined],
    ["empty details", {}],
    ["unknown status", { status: "unknown" }],
    ["a status with no rendering of its own", { status: "queued" }],
  ])("shows the real result text for %s", (_name, details) => {
    const output = render(agentTool(), {
      content: [{ type: "text", text: "Unstructured Agent result." }],
      isError: false,
      details,
    });

    expect(output).toContain("Unstructured Agent result.");
    expect(output).not.toContain("Aborted (max turns exceeded)");
  });
});
