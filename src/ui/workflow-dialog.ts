/**
 * workflow-dialog.ts — the `/agents → Workflows` two-pane inspector.
 *
 * ```
 *  review-changes
 *  Review changed files across dimensions              3/7 agents · 1m12s
 *
 *  ╭ Phases ──────────┬ Verify · 1 agent ──────────────────────────────╮
 *  │ ❯ ✔ Review   3/3 │ ❯ ◌ verify:auth.ts · attempt 2 · waiting 8s    │
 *  │   2 Verify   1/2 │                                                │
 *  │   3 Report       │                                                │
 *  ╰──────────────────┴────────────────────────────────────────────────╯
 *  ↑↓ select · ⏎ open · f filter · x stop · esc close
 * ```
 *
 * Opening an agent swaps the panes: that phase's agents move left and the
 * right becomes the agent's Prompt / Activity / Outcome detail.
 *
 * A phase with no agents yet shows its number and nothing else. The single-pane
 * layout this replaced spelled that out as "Not started yet"; the left pane is
 * too narrow to hold the words, and a numbered row with no count says it.
 *
 * **The glyphs are not the card's glyphs.** `workflow-card.ts` keys off the raw
 * entry `state`; this file keys off the *derived* `displayState(entry, active)`
 * and splits cases the card cannot see — skipped, blocked, queued and
 * interrupted all render as a plain ✘ or ⟳ inline but are distinct here. `◌`
 * (U+25CC) appears only in this file, and a running row animates a spinner where
 * the card draws a static `⟳`.
 *
 * **The phases pane is stranger still**: a phase that has not finished shows
 * *its number*, not a glyph. That is deliberate, recovered behaviour.
 *
 * **The layout is pure.** `layoutWorkflowDialog` returns coloured segments and
 * `handleWorkflowDialogKey` maps a keypress to the next state plus an optional
 * action; neither touches a theme, a terminal, or the workflow runtime. The
 * `WorkflowDialog` component is the thin shell that wires those to `ctx.ui`, and
 * the runtime side arrives as an injected `WorkflowDialogActions`.
 *
 * All state derivation lives in `src/workflow/progress.ts`; this file only
 * arranges what that module returns.
 */

import {
  type Component,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  buildPhaseGroups,
  displayState,
  formatDuration,
  header,
  isLive,
  type PhaseGroup,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowEntry,
} from "../workflow/progress.js";
import { SPINNER, type Theme } from "./agent-widget.js";
import {
  ASCII_GLYPHS,
  clampLine,
  formatCompactTokens,
  formatModel,
  REPLAYED_ANNOTATION,
  styleWorkflowCardLines,
  UNICODE_GLYPHS,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
  type WorkflowCardTask,
} from "./workflow-card.js";

/** Fallback width when the caller does not know the terminal's. */
const DEFAULT_WIDTH = 80;


/** Inner width of the left pane at any comfortable terminal size. */
const LEFT_PANE_WIDTH = 18;

/**
 * Most rows the frame will ever draw between its top and bottom edges.
 *
 * A cap, not a height: the box sizes itself to what it holds, and this is where
 * it stops growing so a 200-agent fan-out scrolls inside the pane instead of
 * pasting 200 rows into the conversation.
 */
export const DEFAULT_PANE_BODY_ROWS = 22;
/**
 * Fewest rows the frame will draw.
 *
 * Below this a pane stops reading as a pane, and the box would resize on
 * nearly every keypress — most phases hold a handful of agents, so a floor here
 * absorbs the ordinary movement and leaves the height alone.
 */
export const MIN_PANE_BODY_ROWS = 6;
/** Prompt lines shown before `expand` is offered. */
export const PROMPT_COLLAPSED_LINES = 4;
/** Spinner cadence. Unlike the card's 1s header tick, this row really animates. */
export const WORKFLOW_DIALOG_SPINNER_MS = 80;

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowDialogGlyphs {
  tick: string;
  cross: string;
  /** `◌` — queued or interrupted. The card has no row that draws this. */
  queued: string;
  /** `figures.pointer` — the selected row in either pane. */
  pointer: string;
  /** Marks whichever pane currently owns j/k. */
  focus: string;
  /** Running rows cycle these. */
  spinner: readonly string[];
  /** The pane frame: corners, edges and the tee where the two panes meet. */
  box: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    topTee: string;
    bottomTee: string;
  };
  /** Trailing marker on a title the pane was too narrow to hold. */
  ellipsis: string;
  /** How the footer names the arrow keys and Enter. */
  upDown: string;
  enter: string;
}

export const UNICODE_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: UNICODE_GLYPHS.tick,
  cross: UNICODE_GLYPHS.cross,
  queued: "◌",
  pointer: "❯",
  focus: UNICODE_GLYPHS.pointer,
  spinner: SPINNER,
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    topTee: "┬",
    bottomTee: "┴",
  },
  ellipsis: "…",
  upDown: "↑↓",
  enter: "⏎",
};

