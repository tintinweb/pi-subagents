/**
 * agent-record-entry.ts — what a finished top-level agent leaves behind in the session.
 *
 * The live record is evicted about ten minutes after the agent finishes, read or
 * not, and is gone after a reload or a restart. Its completion notification
 * carries only a preview of the result and points at `get_subagent_result` for
 * the rest, so that pointer has to outlive the record: the final record is
 * appended to the session as this entry, and `get_subagent_result` falls back
 * to it.
 *
 * It is also what lets `Agent({ resume })` reopen an evicted agent: the entry
 * names the session file the conversation lives in, so the id the model holds
 * still leads somewhere after eviction, a reload or a restart.
 */

import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSpawnType } from "./agent-types.js";
import type { AgentRecord, SubagentType } from "./types.js";

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
  /**
   * The agent's persisted pi session, when it has one — what a resume reopens.
   * Absent for an in-memory session (`rememberAgents` off, or
   * `persist_session: false`), which leaves nothing to come back to.
   */
  sessionFile?: string;
  /** Names to give back to the reopened agent, as the `@handle` path does. */
  handle?: string;
  alias?: string;
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
    sessionFile: record.sessionFile,
    handle: record.handle,
    alias: record.alias,
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

/**
 * Whether an evicted agent's saved conversation can be reopened, and the
 * agent type to reopen it under. Shared by `@handle`, `Agent({ resume })` and
 * a workflow's `resume`, so all three refuse the same cases in the same words;
 * `reason` completes "Could not resume X —" and "cannot be resumed —".
 *
 * The file is checked here rather than left to SessionManager.open: that runs
 * inside runAgent, whose rejection lands on the record as an agent error, not
 * as a refusal. A `/new` in another pi window or a manual delete makes the
 * conversation unrecoverable (Claude Code's `not_reachable`); `gone` marks
 * that, and the no-file case, as refusals that can never clear.
 *
 * The Agent tool deliberately falls back to general-purpose for a type it
 * cannot resolve (#183), which covers a deleted file AND a merely disabled
 * one. A resume must not inherit that: reopening this conversation under a
 * different agent's prompt and tools is not continuing it, and the new record
 * would re-tombstone under the substitute, so the handle would never find its
 * way back. Callers reload the agent files first.
 */
export function reopenTarget(
  type: string,
  sessionFile: string | undefined,
): { ok: true; type: SubagentType; sessionFile: string } | { ok: false; reason: string; gone: boolean } {
  if (sessionFile === undefined) {
    return { ok: false, reason: "its conversation was not saved (`rememberAgents` or `persist_session` was off)", gone: true };
  }
  if (!existsSync(sessionFile)) return { ok: false, reason: "its session is gone", gone: true };
  const dispatch = resolveSpawnType(type);
  if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
    return { ok: false, reason: `the ${type} agent is no longer available`, gone: false };
  }
  return { ok: true, type: dispatch.type, sessionFile };
}
