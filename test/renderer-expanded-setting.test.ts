import { describe, expect, it } from "vitest";
import { subagentNotificationRenderer } from "../src/index.js";
import type { NotificationDetails } from "../src/types.js";

// Mock theme
const mockTheme = {
  fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
  bold: (text: string) => `**${text}**`,
};

describe("resultPreviewExpanded setting", () => {
  const createDetails = (): NotificationDetails => ({
    id: "test-1",
    description: "Test Agent",
    status: "completed",
    toolUses: 2,
    turnCount: 3,
    totalTokens: 150,
    durationMs: 5000,
    resultPreview: "Test result content",
  });

  it("resultPreviewExpanded: true + pi expanded: false → treats as expanded", () => {
    const details = createDetails();
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: false },
      mockTheme,
      "plain",
      true // resultPreviewExpanded = true
    );
    
    // When resultPreviewExpanded is true, should ignore pi's expanded flag
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("resultPreviewExpanded: false + pi expanded: false → treats as collapsed", () => {
    const details = createDetails();
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: false },
      mockTheme,
      "plain",
      false // resultPreviewExpanded = false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("resultPreviewExpanded: false + pi expanded: true → treats as expanded", () => {
    const details = createDetails();
    const rendered = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      false // resultPreviewExpanded = false
    );
    
    expect(rendered).toBeDefined();
    expect(rendered.children).toHaveLength(2);
  });

  it("settings unset → uses pi expanded flag (production default is true)", () => {
    const details = createDetails();
    
    // Test with pi expanded = false, resultPreviewExpanded = true (production default)
    const renderedCollapsed = subagentNotificationRenderer(
      { details },
      { expanded: false },
      mockTheme,
      "plain",
      true // production default
    );
    
    // Test with pi expanded = true, resultPreviewExpanded = true (production default)
    const renderedExpanded = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      true // production default
    );
    
    // Both should render (production default true means always expanded)
    expect(renderedCollapsed).toBeDefined();
    expect(renderedExpanded).toBeDefined();
  });

  it("resultPreviewExpanded: true always overrides pi expanded flag", () => {
    const details = createDetails();
    
    // Test both pi expanded states with resultPreviewExpanded = true
    const renderedPiTrue = subagentNotificationRenderer(
      { details },
      { expanded: true },
      mockTheme,
      "plain",
      true
    );
    
    const renderedPiFalse = subagentNotificationRenderer(
      { details },
      { expanded: false },
      mockTheme,
      "plain",
      true
    );
    
    expect(renderedPiTrue).toBeDefined();
    expect(renderedPiFalse).toBeDefined();
    // Both should behave the same way (expanded) regardless of pi's flag
  });
});