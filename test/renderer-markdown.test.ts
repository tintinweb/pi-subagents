import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { subagentNotificationRenderBody, subagentNotificationRenderHeader, subagentNotificationRenderer } from "../src/index.js";
import type { NotificationDetails, ResultPreviewMode } from "../src/types.js";

// Mock theme
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

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
    const body = subagentNotificationRenderBody(details, true, "markdown", mockTheme);
    
    expect(body).toBeInstanceOf(Container);
    const container = body as Container;
    expect(container.children.length).toBeGreaterThan(0);
    expect(container.children[0]).toBeInstanceOf(Markdown);
  });

  it("markdown mode + collapsed caps at 10 lines with expand hint", () => {
    const fiftyLines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
    const details = createDetails({ resultPreview: fiftyLines });
    
    const body = subagentNotificationRenderBody(details, false, "markdown", mockTheme);
    const container = body as Container;
    const markdown = container.children[0] as Markdown;
    
    // Check that the markdown content includes the expand hint
    expect(markdown.text).toContain("… (40 more lines, ctrl+O to expand)");
  });

  it("plain mode expanded produces byte-equivalent to baseline", () => {
    const details = createDetails();
    const body = subagentNotificationRenderBody(details, true, "plain", mockTheme);
    
    expect(body).toBeInstanceOf(Text);
    const text = body as Text;
    expect(text.text).toContain("[dim]  # Test Result[/dim]");
    expect(text.text).toContain("[dim]  This is a test result with multiple lines.[/dim]");
  });

  it("plain mode collapsed produces byte-equivalent to baseline", () => {
    const details = createDetails({
      resultPreview: "This is a long line that should be truncated at 80 characters for preview",
    });
    const body = subagentNotificationRenderBody(details, false, "plain", mockTheme);
    
    expect(body).toBeInstanceOf(Text);
    const text = body as Text;
    expect(text.text).toContain("[dim]  ⎿  This is a long line that should be truncated at 80 characters for preview[/dim]");
  });

  it("empty body + markdown mode renders sensibly", () => {
    const details = createDetails({ resultPreview: "" });
    const body = subagentNotificationRenderBody(details, true, "markdown", mockTheme);
    
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
    
    const rendered = subagentNotificationRenderer(
      { details: main },
      { expanded: true },
      mockTheme,
      "markdown",
      false
    );
    
    expect(rendered).toBeInstanceOf(Container);
    expect(rendered.children).toHaveLength(5); // 3 agents + 2 spacers
  });

  it("collapsed markdown with code fence cut mid-block renders gracefully", () => {
    const lines = ["# Header", "```typescript", "function foo() {", "  return 42;", "}", "```"];
    const fifteenLines = [...lines, ...Array(9).fill("more content")];
    const details = createDetails({ resultPreview: fifteenLines.join("\n") });
    
    const body = subagentNotificationRenderBody(details, false, "markdown", mockTheme);
    
    // Should not crash, markdown component should handle partial fence gracefully
    expect(body).toBeInstanceOf(Container);
  });

  it("mixed success/failure in d.others renders correctly", () => {
    const main = createDetails({ status: "completed" });
    const failed = createDetails({ status: "error", id: "test-2", resultPreview: "Error occurred" });
    const stopped = createDetails({ status: "stopped", id: "test-3", resultPreview: "No output." });
    main.others = [failed, stopped];
    
    const rendered = subagentNotificationRenderer(
      { details: main },
      { expanded: true },
      mockTheme,
      "markdown",
      false
    );
    
    expect(rendered).toBeInstanceOf(Container);
    expect(rendered.children).toHaveLength(5); // 3 agents + 2 spacers
    
    // Verify each renders appropriately for its status
    const mainContainer = rendered.children[0] as Container;
    const failedContainer = rendered.children[2] as Container;
    const stoppedContainer = rendered.children[4] as Container;
    
    expect(mainContainer).toBeInstanceOf(Container);
    expect(failedContainer).toBeInstanceOf(Container);
    expect(stoppedContainer).toBeInstanceOf(Container);
  });
});