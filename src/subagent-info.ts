/**
 * subagent-info.ts — The one agent shape other extensions read off `pi.events`.
 *
 * Every `subagents:*` lifecycle event carries it, plus whatever that event
 * adds of its own. It is a public contract, so it is built from a whitelist:
 * a field reaches listeners only by being named here, never because it was
 * added to `AgentRecord`. Documented in docs/rpc.md.
 */
import type { AgentRecord } from "./types.js";
import { getLifetimeTotal, type ReportedUsage, toReportedUsage } from "./usage.js";

export interface SubagentInfo {
  id: string;
  type: string;
  description: string;
  status: AgentRecord["status"];
  /** Nesting depth: a top-level agent is 1. */
  depth: number;
  /** The agent that spawned this one through its scoped `Agent` tool. */
  parentAgentId?: string;
  /** The workflow run that spawned this one. */
  workflowId?: string;
  startedAt: number;
  completedAt?: number;
  /** Until `completedAt`, the time elapsed so far. */
  durationMs: number;
  toolUses: number;
  result?: string;
  error?: string;
  /**
   * The validated `StructuredOutput` payload as canonical JSON. Set only when
   * the spawn asked for a schema and the agent produced a valid report.
   */
  structuredJson?: string;
  /** The agent's pi session file, when the session is persisted. */
  sessionFile?: string;
  /**
   * Display token totals: excludes cacheRead (#38). Omitted when nothing was
   * produced.
   */
  tokens?: { input: number; output: number; total: number };
  /** The run's spend as a pi `Usage`. Omitted when nothing was spent. */
  usage?: ReportedUsage;
}

/**
 * Build a record's `SubagentInfo`. A key whose value is unknown is omitted,
 * never present as `undefined`, as on `subagents:usage`.
 */
export function toSubagentInfo(record: AgentRecord, now = Date.now()): SubagentInfo {
  // `lifetimeUsage` is lifetime-accumulated (Σ over every assistant
  // message_end), so it survives compaction: input + output ≤ total always.
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  // Two conventions, kept as they shipped. `usage` is pi's own `Usage`, so
  // `usage.cost.total` is where a listener already looks. `tokens` is a flat
  // view model like pi's `SessionStats`, carrying the DISPLAY total. Neither
  // derives from the other. Both are ungated by `showCost`: that governs what
  // a human is shown, not what the event carries.
  const usage = toReportedUsage(u);
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    depth: record.depth ?? 1,
    ...(record.parentAgentId !== undefined ? { parentAgentId: record.parentAgentId } : {}),
    ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
    startedAt: record.startedAt,
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    durationMs: (record.completedAt ?? now) - record.startedAt,
    toolUses: record.toolUses,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.structuredJson !== undefined ? { structuredJson: record.structuredJson } : {}),
    ...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
    ...(total > 0 ? { tokens: { input: u.input, output: u.output, total } } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}
