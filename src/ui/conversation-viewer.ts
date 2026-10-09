/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import { type AgentSession, getMarkdownTheme, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type ActiveToolCall, type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatMs, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;

/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * The cap is not cosmetic — it bounds render cost. `buildContentLines()` runs on
 * every render *and* on every scroll key (`handleInput` calls it to compute
 * `maxScroll`), so an uncapped 200 KB result costs ~6 ms per keystroke to parse
 * as Markdown, against ~0.5 ms once capped and effectively nothing on a cache
 * hit (best of 5, width 76). 16 KB is roughly a screenful at every terminal size
 * and still ~30x the 500 characters this replaces, which was small enough to cut
 * most real results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;
const TOOL_ARGUMENT_MAX_CHARS = 240;
const TOOL_OUTPUT_TAIL_LINES = 3;
const TOOL_OUTPUT_EXPANDED_MAX_LINES = 16_000;
const TOOL_OUTPUT_RAW_MAX_CHARS = 16_000;
const TOOL_OUTPUT_MAX_BLOCKS = 64;
const TOOL_EXECUTION_MAX_RETAINED = 64;

type ToolCall = { id?: string; name: string; args: unknown };
type ToolOutput = { text: string; expandedText?: string; hasEmbeddedOmission?: boolean; omitted: boolean };
type ToolResultMessage = Extract<AgentSession["messages"][number], { role: "toolResult" }>;
type ToolRange = { id: string; occurrence: number; start: number; end: number };
type ToolHeader = { id: string; occurrence: number; index: number; name: string; args: unknown; isError: boolean; isRunning: boolean };
type ToolRenderContext = {
  lines: string[];
  finalResults: Map<string, ToolResultMessage[]>;
  activeOutputs: Map<string, ToolOutput>;
  callOccurrences: Map<string, number>;
  ranges: ToolRange[];
  headers: ToolHeader[];
  consumedResults: Set<ToolResultMessage>;
  width: number;
};

/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stripUnsafeTerminalSequences(text: string): string {
  let safe = text;
  for (let pass = 0; pass < 4; pass++) {
    const sanitized = safe
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[PX^_][^\x1b\x9c]*(?:\x1b\\|\x9c)/g, "")
      .replace(/[\x90\x98\x9d-\x9f][^\x07\x9c\x90\x98\x9d-\x9f]*(?:\x07|\x9c)/g, "")
      .replace(/(?:\x1b\[|\x9b)[0-?\x00-\x1a\x1c-\x1f\x7f-\x9f]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x06\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, "");
    if (sanitized === safe) break;
    safe = sanitized;
  }
  return safe
    .replace(/\x1b(?![[\]PX^_])[ -/]*[0-~]/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]/g, "");
}

function sanitizedLine(value: unknown): string {
  const raw = Array.isArray(value) ? `[${value.length} items]` : typeof value === "string" ? value : String(value);
  return stripUnsafeTerminalSequences(raw.slice(0, TOOL_ARGUMENT_MAX_CHARS * 4))
    .replace(/\s+/g, " ")
    .trim();
}

