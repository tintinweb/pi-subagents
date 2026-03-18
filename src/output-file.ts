/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 *
 * Uses async writes with buffering to avoid blocking the event loop during
 * high-throughput agent execution.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";

/** Create the output file path, ensuring the directory exists.
 *  Mirrors Claude Code's layout: /tmp/{prefix}-{uid}/{encoded-cwd}/{sessionId}/tasks/{agentId}.output */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = cwd.replace(/\//g, "-").replace(/^-/, "");
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = join(root, encoded, sessionId, "tasks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.output`);
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final synchronous flush and unsubscribes.
 *
 * Normal flushes are async (non-blocking). The final cleanup flush falls back to
 * synchronous I/O to guarantee all data is written before the session is disposed.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
): () => void {
  let writtenCount = 1; // initial user prompt already written
  let flushInProgress = false;
  let pendingFlush = false;

  /** Serialize messages from startIdx onward into a JSONL string and count. */
  const serializeFrom = (startIdx: number): { chunk: string; count: number } => {
    const messages = session.messages;
    let chunk = "";
    let count = 0;
    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      chunk += JSON.stringify(entry) + "\n";
      count++;
    }
    return { chunk, count };
  };

  /** Non-blocking flush — batches pending messages and writes asynchronously. */
  const asyncFlush = async () => {
    if (flushInProgress) {
      pendingFlush = true;
      return;
    }
    flushInProgress = true;
    try {
      const startIdx = writtenCount;
      const { chunk, count } = serializeFrom(startIdx);
      if (chunk) {
        await appendFile(path, chunk, "utf-8");
        // Guard: syncFlush may have run while we were awaiting
        if (writtenCount === startIdx) {
          writtenCount = startIdx + count;
        }
      }
    } catch { /* best-effort async write — failures expected on read-only FS */ }
    flushInProgress = false;
    if (pendingFlush) {
      pendingFlush = false;
      queueMicrotask(() => asyncFlush());
    }
  };

  /** Synchronous final flush — used at cleanup to guarantee all data is written. */
  const syncFlush = () => {
    const { chunk, count } = serializeFrom(writtenCount);
    if (chunk) {
      try {
        appendFileSync(path, chunk, "utf-8");
        writtenCount += count;
      } catch { /* best-effort sync flush — failures expected on read-only FS */ }
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") asyncFlush();
  });

  return () => {
    syncFlush();
    unsubscribe();
  };
}

/**
 * Parse an output JSONL file and extract the last assistant message text.
 * Returns undefined if the file doesn't exist or contains no assistant messages.
 */
export function parseOutputFileResult(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  let content: string;
  try {
    const MAX_TAIL = 256 * 1024;
    const stat = statSync(filePath);
    const fd = openSync(filePath, 'r');
    try {
      const start = Math.max(0, stat.size - MAX_TAIL);
      const buf = Buffer.alloc(Math.min(stat.size, MAX_TAIL));
      readSync(fd, buf, 0, buf.length, start);
      content = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (process.env.DEBUG) console.debug(`[pi-subagents] Failed to read output file ${filePath}:`, err);
    return undefined;
  }
  const lines = content.trim().split("\n");
  let lastAssistantText: string | undefined;
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    if (entry.type !== "assistant") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (typeof msg.content === "string") {
      lastAssistantText = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text);
      if (textParts.length > 0) lastAssistantText = textParts.join("");
    }
  }
  return lastAssistantText;
}
