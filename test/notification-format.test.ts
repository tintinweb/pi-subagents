import { describe, expect, it } from "vitest";
import type { AgentRecord, SubagentsSettings } from "../src/types.js";

// Import the formatTaskNotification function - need to check how it's exported
import { formatTaskNotification } from "../src/index.js";

describe("XML payload formatTaskNotification", () => {
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
    
    const xml = formatTaskNotification(record, defaultSettings);
    
    expect(xml).toContain(`<result>${result1KB}</result>`);
  });

  it("success agent with 100KB result contains full result", () => {
    const result100KB = "x".repeat(100 * 1024);
    const record = createRecord({ result: result100KB });
    
    const xml = formatTaskNotification(record, defaultSettings);
    
    expect(xml).toContain(`<result>${result100KB}</result>`);
  });

  it("failed agent with error message shows error in result", () => {
    const record = createRecord({
      status: "error",
      result: undefined,
      error: "boom",
    });
    
    const xml = formatTaskNotification(record, defaultSettings);
    
    expect(xml).toContain(`<result>boom</result>`);
  });

  it("stopped agent with no output shows fallback message", () => {
    const record = createRecord({
      status: "stopped",
      result: undefined,
      error: undefined,
    });
    
    const xml = formatTaskNotification(record, defaultSettings);
    
    expect(xml).toContain(`<result>No output.</result>`);
  });

  it("failed agent with large error gets truncated", () => {
    const largeError = "x".repeat(100 * 1024);
    const record = createRecord({
      status: "error",
      result: undefined,
      error: largeError,
    });
    
    const settings: SubagentsSettings = { failurePreviewMaxChars: 1000 };
    const xml = formatTaskNotification(record, settings);
    
    const expectedTruncated = largeError.slice(0, 1000) + "\n…(truncated, see transcript)";
    expect(xml).toContain(`<result>${expectedTruncated}</result>`);
  });

  it("aborted status is not subject to failure cap", () => {
    const largeResult = "x".repeat(100 * 1024);
    const record = createRecord({
      status: "aborted",
      result: largeResult,
    });
    
    const settings: SubagentsSettings = { failurePreviewMaxChars: 1000 };
    const xml = formatTaskNotification(record, settings);
    
    expect(xml).toContain(`<result>${largeResult}</result>`);
  });
});