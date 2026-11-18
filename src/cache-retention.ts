// Prompt-cache retention for subagent sessions. A parent on a 1-hour cache
// (`PI_CACHE_RETENTION=long`) would otherwise make every short-lived child pay
// the 1-hour write rate. Precedence: an explicit per-request value (pi passes
// `none` for compaction and branch summaries) > the agent's `cache_retention`
// frontmatter > the `cacheRetention` setting > pi's own default.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CacheRetentionSetting } from "./types.js";

let cacheRetention: CacheRetentionSetting = "inherit";

/** The `cacheRetention` setting; `inherit` leaves pi's default in charge. */
export function getCacheRetention(): CacheRetentionSetting { return cacheRetention; }
/** Set the `cacheRetention` setting. Read at spawn, so it applies to agents started after it. */
export function setCacheRetention(v: CacheRetentionSetting): void { cacheRetention = v; }

/**
 * Supply `retention` on every model call the session makes that doesn't set
 * one itself. Wraps the session's own stream function, so pi's routing, auth
 * and cache warming still run — the warmer sees the value and refreshes on the
 * matching TTL. Install it before `bindExtensions`, so `session_start` handlers
 * already see the wrapped function. `inherit` installs nothing.
 */
export function installCacheRetention(session: AgentSession, retention: CacheRetentionSetting): void {
  if (retention === "inherit") return;
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    streamFunction(model, context, { ...options, cacheRetention: options?.cacheRetention ?? retention });
}
