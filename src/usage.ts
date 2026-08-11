/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum).
 *
 * `input`, `output`, and `cacheWrite` are true sums across every turn — each
 * turn's value for those fields is incremental (new tokens billed *that*
 * turn), so summing is correct and `getLifetimeTotal()` continues to use
 * exactly these three fields (unchanged semantics/back-compat).
 *
 * `cacheRead` is DELIBERATELY NOT SUMMED. Each turn's `cacheRead` from
 * upstream already represents the *cumulative* cached prefix re-read on that
 * one API call — summing it across N turns would count the prefix N times
 * (quadratic inflation). See issue #38. Instead, `cacheRead` holds the most
 * recently observed per-turn value (last-write-wins via `addUsage`), which is
 * the best available point-in-time signal of how much cached context this
 * dispatch is currently leaning on. Do NOT sum this field; if you need a
 * dispatch-level figure, use the latest value as-is, or take the max across
 * turns if you want the peak instead of the latest — both are legitimate,
 * summing is not.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cacheRead?: number };

/**
 * Sum of lifetime usage components, or 0 if undefined. Deliberately excludes
 * `cacheRead` — see the `LifetimeUsage` doc comment / issue #38. This keeps
 * pre-existing total semantics unchanged; use `u.cacheRead` directly (or
 * `getCacheBreakdown`) to report cache-read separately.
 */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/**
 * Cache-related breakdown for telemetry consumers (e.g. Langfuse
 * `usageDetails`). `cacheWrite` is a true lifetime sum; `cacheRead` is the
 * most recently observed per-turn value, NOT a sum (see `LifetimeUsage`).
 * Returns zeros if `u` is undefined.
 */
export function getCacheBreakdown(u?: LifetimeUsage): { cacheRead: number; cacheWrite: number } {
  return { cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0 };
}

/**
 * Add a usage delta into a target accumulator (mutates target).
 *
 * `input`/`output`/`cacheWrite` are summed (they're incremental per turn).
 * `cacheRead` is last-write-wins — it overwrites rather than sums, since
 * upstream's per-turn `cacheRead` is already a cumulative snapshot for that
 * turn, not an incremental delta (see `LifetimeUsage`, issue #38).
 */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  into.cacheRead = delta.cacheRead ?? 0;
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
