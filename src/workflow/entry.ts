/**
 * entry.ts — what a workflow leaves behind in the session transcript: the card
 * a flag-launched run renders through, and the run record a `SubagentWorkflow`
 * run is found by after a reload or a restart ({@link WORKFLOW_RUN_ENTRY_TYPE}).
 *
 * A workflow started from `--subagents-workflow-file` has no tool call to hang
 * its result card on, so it appends a custom session entry instead. That entry
 * has to survive a reload, which is why this is a plain-JSON snapshot rather
 * than the live {@link WorkflowTask}: the task holds an `AbortController`, the
 * script source and the run's control handle, none of which belongs in a
 * session file.
 *
 * Deliberately free of any renderer import. The card this data renders through
 * lives in `ui/workflow-card.ts` (`renderWorkflowEntryCard`), so the shape a
 * session file stores does not depend on the code that draws it.
 */

import { latestEntriesById } from "../agent-record-entry.js";
import type { WorkflowMeta } from "./meta.js";
import type { WorkflowEntry, WorkflowRunStatus } from "./progress.js";
import type { WorkflowTask } from "./task.js";

/** `customType` of the session entry a flag-launched workflow renders through. */
export const WORKFLOW_ENTRY_TYPE = "subagents:workflow";

/** The persisted snapshot of a settled run. */
export interface WorkflowEntryData {
  name: string;
  status: WorkflowRunStatus;
  startTime: number;
  endTime?: number;
  progress: WorkflowEntry[];
  agentCount: number;
  totalTokens: number;
  meta?: WorkflowMeta;
}

/** Snapshot a settled task for {@link WORKFLOW_ENTRY_TYPE}. */
export function workflowEntryData(task: WorkflowTask): WorkflowEntryData {
  return {
    name: task.workflowName ?? task.id,
    status: task.status,
    startTime: task.startTime,
    endTime: task.endTime,
    progress: task.workflowProgress,
    agentCount: task.agentCount,
    totalTokens: task.totalTokens,
    ...(task.meta !== undefined ? { meta: task.meta } : {}),
  };
}

/**
 * `customType` of the record a `SubagentWorkflow` run leaves in the session:
 * once when it starts, with `status: "running"`, and again when it settles. A
 * reload or a restart forgets the in-memory run, so this is what lets
 * `resumeFromRunId` find it afterwards, and what tells the next session about
 * a run that never settled. Separate from {@link WORKFLOW_ENTRY_TYPE}, whose
 * entries each draw a result card.
 */
export const WORKFLOW_RUN_ENTRY_TYPE = "subagents:workflow-run";

/** A `SubagentWorkflow` run, as {@link WORKFLOW_RUN_ENTRY_TYPE} saves it. */
export interface WorkflowRunEntryData {
  runId: string;
  name: string;
  status: WorkflowRunStatus;
  startTime: number;
  endTime?: number;
  /** The script it ran, which a resume re-runs when given no other. */
  scriptPath?: string;
  /** Its settled calls, which a resume replays. */
  journalPath?: string;
  /** `session_end`: killed by the session shutting down, not by the user. */
  stopReason?: "session_end";
  /** The model was told this run was lost; a later session does not tell it again. */
  lostNoticeSent?: boolean;
}

/** Snapshot a run for {@link WORKFLOW_RUN_ENTRY_TYPE}. */
export function workflowRunEntryData(task: WorkflowTask): WorkflowRunEntryData {
  return {
    runId: task.id,
    name: task.workflowName ?? task.id,
    status: task.status,
    startTime: task.startTime,
    endTime: task.endTime,
    scriptPath: task.scriptPath,
    journalPath: task.journalPath,
    stopReason: task.stopReason,
  };
}

function isWorkflowRunEntryData(data: unknown): data is WorkflowRunEntryData {
  if (typeof data !== "object" || data === null) return false;
  const { runId, name, status, startTime } = data as Record<string, unknown>;
  return typeof runId === "string" && typeof name === "string" && typeof status === "string" && typeof startTime === "number";
}

/** The latest saved record of each run on the branch, oldest run first. */
export function latestWorkflowRunEntries(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): WorkflowRunEntryData[] {
  return latestEntriesById(entries, WORKFLOW_RUN_ENTRY_TYPE, isWorkflowRunEntryData, (data) => data.runId);
}

/**
 * Runs a previous session lost: the latest record says `running`, or `killed`
 * by the session ending, and the run is not live in this process. The same
 * rule as `findLostAgentEntries`; a user's kill is not a loss.
 */
export function findLostWorkflowRuns(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
  isLive: (runId: string) => boolean,
): WorkflowRunEntryData[] {
  return latestWorkflowRunEntries(entries).filter(
    (data) =>
      !data.lostNoticeSent &&
      (data.status === "running" || (data.status === "killed" && data.stopReason === "session_end")) &&
      !isLive(data.runId),
  );
}
