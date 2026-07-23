/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/** A finalized assistant message's complete, attribution-ready usage metadata. */
export interface AssistantUsageRecord {
  timestamp: number;
  provider: string;
  model: string;
  usage: Usage;
}

/**
 * Copy and normalize a finalized assistant message's usage for persistence.
 * The fallbacks keep custom providers with partial usage payloads observable.
 */
export function createAssistantUsageRecord(message: AssistantMessage): AssistantUsageRecord {
  const source = message.usage as Partial<Usage> | undefined;
  const input = typeof source?.input === "number" ? source.input : 0;
  const output = typeof source?.output === "number" ? source.output : 0;
  const cacheRead = typeof source?.cacheRead === "number" ? source.cacheRead : 0;
  const cacheWrite = typeof source?.cacheWrite === "number" ? source.cacheWrite : 0;
  const costSource = source?.cost as Partial<Usage["cost"]> | undefined;
  const cost = {
    input: typeof costSource?.input === "number" ? costSource.input : 0,
    output: typeof costSource?.output === "number" ? costSource.output : 0,
    cacheRead: typeof costSource?.cacheRead === "number" ? costSource.cacheRead : 0,
    cacheWrite: typeof costSource?.cacheWrite === "number" ? costSource.cacheWrite : 0,
    total: typeof costSource?.total === "number"
      ? costSource.total
      : (costSource?.input ?? 0) + (costSource?.output ?? 0) + (costSource?.cacheRead ?? 0) + (costSource?.cacheWrite ?? 0),
  };

  return {
    timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
    provider: message.provider ?? "unknown",
    model: message.model ?? "unknown",
    usage: {
      ...source,
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: typeof source?.totalTokens === "number"
        ? source.totalTokens
        : input + output + cacheRead + cacheWrite,
      cost,
    },
  };
}

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
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