/** The ASCII tier, one column per glyph so the panes stay aligned either way. */
export const ASCII_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: ASCII_GLYPHS.tick,
  cross: ASCII_GLYPHS.cross,
  queued: "o",
  pointer: ">",
  focus: ASCII_GLYPHS.pointer,
  spinner: ["-", "\\", "|", "/"],
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    topTee: "+",
    bottomTee: "+",
  },
  ellipsis: "~",
  upDown: "up/down",
  enter: "enter",
};

/**
 * The recovered dialog mapping — keyed on the *display* state.
 *
 * Claude Code's `permission` colour has no pi equivalent; a blocked agent is
 * waiting on the user, so it maps to `warning` (selection maps to `accent`).
 */
export function dialogRowGlyph(
  state: WorkflowDisplayState,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame = 0,
): WorkflowCardSegment {
  switch (state) {
    case "done":
      return { text: glyphs.tick, color: "success" };
    case "failed":
      return { text: glyphs.cross, color: "error" };
    case "skipped":
      return { text: glyphs.cross, color: "dim" };
    case "blocked":
      return { text: glyphs.cross, color: "warning" };
    case "queued":
    case "interrupted":
      return { text: glyphs.queued, color: "dim" };
    case "running":
      return { text: glyphs.spinner[spinnerFrame % glyphs.spinner.length], color: "dim" };
  }
}

/* ------------------------------------------------------------------------- *
 * Verbatim copy
 * ------------------------------------------------------------------------- */

/**
 * Claude Code's own strings. Kept together and named so a reader can see at a
 * glance which surface each belongs to, and so none drifts under an edit.
 */
export const WORKFLOW_DIALOG_COPY = {
  waitingForSlot: "Waiting for an agent slot.",
  availableOnceStarted: "Available once the agent starts.",
  notAvailableYet: "Not available yet (agent still running).",
  noTranscript: "Transcript not available.",
  stoppedEarly: "The workflow stopped before this agent finished.",
  skippedByUser: "Skipped by user.",
  noToolCallsYet: "No tool calls yet.",
  noToolCalls: "No tool calls.",
  noAgents: "No agents",
} as const;

/* ------------------------------------------------------------------------- *
 * State
 * ------------------------------------------------------------------------- */

/**
 * Which of the two drill-down levels is showing.
 *
 * `phases` is the overview — phases on the left, the selected phase's agents on
 * the right. `agent` is the subview reached by opening one: the same phase's
 * agents move to the left pane and the right pane becomes that agent's detail.
 * The panes never change count, only what they hold, which is what makes the
 * frame stay put as you drill in and back out.
 */
export type WorkflowDialogLevel = "phases" | "agent";

/** `all`, or exactly one display state. */
export type WorkflowDialogFilter = "all" | WorkflowDisplayState;

/** The order `f` cycles through. */
export const WORKFLOW_DIALOG_FILTERS: readonly WorkflowDialogFilter[] = [
  "all",
  "running",
  "queued",
  "done",
  "failed",
  "blocked",
  "skipped",
  "interrupted",
];

export interface WorkflowDialogState {
  /** Raw selection; `clampedPhase` is what actually renders. */
  selectedPhase: number;
  selectedAgent: number;
  level: WorkflowDialogLevel;
  filter: WorkflowDialogFilter;
  promptExpanded: boolean;
}

export function initialWorkflowDialogState(initialPhaseIndex = 0): WorkflowDialogState {
  return {
    selectedPhase: initialPhaseIndex,
    selectedAgent: 0,
    level: "phases",
    filter: "all",
    promptExpanded: false,
  };
}

/** Everything the dialog reads about a run, so it can be driven from a stub. */
export interface WorkflowDialogSource {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that reported. */
  agentCount?: number;
}

export interface WorkflowDialogInput extends WorkflowDialogSource {
  state: WorkflowDialogState;
  /**
   * Which actions the caller actually wired. Absent keys default to available,
   * so layout tests and read-only callers keep the full footer; a caller that
   * wires only some actions passes the map so the hints stay truthful.
   */
  available?: Partial<Record<keyof WorkflowDialogActions, boolean>>;
  now?: number;
  /** The *terminal* width; the content width is derived from it. */
  width?: number;
  ascii?: boolean;
  spinnerFrame?: number;
  /**
   * Most rows the frame may use, overriding {@link DEFAULT_PANE_BODY_ROWS}.
   *
   * The frame still sizes to its content and still respects
   * {@link MIN_PANE_BODY_ROWS}; this only moves the ceiling.
   */
  bodyRows?: number;
}

