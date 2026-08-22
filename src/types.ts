/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/**
 * Isolation mode for agent execution.
 *
 * `"off"` exists for the caller's benefit, not the runtime's: models that fill
 * every optional parameter had no legal way to decline a single-value
 * `isolation` field and kept spawning worktrees they had just reasoned their
 * way out of (#231, #184). It is an input spelling only —
 * `resolveAgentInvocationConfig` collapses it to `undefined`, so nothing
 * downstream sees a value other than `"worktree"`. In an agent file it is a
 * genuine veto, since agent config outranks tool-call params.
 */
export type IsolationMode = "worktree" | "off";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  /** UI name. `display_name` wins; Claude Code's `name` is accepted as a fallback. */
  displayName?: string;
  /** Claude Code-compatible name color (named color or #RRGGBB). */
  color?: string;
  description: string;
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Persist this subagent as a normal pi session instead of keeping it in memory only. */
  persistSession?: boolean;
  /** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
  outputTranscript?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  /**
   * Nested delegation, off by default: undefined = no nested tools;
   * "all" = any enabled agent; string[] = only those agent types.
   */
  allowedSubagents?: "all" | string[];
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /**
   * Isolation mode — "worktree" runs the agent in a temporary git worktree,
   * "off" refuses one even when the caller asks (frontmatter outranks params).
   */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
  /** Path of the .md it was loaded from. Unset for embedded defaults. */
  sourcePath?: string;
}

export type JoinMode = 'async' | 'group' | 'smart';

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   Agent tool result, #118); show background/queued/scheduled/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'background' | 'off';

/**
 * How `@handle message` starts an agent that is not already running.
 * - `model`: inject Claude Code's `agent_mention` reminder and let the main
 *   model spawn it with the `Agent` tool, which is what Claude Code does.
 * - `direct`: spawn it here, immediately, with the typed message as its prompt
 *   and no main-model turn spent.
 * - `off`: `@` means only "attach a file" again.
 *
 * Messaging a running agent and resuming a finished one are direct in every
 * mode — Claude Code only differs from us on the *new* invocation.
 */
export type AgentMentionMode = 'model' | 'direct' | 'off';

/**
 * What survives a record's eviction so `@handle` keeps working. The live record
 * is discarded after ~10 minutes, but the pi session it wrote is still on disk,
 * and this is the little that is needed to find and describe it again.
 */
export interface AgentTombstone {
  handle: string;
  alias?: string;
  id: string;
  type: SubagentType;
  description: string;
  /** Always set — a record with no session file is never tombstoned. */
  sessionFile: string;
  completedAt: number;
}

/**
 * What `@handle` resolved to: an agent still in memory, or the remains of one
 * whose conversation can be reopened from disk.
 */
export type MentionResolution =
  | { kind: "live"; record: AgentRecord }
  | { kind: "tombstone"; entry: AgentTombstone };

export interface AgentRecord {
  id: string;
  type: SubagentType;
  /**
   * Typeable name for the `@handle message` prompt mention, derived from the
   * agent type and numbered when siblings collide (`explore`, `explore-2`).
   * Top-level agents only — nested children are hidden from every top-level
   * surface, so nothing can address them.
   */
  handle?: string;
  /**
   * A second, memorable handle from the spawner's `name` (`@auth-audit`), drawn
   * from the same namespace as `handle` so the two can never collide. Purely
   * additive: `handle` is assigned regardless, so a named agent stays reachable
   * by its type and `@explore` never comes to mean "start another one".
   */
  alias?: string;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /**
   * Resolves when a queued spawn actually starts — or is dropped while queued
   * (abort). `spawnAndWait` awaits this before the run promise, which doesn't
   * exist until the agent starts.
   */
  startPromise?: Promise<void>;
  groupId?: string;
  joinMode?: JoinMode;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /**
   * The agent's pi session file, when it was persisted (`persist_session`, or
   * the `rememberAgents` default). Captured so a mention can reopen the
   * conversation after the record itself has been evicted; undefined for an
   * in-memory session, which leaves nothing to reopen.
   */
  sessionFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /**
   * Whether this agent was spawned to run in the background. Tri-state, set at
   * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
   * foreground (has an inline Agent tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface). The widget's background-only filter keys off this
   * — and excludes only explicit `false`, so `undefined` agents stay visible.
   * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
   * which only the Agent-tool path populates.
   */
  isBackground?: boolean;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /**
   * Session id of the root (main) session this branch descends from. Nested
   * spawns inherit it so their transcripts file under the same session
   * directory as their ancestors' instead of the child session's own id.
   */
  rootSessionId?: string;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  /**
   * Estimated cost in USD, from pi's per-message `usage.cost.total`. Always
   * populated (0 when the model has no pricing); the renderer decides whether
   * to show it, per the `showCost` setting.
   */
  totalCost?: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
  id: string;
  /** Unique within store. Defaults to `description`. */
  name: string;
  description: string;
  /** Raw user input — cron expr | "+10m" | ISO | "5m". */
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  /** Computed at create time for interval/once. */
  intervalMs?: number;

  // spawn params (subset of Agent tool params; no inherit_context, no resume)
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;

  // state
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  /** Refreshed on every fire and on store load. */
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  /** For future migrations. */
  version: 1;
  jobs: ScheduledSubagent[];
}
