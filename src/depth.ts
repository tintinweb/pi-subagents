/**
 * depth.ts — Subagent nesting-depth tracking, keyed by AgentSession id.
 *
 * Why session id as the key: it is the only stable per-session handle reachable
 * from both ends of a spawn. The spawn site knows the parent via
 * `ctx.sessionManager.getSessionId()` (the handler runs in the parent's
 * context); the runner learns the child's id from `session.sessionId` right
 * after `createAgentSession`. A Map between the two carries the depth forward
 * without threading a counter through SpawnArgs/RunOptions.
 *
 * Depth convention: the top-level pi session is depth 0. Each spawn increments
 * by 1. A subagent may itself spawn iff its OWN depth < MAX_NESTING_DEPTH, so
 * the deepest spawnable level is exactly MAX_NESTING_DEPTH. With the default
 * of 2: main(0) → child(1) → grandchild(2, cannot spawn further).
 *
 * Resume of an orphaned session falls back to depth 0 — it is treated as a
 * fresh top-level session and may spawn again. This is safe (the cap still
 * holds from the resumed session downward) and avoids persisting depth state.
 */

/** Maximum depth at which a subagent may itself spawn further subagents. */
export const MAX_NESTING_DEPTH = 2;

/** sessionId → depth. Module-global: one process, one agent tree. */
const sessionDepth = new Map<string, number>();

/** Depth of the session with this id, or 0 when unknown (main / resumed-orphan). */
export function getSessionDepth(sessionId: string): number {
  return sessionDepth.get(sessionId) ?? 0;
}

/** Record a child session's depth right after it is created. No-op if no id. */
export function recordSessionDepth(sessionId: string, depth: number): void {
  if (sessionId) sessionDepth.set(sessionId, depth);
}

/** Drop a session's depth entry once it is cleaned up. No-op if absent. */
export function forgetSessionDepth(sessionId: string): void {
  sessionDepth.delete(sessionId);
}

/** Whether a subagent at `depth` is itself allowed to spawn further subagents. */
export function canNest(depth: number): boolean {
  return depth < MAX_NESTING_DEPTH;
}

/** Test-only: clear all tracked depth. Keeps the module-global Map honest between tests. */
export function _resetForTesting(): void {
  sessionDepth.clear();
}
