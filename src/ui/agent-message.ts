/**
 * agent-message.ts — how an agent's `SendMessage` to the main session renders in the chat.
 *
 * Claude Code's row (`kce` collapsed, `ah` expanded), reproduced:
 *
 *   › Message from @general-purpose (ctrl+o to expand)
 *
 *   › Message from general-purpose
 *     <the sender's own words, indented two>
 *
 * Collapsed is one dim line with no preview of the body; several messages from
 * one sender read `› 3 messages from @X`. The model-facing wrapper (header,
 * `<agent-message>` tags, the permission tail) never shows — only what the
 * sender wrote.
 *
 * A click toggles one row, separately from the global expand key, and does
 * nothing while that key has everything expanded (Claude Code's `Kv`). pi
 * delivers clicks only in its fullscreen mode; elsewhere the key is the toggle.
 * pi rebuilds a message's component on every global toggle, so the per-row
 * state lives here, keyed by message, not on the component.
 */

import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export const AGENT_MESSAGE_TYPE = "subagent-message";

export interface AgentMessageEntry {
  fromId: string;
  fromName: string;
  /** The sender's own words, unwrapped. */
  text: string;
}

export interface AgentMessageDetails {
  messages: AgentMessageEntry[];
}

/** Rows a click has expanded, by message key; the oldest drop out past the cap. */
const clickExpanded = new Set<string>();
const CLICK_EXPANDED_MAX = 500;

/** Claude Code's `NS`: no control or format characters, at most 64 characters. */
export function displayName(name: string): string {
  const cleaned = name.replace(/[\p{Cc}\p{Cf}]/gu, "");
  const short = cleaned.length > 64 ? `${cleaned.slice(0, 64)}…` : cleaned;
  return short || "agent";
}

/** Claude Code's `wOt`: the `@` form, with anything outside `[\w-]` turned into `-`. */
export function mentionName(name: string): string {
  return displayName(name).replace(/[^\w\-…]/g, "-");
}

/** Messages grouped by sender, in arrival order. */
function bySender(messages: AgentMessageEntry[]): AgentMessageEntry[][] {
  const groups = new Map<string, AgentMessageEntry[]>();
  for (const m of messages) {
    const group = groups.get(m.fromId);
    if (group) group.push(m);
    else groups.set(m.fromId, [m]);
  }
  return [...groups.values()];
}

/** The row's text for one state. Exported for tests. */
export function renderAgentMessageText(details: AgentMessageDetails, expanded: boolean, theme: Pick<Theme, "fg">): string {
  let expandKey = "ctrl+o";
  try { expandKey = keyText("app.tools.expand"); } catch { /* keybindings not loaded */ }
  return bySender(details.messages).map(group => {
    const from = group[0].fromName;
    const count = group.length === 1 ? "Message" : `${group.length} messages`;
    if (!expanded) return theme.fg("dim", `› ${count} from @${mentionName(from)} (${expandKey} to expand)`);
    const body = group.map(m => m.text.split("\n").map(line => `  ${line}`).join("\n")).join("\n\n");
    return `${theme.fg("dim", `› ${count} from ${displayName(from)}`)}\n${body}`;
  }).join("\n");
}

/** The row pi renders; `key` identifies the message across rebuilds. */
export class AgentMessageRow implements Component {
  private text = new Text("", 0, 0);

  constructor(
    private key: string,
    private details: AgentMessageDetails,
    private globalExpanded: boolean,
    private theme: Pick<Theme, "fg">,
  ) {}

  private expanded(): boolean {
    return this.globalExpanded || clickExpanded.has(this.key);
  }

  render(width: number): string[] {
    this.text.setText(renderAgentMessageText(this.details, this.expanded(), this.theme));
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || this.globalExpanded) return undefined;
    if (clickExpanded.has(this.key)) clickExpanded.delete(this.key);
    else {
      clickExpanded.add(this.key);
      if (clickExpanded.size > CLICK_EXPANDED_MAX) clickExpanded.delete(clickExpanded.values().next().value!);
    }
    this.text.invalidate();
    return { handled: true, render: true };
  }
}

