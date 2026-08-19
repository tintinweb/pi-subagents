/**
 * task.ts — the background record one workflow run lives in.
 *
 * A `SubagentWorkflow` tool call returns a task id immediately and the run continues
 * without it, so the run's state cannot live in the tool call's closure: the
 * inline card, the completion notification and (later) the `/agents → Workflows` dialog
 * all read it after `execute` has returned. This is that record, shaped after
 * Claude Code's `local_workflow` task so the fields line up with what the
 * renderers already expect.
 *
 * The progress log is append-only and collapses by index (see `progress.ts`),
 * so every derived counter here is recomputed from the log rather than
 * incremented as entries arrive — a re-emitted agent entry replaces its
 * predecessor, and adding its tokens on top would double-count them.
 */

import { randomUUID } from "node:crypto";
import type { WorkflowJournalEntry } from "./journal.js";
import type { WorkflowMeta } from "./meta.js";
import { collapse, type WorkflowEntry, type WorkflowRunStatus } from "./progress.js";
import type { WorkflowControl, WorkflowRunResult } from "./runtime.js";

/** `wf_` + hex, matching Claude Code's `^wf_[a-z0-9-]{6,}$` run ids. */
export function workflowRunId(): string {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface WorkflowTask {
  /** Discriminator, alongside Claude Code's `local_agent` / `local_bash`. */
  type: "local_workflow";
  id: string;
  status: WorkflowRunStatus;
  script: string;
  /** Where the script can be edited and re-run from. */
  scriptPath?: string;
  args?: unknown;
  meta?: WorkflowMeta;
  workflowName?: string;
  /** The `tool_use_id` of the call that started this, when one did. */
  toolCallId?: string;

  /**
   * Pause, skip and retry, once the run is up.
   *
   * Absent before the runtime hands it over and after the run settles — the
   * dialog treats "no control" as "those keys do nothing", which is the same
   * thing it does for a run that has finished.
   */
  control?: WorkflowControl;
  /** When the current pause started, so `totalPausedMs` can be closed out. */
  pausedAt?: number;

  /** Where this run records its own settled calls, for a later resume. */
  journalPath?: string;
  /** A previous run's journal, when this call asked to resume one. */
  replay?: readonly WorkflowJournalEntry[];
  /** The run id this one resumed, for the result line that says so. */
  resumedFrom?: string;
  /** How many agents came back from {@link replay} instead of being spawned. */
  replayedCount: number;

  /** The append-only event log, in emission order. */
  workflowProgress: WorkflowEntry[];
  /** Bumped once per applied batch, so a renderer can tell nothing changed. */
  progressVersion: number;
  agentCount: number;
  /**
   * Agents that have settled successfully, recomputed with the other counters.
   *
   * Cached rather than derived on read because the fleet list asks five times a
   * second: deriving it there would walk the whole append-only log on every
   * tick, which for a thousand-agent run is real work in the render loop.
   */
  doneCount: number;
  totalTokens: number;
  totalToolCalls: number;
  logs: string[];

  abortController: AbortController;
  startTime: number;
  endTime?: number;
  /** Excluded from the elapsed clock the header shows. */
  totalPausedMs: number;

  /** The script's return value, once the run produced one. */
  value?: unknown;
  error?: string;
}

export function createWorkflowTask(init: {
  id: string;
  script: string;
  scriptPath?: string;
  args?: unknown;
  meta?: WorkflowMeta;
  toolCallId?: string;
  startTime?: number;
  journalPath?: string;
  replay?: readonly WorkflowJournalEntry[];
  resumedFrom?: string;
}): WorkflowTask {
  return {
    type: "local_workflow",
    id: init.id,
    status: "running",
    script: init.script,
    scriptPath: init.scriptPath,
    args: init.args,
    meta: init.meta,
    workflowName: init.meta?.name,
    toolCallId: init.toolCallId,
    journalPath: init.journalPath,
    replay: init.replay,
    resumedFrom: init.resumedFrom,
    replayedCount: 0,
    workflowProgress: [],
    progressVersion: 0,
    agentCount: 0,
    doneCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    logs: [],
    abortController: new AbortController(),
    startTime: init.startTime ?? Date.now(),
    totalPausedMs: 0,
  };
}

/**
 * Apply one batch of progress entries.
 *
 * Batched rather than per-entry because that is how the worker emits them, and
 * because every counter below is an O(log) recompute — doing it once per fan-out
 * frame instead of once per agent is the difference that keeps a 200-agent run
 * cheap to render.
 */
export function updateWorkflowProgressBatch(
  task: WorkflowTask,
  entries: readonly WorkflowEntry[],
): void {
  if (entries.length === 0) return;
  task.workflowProgress.push(...entries);
  task.progressVersion++;

  const { agents, logs } = collapse(task.workflowProgress);
  task.logs = logs;
  // `agentCount` is what the runtime has scheduled, which can lead what the log
  // has seen — never let a recompute walk it backwards.
  task.agentCount = Math.max(task.agentCount, agents.length);

  let totalTokens = 0;
  let totalToolCalls = 0;
  let done = 0;
  for (const agent of agents) {
    totalTokens += agent.tokens ?? 0;
    totalToolCalls += agent.toolCalls ?? 0;
    // Counted off the collapsed agents, so a re-emitted row counts once.
    if (agent.state === "done") done++;
  }
  task.totalTokens = totalTokens;
  task.totalToolCalls = totalToolCalls;
  task.doneCount = done;
}

/**
 * Hold the run, and stop its clock.
 *
 * The elapsed figure every surface shows subtracts `totalPausedMs`, so a run
 * left paused overnight does not come back reading as a twelve-hour run.
 */
export function pauseWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "running" || task.control === undefined) return false;
  task.control.pause();
  task.status = "paused";
  task.pausedAt = now;
  return true;
}

/** Let it go again, banking however long it was held. */
export function resumeWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "paused" || task.control === undefined) return false;
  task.control.resume();
  task.status = "running";
  task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - (task.pausedAt ?? now));
  task.pausedAt = undefined;
  return true;
}

/** Settle a task from the run's own result. */
export function completeWorkflowTask(task: WorkflowTask, result: WorkflowRunResult): void {
  // Banked before the status moves off "paused": a run that finished while held
  // still spent that time held, and the elapsed figure has to say so.
  if (task.pausedAt !== undefined) {
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, Date.now() - task.pausedAt);
    task.pausedAt = undefined;
  }
  // Nothing left to control, and holding the handle would let the dialog offer
  // pause on a run that has already stopped.
  task.control = undefined;
  task.status = result.status;
  task.meta ??= result.meta;
  task.workflowName ??= result.meta.name;
  task.agentCount = Math.max(task.agentCount, result.agentCount);
  task.replayedCount = result.replayedCount;
  task.value = result.value;
  task.error = result.error;
  task.endTime = Date.now();
}

/**
 * Settle a task that never produced a result — a script rejected before the
 * worker started (bad `meta`, oversized source, non-JSON `args`).
 */
export function failWorkflowTask(task: WorkflowTask, error: string): void {
  task.control = undefined;
  task.pausedAt = undefined;
  task.status = "failed";
  task.error = error;
  task.endTime = Date.now();
}

/** The run's outcome as text, for the notification and the LLM-facing result. */
export function workflowResultText(task: WorkflowTask): string {
  if (task.error !== undefined) return task.error;
  if (task.value === undefined) return "No output.";
  if (typeof task.value === "string") return task.value;
  return JSON.stringify(task.value, null, 2);
}
