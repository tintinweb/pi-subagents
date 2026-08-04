/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/** Per-agent usage accumulated from `message_end` deltas. Survives compaction, which replaces session messages and resets stats-derived sums. */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cacheRead: number; cost: number };

/** A zeroed accumulator. */
export function emptyUsage(): LifetimeUsage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
}

/** Display total excluding repeatedly reported cacheRead prefixes (issue #38). */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cacheRead += delta.cacheRead;
  into.cost += delta.cost;
}

/**
 * pi-ai `Usage` shape for `ToolResultMessage.usage` — the canonical channel
 * pi core (getUsageCostBreakdown, "Tools/summaries" bucket) and statusline
 * extensions aggregate into session cost. Component costs are not tracked
 * per bucket, so only `cost.total` is populated.
 */
export type ReportableUsage = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

/**
 * Return the not-yet-reported slice of an agent's lifetime usage as a pi-ai
 * `Usage`, and mark it reported (mutates record.reportedUsage). Returns
 * undefined when there is nothing new to report — callers must not attach
 * an all-zero usage. Delta semantics make repeated reporting safe: a resumed
 * agent or a second get_subagent_result call reports only new spend, so the
 * parent session never double-counts.
 */
export function takeUnreportedUsage(record: { lifetimeUsage: LifetimeUsage; reportedUsage?: LifetimeUsage }): ReportableUsage | undefined {
  const total = record.lifetimeUsage;
  const prior = record.reportedUsage ?? emptyUsage();
  const delta: LifetimeUsage = {
    input: Math.max(0, total.input - prior.input),
    output: Math.max(0, total.output - prior.output),
    cacheWrite: Math.max(0, total.cacheWrite - prior.cacheWrite),
    cacheRead: Math.max(0, total.cacheRead - prior.cacheRead),
    cost: Math.max(0, total.cost - prior.cost),
  };
  if (delta.input === 0 && delta.output === 0 && delta.cacheWrite === 0 && delta.cacheRead === 0 && delta.cost === 0) {
    return undefined;
  }
  record.reportedUsage = { ...total };
  return {
    input: delta.input,
    output: delta.output,
    cacheRead: delta.cacheRead,
    cacheWrite: delta.cacheWrite,
    totalTokens: delta.input + delta.output + delta.cacheRead + delta.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: delta.cost },
  };
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 *
 * RESETS at compaction — upstream replaces `session.state.messages` and the
 * stats are derived from that array. For a lifetime total that survives
 * compaction, use `getLifetimeTotal(lifetimeUsage)` instead, which reads
 * from an independent accumulator fed by `message_end` events.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}
