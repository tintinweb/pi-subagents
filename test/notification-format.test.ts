import { describe, expect, it } from "vitest";
import { buildNotificationDetails, formatTaskNotification } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";

describe("notification format edge cases", () => {
  const createRecord = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
    id: "test-1",
    description: "Test Agent",
    status: "completed",
    toolUses: 2,
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    lifetimeUsage: { totalTokens: 150, inputTokens: 100, outputTokens: 50 },
    result: "Test result",
    ...overrides,
  });

  it("failure truncation handles surrogate pairs gracefully", () => {
    const emoji = "🚀".repeat(1000); // Each emoji is 2 UTF-16 code units
    const record = createRecord({ status: "error", error: emoji, result: undefined });
    // 1999 = (1000 emoji × 2 UTF-16 units) - 1; cuts the LAST emoji's high surrogate, exercising safeTruncate's drop-trailing-high-surrogate path
    const settings = { failurePreviewMaxChars: 1999 };
    
    const xml = formatTaskNotification(record, settings);
    
    // Should not contain Unicode replacement characters
    expect(xml).not.toContain("�");
    expect(xml).toContain("truncated, see transcript");
  });

  it("high surrogate at exact boundary drops unpaired surrogate", () => {
    const emoji = "🚀".repeat(1000); // 2000 UTF-16 units total
    const record = createRecord({ status: "error", error: emoji, result: undefined });
    const settings = { failurePreviewMaxChars: 1999 }; // Slice would land exactly at high surrogate of last emoji
    
    const xml = formatTaskNotification(record, settings);
    const resultMatch = xml.match(/<result>(.*?)<\/result>/s);
    const resultContent = resultMatch?.[1] || "";
    
    // Should drop the unpaired high surrogate + add truncation suffix, total length 1998 + 29 = 2027
    expect(resultContent.length).toBe(2027);
    expect(resultContent).not.toContain("�");
    expect(resultContent).toContain("truncated, see transcript");
  });

  it("isolated low surrogate does not crash", () => {
    const malformedInput = "hello" + String.fromCharCode(0xDC00) + "world"; // Bare low surrogate
    const record = createRecord({ status: "error", error: malformedInput, result: undefined });
    const settings = { failurePreviewMaxChars: 8 }; // Truncate within the string
    
    expect(() => {
      const xml = formatTaskNotification(record, settings);
      expect(xml).toBeDefined();
    }).not.toThrow();
  });

  it("no truncation when input equals maxChars", () => {
    const input = "hello";
    const record = createRecord({ status: "error", error: input, result: undefined });
    const settings = { failurePreviewMaxChars: 5 };
    
    const xml = formatTaskNotification(record, settings);
    const resultMatch = xml.match(/<result>(.*?)<\/result>/s);
    const resultContent = resultMatch?.[1] || "";
    
    expect(resultContent).toBe("hello");
    expect(resultContent).not.toContain("truncated");
  });

  it("cap zero returns empty string", () => {
    const record = createRecord({ status: "error", error: "hello", result: undefined });
    const settings = { failurePreviewMaxChars: 0 };
    
    const xml = formatTaskNotification(record, settings);
    const resultMatch = xml.match(/<result>(.*?)<\/result>/s);
    const resultContent = resultMatch?.[1] || "";
    
    expect(resultContent).toBe("\n…(truncated, see transcript)");
  });

  it("buildNotificationDetails handles surrogate pairs in UI path", () => {
    const emoji = "🚀".repeat(1000);
    const record = createRecord({ status: "error", error: emoji, result: undefined });
    const settings = { failurePreviewMaxChars: 1999 }; // (1000 emoji × 2 UTF-16 units) - 1; cuts the LAST emoji's high surrogate, exercising safeTruncate's drop-trailing-high-surrogate path
    
    const details = buildNotificationDetails(record, settings);
    
    // Should not contain Unicode replacement characters
    expect(details.resultPreview).not.toContain("�");
    expect(details.resultPreview).toContain("truncated, see transcript");
  });



  it("empty body renders sensibly", () => {
    const record = createRecord({ result: "", error: undefined });
    const settings = {};
    
    const xml = formatTaskNotification(record, settings);
    const details = buildNotificationDetails(record, settings);
    
    expect(xml).toContain("<result>No output.</result>");
    expect(details.resultPreview).toBe("No output.");
  });



  it("mixed status types in error/stopped/aborted", () => {
    const errorRecord = createRecord({ status: "error", error: "Error message", result: undefined });
    const stoppedRecord = createRecord({ status: "stopped", error: "Stopped", result: undefined });
    const abortedRecord = createRecord({ status: "aborted", result: "Partial result" });
    
    const settings = { failurePreviewMaxChars: 100 };
    
    const errorXml = formatTaskNotification(errorRecord, settings);
    const stoppedXml = formatTaskNotification(stoppedRecord, settings);
    const abortedXml = formatTaskNotification(abortedRecord, settings);
    
    expect(errorXml).toContain("<result>Error message</result>");
    expect(stoppedXml).toContain("<result>Stopped</result>");
    expect(abortedXml).toContain("<result>Partial result</result>");
  });
});