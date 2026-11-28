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
 *
 * A top-level background agent also appends one when its session is created,
 * with `status: "running"`. Its settle entry supersedes it; if the process dies
 * first, or the shutdown stop never lands, that entry is what the next session
 * finds — see {@link findLostAgentEntries}.
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
  /**
   * The agent's `.output` transcript, when it writes one. It sits in the OS
   * temp dir, so it can be gone while the session file is not.
   */
  outputFile?: string;
  /** Names to give back to the reopened agent, as the `@handle` path does. */
  handle?: string;
  alias?: string;
  /** Set when the agent's work lived in a worktree that is now gone — see {@link worktreeLost}. */
  worktreeLost?: boolean;
  /** `session_end`: stopped by the session shutting down, not by the user. */
  stopReason?: AgentRecord["stopReason"];
  /** The model was told this agent was lost; a later session does not tell it again. */
  lostNoticeSent?: boolean;
}

/**
 * Whether the agent ran in a worktree that held its work and has since been
 * removed. Settling always removes the worktree, committing any changes to a
 * branch first, so only a clean one (`hasChanges: false`) leaves nothing
 * behind; a run that failed before cleanup reported nothing and counts as lost.
 * Claude Code draws the same line: it resumes an isolated agent outside its
 * worktree only when the worktree was removed clean, and never builds a fresh
 * one on resume.
 */
export function worktreeLost(record: Pick<AgentRecord, "worktree" | "worktreeResult">): boolean {
  return record.worktree !== undefined && record.worktreeResult?.hasChanges !== false;
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
    outputFile: record.outputFile,
    handle: record.handle,
    alias: record.alias,
    worktreeLost: worktreeLost(record) || undefined,
    stopReason: record.stopReason,
  };
}

function isAgentRecordEntryData(data: unknown): data is AgentRecordEntryData {
  if (typeof data !== "object" || data === null) return false;
  const { id, type, status, startedAt } = data as Record<string, unknown>;
  return typeof id === "string" && typeof type === "string" && typeof status === "string" && typeof startedAt === "number";
}

/**
 * The latest persisted record of `id` on the current branch. A resumed agent
 * appends a new entry on each finish, so the last one wins; an entry on an
 * abandoned branch is not this conversation's.
 *
 * When `matchHandle` is set, the handle and alias match too, case-insensitively
 * like `@handle`, and only if no entry's id is `id`. Resume leaves it off: it
 * reopens whatever this returns, and a handle would reopen a saved session
 * while that agent's live record still exists.
 */
export function findAgentRecordEntry(ctx: ExtensionContext, id: string, matchHandle = false): AgentRecordEntryData | undefined {
  const entries = ctx.sessionManager.getBranch();
  const wanted = id.toLowerCase();
  let named: AgentRecordEntryData | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY_TYPE) continue;
    if (!isAgentRecordEntryData(entry.data)) continue;
    if (entry.data.id === id) return entry.data;
    if (
      matchHandle &&
      named === undefined &&
      (entry.data.handle?.toLowerCase() === wanted || entry.data.alias?.toLowerCase() === wanted)
    ) {
      named = entry.data;
    }
  }
  return named;
}

/** The fields of a session entry these readers look at. */
type SessionEntryLike = { type: string; customType?: string; data?: unknown };

/**
 * The latest saved record of each agent on the branch, oldest agent first. A
 * resumed agent appends an entry on every finish, so only its last one counts.
 */
export function latestAgentRecordEntries(entries: readonly SessionEntryLike[]): AgentRecordEntryData[] {
  return latestEntriesById(entries, AGENT_RECORD_ENTRY_TYPE, isAgentRecordEntryData, (data) => data.id);
}

/**
 * The latest entry of `customType` for each key on the branch, in order of
 * each key's first entry. Shared with the workflow run records, which are
 * superseded the same way.
 */
export function latestEntriesById<T>(
  entries: readonly SessionEntryLike[],
  customType: string,
  isData: (data: unknown) => data is T,
  keyOf: (data: T) => string,
): T[] {
  const latest = new Map<string, T>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== customType) continue;
    if (!isData(entry.data)) continue;
    latest.set(keyOf(entry.data), entry.data);
  }
  return [...latest.values()];
}

/**
 * Agents a previous session lost: the latest entry of each id on the branch
 * says it was still `running` (the process died before it settled, or its
 * shutdown stop never landed), or `stopped` by the session ending. A user's
 * stop is not a loss, and an agent live in this process is not lost. One the
 * model was already told about (`lostNoticeSent`) is left out, so reopening a
 * session does not repeat the notice. Oldest first.
 */
export function findLostAgentEntries(
  entries: readonly SessionEntryLike[],
  isLive: (id: string) => boolean,
): AgentRecordEntryData[] {
  return latestAgentRecordEntries(entries).filter(
    (data) =>
      !data.lostNoticeSent &&
      (data.status === "running" || (data.status === "stopped" && data.stopReason === "session_end")) &&
      !isLive(data.id),
  );
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
 * way back. `@handle` and the Agent tool reload the agent files first.
 *
 * `worktreeLost` refuses for good, as Claude Code does ("its worktree no
 * longer exists"): the conversation's edits were made in a directory that is
 * gone, and reopening it in the parent's checkout or a fresh worktree would
 * continue that work somewhere it never happened.
 */
export function reopenTarget(
  type: string,
  sessionFile: string | undefined,
  worktreeLost?: boolean,
): { ok: true; type: SubagentType; sessionFile: string } | { ok: false; reason: string; gone: boolean } {
  if (sessionFile === undefined) {
    return { ok: false, reason: "its conversation was not saved (`rememberAgents` or `persist_session` was off)", gone: true };
  }
  if (!existsSync(sessionFile)) return { ok: false, reason: "its session is gone", gone: true };
  if (worktreeLost) return { ok: false, reason: "its worktree no longer exists", gone: true };
  const dispatch = resolveSpawnType(type);
  if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
    return { ok: false, reason: `the ${type} agent is no longer available`, gone: false };
  }
  return { ok: true, type: dispatch.type, sessionFile };
}
