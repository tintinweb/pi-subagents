/**
 * get-result-rendering.test.ts — the inline card for `get_subagent_result`.
 *
 * A reply is a header the model reads (id, type, status, stats, description)
 * followed by the agent's own output. The header is noise in the transcript, so
 * collapsed the card shows the output's first line and how much is left under
 * it; expanded, it shows the whole reply. A reply with no header — an error, or
 * "Agent not found" — has nothing to fold and renders whole either way.
 */
import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function getResultTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools.get("get_subagent_result");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function render(
  tool: any,
  text: string,
  { expanded = false, isError = false }: { expanded?: boolean; isError?: boolean } = {},
): string {
  return tool
    .renderResult({ content: [{ type: "text", text }], details: {} }, { expanded, isPartial: false }, theme, { isError })
    .render(120)
    .join("\n");
}

const HEADER = [
  "Agent: 0b722d18-0fca-463",
  "Type: Explore | Status: completed | Tool uses: 24 | 60.0k token | Duration: 270.3s",
  "Description: Find the auth files",
].join("\n");

const reply = (body: string) => `${HEADER}\n\n${body}`;

describe("get_subagent_result rendering", () => {
  it("collapses to the first line of the agent's output", () => {
    const output = render(getResultTool(), reply("Found 5 files.\n- a.ts\n- b.ts"));

    expect(output).toContain("  ⎿  Found 5 files.");
    expect(output).not.toContain("Agent: 0b722d18");
    expect(output).not.toContain("Type: Explore");
  });

  it("counts the folded lines and names the key that unfolds them", () => {
    const output = render(getResultTool(), reply("Found 5 files.\n- a.ts\n- b.ts"));

    expect(output).toContain("... (2 more lines, ctrl+o to expand)");
  });

  it("singularizes a single folded line", () => {
    expect(render(getResultTool(), reply("Found 5 files.\nDone."))).toContain("... (1 more line, ctrl+o to expand)");
  });

  it("adds no hint when the output is one line", () => {
    const output = render(getResultTool(), reply("Found 5 files."));

    expect(output).toContain("Found 5 files.");
    expect(output).not.toContain("ctrl+o");
  });

  it("shows the whole reply when expanded", () => {
    const output = render(getResultTool(), reply("Found 5 files.\n- a.ts"), { expanded: true });

    expect(output).toContain("Agent: 0b722d18-0fca-463");
    expect(output).toContain("Description: Find the auth files");
    expect(output).toContain("Found 5 files.");
    expect(output).toContain("- a.ts");
    expect(output).not.toContain("ctrl+o");
  });

  it("renders a running agent's note whole", () => {
    const text = reply("Agent is still running. Use wait: true or check back later.");

    expect(render(getResultTool(), text)).toContain("Agent is still running.");
  });

  it.each([
    ["an agent that was cleaned up", 'Agent not found: "gone". It may have been cleaned up.'],
    ["a malformed reply", "No output."],
  ])("renders %s without folding", (_name, text) => {
    expect(render(getResultTool(), text)).toContain(text);
  });

  it("renders a tool error whole", () => {
    const text = "get_subagent_result failed: cannot read properties of undefined.";

    expect(render(getResultTool(), text, { isError: true })).toContain(text);
  });
});
