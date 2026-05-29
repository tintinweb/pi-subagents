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

  it("UI path: surrogate pairs handled gracefully", () => {
    const emoji = "🚀".repeat(1000);
    const record = createRecord({ status: "error", error: emoji, result: undefined });
    // 1999 = (1000 emoji × 2 UTF-16 units) - 1; cuts the LAST emoji's high surrogate, exercising safeTruncate's drop-trailing-high-surrogate path
    const settings = { failurePreviewMaxChars: 1999 };
    
    const details = buildNotificationDetails(record, settings);
    
    // Should not contain Unicode replacement characters
    expect(details.resultPreview).not.toContain("�");
    expect(details.resultPreview).toContain("truncated, see transcript");
  });

  it("UI path: high surrogate at exact boundary drops unpaired surrogate", () => {
    const emoji = "🚀".repeat(1000); // 2000 UTF-16 units total
    const record = createRecord({ status: "error", error: emoji, result: undefined });
    const settings = { failurePreviewMaxChars: 1999 }; // Slice would land exactly at high surrogate of last emoji
    
    const details = buildNotificationDetails(record, settings);
    
    // Should drop the unpaired high surrogate + add truncation suffix, total length 1998 + 29 = 2027
    expect(details.resultPreview.length).toBe(2027);
    expect(details.resultPreview).not.toContain("�");
    expect(details.resultPreview).toContain("truncated, see transcript");
  });

  it("throws when failurePreviewMaxChars is undefined on error status", () => {
    const record = createRecord({ status: "error", error: "boom", result: undefined });
    const settings = {} as SubagentsSettings;  // no failurePreviewMaxChars
    
    expect(() => buildNotificationDetails(record, settings)).toThrow(/failurePreviewMaxChars must be a number/);
  });

  it("UI path: isolated low surrogate does not crash", () => {
    const malformedInput = "hello" + String.fromCharCode(0xDC00) + "world"; // Bare low surrogate
    const record = createRecord({ status: "error", error: malformedInput, result: undefined });
    const settings = { failurePreviewMaxChars: 8 }; // Truncate within the string
    
    expect(() => {
      const details = buildNotificationDetails(record, settings);
      expect(details.resultPreview).toBeDefined();
    }).not.toThrow();
  });

  it("UI path: no truncation when input equals maxChars", () => {
    const input = "hello";
    const record = createRecord({ status: "error", error: input, result: undefined });
    const settings = { failurePreviewMaxChars: 5 };
    
    const details = buildNotificationDetails(record, settings);
    
    expect(details.resultPreview).toBe("hello");
    expect(details.resultPreview).not.toContain("truncated");
  });

  it("UI path: cap zero returns truncation message", () => {
    const record = createRecord({ status: "error", error: "hello", result: undefined });
    const settings = { failurePreviewMaxChars: 0 };
    
    const details = buildNotificationDetails(record, settings);
    
    expect(details.resultPreview).toBe("\n…(truncated, see transcript)");
  });
});