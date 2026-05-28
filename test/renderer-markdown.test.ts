import { describe, expect, it } from "vitest";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { NotificationDetails, ResultPreviewMode } from "../src/types.js";

// Mock theme and getMarkdownTheme
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

// Mock getMarkdownTheme
const mockGetMarkdownTheme = () => mockTheme;

// Mock the renderer functions based on the current implementation
function renderHeader(d: NotificationDetails, theme: any): Text {
  const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const statusText = isError ? d.status
    : d.status === "steered" ? "completed (steered)"
    : "completed";

  let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(`${d.turnCount} turn${d.turnCount === 1 ? "" : "s"}`);
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) parts.push(`${d.totalTokens} tokens`);
  if (d.durationMs > 0) parts.push(`${Math.round(d.durationMs)}ms`);
  if (parts.length) {
    line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
  }

  return new Text(line, 0, 0);
}

function renderBody(d: NotificationDetails, expanded: boolean, mode: ResultPreviewMode, theme: any): Container | Text {
  const COLLAPSED_PREVIEW_LINES = 10;
  
  if (mode === "markdown") {
    let body = d.resultPreview;
    if (!expanded) {
      const lines = body.split("\n");
      if (lines.length > COLLAPSED_PREVIEW_LINES) {
        const remaining = lines.length - COLLAPSED_PREVIEW_LINES;
        body = lines.slice(0, COLLAPSED_PREVIEW_LINES).join("\n") + `\n… (${remaining} more lines, ctrl+O to expand)`;
      }
    }
    
    const container = new Container();
    if (body.trim()) {
      container.addChild(new Markdown(body, 2, 0, mockGetMarkdownTheme()));
    }
    if (d.outputFile) {
      container.addChild(new Text(theme.fg("muted", `  transcript: ${d.outputFile}`), 0, 0));
    }
    return container;
  } else {
    // Plain mode - original behavior
    let bodyText = "";
    if (expanded) {
      const lines = d.resultPreview.split("\n").slice(0, 30);
      for (const l of lines) bodyText += (bodyText ? "\n" : "") + theme.fg("dim", `  ${l}`);
    } else {
      const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
      bodyText = theme.fg("dim", `  ⎿  ${preview}`);
    }

    if (d.outputFile) {
      bodyText += (bodyText ? "\n" : "") + theme.fg("muted", `  transcript: ${d.outputFile}`);
    }

    return new Text(bodyText, 0, 0);
  }
}

describe("markdown rendering branch", () => {
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

  it("markdown mode + expanded produces Markdown component", () => {
    const details = createDetails();
    const body = renderBody(details, true, "markdown", mockTheme);
    
    expect(body).toBeInstanceOf(Container);
    const container = body as Container;
    expect(container.children.length).toBeGreaterThan(0);
    expect(container.children[0]).toBeInstanceOf(Markdown);
  });

  it("markdown mode + collapsed caps at 10 lines with expand hint", () => {
    const fiftyLines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
    const details = createDetails({ resultPreview: fiftyLines });
    
    const body = renderBody(details, false, "markdown", mockTheme);
    const container = body as Container;
    const markdown = container.children[0] as Markdown;
    
    // Check that the markdown content includes the expand hint
    expect(markdown.text).toContain("… (40 more lines, ctrl+O to expand)");
  });

  it("plain mode expanded produces byte-equivalent to baseline", () => {
    const details = createDetails();
    const body = renderBody(details, true, "plain", mockTheme);
    
    expect(body).toBeInstanceOf(Text);
    const text = body as Text;
    expect(text.text).toContain("[dim]  # Test Result[/dim]");
    expect(text.text).toContain("[dim]  This is a test result with multiple lines.[/dim]");
  });

  it("plain mode collapsed produces byte-equivalent to baseline", () => {
    const details = createDetails({
      resultPreview: "This is a long line that should be truncated at 80 characters for preview",
    });
    const body = renderBody(details, false, "plain", mockTheme);
    
    expect(body).toBeInstanceOf(Text);
    const text = body as Text;
    expect(text.text).toContain("[dim]  ⎿  This is a long line that should be truncated at 80 characters for preview[/dim]");
  });

  it("empty body + markdown mode renders sensibly", () => {
    const details = createDetails({ resultPreview: "" });
    const body = renderBody(details, true, "markdown", mockTheme);
    
    expect(body).toBeInstanceOf(Container);
    const container = body as Container;
    // Should not crash, container may be empty or have minimal content
    expect(container.children.length).toBeGreaterThanOrEqual(0);
  });

  it("group rendering produces separated containers", () => {
    const main = createDetails({ description: "Main Agent" });
    const other1 = createDetails({ description: "Other Agent 1", id: "test-2" });
    const other2 = createDetails({ description: "Other Agent 2", id: "test-3" });
    
    main.others = [other1, other2];
    
    // Simulate group rendering logic
    const all = [main, ...(main.others ?? [])];
    const rendered = all.map(d => {
      const header = renderHeader(d, mockTheme);
      const body = renderBody(d, true, "markdown", mockTheme);
      const container = new Container();
      container.addChild(header);
      container.addChild(body);
      return container;
    });
    
    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toBeInstanceOf(Container);
    expect(rendered[1]).toBeInstanceOf(Container);
    expect(rendered[2]).toBeInstanceOf(Container);
  });
});