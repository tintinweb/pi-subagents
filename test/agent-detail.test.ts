import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { createAgentDetailSource } from "../src/ui/workflow-menu.js";
import { agentDetailFromMessages, toolCallHead } from "../src/workflow/agent-detail.js";

type Messages = Parameters<typeof agentDetailFromMessages>[0];

/** Session messages in pi's shape, cast once here rather than at every call. */
const msgs = (list: unknown[]): Messages => list as Messages;

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, text: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "x",
  content: [{ type: "text", text }],
  isError,
});

describe("toolCallHead", () => {
  it("names the call by its most telling argument", () => {
    expect(toolCallHead("Bash", { command: "ls -la", description: "list" })).toBe("Bash(ls -la)");
    expect(toolCallHead("Read", { path: "src/a.ts", offset: 3 })).toBe("Read(src/a.ts)");
    expect(toolCallHead("Grep", { pattern: "foo", path: "src" })).toBe("Grep(foo)");
  });

  it("falls back to the first string argument, then to the bare name", () => {
    expect(toolCallHead("Custom", { level: 3, target: "prod" })).toBe("Custom(prod)");
    expect(toolCallHead("Noop", { n: 1 })).toBe("Noop");
    expect(toolCallHead("Noop", undefined)).toBe("Noop");
  });

  it("collapses a multi-line argument onto one line", () => {
    expect(toolCallHead("Bash", { command: "python3 - <<'EOF'\n  print(1)\nEOF" })).toBe("Bash(python3 - <<'EOF' print(1) EOF)");
  });
});

describe("agentDetailFromMessages", () => {
  const messages = msgs([
    { role: "user", content: [{ type: "text", text: "  do the thing\nstep 2  " }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Looking first.\nThen acting." }, call("c1", "Bash", { command: "ls" }), call("c2", "Read", { path: "x" })],
    },
    result("c1", "a\nb\n"),
    result("c2", "ENOENT", true),
    { role: "user", content: "a later steer" },
    { role: "assistant", content: [call("c3", "Bash", { command: "pwd" })] },
    { role: "assistant", content: [{ type: "text", text: "Done: all good." }] },
  ]);
  const detail = agentDetailFromMessages(messages);

  it("takes the first user message as the prompt and the last text as the outcome", () => {
    expect(detail.prompt).toBe("do the thing\nstep 2");
    expect(detail.outcome).toBe("Done: all good.");
  });

  it("lists text and calls in order, each call paired with its own result", () => {
    expect(detail.items).toEqual([
      { kind: "text", head: "Looking first.", body: ["Then acting."] },
      { kind: "tool", head: "Bash(ls)", body: ["a", "b"], settled: true },
      { kind: "tool", head: "Read(x)", body: ["ENOENT"], settled: true, isError: true },
      // No result yet: the call is still running.
      { kind: "tool", head: "Bash(pwd)", body: [], settled: false },
      { kind: "text", head: "Done: all good.", body: [] },
    ]);
  });

  it("is empty for a session with no messages", () => {
    expect(agentDetailFromMessages(msgs([]))).toEqual({ items: [] });
  });

  it("strips what would draw over the frame: escapes, carriage returns, tabs, controls", () => {
    // Tool output is stored raw: a coloured test run, a `\r` progress line, a tab.
    const raw = msgs([
      { role: "user", content: "\x1b[1mgo\x1b[0m" },
      { role: "assistant", content: [{ type: "text", text: "\x1b[32mok\x1b[0m" }, call("c1", "Bash", { command: "printf '\x1b[2J'" })] },
      result("c1", "\x1b[31mFAIL\x1b[0m\tsuite\r\nprogress 10%\rprogress 100%\x07"),
    ]);
    const { prompt, items } = agentDetailFromMessages(raw);
    expect(prompt).toBe("go");
    expect(items).toEqual([
      { kind: "text", head: "ok", body: [] },
      { kind: "tool", head: "Bash(printf '')", body: ["FAIL   suite", "progress 10%progress 100%"], settled: true },
    ]);
  });
});

describe("createAgentDetailSource", () => {
  const record = (over: Partial<AgentRecord>) => ({ status: "running", ...over }) as AgentRecord;

  it("prefers the record's structured JSON, pretty-printed, over the last text", () => {
    const messages = msgs([{ role: "assistant", content: [{ type: "text", text: "chatter" }] }]);
    const source = createAgentDetailSource(() => record({ session: { messages } as never, structuredJson: '{"a":1}' }));
    expect(source("r")?.outcome).toBe('{\n  "a": 1\n}');
  });

  it("returns undefined for a swept record", () => {
    expect(createAgentDetailSource(() => undefined)("r")).toBeUndefined();
  });

  it("re-folds only when the transcript grows or the status changes", () => {
    const messages = msgs([{ role: "user", content: "p" }]) as unknown[];
    const rec = record({ session: { messages } as never });
    const source = createAgentDetailSource(() => rec);
    const first = source("r");
    expect(source("r")).toBe(first);
    messages.push({ role: "assistant", content: [{ type: "text", text: "more" }] });
    const grown = source("r");
    expect(grown).not.toBe(first);
    expect(grown?.outcome).toBe("more");
    rec.status = "completed";
    expect(source("r")).not.toBe(grown);
  });
});