/** The actions the dialog needs from the workflow runtime, injected. */
export interface WorkflowDialogActions {
  onKill?(): void;
  onPause?(): void;
  onResume?(): void;
  /** `index` is the entry's stable `index`, not its row position. */
  onSkipAgent?(index: number): void;
  onRetryAgent?(index: number): void;
}

export type WorkflowDialogAction =
  | { kind: "cancel" }
  | { kind: "kill" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip"; index: number }
  | { kind: "retry"; index: number };

export interface ResolvedWorkflowDialog {
  groups: PhaseGroup[];
  clampedPhase: number;
  clampedAgent: number;
  /** The selected phase's agents, after the state filter. */
  visibleAgents: WorkflowAgentEntry[];
  selectedEntry: WorkflowAgentEntry | undefined;
  /** False once the run stops — which is what turns live agents "interrupted". */
  workflowActive: boolean;
  paused: boolean;
}

/** Content width. The 6 columns are the dialog's border and padding. */
export function workflowDialogContentWidth(terminalWidth: number): number {
  return Math.max(12, terminalWidth - 6);
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), length - 1);

/**
 * Settle the selection against the data actually present.
 *
 * Selection is stored raw and clamped on read, so a phase finishing (and its
 * agents dropping out of a filtered view) never leaves the cursor pointing past
 * the end — the same trick `fleet-list.ts` plays, minus the mutation.
 */
export function resolveWorkflowDialog(input: WorkflowDialogInput): ResolvedWorkflowDialog {
  const groups = buildPhaseGroups(input.progress, input.meta?.phases);
  const workflowActive = input.task.status === "running" || input.task.status === "paused";
  const clampedPhase = clampIndex(input.state.selectedPhase, groups.length);
  const all = groups[clampedPhase]?.agents ?? [];
  const visibleAgents =
    input.state.filter === "all"
      ? [...all]
      : all.filter(entry => displayState(entry, workflowActive) === input.state.filter);
  const clampedAgent = clampIndex(input.state.selectedAgent, visibleAgents.length);

  return {
    groups,
    clampedPhase,
    clampedAgent,
    visibleAgents,
    selectedEntry: visibleAgents[clampedAgent],
    workflowActive,
    paused: input.task.status === "paused",
  };
}

/* ------------------------------------------------------------------------- *
 * Row pieces
 * ------------------------------------------------------------------------- */

/**
 * The `·`-separated annotations between an agent's label and its stats.
 *
 * These say *why* a row looks the way it does — a retry and its cause, a cache
 * hit replayed from the resume journal, how long a queued agent has been
 * waiting. The stat tail (agentType, model, tokens, tool calls, duration) is the
 * card's and is appended after.
 */
export function subStatusAnnotations(
  entry: WorkflowAgentEntry,
  state: WorkflowDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.isolation) parts.push(entry.isolation);
  if (entry.cached) parts.push(REPLAYED_ANNOTATION);
  if (entry.lastAttemptReason) {
    parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  }
  if (entry.attempt != null && entry.attempt > 1) parts.push(`attempt ${entry.attempt}`);
  if (state === "queued" && entry.queuedAt != null) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/** Place `right` flush to `width`, cutting `left` first so the stats survive. */
function rightAlign(left: WorkflowCardLine, right: WorkflowCardLine, width: number): WorkflowCardLine {
  const rightWidth = lineWidth(right);
  const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - rightWidth);
  return clampLine([...clampedLeft, { text: " ".repeat(gap) }, ...right], width);
}

/**
 * Window a list around its selection, so a 200-agent fan-out still shows the
 * row you are on. Mirrors `fleet-list.ts`'s arithmetic.
 */
function windowRange(selected: number, total: number, max: number): { start: number; end: number } {
  const visible = Math.min(max, total);
  const start = selected < visible ? 0 : selected - visible + 1;
  return { start, end: start + visible };
}

/* ------------------------------------------------------------------------- *
 * The pane frame
 * ------------------------------------------------------------------------- */

/**
 * Inner width of the left pane.
 *
 * Fixed rather than proportional at usable terminal sizes: the left pane holds
 * short labels (a phase title, an agent label) and the right pane holds
 * everything that actually needs room, so giving the left a share of a wide
 * terminal would only pad it. It gives way on a narrow one.
 */
export function leftPaneWidth(width: number): number {
  // The two cells share everything except the three border columns, and the
  // right one must keep at least a column — so the left is capped by what it
  // can take without squeezing the right out and tearing the frame.
  const available = Math.max(2, width - 3);
  return Math.max(1, Math.min(LEFT_PANE_WIDTH, Math.floor(available / 3), available - 1));
}

/** Fill a title out to the cell width with rule, so the corners stay put. */
function padTitle(line: WorkflowCardLine, width: number, horizontal: string): WorkflowCardLine {
  const gap = Math.max(0, width - lineWidth(line));
  return gap > 0 ? [...line, { text: horizontal.repeat(gap), color: "dim" }] : line;
}

