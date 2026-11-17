/**
 * workflow-info.ts — The one workflow-run shape other extensions read off the bus.
 *
 * `subagents:workflow_started` / `subagents:workflow_settled` carry `WorkflowInfo`;
 * `subagents:rpc:workflow_get` returns `WorkflowDetail` (the summary plus the live
 * per-agent snapshot) and `subagents:rpc:workflow_list` returns `WorkflowInfo[]`.
 * It is a public contract, so it is built from a whitelist: a field reaches a
 * listener only by being named here, never because it was added to `WorkflowTask`
 * or `WorkflowAgentEntry`. The agent entries are explicitly unstable internally
 * (last-write-by-index, mutated in place, churn fields), so `WorkflowAgentInfo`
 * copies a fixed subset into fresh objects rather than exposing them. Documented
 * in docs/rpc.md. Mirrors subagent-info.ts.
 *
 * A key whose value is unknown is omitted, never present as `undefined`.
 */
import {
  collapse,
  elapsedMs,
  stats,
  type WorkflowAgentEntry,
  type WorkflowEntryState,
  type WorkflowRunStatus,
} from "./workflow/progress.js";
import type { WorkflowTask } from "./workflow/task.js";

export interface WorkflowInfo {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  startedAt: number;
  /** Until the run settles, the time elapsed so far; excludes paused time. */
  durationMs: number;
  /** Agents the run has scheduled. */
  agentCount: number;
  /** Agents that have settled successfully. */
  doneCount: number;
  /** Agents that failed. */
  failedCount: number;
  totalTokens: number;
  totalToolCalls: number;
  /** `Reviewing (2/3)` — phases with work outstanding, or `""`. */
  phaseLabel: string;
  /** From the script's `meta`. */
  description?: string;
  /** The `tool_use_id` of the call that started this; absent on the CLI path. */
  toolCallId?: string;
  completedAt?: number;
  error?: string;
  /** Per-agent failure lines, when the run failed with any. */
  failures?: string[];
}

/** One agent in a `WorkflowDetail`, a fixed subset of the internal entry. */
export interface WorkflowAgentInfo {
  /** Stable identity within the run. */
  index: number;
  label: string;
  state: WorkflowEntryState;
  phaseIndex?: number;
  phaseTitle?: string;
  agentType?: string;
  /** Effective short model label, once the child's session reports one. */
  model?: string;
  thinking?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  error?: string;
  skipped?: boolean;
  resultPreview?: string;
  /**
   * The manager's `AgentRecord` id, once the child has one — the join key back
   * to this child's own agent-lifecycle events (their `id`). The run's internal
   * `wf-agent-N` handle is deliberately not exposed; it means nothing off the run.
   */
  recordId?: string;
}

/** The summary plus the live per-agent snapshot — what `workflow_get` returns. */
export interface WorkflowDetail extends WorkflowInfo {
  /** `task.progressVersion`: bumped once per applied progress batch. */
  version: number;
  agents: WorkflowAgentInfo[];
}

/** The run summary — carried by the lifecycle events and `workflow_list`. */
export function toWorkflowInfo(task: WorkflowTask, now = Date.now()): WorkflowInfo {
  const { failedCount } = stats(task.workflowProgress, task.agentCount);
  return {
    id: task.id,
    name: task.workflowName ?? task.meta?.name ?? task.id,
    status: task.status,
    startedAt: task.startTime,
    durationMs: elapsedMs(task, now),
    agentCount: task.agentCount,
    doneCount: task.doneCount,
    failedCount,
    totalTokens: task.totalTokens,
    totalToolCalls: task.totalToolCalls,
    phaseLabel: task.phaseLabel,
    ...(task.meta?.description !== undefined ? { description: task.meta.description } : {}),
    ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
    ...(task.endTime !== undefined ? { completedAt: task.endTime } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.failures !== undefined ? { failures: task.failures } : {}),
  };
}

/** The summary plus the current collapsed per-agent snapshot (fresh objects). */
export function toWorkflowDetail(task: WorkflowTask, now = Date.now()): WorkflowDetail {
  const agents = collapse(task.workflowProgress).agents.map(toWorkflowAgentInfo);
  return { ...toWorkflowInfo(task, now), version: task.progressVersion, agents };
}

function toWorkflowAgentInfo(e: WorkflowAgentEntry): WorkflowAgentInfo {
  return {
    index: e.index,
    label: e.label,
    state: e.state,
    ...(e.phaseIndex !== undefined ? { phaseIndex: e.phaseIndex } : {}),
    ...(e.phaseTitle !== undefined ? { phaseTitle: e.phaseTitle } : {}),
    ...(e.agentType !== undefined ? { agentType: e.agentType } : {}),
    ...(e.model !== undefined ? { model: e.model } : {}),
    ...(e.thinking !== undefined ? { thinking: e.thinking } : {}),
    ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
    ...(e.toolCalls !== undefined ? { toolCalls: e.toolCalls } : {}),
    ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.skipped !== undefined ? { skipped: e.skipped } : {}),
    ...(e.resultPreview !== undefined ? { resultPreview: e.resultPreview } : {}),
    ...(e.recordId !== undefined ? { recordId: e.recordId } : {}),
  };
}
