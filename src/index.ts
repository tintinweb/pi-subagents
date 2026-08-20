/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import { hasAgentBadge, renderAgentName } from "./agent-color.js";
import { buildNewAgentFile, disableInContent, enableInContent, isEmptyStub, locateAgentFile, personalAgentsDir, projectAgentsDir, serializeAgentFile } from "./agent-file-toggle.js";
import { AgentManager } from "./agent-manager.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, getRememberAgents, normalizeMaxTurns, resolveEffectiveMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, setRememberAgents, steerAgent } from "./agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, getConfig, getFallbackSubagent, isDefaultsDisabled, NO_FALLBACK, registerAgents, resolveSpawnType, resolveType, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { inChildSessionContext } from "./child-context.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { GroupJoinManager } from "./group-join.js";
import { isolationParam, resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { describeMention, handleBase, isReservedHandle, parseMention, resolveHandleToType, stripAgentPrefix } from "./mention.js";
import { runMentionClone } from "./mention-clone.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope, isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.js";
import { createOutputFilePath, ensureOutputFile, getOutputTranscriptDefault, setOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, loadSettings, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getForegroundOutcomeNote, getStatusNote, partialOutputSuffix } from "./status-note.js";
import { type AgentConfig, type AgentInvocation, type AgentMentionMode, type AgentRecord, type IsolationBackend, type JoinMode, type NotificationDetails, type SubagentType, type WidgetMode } from "./types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type Theme,
  type UICtx,
} from "./ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { selectItem } from "./ui/select-item.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, PendingUsagePool, toReportedUsage } from "./usage.js";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => {
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number, showCost = false): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";
  // Only under `showCost`: this is LLM context, and a figure the orchestrator
  // did not ask for is a figure it may start reporting unprompted.
  const cost = showCost ? getLifetimeCost(record.lifetimeUsage) : 0;
  const costXml = cost > 0 ? `<estimated_cost_usd>${cost.toFixed(4)}</estimated_cost_usd>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}${costXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any; lifetimeUsage: LifetimeUsage },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    // Raw, and unconditional: `tokens` is preformatted because it is one stat,
    // but a cost is joined by "·" in one surface, "," in another and "|" in a
    // third — so it travels as a number and each renderer punctuates its own.
    cost: getLifetimeCost(record.lifetimeUsage),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    // Carried unconditionally; the renderer gates on the setting. Details are
    // data, and a notification rendered before a mid-session toggle should not
    // be stuck with the old answer.
    totalCost: getLifetimeCost(record.lifetimeUsage),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see test/fixtures/.pi/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

export default function (pi: ExtensionAPI) {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and leak handlers. Nested orchestration is
  // injected as scoped custom tools by the existing manager instead.
  if (inChildSessionContext()) return;

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (showCost) {
          const costText = formatCost(d.totalCost ?? 0);
          if (costText) parts.push(costText);
        }
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: output file link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      const rendered = all.map(renderOne);
      // A group of agents lands as one notification, and the number a user wants
      // from it is what the batch cost — not four figures to add up by hand.
      // Derived from the per-agent details rather than carried alongside them:
      // one source, so the total can never disagree with the rows above it.
      if (showCost && all.length > 1) {
        const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
        if (total) {
          const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
          rendered.unshift(theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`));
        }
      }
      return new Text(rendered.join("\n"), 0, 0);
    }
  );

  // Read directly rather than waiting for applyAndEmitLoaded below: this decides
  // the initial load, which happens hundreds of lines before settings are applied.
  let strictAgentFiles = loadSettings(process.cwd()).strictAgentFiles === true;

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(strictAgentFiles);

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  let reportUsage = false;
  function isReportUsageEnabled(): boolean { return reportUsage; }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) pendingUsage.drain();
  }
  /** Show `~$X` next to token counts in the subagent surfaces. */
  let showCost = false;
  function isShowCostEnabled(): boolean { return showCost; }
  function setShowCost(b: boolean): void { showCost = b; widget.update(); fleet.update(); }
  const pendingUsage = new PendingUsagePool();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;
  // A queued result wait must observe completion before its held notification
  // can fire, so successful waits can still suppress that redundant nudge.
  const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500, showCost);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); fleet.onAgentFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300, showCost)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      widget.update();
    },
    30_000,
  );

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    // The whole run's spend as a pi `Usage` — pi's convention for handing spend
    // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
    // listener already expects them and anything pi adds to `Usage` arrives
    // without a change here. Omitted when nothing was spent, so "spent nothing"
    // and "never ran" stay distinguishable. Ungated by `showCost`: that setting
    // governs what a human is shown, not what the event carries.
    //
    // `tokens` above is the other convention, kept as it shipped: a flat view
    // model like pi's own `SessionStats`, carrying the DISPLAY total, which
    // excludes cacheRead (#38). The two answer different questions and neither
    // derives from the other.
    const usage = toReportedUsage(u);
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      usage,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    // Nested children report only through their owning parent's scoped tools.
    // Keep them out of top-level lifecycle, transcript, notification, and UI channels.
    if (record.parentAgentId) return;

    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      fleet.onAgentFinished(record.id);
      widget.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (currentBatchAgents.some(a => a.id === record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }, undefined, (record) => {
    if (record.parentAgentId) return;
    // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
    // and scheduler spawns enter through the manager directly.
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    if (record.parentAgentId) return;
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (_record, usage) => {
    // Every assistant message from every agent — nested included, exactly once.
    // Parked here until a tool result can carry it back to the parent session;
    // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
    // pool grows in a session that will never drain it.
    if (reportUsage) pendingUsage.add(usage);
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    const { state, callbacks } = createActivityTracker(resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns));
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    const id = manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, ...callbacks });
    agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record?.parentAgentId ? undefined : record;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  let mentionProviderRegistered = false;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
    }
    manager.clearCompleted(true);
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager: {
          spawn: spawnTopLevel,
          abort: (id) => {
            const record = manager.getRecord(id);
            return !record?.parentAgentId && manager.abort(id);
          },
        },
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !mentionProviderRegistered) {
      mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider(current =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(manager, mentionTypes(), type => getConfig(type).displayName),
          isAgentMentionsEnabled,
        ),
      );
    }
  });

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage,
    // scheduled prompts) — only something a person typed can be a mention.
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved = manager.resolveMention(mention.handle)
      ?? (alias ? manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        manager.steer(record.id, mention.message);
        pi.events.emit("subagents:steered", { id: record.id, message: mention.message });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        const config = getAgentConfig(record.type);
        const resumedRecord = await startBackgroundResume(ctx, record, mention.message, {
          outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
        });
        ctx.ui.notify(
          resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    // Evicted, but its conversation is still on disk: reopen it. This is an
    // ordinary spawn carrying a session file, so the new record picks up the
    // widget, fleet row, transcript and completion notification unchanged —
    // and `reclaim` hands it back the names the tombstone was holding.
    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      // Checked here rather than left to SessionManager.open: that runs inside
      // runAgent, whose rejection lands on the record as an agent error, not in
      // the catch below. A `/new` in another pi window or a manual delete makes
      // the conversation unrecoverable (Claude Code's `not_reachable`), so drop
      // the entry — a row that can only ever fail is worse than none — and say
      // so rather than quietly sending this message to an unrelated agent.
      if (!existsSync(entry.sessionFile)) {
        manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }

      // The Agent tool deliberately falls back to general-purpose for a type it
      // cannot resolve (#183), which covers a deleted file AND a merely
      // disabled one. A resume must not inherit that: reopening this
      // conversation under a different agent's prompt and tools is not
      // continuing it, and the new record would re-tombstone under the
      // substitute, so the handle would never find its way back.
      reloadCustomAgents();
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        // The tombstone stays: re-enabling the agent makes the handle work
        // again, which a drop would foreclose.
        ctx.ui.notify(`Could not resume ${target} — the ${entry.type} agent is no longer available.`, "warning");
        return { action: "handled" };
      }

      try {
        // spawnResolved, not spawnTopLevel: the latter strips
        // `resumeSessionFile` and `reclaim` as untrusted. This path is the
        // exception — both come from a tombstone this extension wrote.
        spawnResolved(pi, ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaim: { handle: entry.handle, alias: entry.alias },
          resumeSessionFile: entry.sessionFile,
          isBackground: true,
        });
        // The tombstone deliberately stays. `resolveMention` prefers the live
        // record holding these same names, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        // The type is already settled above, so what is left is a spawn-time
        // failure: a strict worktree-isolation error, an unusable cwd.
        ctx.ui.notify(
          `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    const typeHandle = mention.handle;
    const type = resolveHandleToType(typeHandle, getAvailableTypes())
      ?? (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      void runMentionClone({ ctx, type, message: mention.message, agentTool: registeredAgentTool })
        .then((result) => {
          if (result.spawned) return;
          // A clone that could not run must not swallow the mention: start the
          // agent the direct way rather than leaving the user with a toast and
          // nothing running.
          try {
            spawnTopLevel(pi, ctx, type, mention.message, {
              description: describeMention(mention.message),
              isBackground: true,
            });
            ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            ctx.ui.notify(
              `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        });
      return { action: "handled" };
    }

    try {
      // Nothing else to pass: runAgent resolves model, thinking and max turns
      // from the agent's own config when the spawn omits them, and the
      // manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
      });
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    scheduler.stop();
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await manager.dispose();
  });

  // Live widget: show running agents above editor.
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  let widgetMode: WidgetMode = "background";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  const widget = new AgentWidget(manager, agentActivity, getWidgetMode, isShowCostEnabled);
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; widget.update(); }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  const fleet = new FleetList(manager, agentActivity, isShowCostEnabled);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  let agentMentionMode: AgentMentionMode = "model";
  function getAgentMentionMode(): AgentMentionMode { return agentMentionMode; }
  function setAgentMentionMode(mode: AgentMentionMode): void { agentMentionMode = mode; }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  function isAgentMentionsEnabled(): boolean { return agentMentionMode !== "off"; }

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // What an unqualified top-level spawn means. Defaults to background,
  // following Claude Code; `backgroundByDefault: false` restores the previous
  // foreground default. Nested spawns ignore this — see nested-tools.ts.
  let backgroundByDefault = true;
  function getBackgroundByDefault(): boolean { return backgroundByDefault; }
  function setBackgroundByDefault(b: boolean) { backgroundByDefault = b; }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  /**
   * Launch a detached resume of an existing agent and wire everything a
   * re-running agent needs: transcript anchoring, activity tracking, join-mode
   * batching, the widget/fleet refresh, and the `subagents:created` event.
   *
   * Shared by the Agent tool's `resume` + `run_in_background` branch and the
   * `@handle message` prompt mention — they differ only in how they report the
   * outcome. Returns the record, or undefined when the manager refused because
   * the agent is still running (see AgentManager.resume).
   *
   * Callers must have already established that the record has a session.
   */
  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined> {
    const id = existing.id;
    const joinMode = resolveJoinMode(defaultJoinMode, true);
    // Assigned unconditionally: the completion notification carries this as
    // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
    // id left by the spawn that created the record. Keeping it would point the
    // orchestrator's new result at a tool call that was answered runs ago.
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    // Reuse the agent's transcript rather than starting a fresh one: the
    // path is deterministic per agent+session, so writing an initial entry
    // would truncate the previous run's turns (see ensureOutputFile).
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    // Anchor streaming past the turns already on disk, captured BEFORE the
    // run starts. The resumed prompt lands as an ordinary user message at
    // this index, so it is written exactly once.
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    // resumeAgent has no onSessionCreated — the session predates this run —
    // so seed it directly, or the widget shows no context % for the agent.
    bgState.session = existing.session;

    // No `signal`: a background spawn deliberately omits it, and a detached
    // resume must behave the same. Passing it would abort this agent when
    // the parent turn is interrupted (user Esc), while agents started with
    // run_in_background in that same turn keep going.
    const record = await manager.resume(id, prompt, undefined, {
      isBackground: true,
      onToolActivity: bgCallbacks.onToolActivity,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      // Fires when the run actually starts — immediately, or on queue
      // drain. Wiring it here (rather than after resume() returns) means a
      // resume stopped while still queued never started streaming, so
      // there is no subscription left behind for a later run to trip over.
      onStarted: () => {
        const rec = manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    if (joinMode != null && joinMode !== 'async') {
      currentBatchAgents.push({ id, joinMode });
      if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
      batchFinalizeTimer = setTimeout(finalizeBatch, 100);
    }

    agentActivity.set(id, bgState);
    // This agent already finished once, so the widget holds a finished-age
    // for it that is past the linger limit — without clearing it, the
    // resumed run's ✓/✗ line never renders and the agent just vanishes.
    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    // Resume ignores subagent_type (the record keeps the type it was
    // spawned with), so report the record's own identity — a "created"
    // event carrying the caller's type would re-register the agent under
    // the wrong one in cross-extension mirrors keyed by id.
    pi.events.emit("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setIsolationBackend: (backend) => manager.setIsolationBackend(backend),
      setBackgroundByDefault,
      setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setStrictAgentFiles: (b) => { strictAgentFiles = b; },
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
      setAgentMentions: setAgentMentionMode,
      setRememberAgents,
      setWidgetMode: setWidgetMode,
      setOutputTranscript: setOutputTranscriptDefault,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
      setMaxSubagentDepth: setMaxSubagentDepth,
      setFallbackSubagent: setFallbackSubagent,
      setReportUsage,
      setShowCost,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Same trade as scheduleParam/scheduleGuideline above: `isolationParam` drops
  // the field from the schema when the project set `worktreeIsolation: false`,
  // so the prose has to go with it. Left in, it would teach the model to pass a
  // parameter that isn't declared — accepted (TypeBox sets no
  // `additionalProperties: false`) and then silently dropped by the resolver.
  // With no per-result note by design, the model would have every reason to go
  // on reporting a `pi-agent-*` branch that was never created.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to run the agent in an isolated repository workspace (safe parallel file modifications); leave it unset, or pass "off", for none. The configured backend defaults to the nearest repository and prefers jj at a colocated root. Clean workspaces are removed; changes are preserved on a jj bookmark or Git branch named in the result.`
    : "";

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent an isolated repository workspace through the configured jj or Git backend; changes land on a bookmark or branch named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background by default; you'll be notified when one completes. Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen while it runs. Never fabricate or predict a pending agent's results — if the user asks before the notification arrives, say it's still running.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Pass \`run_in_background: false\` only when your very next action depends on the agent's result and nothing else could usefully happen while it runs — e.g., a research agent whose finding gates the edit you're about to make. Otherwise let it run in the background (the default) — this includes fire-and-forget work, independent investigations, and anything where the user might hand you something else in the meantime. Wanting the result "next" is not enough on its own.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  // Held rather than registered inline: the mention clone reuses this exact
  // definition, so the agent it starts is an ordinary top-level spawn instead
  // of a second implementation that has to be kept in step with this one.
  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      // A badge closes its own background, which would clear the tool block's row tint
      // for the rest of the line, so the badge restores it. The tint is opened here too:
      // the TUI's Box paints it, but HTML export takes it from CSS, and restoring a
      // background the line never opened is what banded the export before. The line is
      // deliberately left open — Box.applyBackgroundToLine pads to width and *then*
      // wraps, so closing here would leave that padding untinted, and HTML export closes
      // any open span per line anyway. No badge means no tint, so an uncolored agent
      // renders exactly the line it always did.
      const rowBackground = hasAgentBadge(args.subagent_type)
        ? theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg")
        : "";
      const desc = args.description ?? "";
      const name = renderAgentName(args.subagent_type, theme, {
        fallbackColor: "toolTitle",
        restoreBackground: rowBackground,
        bold: true,
      });
      return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details as AgentDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Pi reports pre-execution failures (extension block, abort, argument
      // validation) as `{ content: [reason], details: {} }` with isError set —
      // no status to render, so show the reason instead of inventing one (#199).
      if (renderContext.isError || !details?.status) {
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        if (showCost) {
          const costText = formatCost(d.cost ?? 0);
          if (costText) parts.push(costText);
        }
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // Anything left ("queued", or a status added later) has no rendering of
      // its own — the turn-limit wording below must not be the catch-all.
      if (details.status !== "error" && details.status !== "aborted") {
        return new Text(text, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background or scheduled call can't start running the wrong agent while
      // the caller is still unaware. `fallbackSubagent` decides whether an
      // unresolvable type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // What the caller actually asked for, named once: `fellBackFrom` is "" for
      // a blank request, so reading it inline invites the `??`-vs-`||` slip that
      // once persisted an empty type into a scheduled job.
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      // Computed at resolution rather than after the run, so the background and
      // schedule branches carry it too — previously it existed only on the
      // foreground path. Resume deliberately doesn't: it replays the stored
      // session and ignores `subagent_type` entirely, so a note about type
      // substitution would be describing something that didn't happen.
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
        ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
        : "";

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: getBackgroundByDefault(),
      });

      // Resolve model from agent config first; tool-call params only fill gaps.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts so the nested delegation tools apply the same rule.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const modelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        thinking,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };
      // Tool-result render shows the mode label too; viewer's header already does.
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (params.run_in_background === false) {
          return textResult("Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            // The caller's own name, not the substitute — the scheduler re-resolves
            // at fire time, and the original is what a user edits.
            subagent_type: requestedType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing || existing.parentAgentId) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }

        // Background resume: detached run that notifies on completion, mirroring
        // a background spawn. Previously run_in_background was silently ignored
        // on resume (this branch returned before the background branch below),
        // so a resumed agent always blocked the main loop until it finished.
        if (runInBackground) {
          const id = existing.id;
          // A detached resume hands control back while the record stays
          // "running", so nothing stops the model from resuming the same agent
          // again mid-run. manager.resume() refuses that (it would orphan the
          // live run's abort controller); say why here, where the model can act
          // on it, instead of letting it read as a generic failure.
          if (existing.status === "running" || existing.status === "queued") {
            return textResult(
              `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
              `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
            );
          }

          const record = await startBackgroundResume(ctx, existing, params.prompt, {
            outputTranscript,
            maxTurns: effectiveMaxTurns,
            toolCallId,
          });
          if (!record) {
            return textResult(`Failed to resume agent "${params.resume}".`);
          }

          const isQueued = record.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${existing.type}\n` +
            (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
            `\nYou will be notified when this agent completes.\n` +
            `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
            { ...detailBase, subagentType: existing.type, displayName: existing.type, toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
          );
        }

        const record = await manager.resume(params.resume, params.prompt, signal);
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        // A failed resume surfaces the error, plus any partial output THIS
        // resume produced (never the previous turn's answer, #144).
        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBase, record));
        }
        return textResult(
          record.result?.trim() || "No output.",
          buildDetails(detailBase, record),
        );
      }

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
        };

        // A throw here means the agent never started. Let it out: pi marks a
        // tool call failed only when execute throws, and a returned message
        // reads to the model as a subagent that ran and reported this (#179).
        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...bgCallbacks,
        });

        // Set output file + join mode synchronously after spawn, before the
        // event loop yields — onSessionCreated is async so this is safe.
        const joinMode = resolveJoinMode(defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        if (joinMode == null || joinMode === 'async') {
          // Foreground/no join mode or explicit async — not part of any batch
        } else {
          // smart or group — add to current batch
          currentBatchAgents.push({ id, joinMode });
          // Debounce: reset timer on each new agent so parallel tool calls
          // dispatched across multiple event loop ticks are captured together
          if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
          batchFinalizeTimer = setTimeout(finalizeBatch, 100);
        }

        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        // Emit created event
        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;

      const streamUpdate = () => {
        // Spend from the record, everything else from the live tracker. `fgId`
        // is set in onSessionCreated below, which fires before the first
        // assistant message — so nothing is spent while this reads zero.
        const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
          cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as any,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

      // Wire session creation: register in widget + stream to output file.
      // The output file path is set synchronously after spawn (below),
      // before onSessionCreated fires — same pattern as background agents.
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
        // Stream conversation to output file (foreground agent logging)
        if (fgId) {
          const rec = manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      let record: AgentRecord;
      try {
        const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...fgCallbacks,
        }, (fgAgentId) => {
          // onSpawned: called synchronously after spawn, before onSessionCreated fires.
          // Set up the output file so streamToOutputFile can pick it up.
          const fgRec = manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
        });
        record = fgResult.record;
      } finally {
        // Runs on both paths, so a startup throw — which now propagates, see
        // the background spawn above (#179) — no longer leaves the spinner
        // ticking or a finished agent on the widget.
        clearInterval(spinnerInterval);
        if (fgId) {
          agentActivity.delete(fgId);
          widget.markFinished(fgId);
          fleet.onAgentFinished(fgId);
        }
      }

      // Get final token count — from the record, like the cost below it, so the
      // two describe the same work when the agent delegated to nested children.
      const tokenText = formatLifetimeTokens(record);

      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });

      if (record.status === "error") {
        // Error headline + any partial output the run produced before failing.
        return textResult(`${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(costText);
      }
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });
  /**
   * Wrap a tool so its results carry back whatever subagent spend the parent
   * session has not been told about yet (see `PendingUsagePool`).
   *
   * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
   * folds it into `getSessionStats()`, which is what the footer, the statusline
   * and `/cost` read — so this is the whole of "report usage to the parent".
   *
   * Nothing is attached to a call with no tool-call id. That is the `@handle`
   * mention path (`mention-clone.ts`), which invokes this tool from a fork of the
   * conversation that is discarded moments later: the result never becomes a
   * message in the real session, so usage hung on it would be spend the user paid
   * for and nobody counted. Skipping leaves it pending for the next real result.
   */
  function withUsageReporting<T extends { execute: (...args: any[]) => any }>(tool: T): T {
    return {
      ...tool,
      execute: async (toolCallId: string | undefined, ...rest: any[]) => {
        const result = await tool.execute(toolCallId, ...rest);
        if (!reportUsage || !toolCallId) return result;
        const usage = pendingUsage.drain();
        return usage ? { ...result, usage } : result;
      },
    };
  }
  function registerToolReportingUsage(tool: any): void {
    pi.registerTool(withUsageReporting(tool));
  }

  // The mention path is handed THIS object, not the bare `agentTool` — see the
  // mention-clone header on why the clone must call the registered tool.
  const registeredAgentTool = withUsageReporting(agentTool);
  pi.registerTool(registeredAgentTool);

  // ---- get_subagent_result tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || record.parentAgentId) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // Wait for completion if requested. Cancellation stops only this tool
      // call; the background agent keeps running and remains unconsumed so its
      // completion notification can still be delivered.
      // Queued agents have no promise yet (it's created when the queue starts
      // them), so poll until they leave the queue, then await like a running one.
      if (params.wait && (record.status === "running" || record.status === "queued")) {
        while (record.status === "queued") {
          await abortable(
            new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
            signal,
          );
        }
        if (record.promise) await abortable(record.promise, signal);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (showCost) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        output += record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        cancelNudge(params.agent_id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  registerToolReportingUsage(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running). The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || record.parentAgentId) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (showCost) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- /agents interactive menu ----

  // Directory resolution and the frontmatter edits live in agent-file-toggle.ts
  // so they are reachable from tests — this command handler is only registered
  // through `registerCommand`, which every test mocks.

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolved = resolveModel(cfg.model, registry);
    // Configured but unresolvable: the runtime silently falls back to the parent
    // model, so flag it (and the fallback) rather than hiding the config.
    if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Running agents entry (only if there are active agents)
    const agents = manager.listAgents().filter(a => !a.parentAgentId);
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Scheduled jobs entry (always present when scheduler is active)
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    // Actions
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await ctx.ui.select("Agents", options);
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle.
        values: [model],
      };
    });

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");

    const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id), // Enter/Space on a row → return that agent's name
        () => done(undefined), // Esc → cancel
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    });

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents().filter(a => !a.parentAgentId);
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Numbered + item-paired. Two same-type agents spawned together with the
    // same description render identically here, and resolving the choice by
    // string match would open whichever came first.
    const record = await selectItem(ctx.ui, "Running agents", agents, a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });
    if (!record) return;

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./ui/conversation-viewer.js");
    const session = record.session;
    const activity = agentActivity.get(record.id);

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        }, keybindings, (message: string) => manager.steer(record.id, message), showCost);
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = locateAgentFile(name, cfg.sourcePath);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await ctx.ui.select(name, menuOptions);
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const content = serializeAgentFile(cfg);

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      const { content: updated, outcome } = disableInContent(content);
      if (outcome === "already-disabled") {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      if (outcome === "no-frontmatter") {
        // Nothing to edit — say so rather than rewriting the file unchanged and
        // reporting success for a change that never happened.
        ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
        return;
      }
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const { content: updated, changed } = enableInContent(content);
    if (!changed && !isEmptyStub(updated)) {
      // The file carries no `enabled: false` to remove, so it was never disabled
      // by us — reporting success here would hide a no-op.
      ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
      return;
    }
    const { writeFileSync } = await import("node:fs");

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (isEmptyStub(updated)) {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]);
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]);
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
color: <optional agent name badge color: red, blue, green, yellow, purple, orange, pink, cyan, an Agency Agents alias, or quoted "#RRGGBB">
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <pin this agent to background (true) or foreground (false). Omit to follow the backgroundByDefault setting, which is background>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>${
      // Do not offer a field that this project refuses at runtime.
      isWorktreeIsolationEnabled()
        ? `\nisolation: <"worktree" to run in an isolated repository workspace using the configured backend; "off" to refuse one even when the caller asks. Omit for normal>`
        : ""
    }
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; this alone doesn't keep the run off disk (persist_session, isolation: worktree commits, and memory still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const { record } = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Tools
    const toolChoice = await ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]);
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]);
    if (!modelChoice) return;

    let model: string | undefined;
    if (modelChoice === "haiku") model = "anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") model = "anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") model = "anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      model = (await ctx.ui.input("Model (provider/modelId)")) || undefined;
    }

    // 5. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
    if (!thinkingChoice) return;

    // 6. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    const content = buildNewAgentFile({
      description,
      tools,
      model,
      thinking: thinkingChoice === "inherit" ? undefined : thinkingChoice,
      systemPrompt,
    });

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  /**
   * Every settings mutation writes this WHOLE object back to disk, so a field
   * missing here is erased from the user's subagents.json the next time they
   * toggle something unrelated. `SubagentsSettings` has every field optional,
   * so a `: SubagentsSettings` return annotation would let a newly-added setting
   * be forgotten here and still type-check. `satisfies` instead: it still checks
   * each value's type and rejects a mistyped key, but leaves the return type
   * inferred so `_NoMissingSettingsKeys` below can check completeness.
   */
  function snapshotSettings() {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      isolationBackend: manager.getIsolationBackend(),
      backgroundByDefault: getBackgroundByDefault(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      strictAgentFiles,
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      agentMentions: getAgentMentionMode(),
      rememberAgents: getRememberAgents(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      maxSubagentDepth: getMaxSubagentDepth(),
      // Deliberately NOT `?? "general-purpose"`: every settings change writes the
      // whole snapshot, and materializing the implicit default would turn it into
      // explicit configuration — which then fails loudly if general-purpose later
      // goes away. undefined is dropped by JSON.stringify.
      fallbackSubagent: getFallbackSubagent(),
      reportUsage: isReportUsageEnabled(),
      showCost: isShowCostEnabled(),
    } satisfies SubagentsSettings;
  }

  // Compile-time completeness guard for snapshotSettings(). If a field is added
  // to SubagentsSettings and not mirrored above, this Exclude is non-empty and
  // fails to satisfy `never` — turning a silent settings-erasure bug into a
  // typecheck error. `npm run typecheck` runs in CI.
  type _NoMissingSettingsKeys =
    Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  const NUMERIC_IDS = new Set(["maxConcurrent", "defaultMaxTurns", "graceTurns", "maxSubagentDepth"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();
      const msd = getMaxSubagentDepth();
      // Label what unset actually does — it targets general-purpose even when
      // that is unregistered (the permissive hardcoded tier), so showing "none"
      // there would advertise strict dispatch for the most permissive state.
      // `values` still offers only resolvable targets, so the user cannot
      // persist a fallback that would hard-error on every dispatch.
      const fallbackValue = getFallbackSubagent() ?? "general-purpose";
      const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "maxSubagentDepth",
          label: "Nested depth",
          description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
          currentValue: String(msd),
          values: [String(msd)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "Default join mode for background agents",
          currentValue: getDefaultJoinMode(),
          values: ["smart", "async", "group"],
        },
        {
          id: "isolationBackend",
          label: "Isolation backend",
          description: "Backend for worktree isolation: auto chooses the nearest repo and prefers jj at a colocated root",
          currentValue: manager.getIsolationBackend(),
          values: ["auto", "jj", "git"],
        },
        {
          id: "backgroundByDefault",
          label: "Background by default",
          description: "An Agent call that does not specify a mode runs detached; off blocks and returns inline",
          currentValue: getBackgroundByDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "strictAgentFiles",
          label: "Strict agent files",
          description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
          currentValue: strictAgentFiles ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fallbackSubagent",
          label: "Fallback agent",
          description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
          currentValue: fallbackValue,
          values: fallbackValues,
        },
        {
          id: "outputTranscript",
          label: "Output transcript",
          description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "worktreeIsolation",
          label: "Worktree isolation",
          description:
            "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
          currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "reportUsage",
          label: "Report usage to session",
          description:
            "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
          currentValue: isReportUsageEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "showCost",
          label: "Show cost",
          description:
            "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
          currentValue: isShowCostEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "fleetView",
          label: "Fleet view",
          description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
          currentValue: isFleetViewEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "agentMentions",
          label: "Agent mentions",
          description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
          currentValue: getAgentMentionMode(),
          values: ["model", "direct", "off"],
        },
        {
          id: "rememberAgents",
          label: "Remember agents",
          description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
          currentValue: getRememberAgents() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "widgetMode",
          label: "Widget",
          description: "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
          currentValue: getWidgetMode(),
          values: ["all", "background", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "maxSubagentDepth") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setMaxSubagentDepth(n);
          notifyApplied(
            ctx,
            n <= 1
              ? "Nested delegation disabled"
              : `Nested depth set to ${n}. Applies to agents started from now on.`,
          );
        }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "isolationBackend") {
        manager.setIsolationBackend(value as IsolationBackend);
        notifyApplied(ctx, `Isolation backend set to ${value}`);
      } else if (id === "backgroundByDefault") {
        const enabled = value === "on";
        setBackgroundByDefault(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Agent calls run in the background unless they pass run_in_background: false"
            : "Agent calls block and return inline unless they pass run_in_background: true",
        );
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "strictAgentFiles") {
        const enabled = value === "on";
        strictAgentFiles = enabled;
        notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`);
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
      } else if (id === "fallbackSubagent") {
        setFallbackSubagent(value);
        notifyApplied(
          ctx,
          value === NO_FALLBACK
            ? "Unknown or disabled agent types will now be rejected"
            : `Unknown agent types will fall back to ${value}`,
        );
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscriptDefault(enabled);
        notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`);
      } else if (id === "worktreeIsolation") {
        const enabled = value === "on";
        setWorktreeIsolationEnabled(enabled);
        // The refusal is live, but the tool schema is built at registration, so
        // the isolation parameter only appears/disappears next session.
        notifyApplied(
          ctx,
          `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        );
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "reportUsage") {
        const enabled = value === "on";
        setReportUsage(enabled);
        notifyApplied(
          ctx,
          enabled
            ? "Subagent usage now counted in this session's totals"
            : "Subagent usage no longer counted in this session's totals",
        );
      } else if (id === "showCost") {
        const enabled = value === "on";
        setShowCost(enabled);
        notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "fleetView") {
        const enabled = value === "on";
        setFleetViewEnabled(enabled);
        notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "agentMentions") {
        const mode = value as AgentMentionMode;
        setAgentMentionMode(mode);
        notifyApplied(
          ctx,
          mode === "off"
            ? "Agent mentions disabled"
            : mode === "model"
              ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
              : "Agent mentions on — a mentioned agent starts here, with no model call",
        );
      } else if (id === "rememberAgents") {
        const enabled = value === "on";
        setRememberAgents(enabled);
        notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "widgetMode") {
        setWidgetMode(value as WidgetMode);
        notifyApplied(ctx, `Widget set to ${value}`);
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : result === "maxSubagentDepth"
            ? String(getMaxSubagentDepth())
            : String(getGraceTurns());

      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : result === "maxSubagentDepth"
            ? "Nested depth (0/1 = nesting off)"
            : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
