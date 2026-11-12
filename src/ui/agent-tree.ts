/**
 * agent-tree.ts — Nested subagents laid out under their parent.
 *
 * Shared by the two surfaces that list nested children — FleetView and
 * `/agents → Running agents` — so both draw the same tree. Every other
 * user-facing surface filters on `isTopLevelAgent`.
 */

import type { AgentRecord } from "../types.js";

export interface AgentTreeRow {
  record: AgentRecord;
  /** Tree glyphs before the row (`├ `, `└ `, `│ ` continuation); `""` at top level. */
  prefix: string;
}

/**
 * `records` as a tree: each top-level record in the order given, then its
 * children depth-first under it, siblings earliest-launched first. A child
 * whose parent is not in `records` is dropped — it has no row to hang from.
 */
export function agentTree(records: readonly AgentRecord[]): AgentTreeRow[] {
  const children = new Map<string, AgentRecord[]>();
  for (const record of records) {
    if (record.parentAgentId === undefined) continue;
    const siblings = children.get(record.parentAgentId);
    if (siblings) siblings.push(record);
    else children.set(record.parentAgentId, [record]);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.startedAt - b.startedAt);

  const rows: AgentTreeRow[] = [];
  // `indent` is what a child's own children continue with: a rail under a
  // `├`, blank under the last sibling's `└`.
  const visit = (record: AgentRecord, prefix: string, indent: string): void => {
    rows.push({ record, prefix });
    const kids = children.get(record.id) ?? [];
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      visit(kid, indent + (last ? "└ " : "├ "), indent + (last ? "  " : "│ "));
    });
  };
  for (const record of records) if (record.parentAgentId === undefined) visit(record, "", "");
  return rows;
}
