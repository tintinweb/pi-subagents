/**
 * agent-detail.ts — a workflow child's transcript, flattened for the inspector.
 *
 * The progress log carries only a tool-call count and 200-character previews;
 * the child's session holds the full prompt, every call and result, and the
 * final answer. This folds that session into plain text the dialog's pure
 * layout can arrange, so the Activity section can list calls (`Bash(ls -la)`)
 * and expand into a transcript without the dialog knowing about sessions.
 *
 * Plain text on purpose: pi's tool renderers produce styled rows that the
 * dialog's segment layout cannot clamp or scroll. The conversation viewer
 * (`c` in the dialog) remains the place for those.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { extractText } from "../context.js";

type AgentMessage = AgentSession["messages"][number];

export interface AgentDetailItem {
  kind: "text" | "tool";
  /** A text block's first line, or a call's `Name(summary)`. */
  head: string;
  /** The rest of a text block, or the call's result lines. */
  body: string[];
  /** Tool items only: whether a result has arrived, and whether it failed. */
  settled?: boolean;
  isError?: boolean;
}

export interface AgentDetail {
  prompt?: string;
  outcome?: string;
  items: AgentDetailItem[];
}

/**
 * Argument keys whose value names what a call is doing, most telling first. A
 * search's pattern outranks its path: `Grep(foo)` says what it looked for,
 * `Grep(src)` only where.
 */
const SUMMARY_KEYS = ["command", "pattern", "query", "url", "file_path", "path", "description", "prompt"] as const;

/** `cat a && cat b` from a multi-line argument: whitespace collapsed to one line. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** `Name(summary)` — the argument that says what the call does, on one line. */
export function toolCallHead(name: string, args: unknown): string {
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const value =
    SUMMARY_KEYS.map(key => record[key]).find((v): v is string => typeof v === "string" && v.trim() !== "")
    ?? Object.values(record).find((v): v is string => typeof v === "string" && v.trim() !== "");
  return value === undefined ? name : `${name}(${oneLine(displayText(value))})`;
}

/**
 * Text made safe to place in a layout, as pi's tool renderers make it: tool
 * output is stored raw, so a coloured test run or a `\r` progress line would
 * otherwise reach the terminal — a reset cancels the row's dim, a carriage
 * return draws over the left pane, a tab overruns the width the layout
 * measured (pi-tui counts it as three cells).
 */
export function displayText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r/g, "")
    .replace(/\t/g, "   ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

const splitLines = (text: string) => (text === "" ? [] : text.split("\n"));

/**
 * Fold a session's messages into prompt, transcript items and outcome.
 *
 * `prompt` is the first user message; `outcome` is the last assistant text,
 * which is what the child answered. A result is paired to its call by id, as
 * the conversation viewer pairs them; one whose call is not in the
 * transcript (a compacted prefix) is dropped, since there is no row to hang
 * it from.
 */
export function agentDetailFromMessages(messages: readonly AgentMessage[]): AgentDetail {
  const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
  for (const msg of messages) {
    if (msg.role === "toolResult") results.set(msg.toolCallId, msg);
  }

  let prompt: string | undefined;
  let outcome: string | undefined;
  const items: AgentDetailItem[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      if (prompt !== undefined) continue;
      const text = displayText(typeof msg.content === "string" ? msg.content : extractText(msg.content)).trim();
      if (text) prompt = text;
    } else if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          const text = displayText(part.text).trim();
          if (!text) continue;
          const [head, ...body] = text.split("\n");
          items.push({ kind: "text", head, body });
          outcome = text;
        } else if (part.type === "toolCall") {
          const result = results.get(part.id);
          items.push({
            kind: "tool",
            head: toolCallHead(part.name, part.arguments),
            body: result ? splitLines(displayText(extractText(result.content)).trimEnd()) : [],
            settled: result !== undefined,
            ...(result?.isError ? { isError: true } : {}),
          });
        }
      }
    }
  }
  return { ...(prompt !== undefined ? { prompt } : {}), ...(outcome !== undefined ? { outcome } : {}), items };
}
