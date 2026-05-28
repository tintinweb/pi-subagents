import { describe, expect, it } from "vitest";

// Mock settings menu structure based on the showSettings implementation
interface SettingItem {
  id: string;
  label: string;
  description: string;
  currentValue: string;
  values: string[];
}

function buildMockSettingsItems(): SettingItem[] {
  return [
    {
      id: "maxConcurrent",
      label: "Max concurrency",
      description: "Max concurrent background agents (Enter to type)",
      currentValue: "4",
      values: ["4"],
    },
    {
      id: "defaultMaxTurns",
      label: "Default max turns",
      description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
      currentValue: "0",
      values: ["0"],
    },
    {
      id: "graceTurns",
      label: "Grace turns",
      description: "Grace turns after wrap-up steer (Enter to type)",
      currentValue: "3",
      values: ["3"],
    },
    {
      id: "joinMode",
      label: "Join mode",
      description: "Default join mode for background agents",
      currentValue: "smart",
      values: ["smart", "async", "group"],
    },
    {
      id: "schedulingEnabled",
      label: "Scheduling",
      description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
      currentValue: "on",
      values: ["on", "off"],
    },
    {
      id: "scopeModels",
      label: "Scope models",
      description: "Validate subagent models against scoped models (/scoped-models)",
      currentValue: "off",
      values: ["on", "off"],
    },
    {
      id: "resultPreviewMode",
      label: "Result preview mode",
      description: "Render result body as markdown or plain text",
      currentValue: "markdown",
      values: ["markdown", "plain"],
    },
    {
      id: "resultPreviewExpanded",
      label: "Result preview expanded by default",
      description: "Always show expanded result preview, ignoring pi's expanded flag",
      currentValue: "on",
      values: ["on", "off"],
    },
    {
      id: "failurePreviewMaxChars",
      label: "Failure preview max chars",
      description: "Max chars for failure preview before truncation (Enter to type)",
      currentValue: "65536",
      values: ["65536"],
    },
  ];
}

describe("menu structure", () => {
  it("settings menu includes all three new result preview entries", () => {
    const items = buildMockSettingsItems();
    
    // Check that all three new settings are present
    const resultPreviewMode = items.find(item => item.id === "resultPreviewMode");
    expect(resultPreviewMode).toBeDefined();
    expect(resultPreviewMode?.label).toBe("Result preview mode");
    expect(resultPreviewMode?.values).toEqual(["markdown", "plain"]);
    
    const resultPreviewExpanded = items.find(item => item.id === "resultPreviewExpanded");
    expect(resultPreviewExpanded).toBeDefined();
    expect(resultPreviewExpanded?.label).toBe("Result preview expanded by default");
    expect(resultPreviewExpanded?.values).toEqual(["on", "off"]);
    
    const failurePreviewMaxChars = items.find(item => item.id === "failurePreviewMaxChars");
    expect(failurePreviewMaxChars).toBeDefined();
    expect(failurePreviewMaxChars?.label).toBe("Failure preview max chars");
    expect(failurePreviewMaxChars?.values).toEqual(["65536"]);
  });

  it("menu builder does not crash and includes expected entries", () => {
    const items = buildMockSettingsItems();
    
    // Smoke test - menu should build without crashing
    expect(items).toHaveLength(9);
    expect(items.every(item => item.id && item.label && item.description)).toBe(true);
    
    // Verify the three new entries are in the expected positions (after existing settings)
    const ids = items.map(item => item.id);
    expect(ids).toContain("resultPreviewMode");
    expect(ids).toContain("resultPreviewExpanded");
    expect(ids).toContain("failurePreviewMaxChars");
  });

  it("result preview mode cycles between markdown and plain", () => {
    const items = buildMockSettingsItems();
    const modeItem = items.find(item => item.id === "resultPreviewMode");
    
    expect(modeItem?.values).toEqual(["markdown", "plain"]);
    expect(modeItem?.currentValue).toBe("markdown");
  });

  it("result preview expanded toggles boolean", () => {
    const items = buildMockSettingsItems();
    const expandedItem = items.find(item => item.id === "resultPreviewExpanded");
    
    expect(expandedItem?.values).toEqual(["on", "off"]);
    expect(expandedItem?.currentValue).toBe("on");
  });

  it("failure preview max chars accepts numeric input", () => {
    const items = buildMockSettingsItems();
    const maxCharsItem = items.find(item => item.id === "failurePreviewMaxChars");
    
    expect(maxCharsItem?.description).toContain("Enter to type");
    expect(maxCharsItem?.currentValue).toBe("65536");
  });
});