/** One pane row, padded to exactly `width` so the frame stays vertical. */
function padCell(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped = clampLine(line, width);
  const gap = Math.max(0, width - lineWidth(clamped));
  return gap > 0 ? [...clamped, { text: " ".repeat(gap) }] : clamped;
}

/** A title as it sits in the frame's top edge: ` Title ` then rule to `width`. */
function frameTitle(title: string, width: number, glyphs: WorkflowDialogGlyphs): WorkflowCardSegment[] {
  const room = Math.max(0, width - 2);
  // Truncated with the marker rather than simply cut: `Discover · 1 ag…` has to
  // read as "there was more", not as a title that happens to end oddly. Pi's
  // own truncation does the width arithmetic, including wide characters; its
  // ellipsis arrives wrapped in resets, which are stripped for the same reason
  // `clampLine` strips them — the layout stays plain text until it is themed.
  const shown = stripTerminalSequences(truncateToWidth(title, room, glyphs.ellipsis));
  const rule = Math.max(0, width - visibleWidth(shown) - 2);
  // Clamped as well as computed: at a terminal narrow enough that `room` hits
  // zero the marker alone is already wider than the cell, and a title that
  // overflows tears the frame open on every row below it.
  return clampLine(
    [
      { text: " ", color: "dim" },
      { text: shown, color: "muted", bold: true },
      { text: ` ${glyphs.box.horizontal.repeat(rule)}`, color: "dim" },
    ],
    width,
  );
}

/**
 * Draw the two panes into one framed block.
 *
 * Both columns are padded to `bodyRows` so the frame is the same height however
 * much either side holds — a box that grew and shrank as you moved the
 * selection would make the whole dialog jump.
 */
function paneFrame(options: {
  leftTitle: string;
  rightTitle: string;
  leftRows: WorkflowCardLine[];
  rightRows: WorkflowCardLine[];
  width: number;
  bodyRows: number;
  glyphs: WorkflowDialogGlyphs;
}): WorkflowCardLine[] {
  const { glyphs, width } = options;
  const box = glyphs.box;
  const left = leftPaneWidth(width);
  const right = Math.max(1, width - left - 3);

  const lines: WorkflowCardLine[] = [];
  lines.push([
    { text: box.topLeft, color: "dim" },
    ...padTitle(frameTitle(options.leftTitle, left, glyphs), left, box.horizontal),
    { text: box.topTee, color: "dim" },
    ...padTitle(frameTitle(options.rightTitle, right, glyphs), right, box.horizontal),
    { text: box.topRight, color: "dim" },
  ]);

  for (let row = 0; row < options.bodyRows; row++) {
    lines.push([
      { text: box.vertical, color: "dim" },
      ...padCell(options.leftRows[row] ?? [], left),
      { text: box.vertical, color: "dim" },
      ...padCell(options.rightRows[row] ?? [], right),
      { text: box.vertical, color: "dim" },
    ]);
  }

  lines.push([
    { text: box.bottomLeft, color: "dim" },
    { text: box.horizontal.repeat(left), color: "dim" },
    { text: box.bottomTee, color: "dim" },
    { text: box.horizontal.repeat(right), color: "dim" },
    { text: box.bottomRight, color: "dim" },
  ]);
  return lines;
}

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

/** Split a preview into lines, treating an empty preview as absent. */
const previewLines = (preview: string | undefined) => (preview ? preview.split("\n") : []);

/** What the Activity body says. There is a count of tool calls, never a list. */
function activityBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  if (state === "queued") return WORKFLOW_DIALOG_COPY.availableOnceStarted;
  if ((entry.toolCalls ?? 0) > 0) return WORKFLOW_DIALOG_COPY.noTranscript;
  return isLive(entry) ? WORKFLOW_DIALOG_COPY.noToolCallsYet : WORKFLOW_DIALOG_COPY.noToolCalls;
}

/** What the Outcome body says, which is a different sentence for every state. */
function outcomeBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "skipped":
      return WORKFLOW_DIALOG_COPY.skippedByUser;
    case "interrupted":
      return WORKFLOW_DIALOG_COPY.stoppedEarly;
    case "queued":
      return WORKFLOW_DIALOG_COPY.waitingForSlot;
    case "running":
      return WORKFLOW_DIALOG_COPY.notAvailableYet;
    case "failed":
    case "blocked":
      return entry.error ?? WORKFLOW_DIALOG_COPY.noTranscript;
    case "done":
      return entry.resultPreview ?? WORKFLOW_DIALOG_COPY.noTranscript;
  }
}

/* ------------------------------------------------------------------------- *
 * Layout
 * ------------------------------------------------------------------------- */

