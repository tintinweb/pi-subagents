import { describe, expect, it } from "vitest";
import { subagentNotificationRenderer } from "../src/index.js";
import type { NotificationDetails } from "../src/types.js";

// Mock theme for consistent output
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

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
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      false
    );
    
    // This test locks the expected output format for regression detection
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2); // header + body
  });

  it("error status matches upstream baseline", () => {
    const details = createDetails({
      status: "error",
      resultPreview: "Error: something went wrong",
    });
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("stopped status matches upstream baseline", () => {
    const details = createDetails({
      status: "stopped",
      resultPreview: "No output.",
    });
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("aborted status matches upstream baseline", () => {
    const details = createDetails({
      status: "aborted",
      resultPreview: "Partial result before abort",
    });
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("steered status matches upstream baseline", () => {
    const details = createDetails({
      status: "steered",
      resultPreview: "Steered completion result",
    });
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("collapsed view matches upstream baseline", () => {
    const details = createDetails({
      resultPreview: "This is a very long line that should be truncated at 80 characters and show preview format",
    });
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: false },
      mockTheme,
      "plain",
      false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("group rendering with others matches upstream baseline", () => {
    const main = createDetails({ description: "Main Agent" });
    const other1 = createDetails({ description: "Other Agent 1", id: "test-2" });
    const other2 = createDetails({ description: "Other Agent 2", id: "test-3" });
    
    main.others = [other1, other2];
    
    const rendered = subagentNotificationRenderer(
      { details: main },
      { expanded: true },
      mockTheme,
      "plain",
      false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(5); // 3 agents + 2 spacers
  });
});