/**
 * workflow-card.ts — the inline transcript card for a running workflow.
 *
 * ```
 * ▸ Workflow  review-changes                       3/7 agents · 1m12s
 *   Review changed files across dimensions, verify each finding
 *   ╭─ Review
 *   │ ├─ ✔ review:bugs      · Explore · haiku · 18.4k · 12 tool calls · 42s
 *   │ ├─ ⟳ review:perf      · Explore · 8 tool calls · 21s
 *   │ └─ ⟳ review:security
 *   ╰─ Verify
 *     └─ ⟳ verify:auth.ts   · Plan · 3 tool calls · 9s
 *   ⎿  scanned 41 changed files
 * ```
 *
 * Two things about this file are easy to get wrong.
 *
 * **The glyphs are not the dialog's glyphs.** The inline row keys off the *raw*
 * entry `state` (start | progress | done | error), not the derived display
 * state, so a skipped or blocked agent renders as a plain ✘ here while the
 * workflows dialog distinguishes them. `displayState` is deliberately not
 * consulted below.
 *
 * **The layout is pure.** `layoutWorkflowCard` returns coloured segments and
 * never touches a theme or a terminal, so the same layout drives the `Workflow`
 * tool's `renderResult` and a standalone session entry (a workflow launched from
 * a CLI flag has no tool call to attach to). Theme application is the thin
 * `styleWorkflowCardLines` wrapper on top.
 *
 * All state derivation lives in `src/workflow/progress.ts`; this file only
 * arranges what that module returns.
 */

import { stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  buildPhaseGroups,
  collapse,
  formatDuration,
  header,
  sizeWarning,
  stats,
  type WorkflowAgentEntry,
  type WorkflowEntry,
  type WorkflowRunStatus,
} from "../workflow/progress.js";
import type { Theme } from "./agent-widget.js";

/**
 * Header re-render cadence. Claude Code ticks the workflow clock once a second,
 * not at the 80ms spinner cadence — the running glyph is static, so there is
 * nothing to animate faster than the elapsed time changes.
 */
export const WORKFLOW_TICK_MS = 1000;

/** Widest label column before stats stop being aligned and just follow the label. */
const LABEL_COLUMN_MAX = 28;

/** Fallback width when the caller does not know the terminal's. */
const DEFAULT_WIDTH = 80;

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowGlyphs {
  /** Tool-title pointer, matching the Agent tool's `▸`. */
  pointer: string;
  tick: string;
  cross: string;
  /** Running/queued. A static glyph, hence no spinner inline. */
  running: string;
  /** First and subsequent phase groups. */
  groupTop: string;
  /** A group that is neither the first nor the last. */
  groupMid: string;
  /** The last phase group. */
  groupBottom: string;
  /** Continuation rail under a non-final group. */
  vertical: string;
  branch: string;
  lastBranch: string;
  /** Log-line prefix, matching the Agent tool's result lines. */
  log: string;
  warning: string;
}

export const UNICODE_GLYPHS: WorkflowGlyphs = {
  pointer: "▸",
  tick: "✔",
  cross: "✘",
  running: "⟳",
  groupTop: "╭─",
  groupMid: "├─",
  groupBottom: "╰─",
  vertical: "│",
  branch: "├─",
  lastBranch: "└─",
  log: "⎿",
  warning: "⚠",
};

/**
 * The `figures` ASCII tier, for terminals that cannot draw the box set. Every
 * glyph keeps its unicode counterpart's column width so the tree stays aligned
 * either way.
 */
export const ASCII_GLYPHS: WorkflowGlyphs = {
  pointer: ">",
  tick: "√",
  cross: "×",
  running: "*",
  groupTop: ",-",
  groupMid: "|-",
  groupBottom: "`-",
  vertical: "|",
  branch: "|-",
  lastBranch: "`-",
  log: "\\",
  warning: "!",
};

/* ------------------------------------------------------------------------- *
 * Lines
 * ------------------------------------------------------------------------- */

/**
 * pi theme keys. Claude Code's palette maps as success→success, error→error,
 * subtle→dim, permission→warning for a blocked row and accent for selection;
 * an undefined colour means "leave it at the terminal default", which is what
 * the recovered inline mapping asks for on a running row.
 *
 * `accent` is unused by the card and exists for the workflows dialog, which
 * shares these segment types.
 */
export type WorkflowCardColor = "success" | "error" | "warning" | "dim" | "muted" | "toolTitle" | "accent";

export interface WorkflowCardSegment {
  text: string;
  color?: WorkflowCardColor;
  bold?: boolean;
}