/**
 * Which of the per-agent actions the selected row can currently take.
 *
 * The window for both is the one in which the agent's `agent()` call is still
 * unanswered. Skip covers that whole window; retry needs a child to stop and
 * start again, so it begins only once one exists. Once the call has settled its
 * value is already the script's, and there is nothing either key could change.
 */
export function agentActions(
  entry: WorkflowAgentEntry | undefined,
  workflowActive: boolean,
): { skip: boolean; retry: boolean } {
  if (entry === undefined || !workflowActive) return { skip: false, retry: false };
  const state = displayState(entry, workflowActive);
  return { skip: state === "queued" || state === "running", retry: state === "running" };
}

/** Status word the detail pane leads with, one per display state. */
function statusWord(state: WorkflowDisplayState): string {
  switch (state) {
    case "done": return "Completed";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
    case "blocked": return "Blocked";
    case "queued": return "Queued";
    case "interrupted": return "Stopped";
    case "running": return "Running";
  }
}

/** `Prompt · 5 lines · ⏎ expand` — a detail heading and its dim suffixes. */
function detailHeading(title: string, suffixes: readonly string[], width: number): WorkflowCardLine {
  const line: WorkflowCardLine = [{ text: " " }, { text: title, color: "muted", bold: true }];
  for (const suffix of suffixes) {
    line.push({ text: " · ", color: "dim" }, { text: suffix, color: "dim" });
  }
  return clampLine(line, width);
}

/** A detail body line, indented under its heading. */
const detailBody = (text: string, width: number): WorkflowCardLine =>
  clampLine([{ text: `   ${text}`, color: "dim" }], width);

/** The row for one agent, as it appears in whichever pane is listing agents. */
function agentRow(options: {
  entry: WorkflowAgentEntry;
  selected: boolean;
  compact: boolean;
  width: number;
  glyphs: WorkflowDialogGlyphs;
  workflowActive: boolean;
  spinnerFrame: number;
  now: number;
}): WorkflowCardLine {
  const { entry, selected, glyphs, width } = options;
  const display = displayState(entry, options.workflowActive);
  const head: WorkflowCardLine = [
    { text: " " },
    { text: selected ? glyphs.pointer : " ", color: "accent" },
    { text: " " },
    dialogRowGlyph(display, glyphs, options.spinnerFrame),
    { text: " " },
    { text: entry.label, color: selected ? "accent" : undefined },
  ];
  // The narrow pane holds the label and nothing else; there is no room for a
  // stat tail, and clamping one would just spend columns on a truncated word.
  if (options.compact) return clampLine(head, width);

  const model = formatModel(entry);
  if (model) head.push({ text: ` ${model}`, color: "dim" });
  for (const part of [...subStatusAnnotations(entry, display, options.now), ...rowStatSegments(entry)]) {
    head.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
  }
  // The duration sits flush right, so a column of rows reads as a column of
  // durations rather than as ragged text.
  const duration = entry.durationMs ? [{ text: `${formatDuration(entry.durationMs)} `, color: "dim" as const }] : [];
  return duration.length > 0 ? rightAlign(head, duration, width) : clampLine(head, width);
}

/** The agent row's dot-separated tail. The model is not in it — it leads. */
function rowStatSegments(entry: WorkflowAgentEntry): string[] {
  return entry.tokens ? [`${formatCompactTokens(entry.tokens)} tok`] : [];
}

/**
 * Build the dialog.
 *
 * Two panes side by side inside one frame, and two levels of depth: phases with
 * the selected phase's agents beside them, then — on opening one — those agents
 * with the selected agent's detail beside them. The frame is a fixed height so
 * the dialog does not jump as the selection moves through runs of very
 * different sizes.
 */
