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

  // Helper to extract rendered text from Container/Text components
  function extractRenderedText(component: any): string {
    if (!component) return "";
    if (typeof component.text === "string") return component.text;
    if (component.children && Array.isArray(component.children)) {
      return component.children.map(extractRenderedText).join("");
    }
    return "";
  }

  it("plain mode rendering produces consistent ANSI output", () => {
    const testCases = [
      { status: "completed", preview: "Success result" },
      { status: "error", preview: "Error: failed" },
      { status: "stopped", preview: "No output." },
      { status: "aborted", preview: "Partial result" },
      { status: "steered", preview: "Steered result" },
    ];

    const outputs = testCases.map(({ status, preview }) => {
      const details = createDetails({ status: status as any, resultPreview: preview });
      const rendered = subagentNotificationRenderer(
        { details },
        { expanded: true },
        mockTheme,
        "plain",
        false
      );
      return `${status}: ${extractRenderedText(rendered)}`;
    });

    expect(outputs).toMatchInlineSnapshot(`
      [
        "completed: [success]✓[/success] **Test Agent** [dim]completed[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Success result[/dim]",
        "error: [error]✗[/error] **Test Agent** [dim]error[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Error: failed[/dim]",
        "stopped: [error]✗[/error] **Test Agent** [dim]stopped[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  No output.[/dim]",
        "aborted: [error]✗[/error] **Test Agent** [dim]aborted[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Partial result[/dim]",
        "steered: [success]✓[/success] **Test Agent** [dim]completed (steered)[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Steered result[/dim]",
      ]
    `);
  });

  it("snapshot: group rendering with d.others populated", () => {
    // 2 agents: completed + completed
    const completedCompleted = createDetails({
      description: "Main Agent",
      resultPreview: "Main result",
      others: [
        { id: "agent-2", description: "Second Agent", status: "completed" as const, toolUses: 1, turnCount: 2, totalTokens: 100, durationMs: 3000, resultPreview: "Second result" }
      ]
    });
    const rendered1 = subagentNotificationRenderer({ details: completedCompleted }, { expanded: true }, mockTheme, "plain", false);
    expect(extractRenderedText(rendered1)).toMatchInlineSnapshot(`
      "[success]✓[/success] **Main Agent** [dim]completed[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Main result[/dim][success]✓[/success] **Second Agent** [dim]completed[/dim]
        [dim]⟳2[/dim] [dim]·[/dim] [dim]1 tool use[/dim] [dim]·[/dim] [dim]100 token[/dim] [dim]·[/dim] [dim]3.0s[/dim][dim]  Second result[/dim]"
    `);

    // 2 agents: completed + error (mixed)
    const completedError = createDetails({
      description: "Main Agent",
      resultPreview: "Main result",
      others: [
        { id: "agent-2", description: "Failed Agent", status: "error" as const, toolUses: 0, turnCount: 1, totalTokens: 50, durationMs: 1000, resultPreview: "Error occurred" }
      ]
    });
    const rendered2 = subagentNotificationRenderer({ details: completedError }, { expanded: true }, mockTheme, "plain", false);
    expect(extractRenderedText(rendered2)).toMatchInlineSnapshot(`
      "[success]✓[/success] **Main Agent** [dim]completed[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Main result[/dim][error]✗[/error] **Failed Agent** [dim]error[/dim]
        [dim]⟳1[/dim] [dim]·[/dim] [dim]50 token[/dim] [dim]·[/dim] [dim]1.0s[/dim][dim]  Error occurred[/dim]"
    `);

    // 3 agents: completed + steered + aborted (all success-ish)
    const mixedSuccess = createDetails({
      description: "Main Agent",
      resultPreview: "Main result",
      others: [
        { id: "agent-2", description: "Steered Agent", status: "steered" as const, toolUses: 3, turnCount: 4, totalTokens: 200, durationMs: 6000, resultPreview: "Steered result" },
        { id: "agent-3", description: "Aborted Agent", status: "aborted" as const, toolUses: 1, turnCount: 2, totalTokens: 75, durationMs: 2000, resultPreview: "Partial result" }
      ]
    });
    const rendered3 = subagentNotificationRenderer({ details: mixedSuccess }, { expanded: true }, mockTheme, "plain", false);
    expect(extractRenderedText(rendered3)).toMatchInlineSnapshot(`
      "[success]✓[/success] **Main Agent** [dim]completed[/dim]
        [dim]⟳3[/dim] [dim]·[/dim] [dim]2 tool uses[/dim] [dim]·[/dim] [dim]150 token[/dim] [dim]·[/dim] [dim]5.0s[/dim][dim]  Main result[/dim][success]✓[/success] **Steered Agent** [dim]completed (steered)[/dim]
        [dim]⟳4[/dim] [dim]·[/dim] [dim]3 tool uses[/dim] [dim]·[/dim] [dim]200 token[/dim] [dim]·[/dim] [dim]6.0s[/dim][dim]  Steered result[/dim][error]✗[/error] **Aborted Agent** [dim]aborted[/dim]
        [dim]⟳2[/dim] [dim]·[/dim] [dim]1 tool use[/dim] [dim]·[/dim] [dim]75 token[/dim] [dim]·[/dim] [dim]2.0s[/dim][dim]  Partial result[/dim]"
    `);
  });

});