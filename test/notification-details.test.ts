import { describe, expect, it } from "vitest";
import { buildNotificationDetails } from "../src/index.js";
import type { AgentRecord, SubagentsSettings } from "../src/types.js";

describe("UI details buildNotificationDetails", () => {
  const createRecord = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
    id: "test-agent-1",
    description: "Test Agent",
    status: "completed",
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    result: undefined,
    error: undefined,
    lifetimeUsage: { inputTokens: 100, outputTokens: 50 },
    session: { id: "session-1", contextTokens: 1000, maxContextTokens: 10000 },
    compactionCount: 0,
    ...overrides,
  });

  const defaultSettings: SubagentsSettings = {
    failurePreviewMaxChars: 65536,
  };

  it("success agent with 1KB result contains full result", () => {
    const result1KB = "x".repeat(1024);
    const record = createRecord({ result: result1KB });
    
    const details = buildNotificationDetails(record, defaultSettings);
    
    expect(details.resultPreview).toBe(result1KB);
  });

  it("success agent with 100KB result contains full result", () => {
    const result100KB = "x".repeat(100 * 1024);
    const record = createRecord({ result: result100KB });
    
    const details = buildNotificationDetails(record, defaultSettings);
    
    expect(details.resultPreview).toBe(result100KB);
  });

  it("failed agent with error message shows error in resultPreview", () => {
    const record = createRecord({
      status: "error",
      result: undefined,
      error: "boom",
    });
    
    const details = buildNotificationDetails(record, defaultSettings);
    
    expect(details.resultPreview).toBe("boom");
  });

  it("stopped agent with no output shows fallback message", () => {
    const record = createRecord({
      status: "stopped",
      result: undefined,
      error: undefined,
    });
    
    const details = buildNotificationDetails(record, defaultSettings);
    
    expect(details.resultPreview).toBe("No output.");
  });

  it("failed agent with large error gets truncated", () => {
    const largeError = "x".repeat(100 * 1024);
    const record = createRecord({
      status: "error",
      result: undefined,
      error: largeError,
    });
    
    const settings: SubagentsSettings = { failurePreviewMaxChars: 1000 };
    const details = buildNotificationDetails(record, settings);
    
    const expectedTruncated = largeError.slice(0, 1000) + "\n…(truncated, see transcript)";
    expect(details.resultPreview).toBe(expectedTruncated);
  });

  it("aborted status is not subject to failure cap", () => {
    const largeResult = "x".repeat(100 * 1024);
    const record = createRecord({
      status: "aborted",
      result: largeResult,
    });
    
    const settings: SubagentsSettings = { failurePreviewMaxChars: 1000 };
    const details = buildNotificationDetails(record, settings);
    
    expect(details.resultPreview).toBe(largeResult);
  });

  it("fallback precedence: result ?? error ?? empty", () => {
    // When both result and error are present, result takes precedence
    const record = createRecord({
      status: "completed",
      result: "partial output",
      error: "some error",
    });
    
    const details = buildNotificationDetails(record, defaultSettings);
    
    expect(details.resultPreview).toBe("partial output");
  });
});