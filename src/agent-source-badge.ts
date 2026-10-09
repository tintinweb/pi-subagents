/**
 * agent-source-badge.ts — How `/agents → Agent types` shows where an agent came
 * from: the per-row badge, the legend that explains the badges actually on
 * screen, and the description line under the highlighted row.
 *
 * These live outside src/index.ts for the same reason as agent-file-toggle.ts:
 * the `/agents` handler is a large closure reached only through
 * `registerCommand`, which every test mocks, so nothing inside it can be
 * asserted on directly.
 *
 * The badges are deliberately terse — the list is one row per agent and the
 * model already occupies the right-hand column. Anything wordier than a glyph
 * (the package's name, in particular) goes on the description line, which
 * `SettingsList` renders for the highlighted row only.
 */

import type { AgentConfig } from "./types.js";

/**
 * The badge column: a two-cell glyph plus a space, so every label starts at the
 * same offset whether or not the agent is badged.
 *
 * Built-in defaults are unmarked. They are the majority of the list, and a
 * badge on them would make the three that matter — the agents the user or a
 * package put there — harder to pick out, not easier.
 */
export function sourceIndicator(cfg: AgentConfig | undefined): string {
  const disabled = cfg?.enabled === false;
  if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
  if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
  if (cfg?.source === "package") return disabled ? "✕▪ " : "▪  ";
  if (disabled) return "✕  ";
  return "   ";
}

/**
 * The legend line, naming only the badges the given roster actually renders.
 *
 * Keyed on what `sourceIndicator` would emit, so the two cannot drift into a
 * glyph with no key (which is what `▪` was) or a key for a glyph that is not on
 * screen. A defaults-only roster returns "", and the caller omits the line.
 *
 * `source` is undefined for built-in defaults — the `"default"` member of the
 * union is declared but never assigned, since default-agents.ts sets only
 * `isDefault` — so they contribute no key, matching their blank badge.
 */
export function sourceLegend(cfgs: readonly (AgentConfig | undefined)[]): string {
  const parts: string[] = [];
  if (cfgs.some(c => c?.source === "project")) parts.push("• = project");
  if (cfgs.some(c => c?.source === "global")) parts.push("◦ = global");
  if (cfgs.some(c => c?.source === "package")) parts.push("▪ = package");
  if (cfgs.some(c => c?.enabled === false)) parts.push("✕ = disabled");
  return parts.join("  ");
}

/**
 * The description line under the highlighted row.
 *
 * `packageName` is the one piece of provenance a badge cannot carry: with two
 * agent-providing packages installed, `▪` says only that *some* package won.
 * It is prefixed rather than appended so it stays visible when a long
 * description wraps, and it prefixes "(disabled)" too — a disabled package
 * agent is exactly the case where you want to know whose it was.
 *
 * Falls back to the agent's own name when it has no description, which is what
 * a hand-written agent file without one already showed.
 */
export function rowDescription(
  name: string,
  cfg: AgentConfig | undefined,
  packageName?: string,
): string {
  const base = cfg?.enabled === false ? "(disabled)" : (cfg?.description ?? name);
  return packageName ? `${packageName} · ${base}` : base;
}
