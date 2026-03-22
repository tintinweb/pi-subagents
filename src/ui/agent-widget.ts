/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@mariozechner/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { SubagentType } from "../types.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  tokens: string;
  responseText: string;
  session?: { getSessionStats(): { tokens: { total: number } } };
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/** Format turn count with optional max limit: "⟳5≤30" or "⟳5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `⟳${turnCount}≤${maxTurns}` : `⟳${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
  ) {}

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and prunes those that have lingered long enough.
   */
  onTurnStart() {
    for (const [id, age] of this.finishedTurnAge) {
      const newAge = age + 1;
      if (newAge > AgentWidget.ERROR_LINGER_TURNS) { // upper bound; renderWidget does exact filtering
        this.finishedTurnAge.delete(id);
      } else {
        this.finishedTurnAge.set(id, newAge);
      }
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: { id: string; type: SubagentType; status: string; description: string; toolUses: number; startedAt: number; completedAt?: number; error?: string }, theme: Theme): string {
    const name = getDisplayName(a.type);
    const modeLabel = getPromptModeLabel(a.type);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const parts: string[] = [];
    const activity = this.agentActivity.get(a.id);
    if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    parts.push(duration);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    return `${icon} ${theme.fg("dim", name)}${modeTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.manager.listAgents();
    const running = allAgents.filter(a => a.status === "running");
    const queued = allAgents.filter(a => a.status === "queued");
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(a, theme)));
    }

    const runningLines: string[][] = []; // each entry is [header, activity]
    for (const a of running) {
      const name = getDisplayName(a.type);
      const modeLabel = getPromptModeLabel(a.type);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.agentActivity.get(a.id);
      const toolUses = bg?.toolUses ?? a.toolUses;
      let tokenText = "";
      if (bg?.session) {
        try { tokenText = formatTokens(bg.session.getSessionStats().tokens.total); } catch { /* */ }
      }

      const parts: string[] = [];
      if (bg) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
      if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
      if (tokenText) parts.push(tokenText);
      parts.push(elapsed);
      const statsText = parts.join(" · ");

      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

      runningLines.push([
        truncate(theme.fg("dim", "├─") + ` ${theme.fg("accent", frame)} ${theme.bold(name)}${modeTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", statsText)}`),
        truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`)),
      ]);
    }

    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;

    // Assemble with overflow cap (heading + overflow indicator = 2 reserved lines).
    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

    if (totalBody <= maxBody) {
      // Everything fits — add all lines and fix up connectors for the last item.
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
        // If last item is a running agent activity line, fix indent of that line
        // and fix the header line above it.
        if (runningLines.length > 0 && !queuedLine) {
          // The last two lines are the last running agent's header + activity.
          if (last >= 2) {
            lines[last - 1] = lines[last - 1].replace("├─", "└─");
            lines[last] = lines[last].replace("│  ", "   ");
          }
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished.
      // Reserve 1 line for overflow indicator.
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // 1. Running agents (2 lines each)
      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      // 2. Queued line
      if (queuedLine && budget >= 1) {
        lines.push(queuedLine);
        budget--;
      }

      // 3. Finished agents
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`)
      );
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
