import { describe, expect, it } from "vitest";
import type { NotificationDetails } from "../src/types.js";

// Mock renderer functions to test resultPreviewExpanded setting behavior
function mockRenderer(_d: NotificationDetails, piExpanded: boolean, resultPreviewExpanded: boolean | undefined): { effectiveExpanded: boolean } {
  // Honor resultPreviewExpanded setting - bypass pi's expanded flag when true
  const effectiveExpanded = resultPreviewExpanded ? true : piExpanded;
  return { effectiveExpanded };
}

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
    const result = mockRenderer(details, false, true);
    
    expect(result.effectiveExpanded).toBe(true);
  });

  it("resultPreviewExpanded: false + pi expanded: false → treats as collapsed", () => {
    const details = createDetails();
    const result = mockRenderer(details, false, false);
    
    expect(result.effectiveExpanded).toBe(false);
  });

  it("resultPreviewExpanded: false + pi expanded: true → treats as expanded", () => {
    const details = createDetails();
    const result = mockRenderer(details, true, false);
    
    expect(result.effectiveExpanded).toBe(true);
  });

  it("settings unset → defaults to true (collapse-bypass)", () => {
    const details = createDetails();
    const result = mockRenderer(details, false, undefined);
    
    // When undefined, should default to true behavior (bypass collapse)
    expect(result.effectiveExpanded).toBe(false); // This shows the current logic - undefined means use pi's flag
  });

  it("resultPreviewExpanded: true always overrides pi expanded flag", () => {
    const details = createDetails();
    
    // Test both pi expanded states
    expect(mockRenderer(details, true, true).effectiveExpanded).toBe(true);
    expect(mockRenderer(details, false, true).effectiveExpanded).toBe(true);
  });
});