export function layoutWorkflowDialog(input: WorkflowDialogInput): WorkflowCardLine[] {
  const glyphs = input.ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const width = workflowDialogContentWidth(input.width ?? DEFAULT_WIDTH);
  const now = input.now ?? Date.now();
  const view = resolveWorkflowDialog(input);
  const { state } = input;
  // What the panes may *hold*; the frame's actual height is settled below, once
  // there is something to measure.
  const capacity = Math.max(MIN_PANE_BODY_ROWS, input.bodyRows ?? DEFAULT_PANE_BODY_ROWS);
  const spinnerFrame = input.spinnerFrame ?? 0;

  const lines: WorkflowCardLine[] = [];

  // ---- Header: the run's name, then its description with the stats flush right.
  const head = header(input.task, input.meta, view.groups, input.agentCount ?? 0, now);
  lines.push(clampLine([{ text: " " }, { text: head.name, color: "toolTitle", bold: true }], width));
  lines.push(
    rightAlign(
      head.subtext ? [{ text: " " }, { text: head.subtext, color: "dim" }] : [],
      [{ text: head.stats, color: "dim" }],
      width,
    ),
  );
  lines.push([]);

  const frameWidth = width - 1;
  const leftWidth = leftPaneWidth(frameWidth);
  const rightWidth = Math.max(1, frameWidth - leftWidth - 3);
  const inPhases = state.level === "phases";
  const entry = view.selectedEntry;

  // ---- The pane listing phases, shown only at the overview level.
  const phaseRows: WorkflowCardLine[] = [];
  const digits = String(view.groups.length).length;
  const phases = windowRange(view.clampedPhase, view.groups.length, capacity);
  for (let i = phases.start; i < Math.min(phases.end, view.groups.length); i++) {
    const group = view.groups[i];
    const selected = i === view.clampedPhase;
    const color: WorkflowCardColor =
      selected ? "accent"
      : group.status === "done" ? "success"
      : group.status === "failed" ? "error"
      : "dim";
    // An unfinished phase shows its number where a finished one shows a glyph —
    // so the list doubles as a numbered plan of the run.
    const glyph =
      group.status === "done" ? glyphs.tick
      : group.status === "failed" ? glyphs.cross
      : String(i + 1);
    phaseRows.push(
      rightAlign(
        [
          { text: " " },
          { text: selected ? glyphs.pointer : " ", color: "accent" },
          { text: " " },
          { text: glyph.padStart(digits), color },
          { text: " " },
          { text: group.title, color },
        ],
        group.totalCount === 0 ? [] : [{ text: `${group.doneCount}/${group.totalCount} `, color }],
        leftWidth,
      ),
    );
  }

  // ---- The pane listing this phase's agents. It is the right pane at the
  // overview level and the left pane in the subview, so it is built once.
  const agentPaneWidth = inPhases ? rightWidth : leftWidth;
  const agentRows: WorkflowCardLine[] = [];
  if (view.visibleAgents.length === 0) {
    agentRows.push(clampLine([{ text: `   ${WORKFLOW_DIALOG_COPY.noAgents}`, color: "dim" }], agentPaneWidth));
  } else {
    const agents = windowRange(view.clampedAgent, view.visibleAgents.length, capacity);
    for (let i = agents.start; i < Math.min(agents.end, view.visibleAgents.length); i++) {
      agentRows.push(
        agentRow({
          entry: view.visibleAgents[i],
          selected: i === view.clampedAgent,
          compact: !inPhases,
          width: agentPaneWidth,
          glyphs,
          workflowActive: view.workflowActive,
          spinnerFrame,
          now,
        }),
      );
    }
  }

  // ---- The detail pane, in the subview only.
  const detailRows: WorkflowCardLine[] = [];
  if (!inPhases && entry) {
    const display = displayState(entry, view.workflowActive);
    const model = formatModel(entry);
    detailRows.push(
      clampLine(
        [
          { text: " " },
          dialogRowGlyph(display, glyphs, spinnerFrame),
          { text: ` ${statusWord(display)}`, color: "muted" },
          ...(model ? [{ text: " · ", color: "dim" as const }, { text: model, color: "dim" as const }] : []),
        ],
        rightWidth,
      ),
    );
    // Rebuilt rather than filtered out of `agentStatSegments`: the model and the
    // agent type are already on the line above, and the token count wants its
    // unit here exactly as it has one in the row.
    const stats: string[] = [];
    if (entry.tokens) stats.push(`${formatCompactTokens(entry.tokens)} tok`);
    if (entry.toolCalls) stats.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
    if (entry.durationMs) stats.push(formatDuration(entry.durationMs));
    if (stats.length > 0) {
      detailRows.push(clampLine([{ text: ` ${stats.join(" · ")}`, color: "dim" }], rightWidth));
    }

    const prompt = previewLines(entry.promptPreview);
    const collapsed = !state.promptExpanded && prompt.length > PROMPT_COLLAPSED_LINES;
    const promptSuffix: string[] = [];
    if (prompt.length > 0) promptSuffix.push(`${prompt.length} ${prompt.length === 1 ? "line" : "lines"}`);
    if (prompt.length > PROMPT_COLLAPSED_LINES) {
      promptSuffix.push(`${glyphs.enter} ${state.promptExpanded ? "collapse" : "expand"}`);
    }
    detailRows.push([]);
    detailRows.push(detailHeading("Prompt", promptSuffix, rightWidth));
    if (prompt.length === 0) {
      detailRows.push(detailBody(WORKFLOW_DIALOG_COPY.availableOnceStarted, rightWidth));
    } else {
      const shown = collapsed ? prompt.slice(0, PROMPT_COLLAPSED_LINES) : prompt;
      for (const text of shown) detailRows.push(detailBody(text, rightWidth));
      // Named rather than silently cut: the reader has to know the prompt goes on.
      if (collapsed) {
        const hidden = prompt.length - PROMPT_COLLAPSED_LINES;
        detailRows.push(detailBody(`${glyphs.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}`, rightWidth));
      }
    }

    const toolCalls = entry.toolCalls ?? 0;
    detailRows.push([]);
    detailRows.push(
      detailHeading(
        "Activity",
        toolCalls > 0 ? [`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : [],
        rightWidth,
      ),
    );
    detailRows.push(detailBody(activityBody(entry, display), rightWidth));

    detailRows.push([]);
    detailRows.push(detailHeading("Outcome", [], rightWidth));
    // Wrapped, not clamped: the outcome is the thing the reader came for, and
    // cutting it at the pane edge would hide the half that matters.
    for (const text of wrapTextWithAnsi(outcomeBody(entry, display), Math.max(1, rightWidth - 4))) {
      detailRows.push(detailBody(text, rightWidth));
    }
  }

  const phaseTitle = view.groups[view.clampedPhase]?.title ?? "Phases";
  // With a filter on, the count is of what survived it — so the title says
  // which filter, rather than leaving "3 agents" looking like the whole phase.
  const shown = view.visibleAgents.length;
  const agentPaneTitle =
    state.filter === "all" ?
      `${phaseTitle} · ${shown} agent${shown === 1 ? "" : "s"}`
    : `${phaseTitle} · ${shown} ${state.filter}`;
  // Indented one column, so the frame's left edge lines up under the name and
  // the description rather than hanging off the edge of them.
  const leftRows = inPhases ? phaseRows : agentRows;
  const rightRows = inPhases ? agentRows : detailRows;
  lines.push(
    ...paneFrame({
      leftTitle: inPhases ? "Phases" : agentPaneTitle,
      rightTitle: inPhases ? agentPaneTitle : (entry?.label ?? WORKFLOW_DIALOG_COPY.noAgents),
      leftRows,
      rightRows,
      width: width - 1,
      // Tall enough for whichever pane holds more, and no taller. Both panes
      // were built against `capacity`, so neither can exceed it and nothing
      // measured here is ever cut by the frame it is sizing.
      bodyRows: Math.min(capacity, Math.max(MIN_PANE_BODY_ROWS, leftRows.length, rightRows.length)),
      glyphs,
    }).map(line => [{ text: " " }, ...line]),
  );

  // ---- Key hints ----
  // Only the actions the run can currently take, so the footer never advertises
  // a key that does nothing. Gated on `available` as well as run state: a caller
  // that wires only some of the actions must not get a footer advertising keys
  // that do nothing. Omitting `available` entirely keeps every hint, which is
  // what the layout tests want.
  const can = (action: keyof WorkflowDialogActions) => input.available?.[action] ?? true;
  const hints: string[] = [];
  if (inPhases) {
    hints.push(`${glyphs.upDown} select`);
    if (view.visibleAgents.length > 0) hints.push(`${glyphs.enter} open`);
    hints.push("f filter");
  } else {
    hints.push(`${glyphs.upDown} agent`);
    if (previewLines(entry?.promptPreview).length > PROMPT_COLLAPSED_LINES) {
      hints.push(`${glyphs.enter} prompt`);
    }
    const actions = agentActions(entry, view.workflowActive);
    if (actions.skip && can("onSkipAgent")) hints.push("s skip");
    if (actions.retry && can("onRetryAgent")) hints.push("r retry");
  }
  if (view.paused && can("onResume")) hints.push("p resume");
  else if (view.workflowActive && can("onPause")) hints.push("p pause");
  if (view.workflowActive && can("onKill")) hints.push("x stop");
  hints.push(inPhases ? "esc close" : "esc back");
  lines.push(clampLine([{ text: ` ${hints.join(" · ")}`, color: "dim" }], width));

  return lines;
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

const nextFilter = (filter: WorkflowDialogFilter): WorkflowDialogFilter =>
  WORKFLOW_DIALOG_FILTERS[(WORKFLOW_DIALOG_FILTERS.indexOf(filter) + 1) % WORKFLOW_DIALOG_FILTERS.length];

/**
 * Map a keypress to the next state and, where the key is an action, what the
 * caller should do about it. Pure: `undefined` means "not ours".
 *
 * Movement clamps at both ends rather than wrapping — a long agent list should
 * not jump back to the top under a held `j`.
 */
export function handleWorkflowDialogKey(
  data: string,
  state: WorkflowDialogState,
  view: ResolvedWorkflowDialog,
): { state: WorkflowDialogState; action?: WorkflowDialogAction } | undefined {
  // Back one level before out of the dialog: `esc` in the subview returns to
  // the overview, and only closes from there. Anything else would make a wrong
  // turn cost the whole dialog.
  if (matchesKey(data, "escape") || matchesKey(data, "q")) {
    if (state.level === "agent") return { state: { ...state, level: "phases", promptExpanded: false } };
    return { state, action: { kind: "cancel" } };
  }
  if (matchesKey(data, "left") && state.level === "agent") {
    return { state: { ...state, level: "phases", promptExpanded: false } };
  }

  const down = matchesKey(data, "j") || matchesKey(data, "down");
  const up = matchesKey(data, "k") || matchesKey(data, "up");
  if (down || up) {
    const delta = down ? 1 : -1;
    if (state.level === "phases") {
      const next = clampIndex(view.clampedPhase + delta, view.groups.length);
      // Changing phase re-points the agent list at a different set of rows, so
      // the old row index would be meaningless.
      return { state: next === view.clampedPhase ? state : { ...state, selectedPhase: next, selectedAgent: 0 } };
    }
    return { state: { ...state, selectedAgent: clampIndex(view.clampedAgent + delta, view.visibleAgents.length) } };
  }

  // One key, two jobs, because the two levels are what it means at each: open
  // the selected phase's agents, then expand the prompt of the one you opened.
  if (matchesKey(data, "enter") || matchesKey(data, "right")) {
    if (state.level === "phases") {
      // Nothing to open, so nothing happens — entering an empty pane would
      // strand the reader in a subview with no rows and no detail.
      if (view.visibleAgents.length === 0) return { state };
      return { state: { ...state, level: "agent", promptExpanded: false } };
    }
    return { state: { ...state, promptExpanded: !state.promptExpanded } };
  }
  if (matchesKey(data, "e")) {
    return { state: { ...state, promptExpanded: !state.promptExpanded } };
  }

  // The filter re-points the agent list, so it belongs to the level that shows
  // the whole list rather than the one showing a single agent's detail.
  if (matchesKey(data, "f") && state.level === "phases") {
    return { state: { ...state, filter: nextFilter(state.filter), selectedAgent: 0 } };
  }

  // Gated on the run being live, exactly as the footer's hints are. A settled
  // run has nothing left to stop, and firing `kill` at one aborts a controller
  // that is already done and reports a stop that never happened.
  if (matchesKey(data, "x")) return view.workflowActive ? { state, action: { kind: "kill" } } : undefined;
  if (matchesKey(data, "p")) {
    if (!view.workflowActive) return undefined;
    return { state, action: { kind: view.paused ? "resume" : "pause" } };
  }
  const actions = agentActions(view.selectedEntry, view.workflowActive);
  if (matchesKey(data, "s") && actions.skip && view.selectedEntry) {
    return { state, action: { kind: "skip", index: view.selectedEntry.index } };
  }
  if (matchesKey(data, "r") && actions.retry && view.selectedEntry) {
    return { state, action: { kind: "retry", index: view.selectedEntry.index } };
  }

  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

/** The dialog as plain text — what the layout tests assert against. */
export function plainWorkflowDialogLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

/**
 * The `/agents → Workflows` overlay.
 *
 * Deliberately thin: it owns the spinner timer and the theme, and delegates
 * everything else to the two pure functions above. `source` is re-read every
 * render so a live run updates in place without any subscription plumbing.
 */
export class WorkflowDialog implements Component {
  private state: WorkflowDialogState;
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private tui: TUI,
    private source: () => WorkflowDialogSource,
    private theme: Theme,
    private done: (result: undefined) => void,
    private actions: WorkflowDialogActions = {},
    initialPhaseIndex = 0,
  ) {
    this.state = initialWorkflowDialogState(initialPhaseIndex);
    this.timer = setInterval(() => {
      this.spinnerFrame++;
      if (!this.closed) this.tui.requestRender();
    }, WORKFLOW_DIALOG_SPINNER_MS);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    const input: WorkflowDialogInput = { ...this.source(), state: this.state };
    const result = handleWorkflowDialogKey(data, this.state, resolveWorkflowDialog(input));
    if (!result) return;
    this.state = result.state;
    if (result.action) this.dispatch(result.action);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = layoutWorkflowDialog({
      ...this.source(),
      state: this.state,
      // Derived from what was actually injected, so the footer advertises only
      // the keys this dialog can service.
      available: {
        onKill: this.actions.onKill !== undefined,
        onPause: this.actions.onPause !== undefined,
        onResume: this.actions.onResume !== undefined,
        onSkipAgent: this.actions.onSkipAgent !== undefined,
        onRetryAgent: this.actions.onRetryAgent !== undefined,
      },
      width,
      spinnerFrame: this.spinnerFrame,
    });
    return styleWorkflowCardLines(lines, this.theme);
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private dispatch(action: WorkflowDialogAction): void {
    switch (action.kind) {
      case "cancel":
        this.closed = true;
        this.done(undefined);
        return;
      case "kill":
        this.actions.onKill?.();
        return;
      case "pause":
        this.actions.onPause?.();
        return;
      case "resume":
        this.actions.onResume?.();
        return;
      case "skip":
        this.actions.onSkipAgent?.(action.index);
        return;
      case "retry":
        this.actions.onRetryAgent?.(action.index);
        return;
    }
  }
}
