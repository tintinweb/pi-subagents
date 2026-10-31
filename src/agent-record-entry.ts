/**
 * agent-record-entry.ts — what a finished top-level agent leaves behind in the session.
 *
 * The live record is evicted about ten minutes after the agent finishes, read or
 * not, and is gone after a reload or a restart. Its completion notification
 * carries only a preview of the result and points at `get_subagent_result` for
 * the rest, so that pointer has to outlive the record: the final record is
 * appended to the session as this entry, and `get_subagent_result` falls back
 * to it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

/** `customType` of the session entry a finished top-level agent appends. */
export const AGENT_RECORD_ENTRY_TYPE = "subagents:record";

/** The persisted snapshot of a finished agent. */
export interface AgentRecordEntryData {
  id: string;
  type: AgentRecord["type"];
  description: string;
  status: AgentRecord["status"];
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

/** Snapshot a finished record for {@link AGENT_RECORD_ENTRY_TYPE}. */
export function agentRecordEntryData(record: AgentRecord): AgentRecordEntryData {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    result: record.result,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

function isAgentRecordEntryData(data: unknown): data is AgentRecordEntryData {
  if (typeof data !== "object" || data === null) return false;
  const { id, type, status, startedAt } = data as Record<string, unknown>;
  return typeof id === "string" && typeof type === "string" && typeof status === "string" && typeof startedAt === "number";
}

/**
 * The latest persisted record of agent `id` on the current branch. A resumed
 * agent appends a new entry on each finish, so the last one wins; an entry on
 * an abandoned branch is not this conversation's.
 */
export function findAgentRecordEntry(ctx: ExtensionContext, id: string): AgentRecordEntryData | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY_TYPE) continue;
    if (isAgentRecordEntryData(entry.data) && entry.data.id === id) return entry.data;
  }
  return undefined;
}