function boundedLine(value: unknown, maxChars = TOOL_ARGUMENT_MAX_CHARS): string {
  const line = sanitizedLine(value);
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

function fallbackArguments(args: unknown): string {
  const record = objectRecord(args);
  if (!record) return boundedLine(args);

  const entries = Object.entries(record);
  const parts = entries.slice(0, 4).map(([key, value]) => {
    const summary = typeof value === "string"
      ? JSON.stringify(boundedLine(value, 80))
      : value === null || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : Array.isArray(value) ? `[${value.length} items]` : "{…}";
    return `${JSON.stringify(key)}:${summary}`;
  });
  return boundedLine(`{${parts.join(",")}${entries.length > parts.length ? ",…" : ""}}`);
}

function partialResultText(result: unknown): ToolOutput {
  const content = typeof result === "string" ? [result] : objectRecord(result)?.content;
  if (!Array.isArray(content)) return { text: "", omitted: false };

  const blockText = (block: unknown): string | undefined => {
    const value = typeof block === "string" ? block : objectRecord(block);
    return typeof value === "string"
      ? value
      : value?.type === "text" && typeof value.text === "string" ? value.text : undefined;
  };
  const tailChunks: string[] = [];
  let tailRemaining = TOOL_OUTPUT_RAW_MAX_CHARS;
  const firstTailBlock = Math.max(0, content.length - TOOL_OUTPUT_MAX_BLOCKS);
  let omitted = firstTailBlock > 0;
  for (let i = content.length - 1; i >= firstTailBlock; i--) {
    const text = blockText(content[i]);
    if (text === undefined) continue;
    const separator = tailChunks.length > 0 ? 1 : 0;
    const room = tailRemaining - separator;
    if (room <= 0) {
      omitted = true;
      break;
    }
    const chunk = text.slice(-room);
    tailChunks.unshift(chunk);
    tailRemaining -= chunk.length + separator;
    if (chunk.length < text.length) {
      omitted = true;
      break;
    }
  }
  const sanitize = (text: string) => stripUnsafeTerminalSequences(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
  const tail = sanitize(tailChunks.join("\n"));
  if (!omitted) return { text: tail, expandedText: tail, omitted: false };

  const omission = "... output omitted ...";
  const headLimit = Math.floor((RESULT_MAX_CHARS - omission.length - 2) / 2);
  const headChunks: string[] = [];
  let headRemaining = headLimit;
  const lastHeadBlock = Math.min(content.length, TOOL_OUTPUT_MAX_BLOCKS);
  for (let i = 0; i < lastHeadBlock; i++) {
    const text = blockText(content[i]);
    if (text === undefined) continue;
    const separator = headChunks.length > 0 ? 1 : 0;
    const room = headRemaining - separator;
    if (room <= 0) break;
    const chunk = text.slice(0, room);
    headChunks.push(chunk);
    headRemaining -= chunk.length + separator;
    if (chunk.length < text.length) break;
  }
  const head = sanitize(headChunks.join("\n")).slice(0, headLimit);
  const text = tail || head;
  if (!text || !head || head === tail) return { text, expandedText: text, omitted: !!text };

  const tailLimit = RESULT_MAX_CHARS - head.length - omission.length - 2;
  return {
    text,
    expandedText: `${head}\n${omission}\n${tail.slice(-tailLimit)}`,
    hasEmbeddedOmission: true,
    omitted: true,
  };
}

function indexFinalToolResults(messages: AgentSession["messages"]): Map<string, ToolResultMessage[]> {
  const results = new Map<string, ToolResultMessage[]>();
  for (const message of messages) {
    if (message.role === "toolResult" && message.toolCallId) {
      const calls = results.get(message.toolCallId);
      if (calls) calls.push(message);
      else results.set(message.toolCallId, [message]);
    }
  }
  return results;
}

function parseToolCalls(content: Extract<AgentSession["messages"][number], { role: "assistant" }> ["content"]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    const tool = block as unknown as {
      id?: string; toolCallId?: string; toolUseId?: string; name?: string; toolName?: string; arguments?: unknown; input?: unknown;
    };
    calls.push({
      id: tool.id ?? tool.toolCallId ?? tool.toolUseId,
      name: tool.name ?? tool.toolName ?? "unknown",
      args: tool.arguments ?? tool.input,
    });
  }
  return calls;
}

function toolArgumentLines(toolName: string, args: unknown, width: number, theme: Theme): string[] {
  const record = objectRecord(args);
  if (toolName === "bash" && record?.command !== undefined) {
    return [truncateToWidth(`  $ ${boundedLine(record.command)}`, width)];
  }
  if (record) {
    const primary = ["path", "query", "pattern"].flatMap(key =>
      record[key] === undefined ? [] : [`${key}: ${boundedLine(record[key])}`]);
    return (primary.length > 0 ? primary : [fallbackArguments(args)])
      .map(summary => truncateToWidth(theme.fg("dim", `  ${summary}`), width));
  }
  return args === undefined ? [] : [truncateToWidth(theme.fg("dim", `  ${fallbackArguments(args)}`), width)];
}

function toolOutputLines(
  output: ToolOutput,
  expanded: boolean,
  width: number,
  theme: Theme,
  renderText?: (text: string, width: number) => string[],
): string[] {
  const lines: string[] = [];
  const text = (expanded ? output.expandedText ?? output.text : output.text).trimEnd();
  if (!text) return lines;

  const capped = text.length <= RESULT_MAX_CHARS
    ? { text, elided: 0 }
    : { text: text.slice(-RESULT_MAX_CHARS), elided: text.length - RESULT_MAX_CHARS };
  const lineLimit = expanded ? TOOL_OUTPUT_EXPANDED_MAX_LINES : TOOL_OUTPUT_TAIL_LINES;
  const preview = truncateToVisualLines(capped.text, lineLimit, Math.max(1, width - 4));
  if ((!expanded || !output.hasEmbeddedOmission) && (output.omitted || capped.elided || preview.skippedCount > 0)) {
    const omitted = !output.omitted && capped.elided === 0 && preview.skippedCount > 0
      ? `${preview.skippedCount} earlier line${preview.skippedCount === 1 ? "" : "s"}`
      : "earlier output";
    lines.push(theme.fg("dim", `    ... ${omitted}`));
  }
  const outputLines = renderText
    ? renderText(preview.visualLines.join("\n"), Math.max(1, width - 4))
    : preview.visualLines.map(line => theme.fg("dim", line));
  lines.push(...outputLines.map(line => truncateToWidth(`    ${line}`, width)));
  lines.push(theme.fg("dim", `    ctrl+o to ${expanded ? "collapse" : "expand"}`));
  return lines;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  private activeOutputExpanded = false;
  private isToolOutputAvailable = false;
  private readonly toolExecutions = new Map<string, {
    occurrence: number;
    toolName: string;
    args: unknown;
    startedAt: number;
    partialResult?: ToolOutput;
    result?: ToolOutput;
    isError?: boolean;
  }>();
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;
  private contentDirty = true;
  private stateRevision = 0;
  private activeToolFrameCache: {
    width: number;
    mode: ViewerMarkdownMode;
    status: AgentRecord["status"];
    lines: string[];
    toolRanges: ToolRange[];
    headers: ToolHeader[];
    activeToolCallCount: number;
    messages: AgentSession["messages"];
    messageCount: number;
    stateRevision: number;
    expanded: boolean;
    activeStateSignature: string;
    staticMessageCount: number;
    staticLineCount: number;
    staticLastMessage: object | undefined;
    staticFinalResults: Map<string, ToolResultMessage[]>;
    staticPairedResults: Set<ToolResultMessage>;
    staticCallOccurrences: Map<string, number>;
    staticToolRanges: ToolRange[];
    isStaticToolOutputAvailable: boolean;
  } | undefined;
  /**
   * One `Markdown` per message, so its own text/width cache does the work. A
   * fresh instance per render would re-parse the whole transcript on every
   * keystroke — the component caches, but only across calls to the same object.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly markdownCache = new WeakMap<object, {
    md: Markdown;
    text: string;
    failed?: boolean;
    renderedWidth?: number;
    renderedLines?: string[];
  }>();
  private readonly rawLineCache = new WeakMap<object, { text: string; width: number; dim: boolean; lines: string[] }>();
  private readonly partialResultCache = new WeakMap<ActiveToolCall, {
    source: unknown;
    value: ToolOutput;
  }>();
  private readonly finalToolResultCache = new WeakMap<ToolResultMessage, ToolOutput>();
  private readonly toolOutputLineCache = new WeakMap<ToolOutput, {
    width: number;
    expanded: boolean;
    mode: ViewerMarkdownMode;
    lines: string[];
  }>();
  private readonly finalToolResultCounts = new Map<string, number>();
  private finalToolResultMessages: AgentSession["messages"] | undefined;
  private finalToolResultFirstMessage: object | undefined;
  private finalToolResultLastMessage: object | undefined;
  private finalToolResultMessageCount = 0;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
  ) {
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.isToolOutputAvailable = false;
    this.unsubscribe = session.subscribe((event) => {
      if (this.closed) return;
      this.contentDirty = true;
      this.stateRevision++;
      if (event.type === "tool_execution_start") {
        const occurrence = this.currentFinalToolResultCount(event.toolCallId);
        this.toolExecutions.set(event.toolCallId, {
          occurrence,
          toolName: event.toolName,
          args: event.args,
          startedAt: Date.now(),
        });
        this.pruneCompletedToolExecutions();
        this.ensureElapsedTimer();
      }
      if (event.type === "tool_execution_update") {
        const execution = this.toolExecutions.get(event.toolCallId);
        const occurrence = execution?.result === undefined && execution !== undefined
          ? execution.occurrence
          : this.finalToolResultCount(event.toolCallId);
        if (execution?.occurrence === occurrence) {
          execution.toolName = event.toolName;
          execution.args = event.args;
          execution.partialResult = partialResultText(event.partialResult);
        } else {
          this.toolExecutions.set(event.toolCallId, {
            occurrence,
            toolName: event.toolName,
            args: event.args,
            startedAt: Date.now(),
            partialResult: partialResultText(event.partialResult),
          });
        }
        this.pruneCompletedToolExecutions();
      }
      if (event.type === "tool_execution_end") {
        const execution = this.toolExecutions.get(event.toolCallId);
        const occurrence = execution?.result === undefined && execution !== undefined
          ? execution.occurrence
          : this.finalToolResultCount(event.toolCallId);
        if (execution?.occurrence === occurrence) {
          execution.result = partialResultText(event.result);
          execution.isError = event.isError;
        } else this.toolExecutions.set(event.toolCallId, {
          occurrence,
          toolName: event.toolName,
          args: undefined,
          startedAt: Date.now(),
          result: partialResultText(event.result),
          isError: event.isError,
        });
        this.pruneCompletedToolExecutions();
        this.syncElapsedTimer();
      }
      this.tui.requestRender();
    });
    this.syncFinalToolResultCounts();
    this.syncElapsedTimer();
  }

  handleInput(data: string): void {
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    // Cycle raw → assistant-only → everything. The escape hatch that makes
    // Markdown rendering safe to default on: a result the renderer reshapes
    // (a diff, an indented log, a `#`-commented script) is one key from verbatim.
    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.contentDirty = true;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+o")) {
      this.stopArmed = false;
      if (!this.isToolOutputAvailable && this.lastInnerW > 0) this.buildContentFrame(this.lastInnerW);
      if (!this.isToolOutputAvailable && this.lastInnerW === 0) {
        const pairedIds = new Set(this.session.messages.flatMap(message =>
          message.role === "assistant" ? parseToolCalls(message.content).flatMap(call => call.id ?? []) : []));
        this.isToolOutputAvailable = this.session.messages.some(message =>
          message.role === "toolResult"
          && !!message.toolCallId
          && pairedIds.has(message.toolCallId)
          && !!this.finalToolResultText(message).text.trimEnd())
          || [...(this.activity?.activeToolCalls.values() ?? [])].some(call => !!this.partialText(call).text.trimEnd());
      }
      if (!this.isToolOutputAvailable) return;
      const before = this.buildContentFrame(this.lastInnerW);
      const anchor = before.toolRanges.find(range => range.start <= this.scrollOffset && this.scrollOffset < range.end)
        ?? before.toolRanges.find(range => range.start >= this.scrollOffset);
      const screenOffset = anchor ? anchor.start - this.scrollOffset : 0;
      this.activeOutputExpanded = !this.activeOutputExpanded;
      this.contentDirty = true;
      if (anchor) {
        const after = this.buildContentFrame(this.lastInnerW);
        const next = after.toolRanges.find(range => range.id === anchor.id && range.occurrence === anchor.occurrence);
        if (next) {
          const maxScroll = Math.max(0, after.lines.length - this.viewportHeight());
          this.scrollOffset = Math.min(maxScroll, Math.max(0, next.start - screenOffset));
        }
      }
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);

    lines.push(row(
      `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);

    // Content area — rebuild every render (live data, no cache needed)
    const contentLines = this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer
    lines.push(hrMid);
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      const actions: string[] = [];
      if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
      if (this.isStoppable()) {
        actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
      }
      // Abbreviated (`raw`/`md`/`md+`) because the idle footer is already full
      // at 80 columns with steer + stop present, and this group has no
      // degradation step below "drop the line-count readout".
      actions.push(th.fg("dim", `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`));
      if (this.isToolOutputAvailable) {
        actions.push(th.fg("dim", `ctrl+o ${this.activeOutputExpanded ? "compact" : "expand"}`));
      }
      const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
      const scrollPct = contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
      const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** The mode in force: an `m` press, else the setting, else the default. */
  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  private cachedRawLines(msg: object, text: string, width: number, dim: boolean): string[] {
    const cached = this.rawLineCache.get(msg);
    if (cached && cached.text === text && cached.width === width && cached.dim === dim) return cached.lines;
    const lines = this.rawLines(text, width, dim).map(line => truncateToWidth(line, width));
    this.rawLineCache.set(msg, { text, width, dim, lines });
    return lines;
  }

  private partialText(call: ActiveToolCall): ToolOutput {
    const cached = this.partialResultCache.get(call);
    if (!this.contentDirty && cached && cached.source === call.partialResult) return cached.value;
    const value = partialResultText(call.partialResult);
    this.partialResultCache.set(call, { source: call.partialResult, value });
    return value;
  }

  private finalToolResultText(result: ToolResultMessage): ToolOutput {
    const cached = this.finalToolResultCache.get(result);
    if (cached) return cached;
    const output = partialResultText(result);
    this.finalToolResultCache.set(result, output);
    return output;
  }

  private cachedToolOutputLines(output: ToolOutput, width: number, result?: ToolResultMessage): string[] {
    const mode = this.markdownMode();
    const cached = this.toolOutputLineCache.get(output);
    if (cached && cached.width === width && cached.expanded === this.activeOutputExpanded && cached.mode === mode) return cached.lines;
    const renderText = result && mode === "all"
      ? (text: string, innerWidth: number) => this.markdownLines(result, text, innerWidth, true)
      : undefined;
    const lines = toolOutputLines(output, this.activeOutputExpanded, width, this.theme, renderText);
    this.toolOutputLineCache.set(output, { width, expanded: this.activeOutputExpanded, mode, lines });
    return lines;
  }

  private markdownLines(msg: AgentSession["messages"][number], text: string, width: number, dim: boolean): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          // Keeps result prose visually receded, the way the raw path's
          // per-line `fg("dim", …)` did. Fenced code is the exception and is
          // left alone deliberately: pi's theme highlights it with its own
          // colors, which this would otherwise flatten.
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      // Streaming: the message object is stable, its text grows. A failed
      // prefix remains unsafe after append-only deltas, so retry only when the
      // content was replaced or truncated.
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      entry.renderedWidth = undefined;
      entry.renderedLines = undefined;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.cachedRawLines(msg, text, width, dim);
    if (entry.renderedWidth === width && entry.renderedLines) return entry.renderedLines;

    try {
      const lines = entry.md.render(width);
      entry.renderedWidth = width;
      entry.renderedLines = lines;
      return lines;
    } catch {
      // The parser is recursive and this is arbitrary tool output: ~54 nested
      // blockquotes overflow the stack, and no amount of fuzzing proves that is
      // the only such input. `render()` is on the TUI's critical path, so a
      // throw here takes the overlay down for content the literal path shows
      // fine — degrade to that instead, and remember, since the throw would
      // otherwise repeat on every render and every scroll key.
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Open the inline steering composer and route subsequent input to it. */
  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void { /* no cached state to clear */ }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    this.clearElapsedTimer();
  }

  // ---- Private ----

  private hasActiveToolCalls(): boolean {
    return this.record.status === "running" && ((this.activity?.activeToolCalls.size ?? 0) > 0 || [...this.toolExecutions.values()].some(execution => execution.result === undefined));
  }

  private pruneCompletedToolExecutions(): void {
    while (this.toolExecutions.size > TOOL_EXECUTION_MAX_RETAINED) {
      const entries = [...this.toolExecutions];
      const evicted = entries.find(([, execution]) => execution.result !== undefined)
        ?? entries.find(([id]) => !this.activity?.activeToolCalls.has(id))
        ?? entries[0];
      this.toolExecutions.delete(evicted[0]);
    }
  }

  private ensureElapsedTimer(): void {
    if (this.elapsedTimer || this.record.status !== "running" || !this.hasActiveToolCalls()) return;
    this.elapsedTimer = setInterval(() => {
      if (this.closed || this.record.status !== "running" || !this.hasActiveToolCalls()) {
        this.clearElapsedTimer();
        return;
      }
      this.tui.requestRender();
    }, 100);
  }

  private clearElapsedTimer(): void {
    if (!this.elapsedTimer) return;
    clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }

  private syncElapsedTimer(): void {
    if (this.hasActiveToolCalls() && this.record.status === "running") this.ensureElapsedTimer();
    else this.clearElapsedTimer();
  }

  private finalToolResultCount(id: string): number {
    this.syncFinalToolResultCounts();
    return this.finalToolResultCounts.get(id) ?? 0;
  }

  private currentFinalToolResultCount(id: string): number {
    const messages = this.session.messages;
    this.finalToolResultCounts.clear();
    for (const message of messages) {
      if (message.role === "toolResult" && message.toolCallId) {
        this.finalToolResultCounts.set(message.toolCallId, (this.finalToolResultCounts.get(message.toolCallId) ?? 0) + 1);
      }
    }
    this.finalToolResultMessages = messages;
    this.finalToolResultFirstMessage = messages[0];
    this.finalToolResultLastMessage = messages[messages.length - 1];
    this.finalToolResultMessageCount = messages.length;
    return this.finalToolResultCounts.get(id) ?? 0;
  }

  private syncFinalToolResultCounts(): void {
    const messages = this.session.messages;
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const isSameLengthReplacement = messages === this.finalToolResultMessages
      && messages.length === this.finalToolResultMessageCount
      && (firstMessage !== this.finalToolResultFirstMessage
        || lastMessage !== this.finalToolResultLastMessage);
    if (messages !== this.finalToolResultMessages
      || messages.length < this.finalToolResultMessageCount
      || isSameLengthReplacement) {
      this.finalToolResultCounts.clear();
      this.finalToolResultMessages = messages;
      this.finalToolResultMessageCount = 0;
    }
    for (; this.finalToolResultMessageCount < messages.length; this.finalToolResultMessageCount++) {
      const message = messages[this.finalToolResultMessageCount];
      if (message.role === "toolResult" && message.toolCallId) {
        this.finalToolResultCounts.set(message.toolCallId, (this.finalToolResultCounts.get(message.toolCallId) ?? 0) + 1);
      }
    }
    this.finalToolResultFirstMessage = firstMessage;
    this.finalToolResultLastMessage = lastMessage;
  }

  private activeHeader(call: ActiveToolCall, width: number): string {
    const args = objectRecord(call.args);
    const timeout = call.toolName === "bash"
      ? typeof args?.timeout === "number" ? `timeout ${args.timeout}s` : "no timeout"
      : undefined;
    const parts = [
      boundedLine(call.toolName),
      formatMs(Math.max(0, Date.now() - call.startedAt)),
      timeout,
    ].filter((part): part is string => !!part);
    return truncateToWidth(this.theme.fg("muted", `  [Tool: ${parts.join(" · ")}]`), width);
  }

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The composer adds one row above the footer hint while it's open.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.composer ? 1 : 0);
  }

  private invocationLine(): string | undefined {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = model ? [model, ...tags] : tags;
    if (parts.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${parts.join(" · ")}`);
  }

  private renderToolBlock(id: string, name: string, args: unknown, context: ToolRenderContext): void {
    const occurrence = context.callOccurrences.get(id) ?? 0;
    context.callOccurrences.set(id, occurrence + 1);
    const result = context.finalResults.get(id)?.[occurrence];
    const active = result === undefined ? this.activity?.activeToolCalls.get(id) : undefined;
    const candidate = this.toolExecutions.get(id);
    const execution = candidate?.occurrence === occurrence ? candidate : undefined;
    const toolName = execution?.toolName ?? active?.toolName ?? name;
    const toolArgs = execution?.args ?? active?.args ?? args;
    const output = result !== undefined
      ? this.finalToolResultText(result)
      : execution?.result !== undefined
        ? execution.result
        : execution?.partialResult !== undefined
          ? execution.partialResult
          : active
            ? context.activeOutputs.get(id) ?? this.partialText(active)
            : { text: "", omitted: false };
    const isError = result?.isError === true || execution?.isError === true;
    if (output.text.trimEnd()) this.isToolOutputAvailable = true;
    const isRunning = result === undefined && execution?.result === undefined && this.record.status === "running";
    const startedAt = execution?.startedAt ?? active?.startedAt;
    const displayToolName = boundedLine(toolName);
    const heading = isRunning && startedAt !== undefined
      ? this.activeHeader({ toolName, args: toolArgs, startedAt }, context.width)
      : truncateToWidth(this.theme.fg(isError ? "error" : "muted", `  [Tool: ${displayToolName}${isError ? " · error" : ""}]`), context.width);
    const start = context.lines.length;
    context.lines.push(heading);
    context.headers.push({ id, occurrence, index: context.lines.length - 1, name: displayToolName, args: toolArgs, isError, isRunning });
    context.lines.push(...toolArgumentLines(toolName, toolArgs, context.width, this.theme));
    context.lines.push(...this.cachedToolOutputLines(output, context.width, result));
    context.ranges.push({ id, occurrence, start, end: context.lines.length });
    if (result) {
      context.consumedResults.add(result);
      if (this.toolExecutions.get(id) === execution) this.toolExecutions.delete(id);
    }
  }

  private buildContentLines(width: number): string[] {
    return this.buildContentFrame(width).lines;
  }

  private buildContentFrame(width: number): {
    lines: string[];
    toolRanges: ToolRange[];
  } {
    if (width <= 0) return { lines: [], toolRanges: [] };

    const th = this.theme;
    const mode = this.markdownMode();
    const messages = this.session.messages;
    const activeToolCallCount = this.activity?.activeToolCalls.size ?? 0;
    const cache = this.activeToolFrameCache;
    const staticPairingChanged = cache !== undefined && messages.slice(cache.messageCount).some(message =>
      message.role === "toolResult"
      && !!message.toolCallId
      && (cache.staticFinalResults.get(message.toolCallId)?.length ?? 0) < (cache.staticCallOccurrences.get(message.toolCallId) ?? 0));
    const activeOutputs = new Map<string, ToolOutput>();
    const activeStateSignature = this.contentDirty
      ? [...(this.activity?.activeToolCalls ?? new Map<string, ActiveToolCall>())].map(([id, call]) => {
        const output = this.partialText(call);
        activeOutputs.set(id, output);
        return `${id}:${call.toolName}:${String(call.args)}:${output.text}:${output.omitted}`;
      }).join("\u0000")
      : cache?.activeStateSignature;
    const isCacheCompatible = !staticPairingChanged && this.hasActiveToolCalls() && cache?.width === width && cache.mode === mode
      && cache.status === this.record.status && cache.activeToolCallCount === activeToolCallCount
      && cache.messages === messages
      && cache.expanded === this.activeOutputExpanded
      && cache.staticMessageCount <= messages.length
      && (cache.staticMessageCount === 0 || messages[cache.staticMessageCount - 1] === cache.staticLastMessage);
    if (isCacheCompatible && !this.contentDirty && cache.messageCount === messages.length
      && cache.stateRevision === this.stateRevision && cache.activeStateSignature === activeStateSignature) {
      for (const header of cache.headers) this.refreshToolHeader(cache.lines, header, width);
      return { lines: cache.lines, toolRanges: cache.toolRanges };
    }

    if (messages.length === 0) {
      this.isToolOutputAvailable = false;
      return { lines: [th.fg("dim", "(waiting for first message...)")], toolRanges: [] };
    }

    const isRebuildingSuffix = isCacheCompatible;
    const isPairingIndexCurrent = isRebuildingSuffix && cache.messageCount === messages.length;
    const finalResults = isPairingIndexCurrent ? cache.staticFinalResults : indexFinalToolResults(messages);
    const pairedResults = isPairingIndexCurrent ? cache.staticPairedResults : new Set<ToolResultMessage>();
    const callCounts = new Map<string, number>();
    if (!isPairingIndexCurrent) {
      for (const message of messages) {
        if (message.role !== "assistant") continue;
        for (const call of parseToolCalls(message.content)) {
          if (call.id) callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
        }
      }
      for (const [id, count] of callCounts) {
        for (const result of finalResults.get(id)?.slice(0, count) ?? []) pairedResults.add(result);
      }
    }

    const lines = isRebuildingSuffix ? cache.lines : [];
    const toolRanges = isRebuildingSuffix ? cache.toolRanges : [];
    if (isRebuildingSuffix) {
      lines.length = cache.staticLineCount;
      toolRanges.length = cache.staticToolRanges.length;
    }
    const toolHeaders: ToolHeader[] = [];
    const toolContext: ToolRenderContext = {
      lines,
      finalResults,
      activeOutputs,
      callOccurrences: isRebuildingSuffix ? new Map(cache.staticCallOccurrences) : new Map(),
      ranges: toolRanges,
      headers: toolHeaders,
      consumedResults: pairedResults,
      width,
    };
    let needsSeparator = isRebuildingSuffix ? cache.staticLineCount > 0 : false;
    let staticMessageCount = isRebuildingSuffix ? cache.staticMessageCount : messages.length;
    let staticLineCount = isRebuildingSuffix ? cache.staticLineCount : 0;
    let staticLastMessage = isRebuildingSuffix ? cache.staticLastMessage : undefined;
    let staticToolRanges = isRebuildingSuffix ? cache.staticToolRanges : [] as ToolRange[];
    let staticCallOccurrences = isRebuildingSuffix ? cache.staticCallOccurrences : new Map<string, number>();
    let isStaticToolOutputAvailable = isRebuildingSuffix ? cache.isStaticToolOutputAvailable : false;
    const activeIds = new Set<string>([
      ...(this.activity?.activeToolCalls.keys() ?? []),
      ...[...this.toolExecutions].filter(([, execution]) => execution.result === undefined).map(([id]) => id),
    ]);
    const startMessage = isRebuildingSuffix ? cache.staticMessageCount : 0;
    this.isToolOutputAvailable = isRebuildingSuffix ? cache.isStaticToolOutputAvailable : false;

    for (let messageIndex = startMessage; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex];
      if (!isRebuildingSuffix && staticMessageCount === messages.length && message.role === "assistant"
        && parseToolCalls(message.content).some(call => call.id !== undefined && activeIds.has(call.id))) {
        staticMessageCount = messageIndex;
        staticLineCount = lines.length;
        staticLastMessage = messages[messageIndex - 1];
        staticToolRanges = [...toolRanges];
        staticCallOccurrences = new Map(toolContext.callOccurrences);
        isStaticToolOutputAvailable = this.isToolOutputAvailable;
      }
      if (message.role === "user") {
        const text = typeof message.content === "string" ? message.content : extractText(message.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        lines.push(...this.cachedRawLines(message, text.trim(), width, false));
        needsSeparator = true;
      } else if (message.role === "assistant") {
        const textParts = message.content.flatMap(content => content.type === "text" && content.text ? [content.text] : []);
        const toolCalls = parseToolCalls(message.content);
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          const text = textParts.join("\n").trim();
          lines.push(...(mode === "off" ? this.cachedRawLines(message, text, width, false) : this.markdownLines(message, text, width, false)));
        }
        for (const toolCall of toolCalls) {
          if (toolCall.id) this.renderToolBlock(toolCall.id, toolCall.name, toolCall.args, toolContext);
          else lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${boundedLine(toolCall.name)}]`), width));
        }
        needsSeparator = true;
      } else if (message.role === "toolResult") {
        if (toolContext.consumedResults.has(message)) continue;
        const { text, elided } = capResult(stripUnsafeTerminalSequences(extractText(message.content)).trim());
        if (!text) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        lines.push(...(mode === "all" ? this.markdownLines(message, text, width, true) : this.cachedRawLines(message, text, width, true)));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        needsSeparator = true;
      } else if ((message as { role?: string }).role === "bashExecution") {
        const bash = message as unknown as { command: string; output?: string };
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${boundedLine(bash.command)}`), width));
        if (bash.output?.trim()) {
          const { text, elided } = capResult(stripUnsafeTerminalSequences(bash.output).trim());
          lines.push(...this.cachedRawLines(message, text, width, true));
          if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        }
        needsSeparator = true;
      }
    }

    if (this.record.status === "running" && this.activity) {
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", describeActivity(this.activity.activeTools, this.activity.responseText)), width));
    }
    const clampStart = isRebuildingSuffix ? staticLineCount : 0;
    for (let i = clampStart; i < lines.length; i++) lines[i] = truncateToWidth(lines[i], width);
    const frame = { lines, toolRanges };
    if (this.hasActiveToolCalls()) {
      this.activeToolFrameCache = {
        ...frame,
        width,
        mode,
        status: this.record.status,
        headers: toolHeaders,
        activeToolCallCount,
        messages,
        messageCount: messages.length,
        stateRevision: this.stateRevision,
        expanded: this.activeOutputExpanded,
        activeStateSignature: activeStateSignature ?? "",
        staticMessageCount,
        staticLineCount,
        staticLastMessage,
        staticFinalResults: finalResults,
        staticPairedResults: pairedResults,
        staticCallOccurrences,
        staticToolRanges,
        isStaticToolOutputAvailable,
      };
      this.contentDirty = false;
    } else this.activeToolFrameCache = undefined;
    return frame;
  }

  private refreshToolHeader(lines: string[], header: ToolHeader, width: number): void {
    const active = this.activity?.activeToolCalls.get(header.id);
    const candidate = this.toolExecutions.get(header.id);
    const execution = candidate?.occurrence === header.occurrence ? candidate : undefined;
    const startedAt = execution?.startedAt ?? active?.startedAt;
    lines[header.index] = header.isRunning && this.record.status === "running" && startedAt !== undefined
      ? this.activeHeader({ toolName: execution?.toolName ?? active?.toolName ?? header.name, args: execution?.args ?? active?.args ?? header.args, startedAt }, width)
      : truncateToWidth(this.theme.fg(header.isError ? "error" : "muted", `  [Tool: ${header.name}${header.isError ? " · error" : ""}]`), width);
  }

}
