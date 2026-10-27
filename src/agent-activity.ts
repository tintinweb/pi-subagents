/**
 * agent-activity.ts — canonical subagent activity model and formatting.
 *
 * Provides a pure immutable state reducer for subagent execution activity,
 * snapshot formatting for UI/logs/RPC, and helpers shared by runner, manager,
 * widgets, transcripts, and workflows.
 */

export type ActivityPhase =
  | "queued"
  | "initializing"
  | "model-inference"
  | "retrying"
  | "compacting"
  | "tool-execution"
  | "waiting-for-child"
  | "idle";

export interface ActiveToolActivity {
  callId: string;
  name: string;
  startedAt: number;
  lastUpdateAt: number;
}

export interface RetryActivity {
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
  reason?: string;
}

export interface CompactionActivity {
  startedAt: number;
  reason?: "manual" | "threshold" | "overflow";
}

export interface ActivitySnapshot {
  phase: ActivityPhase;
  detail?: string;
  phaseStartedAt: number;
  lastProgressAt: number;
  stalledSince?: number;
  effectiveModel?: string;
  effectiveProvider?: string;
  activeTool?: ActiveToolActivity;
  retry?: RetryActivity;
  compaction?: CompactionActivity;
  turnCount: number;
  contextPercent?: number;
}

export type AgentActivityEvent =
  | { type: "initializing"; stage: string; at: number }
  | { type: "model-inference"; at: number }
  | { type: "model-progress"; at: number }
  | { type: "retry-start"; at: number; retry: RetryActivity }
  | { type: "retry-end"; at: number }
  | { type: "compaction-start"; at: number; compaction: CompactionActivity }
  | { type: "compaction-end"; at: number }
  | { type: "tool-start"; at: number; tool: ActiveToolActivity }
  | { type: "tool-update"; at: number; callId: string }
  | { type: "tool-end"; at: number; callId: string }
  | { type: "waiting-for-child"; at: number; child: string }
  | { type: "idle"; at: number }
  | { type: "turn-end"; at: number; turnCount?: number; contextPercent?: number }
  | { type: "stalled"; at: number; stalledSince: number }
  | { type: "unstalled"; at: number };

export function formatActivityDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    const mm = minutes < 10 ? `0${minutes}` : `${minutes}`;
    const ss = seconds < 10 ? `0${seconds}` : `${seconds}`;
    return `${hours}h${mm}m${ss}s`;
  }
  if (minutes > 0) {
    const ss = seconds < 10 ? `0${seconds}` : `${seconds}`;
    return `${minutes}m${ss}s`;
  }
  return `${seconds}s`;
}

export function createInitialActivity(
  now: number,
  opts?: { model?: string; provider?: string },
): ActivitySnapshot {
  return {
    phase: "queued",
    phaseStartedAt: now,
    lastProgressAt: now,
    turnCount: 0,
    effectiveModel: opts?.model,
    effectiveProvider: opts?.provider,
  };
}

export function reduceActivity(
  prev: ActivitySnapshot,
  event: AgentActivityEvent,
): ActivitySnapshot {
  switch (event.type) {
    case "initializing":
      return {
        ...prev,
        phase: "initializing",
        detail: event.stage,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
        activeTool: undefined,
        retry: undefined,
        compaction: undefined,
      };

    case "model-inference":
      return {
        ...prev,
        phase: "model-inference",
        detail: undefined,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
        activeTool: undefined,
        retry: undefined,
        compaction: undefined,
      };

    case "model-progress":
      return {
        ...prev,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "retry-start":
      return {
        ...prev,
        phase: "retrying",
        retry: event.retry,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "retry-end":
      return {
        ...prev,
        phase: "model-inference",
        retry: undefined,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "compaction-start":
      return {
        ...prev,
        phase: "compacting",
        compaction: event.compaction,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "compaction-end":
      return {
        ...prev,
        phase: "model-inference",
        compaction: undefined,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "tool-start":
      return {
        ...prev,
        phase: "tool-execution",
        activeTool: event.tool,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "tool-update": {
      if (prev.activeTool?.callId !== event.callId) {
        return prev;
      }
      return {
        ...prev,
        activeTool: {
          ...prev.activeTool,
          lastUpdateAt: event.at,
        },
        lastProgressAt: event.at,
        stalledSince: undefined,
      };
    }

    case "tool-end": {
      if (prev.activeTool?.callId !== event.callId) {
        return prev;
      }
      return {
        ...prev,
        phase: "model-inference",
        activeTool: undefined,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };
    }

    case "waiting-for-child":
      return {
        ...prev,
        phase: "waiting-for-child",
        detail: event.child,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "idle":
      return {
        ...prev,
        phase: "idle",
        detail: undefined,
        phaseStartedAt: event.at,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "turn-end":
      return {
        ...prev,
        turnCount: event.turnCount ?? prev.turnCount,
        contextPercent: event.contextPercent ?? prev.contextPercent,
        lastProgressAt: event.at,
        stalledSince: undefined,
      };

    case "stalled":
      return {
        ...prev,
        stalledSince: event.stalledSince,
      };

    case "unstalled":
      return {
        ...prev,
        stalledSince: undefined,
      };

    default:
      return prev;
  }
}

export function describeActivity(snapshot: ActivitySnapshot, now: number): string {
  const elapsed = formatActivityDuration(now - snapshot.phaseStartedAt);

  switch (snapshot.phase) {
    case "initializing":
      return `initializing ${snapshot.detail || "environment"} · ${elapsed}`;

    case "model-inference": {
      const model = snapshot.effectiveProvider && snapshot.effectiveModel
        ? (snapshot.effectiveModel.startsWith(`${snapshot.effectiveProvider}/`)
            ? snapshot.effectiveModel
            : `${snapshot.effectiveProvider}/${snapshot.effectiveModel}`)
        : snapshot.effectiveModel;
      return model ? `model inference · ${model} · ${elapsed}` : `model inference · ${elapsed}`;
    }

    case "retrying": {
      const parts: string[] = ["retrying"];
      if (snapshot.retry) {
        const attempt = snapshot.retry.maxAttempts
          ? `attempt ${snapshot.retry.attempt}/${snapshot.retry.maxAttempts}`
          : `attempt ${snapshot.retry.attempt}`;
        parts.push(attempt);
        if (snapshot.retry.delayMs) {
          parts.push(`next attempt in ${Math.ceil(snapshot.retry.delayMs / 1000)}s`);
        }
        if (snapshot.retry.reason) {
          parts.push(snapshot.retry.reason);
        }
      }
      return parts.join(" · ");
    }

    case "compacting": {
      const reason = snapshot.compaction?.reason ? ` (${snapshot.compaction.reason})` : "";
      return `compacting context${reason} · ${elapsed}`;
    }

    case "tool-execution": {
      const toolName = snapshot.activeTool?.name || "running";
      const toolElapsed = formatActivityDuration(
        now - (snapshot.activeTool?.startedAt ?? snapshot.phaseStartedAt),
      );
      const base = `tool ${toolName} · ${toolElapsed}`;
      if (snapshot.stalledSince) {
        const stalledElapsed = formatActivityDuration(now - snapshot.stalledSince);
        return `${base} · stalled for ${stalledElapsed}`;
      }
      return base;
    }

    case "waiting-for-child":
      return `waiting for child ${snapshot.detail || "subagent"} · ${elapsed}`;

    case "idle":
      return "idle";

    case "queued":
      return "queued";

    default:
      return snapshot.phase;
  }
}
