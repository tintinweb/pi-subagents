import { describe, expect, it } from "vitest";
import { formatTaskNotification, buildNotificationDetails } from "../src/index.js";
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
    const settings = { failurePreviewMaxChars: 1999 }; // Odd boundary that could split surrogate pair
    
    const xml = formatTaskNotification(record, settings);
    
    // Should not contain Unicode replacement characters
    expect(xml).not.toContain("�");
    expect(xml).toContain("truncated, see transcript");
  });

  it("buildNotificationDetails handles surrogate pairs in UI path", () => {
    const emoji = "🚀".repeat(1000);
    const record = createRecord({ status: "error", error: emoji, result: undefined });
    const settings = { failurePreviewMaxChars: 1999 };
    
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

  it("handles very large input without performance issues", () => {
    const largeMB = "x".repeat(1024 * 1024); // 1MB
    const record = createRecord({ result: largeMB });
    const settings = { failurePreviewMaxChars: 65536 };
    
    const start = Date.now();
    const xml = formatTaskNotification(record, settings);
    const details = buildNotificationDetails(record, settings);
    const duration = Date.now() - start;
    
    // Should complete quickly (within 100ms)
    expect(duration).toBeLessThan(100);
    expect(xml).toBeDefined();
    expect(details).toBeDefined();
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