export type WorkflowCardLine = WorkflowCardSegment[];

/** The subset of the task record the card reads. */
export interface WorkflowCardTask {
  status: WorkflowRunStatus;
  workflowName?: string;
  summary?: string;
  description?: string;
  startTime: number;
  endTime?: number;
  totalPausedMs?: number;
}

export interface WorkflowCardInput {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that have reported. */
  agentCount?: number;
  /** Total tokens for the size warning; summed from the entries when omitted. */
  totalTokens?: number;
  agentCap?: number;
  tokenCap?: number;
  now?: number;
  width?: number;
  /** Swap in the ASCII glyph tier for terminals without unicode. */
  ascii?: boolean;
  /**
   * Lead with `▸ SubagentWorkflow`.
   *
   * True where the card stands alone — the session entry a flag-launched run
   * writes, which has no tool call above it to say what it is. False as a tool
   * result, where the call line directly above already does.
   */
  showToolTitle?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Formatting
 * ------------------------------------------------------------------------- */

/** `18.4k` / `1.2M` — bare magnitude, since the row already reads as a stat. */
export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

/**
 * One label for the model pair. A fallback that never differed from the primary
 * would just be noise, so it only shows when the run actually has two models in
 * play.
 */
export function formatModel(entry: WorkflowAgentEntry): string | undefined {
  const { model, fallbackModel } = entry;
  if (model && fallbackModel && model !== fallbackModel) return `${model}→${fallbackModel}`;
  return model ?? fallbackModel;
}

/**
 * What a row replayed from a resume journal says instead of a duration.
 *
 * Shared with the dialog so both views name the same thing the same way — the
 * card shows it inline while the run happens, the dialog on the agent's row.
 */
export const REPLAYED_ANNOTATION = "from resume journal";

/**
 * The `·`-separated tail of an agent row, in the recovered order: agentType,
 * model, tokens, toolCalls, durationMs. Absent values drop out entirely rather
 * than rendering a placeholder.
 */
export function agentStatSegments(entry: WorkflowAgentEntry): string[] {
  const parts: string[] = [];
  if (entry.agentType) parts.push(entry.agentType);
  const model = formatModel(entry);
  if (model) parts.push(model);
  if (entry.tokens) parts.push(formatCompactTokens(entry.tokens));
  if (entry.toolCalls) parts.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
  if (entry.durationMs) parts.push(formatDuration(entry.durationMs));
  return parts;
}

/**
 * The recovered inline mapping — keyed on the raw entry state. `skipped` and
 * `blocked` are not distinguished here; that is the dialog's job.
 */
function rowGlyph(entry: WorkflowAgentEntry, glyphs: WorkflowGlyphs): WorkflowCardSegment {
  if (entry.state === "done") return { text: glyphs.tick, color: "success" };
  if (entry.state === "error") return { text: glyphs.cross, color: "error" };
  return { text: glyphs.running };
}

/* ------------------------------------------------------------------------- *
 * Layout
 * ------------------------------------------------------------------------- */

/** Trim a line to `width`, cutting inside whichever segment crosses the edge. */
export function clampLine(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped: WorkflowCardLine = [];
  let used = 0;
  for (const segment of line) {
    const segmentWidth = visibleWidth(segment.text);
    if (used + segmentWidth <= width) {
      clamped.push(segment);
      used += segmentWidth;
      continue;
    }
    const room = width - used;
    // truncateToWidth wraps its ellipsis in resets, which would leak escape
    // codes into a layout that is supposed to be plain text until it is themed.
    if (room > 0) {
      clamped.push({ ...segment, text: stripTerminalSequences(truncateToWidth(segment.text, room, "…")) });
    }
    return clamped;
  }
  return clamped;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/**
 * Build the card.
 *
 * Everything derived — the phase tree, the header counts, the logs, the size
 * warning — comes from `progress.ts`; what happens here is purely arrangement.
 */
export function layoutWorkflowCard(input: WorkflowCardInput): WorkflowCardLine[] {
  const glyphs = input.ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
  const width = Math.max(1, input.width ?? DEFAULT_WIDTH);
  const now = input.now ?? Date.now();

  const groups = buildPhaseGroups(input.progress, input.meta?.phases);
  const { agents, logs } = collapse(input.progress);
  const totals = stats(input.progress, input.agentCount ?? 0);
  const head = header(input.task, input.meta, groups, input.agentCount ?? 0, now);

  const lines: WorkflowCardLine[] = [];

  // ---- Header: `<name>` with the stats flush right ----
  // The tool name appears only when nothing above the card already carries it.
  // As a tool result there is a `▸ SubagentWorkflow …` call line directly above,
  // and repeating it put two near-identical pointer lines back to back.
  const left: WorkflowCardLine = input.showToolTitle
    ? [
        { text: `${glyphs.pointer} `, color: "toolTitle" },
        { text: "SubagentWorkflow", color: "toolTitle", bold: true },
        { text: "  " },
        { text: head.name, color: "muted" },
      ]
    : [{ text: "  " }, { text: head.name, color: "toolTitle", bold: true }];
  const statsWidth = visibleWidth(head.stats);
  const clampedLeft = clampLine(left, Math.max(0, width - statsWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - statsWidth);
  lines.push([...clampedLeft, { text: " ".repeat(gap) }, { text: head.stats, color: "dim" }]);

  if (head.subtext) lines.push(clampLine([{ text: `  ${head.subtext}`, color: "dim" }], width));

  // ---- Phase tree ----
  // Stats line up in one column across the whole card, not per group, so the
  // eye can scan them; a label past the cap just pushes its own stats along.
  const labelColumn = Math.min(
    LABEL_COLUMN_MAX,
    Math.max(0, ...groups.flatMap(group => group.agents.map(a => visibleWidth(a.label)))),
  );

  groups.forEach((group, groupIndex) => {
    const lastGroup = groupIndex === groups.length - 1;
    lines.push(
      clampLine(
        [
          { text: "  " },
          // One box, not a stack of them: only the first group opens it and
          // only the last closes it. Everything between branches off the side,
          // or three phases read as three half-drawn boxes.
          {
            text: `${
              lastGroup ? glyphs.groupBottom
              : groupIndex === 0 ? glyphs.groupTop
              : glyphs.groupMid
            } `,
            color: "dim",
          },
          { text: group.title },
        ],
        width,
      ),
    );

    const rail = lastGroup ? "  " : `${glyphs.vertical} `;
    group.agents.forEach((entry, agentIndex) => {
      const lastAgent = agentIndex === group.agents.length - 1;
      const segments: WorkflowCardLine = [
        { text: "  " },
        { text: rail, color: "dim" },
        { text: `${lastAgent ? glyphs.lastBranch : glyphs.branch} `, color: "dim" },
        rowGlyph(entry, glyphs),
        { text: " " },
      ];

      // Prepended rather than folded into `agentStatSegments`, which is the
      // ported stat tail in its recovered order. A replayed agent otherwise
      // renders as a tick with no tokens and no duration — indistinguishable
      // from one that somehow did the work for free.
      const statParts = entry.cached
        ? [REPLAYED_ANNOTATION, ...agentStatSegments(entry)]
        : agentStatSegments(entry);
      const pad = Math.max(0, labelColumn - visibleWidth(entry.label));
      segments.push({ text: statParts.length > 0 ? entry.label + " ".repeat(pad) : entry.label });
      for (const part of statParts) {
        segments.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
      }
      lines.push(clampLine(segments, width));
    });
  });

  // ---- log() output, below the tree ----
  for (const message of logs) {
    const [first, ...rest] = message.split("\n");
    lines.push(clampLine([{ text: `  ${glyphs.log}  ${first}`, color: "dim" }], width));
    for (const continuation of rest) {
      lines.push(clampLine([{ text: `     ${continuation}`, color: "dim" }], width));
    }
  }

  // ---- Size warning ----
  const totalTokens =
    input.totalTokens ?? agents.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
  const warning = sizeWarning({
    scheduledAgents: Math.max(input.agentCount ?? 0, totals.total),
    startedAgents: totals.started,
    totalTokens,
    agentCap: input.agentCap,
    tokenCap: input.tokenCap,
  });
  if (warning) {
    lines.push(
      clampLine([{ text: `  ${glyphs.warning} Large workflow · /agents → Workflows to stop`, color: "warning" }], width),
    );
  }

  return lines;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

/** The card as plain text — what the layout tests assert against. */
export function plainWorkflowCardLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

/** Apply the theme. Nothing here changes the layout, only its colours. */
export function styleWorkflowCardLines(lines: readonly WorkflowCardLine[], theme: Theme): string[] {
  return lines.map(line =>
    line
      .map(segment => {
        const text = segment.bold ? theme.bold(segment.text) : segment.text;
        return segment.color ? theme.fg(segment.color, text) : text;
      })
      .join(""),
  );
}

/** The card as a component, for a tool result or a session entry renderer. */
export function renderWorkflowCard(input: WorkflowCardInput, theme: Theme): Text {
  return new Text(styleWorkflowCardLines(layoutWorkflowCard(input), theme).join("\n"), 0, 0);
}
