import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeCwd, streamToOutputFile, writeInitialEntry } from "../src/output-file.js";

describe("encodeCwd", () => {
  it("encodes a POSIX absolute path by stripping the leading slash and replacing separators", () => {
    expect(encodeCwd("/home/user/project")).toBe("home-user-project");
  });

  it("handles a POSIX root path", () => {
    expect(encodeCwd("/")).toBe("");
  });

  it("encodes a Windows drive-letter path by stripping the drive prefix", () => {
    expect(encodeCwd("C:\\Users\\foo\\project")).toBe("Users-foo-project");
  });

  it("handles lowercase Windows drives", () => {
    expect(encodeCwd("c:\\foo")).toBe("foo");
  });

  it("handles a Windows path written with forward slashes", () => {
    expect(encodeCwd("C:/Users/foo/project")).toBe("Users-foo-project");
  });

  it("preserves server and share for UNC paths", () => {
    expect(encodeCwd("\\\\server\\share\\project")).toBe("server-share-project");
  });

  it("handles mixed separators", () => {
    expect(encodeCwd("/home\\user/project")).toBe("home-user-project");
  });

  it("collapses runs of leading dashes after separator replacement", () => {
    expect(encodeCwd("///foo")).toBe("foo");
  });

  it("returns an empty string for an empty cwd", () => {
    expect(encodeCwd("")).toBe("");
  });

  it("leaves a relative-looking path with no leading separator alone", () => {
    expect(encodeCwd("foo/bar")).toBe("foo-bar");
  });
});

/**
 * Minimal AgentSession fake. streamToOutputFile only reads `session.messages`
 * and calls `session.subscribe(cb)`, so we provide just those — plus test-only
 * helpers to mutate state and fire events deterministically.
 */
function makeFakeSession(initialMessages: unknown[] = []) {
  let messages: unknown[] = [...initialMessages];
  let cb: ((event: unknown) => void) | null = null;
  return {
    get messages() {
      return messages;
    },
    subscribe(fn: (event: unknown) => void) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
    push(...msgs: unknown[]) {
      messages.push(...msgs);
    },
    /** Swap the whole array, like pi's compaction (`agent.state.messages = ...`). */
    replaceAll(msgs: unknown[]) {
      messages = msgs;
    },
    fire(event: unknown) {
      cb?.(event);
    },
    isSubscribed() {
      return cb !== null;
    },
  };
}

/** Drain the microtask queue (the compaction re-anchor is deferred one tick). */
const microtask = () => Promise.resolve();

