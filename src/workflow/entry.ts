/**
 * entry.ts — what a finished workflow leaves behind in the session transcript.
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
