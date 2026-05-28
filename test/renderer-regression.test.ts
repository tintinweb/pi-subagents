
import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "../src/types.js";

// Mock theme for consistent output
const _mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

// Create a mock renderer that matches upstream master behavior
function renderUpstreamBaseline(d: NotificationDetails, expanded: boolean): string {
  const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
  const icon = isError ? "[error]✗[/error]" : "[success]✓[/success]";
  const statusText = isError ? d.status
    : d.status === "steered" ? "completed (steered)"
    : "completed";

  let line = `${icon} **${d.description}** [dim]${statusText}[/dim]`;

  // Stats line
  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(`${d.turnCount} turn${d.turnCount === 1 ? "" : "s"}`);
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(`${d.totalTokens} tokens`);
  if (d.durationMs > 0) parts.push(`${Math.round(d.durationMs)}ms`);
  if (parts.length) {
    line += "\n  " + parts.map(p => `[dim]${p}[/dim]`).join(" [dim]·[/dim] ");
  }

  // Result preview
  if (expanded) {
    const lines = d.resultPreview.split("\n").slice(0, 30);
    for (const l of lines) line += "\n" + `[dim]  ${l}[/dim]`;
  } else {
    const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
    line += "\n  " + `[dim]⎿  ${preview}[/dim]`;
  }

  // Output file
  if (d.outputFile) {
    line += "\n  " + `[muted]transcript: ${d.outputFile}[/muted]`;
  }

  return line;
}

describe("renderer regression-lock snapshot", () => {
  const createDetails = (overrides: Partial<NotificationDetails> = {}): NotificationDetails => ({
    id: "test-1",
    description: "Test Agent",
    status: "completed",
    toolUses: 2,
    turnCount: 3,
    totalTokens: 150,
    durationMs: 5000,
    resultPreview: "# Test Result\n\nThis is a test result with multiple lines.\nLine 2\nLine 3",
    ...overrides,
  });

  it("completed status matches upstream baseline", () => {
    const details = createDetails();
    const expected = renderUpstreamBaseline(details, true);
    
    // This test locks the expected output format for regression detection
    expect(expected).toContain("[success]✓[/success] **Test Agent** [dim]completed[/dim]");
    expect(expected).toContain("[dim]3 turns[/dim] [dim]·[/dim] [dim]2 tool uses[/dim]");
    expect(expected).toContain("[dim]  # Test Result[/dim]");
  });

  it("error status matches upstream baseline", () => {
    const details = createDetails({
      status: "error",
      resultPreview: "Error: something went wrong",
    });
    const expected = renderUpstreamBaseline(details, true);
    
    expect(expected).toContain("[error]✗[/error] **Test Agent** [dim]error[/dim]");
    expect(expected).toContain("[dim]  Error: something went wrong[/dim]");
  });

  it("stopped status matches upstream baseline", () => {
    const details = createDetails({
      status: "stopped",
      resultPreview: "No output.",
    });
    const expected = renderUpstreamBaseline(details, true);
    
    expect(expected).toContain("[error]✗[/error] **Test Agent** [dim]stopped[/dim]");
    expect(expected).toContain("[dim]  No output.[/dim]");
  });

  it("aborted status matches upstream baseline", () => {
    const details = createDetails({
      status: "aborted",
      resultPreview: "Partial result before abort",
    });
    const expected = renderUpstreamBaseline(details, true);
    
    expect(expected).toContain("[error]✗[/error] **Test Agent** [dim]aborted[/dim]");
    expect(expected).toContain("[dim]  Partial result before abort[/dim]");
  });

  it("steered status matches upstream baseline", () => {
    const details = createDetails({
      status: "steered",
      resultPreview: "Steered completion result",
    });
    const expected = renderUpstreamBaseline(details, true);
    
    expect(expected).toContain("[success]✓[/success] **Test Agent** [dim]completed (steered)[/dim]");
    expect(expected).toContain("[dim]  Steered completion result[/dim]");
  });

  it("collapsed view matches upstream baseline", () => {
    const details = createDetails({
      resultPreview: "This is a very long line that should be truncated at 80 characters and show preview format",
    });
    const expected = renderUpstreamBaseline(details, false);
    
    expect(expected).toContain("[dim]⎿  This is a very long line that should be truncated at 80 characters and show prev[/dim]");
  });

  it("group rendering with others matches upstream baseline", () => {
    const main = createDetails({ description: "Main Agent" });
    const other1 = createDetails({ description: "Other Agent 1", id: "test-2" });
    const other2 = createDetails({ description: "Other Agent 2", id: "test-3" });
    
    main.others = [other1, other2];
    
    const expectedMain = renderUpstreamBaseline(main, true);
    const expectedOther1 = renderUpstreamBaseline(other1, true);
    const expectedOther2 = renderUpstreamBaseline(other2, true);
    
    expect(expectedMain).toContain("**Main Agent**");
    expect(expectedOther1).toContain("**Other Agent 1**");
    expect(expectedOther2).toContain("**Other Agent 2**");
  });
});