describe("streamToOutputFile", () => {
  let tmp: string;
  let outPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "stream-out-test-"));
    outPath = join(tmp, "agent.output");
    writeInitialEntry(outPath, "agent-1", "do the thing", "/work");
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function readEntries(): Array<Record<string, unknown>> {
    return readFileSync(outPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("writes nothing past the initial entry until turn_end fires", () => {
    const session = makeFakeSession([{ role: "user", content: "do the thing" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "ok" }] });
    expect(readEntries()).toHaveLength(1); // only the initial entry

    session.fire({ type: "turn_end" });
    expect(readEntries()).toHaveLength(2);
  });

  it("tags assistant, user, and tool messages with the correct type field", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push(
      { role: "assistant", content: [{ type: "text", text: "thinking" }] },
      { role: "user", content: "follow-up" },
      { role: "tool", content: [{ type: "tool_result", content: "x" }] },
    );
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "toolResult"]);
    expect(entries.every((e) => e.agentId === "agent-1" && e.isSidechain === true)).toBe(true);
    expect(entries.every((e) => e.cwd === "/work")).toBe(true);
  });

  it("never re-emits messages already flushed on a previous turn_end", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "one" }] });
    session.fire({ type: "turn_end" });

    session.push({ role: "assistant", content: [{ type: "text", text: "two" }] });
    session.fire({ type: "turn_end" });

    // Fire a redundant turn_end with no new messages — must not duplicate
    session.fire({ type: "turn_end" });

    expect(readEntries()).toHaveLength(3);
  });

  it("ignores session events other than turn_end", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "x" }] });
    session.fire({ type: "message_start" });
    session.fire({ type: "tool_call" });
    session.fire({ type: "message_end" });

    expect(readEntries()).toHaveLength(1);
  });

  // ---- Compaction (#145): pi replaces session.messages with a shorter,
  // summarized array; streaming must survive it. Event sequences below mirror
  // pi's real order of operations (verified against agent-session 0.80.6).

  it("resumes streaming after compaction shrinks the message array (#145)", async () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push(
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "user", content: "q2" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    );
    session.fire({ type: "turn_end" }); // 4 messages flushed

    // Compaction: summary + kept tail, much shorter than what was written.
    session.fire({ type: "compaction_start", reason: "manual" });
    session.replaceAll([
      { role: "user", content: "summary of earlier turns" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
    ]);
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: { summary: "s" } });
    await microtask();

    session.push({ role: "assistant", content: [{ type: "text", text: "AFTER" }] });
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    // initial + one + q2 + two + AFTER — the kept tail is NOT re-written.
    expect(entries).toHaveLength(5);
    expect(JSON.stringify(entries.at(-1))).toContain("AFTER");
  });

  it("flushes the not-yet-written tail before compaction discards it (#145)", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    // A message lands with no turn_end yet (e.g. overflow mid-turn)...
    session.push({ role: "assistant", content: [{ type: "text", text: "tail-before-compact" }] });
    expect(readEntries()).toHaveLength(1);

    // ...then compaction starts: the tail must reach the file before the array is replaced.
    session.fire({ type: "compaction_start", reason: "overflow" });
    expect(JSON.stringify(readEntries().at(-1))).toContain("tail-before-compact");
  });

  it("re-anchors after the overflow-retry trim, not at compaction_end (#145)", async () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.push({ role: "assistant", content: [{ type: "text", text: "big" }] });
    session.fire({ type: "turn_end" });

    // pi's overflow-retry order: compaction_end fires, THEN the trailing error
    // assistant message is sliced off. A synchronous anchor would sit one past
    // the trimmed array and skip the first post-compaction message.
    session.fire({ type: "compaction_start", reason: "overflow" });
    session.replaceAll([
      { role: "user", content: "summary" },
      { role: "assistant", content: [{ type: "text", text: "err" }], stopReason: "error" },
    ]);
    session.fire({ type: "compaction_end", reason: "overflow", aborted: false, result: { summary: "s" }, willRetry: true });
    session.replaceAll([{ role: "user", content: "summary" }]); // the post-emit trim
    await microtask();

    session.push({ role: "assistant", content: [{ type: "text", text: "RETRY-ANSWER" }] });
    session.fire({ type: "turn_end" });

    expect(JSON.stringify(readEntries().at(-1))).toContain("RETRY-ANSWER");
  });

  it("does not re-anchor on aborted or failed compaction (#145)", async () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    streamToOutputFile(session as never, outPath, "agent-1", "/work");

    session.fire({ type: "compaction_start", reason: "manual" });
    // Aborted/failed: session.messages is left untouched by pi.
    session.fire({ type: "compaction_end", reason: "manual", aborted: true, result: undefined });
    session.fire({ type: "compaction_end", reason: "manual", aborted: false, result: undefined, errorMessage: "boom" });
    await microtask();

    session.push({ role: "assistant", content: [{ type: "text", text: "still-streaming" }] });
    session.fire({ type: "turn_end" });

    const entries = readEntries();
    expect(entries).toHaveLength(2); // nothing skipped, nothing duplicated
    expect(JSON.stringify(entries.at(-1))).toContain("still-streaming");
  });

  it("cleanup() does a final flush and detaches the subscription", () => {
    const session = makeFakeSession([{ role: "user", content: "go" }]);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-1", "/work");

    // Trailing message arrives with no turn_end before shutdown
    session.push({ role: "assistant", content: [{ type: "text", text: "tail" }] });
    expect(readEntries()).toHaveLength(1);

    cleanup();
    expect(readEntries()).toHaveLength(2);
    expect(session.isSubscribed()).toBe(false);

    // Post-cleanup messages must not be written, even if events would otherwise fire
    session.push({ role: "assistant", content: [{ type: "text", text: "ghost" }] });
    session.fire({ type: "turn_end" });
    expect(readEntries()).toHaveLength(2);
  });
});
