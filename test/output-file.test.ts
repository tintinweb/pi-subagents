import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createOutputFilePath,
  writeInitialEntry,
  streamToOutputFile,
} from "../src/output-file.js";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

/** Minimal mock session with subscribe that captures the callback. */
function mockSession() {
  let subscriber: ((event: AgentSessionEvent) => void) | undefined;
  const messages: any[] = [];
  return {
    get messages() { return messages; },
    subscribe(cb: (event: AgentSessionEvent) => void) {
      subscriber = cb;
      return () => { subscriber = undefined; };
    },
    emit(event: AgentSessionEvent) {
      subscriber?.(event);
    },
    pushMessage(msg: any) {
      messages.push(msg);
    },
  };
}

/** Poll until the file has more than `minBytes` bytes (async flush completed). */
async function waitForFileGrowth(path: string, minBytes: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (statSync(path).size > minBytes) return;
    } catch { /* file may not exist yet */ }
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("output-file", () => {
  describe("createOutputFilePath", () => {
    it("creates the directory structure and returns a path", () => {
      const path = createOutputFilePath("/tmp/test-cwd", "agent-123", "sess-456");
      expect(path).toContain("agent-123.output");
      expect(path).toContain("sess-456");
      expect(path).toContain("tasks");
    });

    it("returns different paths for different agent IDs", () => {
      const p1 = createOutputFilePath("/tmp/cwd", "a1", "s1");
      const p2 = createOutputFilePath("/tmp/cwd", "a2", "s1");
      expect(p1).not.toBe(p2);
    });
  });

  describe("writeInitialEntry", () => {
    let tempDir: string;
    let outputPath: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "pi-output-test-"));
      outputPath = join(tempDir, "test.output");
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("writes a valid JSONL entry with user prompt", () => {
      writeInitialEntry(outputPath, "agent-1", "hello world", "/tmp");
      const content = readFileSync(outputPath, "utf-8");
      const entry = JSON.parse(content.trim());

      expect(entry.isSidechain).toBe(true);
      expect(entry.agentId).toBe("agent-1");
      expect(entry.type).toBe("user");
      expect(entry.message.role).toBe("user");
      expect(entry.message.content).toBe("hello world");
      expect(entry.cwd).toBe("/tmp");
      expect(entry.timestamp).toBeDefined();
    });

    it("writes entry ending with newline", () => {
      writeInitialEntry(outputPath, "a", "p", "/tmp");
      const content = readFileSync(outputPath, "utf-8");
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  describe("streamToOutputFile", () => {
    let tempDir: string;
    let outputPath: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "pi-stream-test-"));
      outputPath = join(tempDir, "stream.output");
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("sync-flushes remaining messages on cleanup", () => {
      const session = mockSession();
      // Write initial entry so writtenCount starts at 1
      writeInitialEntry(outputPath, "a1", "prompt", "/tmp");

      // session.messages[0] must exist (the user prompt) since writtenCount starts at 1
      session.pushMessage({ role: "user", content: "prompt" });

      const cleanup = streamToOutputFile(
        session as unknown as AgentSession,
        outputPath,
        "a1",
        "/tmp",
      );

      // Add messages to session without emitting turn_end
      session.pushMessage({ role: "assistant", content: [{ type: "text", text: "response" }] });

      // Cleanup should sync-flush
      cleanup();

      const content = readFileSync(outputPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2); // initial + assistant
      const entry = JSON.parse(lines[1]);
      expect(entry.type).toBe("assistant");
      expect(entry.agentId).toBe("a1");
    });

    it("async flush writes on turn_end", async () => {
      const session = mockSession();
      writeInitialEntry(outputPath, "a1", "prompt", "/tmp");
      session.pushMessage({ role: "user", content: "prompt" });

      const cleanup = streamToOutputFile(
        session as unknown as AgentSession,
        outputPath,
        "a1",
        "/tmp",
      );

      session.pushMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] });
      const sizeBefore = statSync(outputPath).size;
      session.emit({ type: "turn_end" } as AgentSessionEvent);

      // Wait for async appendFile to grow the file
      await waitForFileGrowth(outputPath, sizeBefore);

      const content = readFileSync(outputPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2);

      cleanup();
    });

    it("does not duplicate messages on cleanup after async flush", async () => {
      const session = mockSession();
      writeInitialEntry(outputPath, "a1", "prompt", "/tmp");
      session.pushMessage({ role: "user", content: "prompt" });

      const cleanup = streamToOutputFile(
        session as unknown as AgentSession,
        outputPath,
        "a1",
        "/tmp",
      );

      session.pushMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] });
      const sizeBefore = statSync(outputPath).size;
      session.emit({ type: "turn_end" } as AgentSessionEvent);

      await waitForFileGrowth(outputPath, sizeBefore);

      // Cleanup should not re-write the already-flushed message
      cleanup();

      const content = readFileSync(outputPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(2); // not 3
    });

    it("handles toolResult messages", () => {
      const session = mockSession();
      writeInitialEntry(outputPath, "a1", "prompt", "/tmp");
      session.pushMessage({ role: "user", content: "prompt" });

      const cleanup = streamToOutputFile(
        session as unknown as AgentSession,
        outputPath,
        "a1",
        "/tmp",
      );

      session.pushMessage({ role: "toolResult", toolName: "bash", content: "output" });
      cleanup();

      const content = readFileSync(outputPath, "utf-8");
      const lines = content.trim().split("\n");
      const entry = JSON.parse(lines[1]);
      expect(entry.type).toBe("toolResult");
    });
  });
});
