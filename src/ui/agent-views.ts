/**
 * agent-views.ts — Transcript / Info / Prompt / Output picker and info-line builder.
 *
 * One overlay has four views. This module owns the names, the letter keys, the
 * picker that chooses a view before the overlay opens, and the Info body so
 * ConversationViewer does not have to know how the picker is spelled.
 * Keys are t/i/p/o so they do not collide with workflow-dialog s (skip) / p (pause)
 * while that dialog has focus; overlay and dialog never share a key stream.
 */

import { isKeyRelease, Key, matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import {
  buildInvocationTags,
  formatCost,
  formatDuration,
  formatTokens,
  getDisplayName,
  type Theme,
} from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

export const AGENT_VIEWS = ["transcript", "info", "prompt", "output"] as const;
export type AgentViewerView = (typeof AGENT_VIEWS)[number];

export const VIEW_LABELS: Record<AgentViewerView, string> = {
  transcript: "Transcript",
  info: "Info",
  prompt: "Prompt",
  output: "Output",
};

const VIEW_KEYS = ["t", "i", "p", "o"] as const;
const VIEW_BY_KEY: Record<(typeof VIEW_KEYS)[number], AgentViewerView> = {
  t: "transcript",
  i: "info",
  p: "prompt",
  o: "output",
};

/** Map a keypress to a view, or undefined when it is not a view key. */
export function viewFromKey(data: string): AgentViewerView | undefined {
  for (const key of VIEW_KEYS) {
    if (matchesKey(data, key)) return VIEW_BY_KEY[key];
  }
  return undefined;
}

/** Compact local wall-clock stamp for the Info view. */
export function formatWallClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Info-view body. No turn count — that is the one stat this surface refuses.
 * Cost follows the same `showCost` gate as the Transcript header.
 */
export function buildInfoLines(record: AgentRecord, showCost: boolean): string[] {
  const lines: string[] = [];
  const inv = record.invocation;
  const { modelName, modelId, tags } = buildInvocationTags(inv);
  const model = modelId ?? modelName;

  lines.push(`Status:    ${record.status}`);
  lines.push(`Model:     ${model ?? "unknown"}`);
  const thinking = tags.find(t => t.startsWith("thinking: "));
  if (thinking) lines.push(`Thinking:  ${thinking.slice("thinking: ".length)}`);
  const tokens = getLifetimeTotal(record.lifetimeUsage);
  if (tokens > 0) lines.push(`Tokens:    ${formatTokens(tokens)}`);
  if (showCost) {
    const cost = formatCost(getLifetimeCost(record.lifetimeUsage));
    if (cost) lines.push(`Cost:      ${cost}`);
  }
  lines.push(`Tools:     ${record.toolUses}`);
  lines.push(`Elapsed:   ${formatDuration(record.startedAt, record.completedAt)}`);
  lines.push(`Started:   ${formatWallClock(record.startedAt)}`);
  lines.push(`Ended:     ${record.completedAt ? formatWallClock(record.completedAt) : "running"}`);
  const flags = tags.filter(t => !t.startsWith("thinking: "));
  if (flags.length > 0) lines.push(`Flags:     ${flags.join(", ")}`);
  if (record.compactionCount > 0) lines.push(`Compactions: ${record.compactionCount}`);
  return lines;
}

/** Four-row view picker: arrows + Enter, or t/i/p/o. */
export class ViewPicker {
  private index = 0;
  private keys: ViewerKeys;

  constructor(
    private tui: TUI,
    private theme: Theme,
    keybindings: ViewerKeybindings | undefined,
    private done: (view: AgentViewerView | undefined) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }
    const byKey = viewFromKey(data);
    if (byKey) {
      this.done(byKey);
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, Key.enter)) {
      this.done(AGENT_VIEWS[this.index]);
      return;
    }
    if (this.keys.scrollUp(data)) {
      this.index = Math.max(0, this.index - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.scrollDown(data)) {
      this.index = Math.min(AGENT_VIEWS.length - 1, this.index + 1);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    const lines: string[] = [hrTop];
    lines.push(row(th.bold("View")));
    lines.push(hrMid);
    for (let i = 0; i < AGENT_VIEWS.length; i++) {
      const view = AGENT_VIEWS[i];
      const selected = i === this.index;
      const bullet = selected ? th.fg("accent", "●") : th.fg("dim", "○");
      const label = VIEW_LABELS[view];
      const key = Object.entries(VIEW_BY_KEY).find(([, v]) => v === view)?.[0] ?? "";
      const text = selected ? th.bold(label) : th.fg("muted", label);
      const hint = th.fg("dim", key);
      const left = `${bullet} ${text}`;
      const gap = Math.max(1, innerW - visibleWidth(left) - visibleWidth(hint));
      lines.push(row(left + " ".repeat(gap) + hint));
    }
    lines.push(hrMid);
    lines.push(row(th.fg("dim", "t/i/p/o · ↑↓ · Enter open · Esc back")));
    lines.push(hrBot);
    return lines;
  }

  invalidate(): void { /* no cached state */ }
}

/** Result of the running-agent list: a record, plus a view when t/i/p/o skipped the picker. */
export type RunningAgentChoice = { record: AgentRecord; view?: AgentViewerView };

/** Numbered agent list. Enter opens the view picker; t/i/p/o open that view at once. */
export class RunningAgentPicker {
  private index = 0;
  private keys: ViewerKeys;

  constructor(
    private tui: TUI,
    private theme: Theme,
    keybindings: ViewerKeybindings | undefined,
    private agents: readonly AgentRecord[],
    private done: (choice: RunningAgentChoice | undefined) => void,
  ) {
    this.keys = createViewerKeys(keybindings);
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.done(undefined);
      return;
    }
    const record = this.agents[this.index];
    if (!record) return;
    const byKey = viewFromKey(data);
    if (byKey) {
      this.done({ record, view: byKey });
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, Key.enter)) {
      this.done({ record });
      return;
    }
    if (this.keys.scrollUp(data)) {
      this.index = Math.max(0, this.index - 1);
      this.tui.requestRender();
      return;
    }
    if (this.keys.scrollDown(data)) {
      this.index = Math.min(this.agents.length - 1, this.index + 1);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    const lines: string[] = [hrTop];
    lines.push(row(`${th.bold("Running agents")}${th.fg("dim", " · t/i/p/o")}`));
    lines.push(hrMid);
    const numW = String(this.agents.length).length;
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const selected = i === this.index;
      const bullet = selected ? th.fg("accent", "●") : th.fg("dim", "○");
      const n = String(i + 1).padStart(numW);
      const dur = formatDuration(a.startedAt, a.completedAt);
      const label = `${n}. ${getDisplayName(a.type)} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
      const text = selected ? th.bold(label) : th.fg("muted", label);
      lines.push(row(`${bullet} ${text}`));
    }
    lines.push(hrMid);
    lines.push(row(th.fg("dim", "↑↓ select · enter view · t/i/p/o · esc back")));
    lines.push(hrBot);
    return lines;
  }

  invalidate(): void { /* no cached state */ }
}

/** Minimal UI surface the picker needs from `ctx.ui` / FleetView. */
export type ViewPickerUI = {
  custom<T>(
    factory: (
      tui: any,
      theme: Theme,
      keybindings: any,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void },
    options?: { overlay?: boolean; overlayOptions?: unknown },
  ): Promise<T>;
};

/** Open the four-view picker and return the chosen view, or undefined on cancel. */
export async function pickAgentView(ui: ViewPickerUI): Promise<AgentViewerView | undefined> {
  return ui.custom<AgentViewerView | undefined>(
    (tui, theme, keybindings, done) => new ViewPicker(tui, theme, keybindings, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "50%", minWidth: 36, maxHeight: "50%" },
    },
  );
}

/** Open the running-agent list. Enter then picks a view; t/i/p/o skip that picker. */
export async function pickRunningAgent(
  ui: ViewPickerUI,
  agents: readonly AgentRecord[],
): Promise<RunningAgentChoice | undefined> {
  return ui.custom<RunningAgentChoice | undefined>(
    (tui, theme, keybindings, done) => new RunningAgentPicker(tui, theme, keybindings, agents, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "80%", minWidth: 48, maxHeight: "70%" },
    },
  );
}
