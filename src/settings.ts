// Persistence for pi-subagents operational settings.
// - Global:  ~/.pi/agent/subagents.json (via getAgentDir()) — manual defaults, never written here
// - Project: <cwd>/.pi/subagents.json — written by /agents → Settings; overrides global on load

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NO_FALLBACK } from "./agent-types.js";
import type { AgentMentionMode, IsolationBackend, JoinMode, WidgetMode } from "./types.js";

export interface SubagentsSettings {
  maxConcurrent?: number;
  /**
   * 0 = unlimited — the extension's single source of truth for that convention:
   * `normalizeMaxTurns()` in agent-runner.ts treats 0 → `undefined`, and the
   * `/agents` → Settings input prompt explicitly says "0 = unlimited".
   */
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  /**
   * Backend for `isolation: worktree`. `auto` (default) chooses the nearest
   * repository; at a colocated root it prefers Jujutsu, then Git. Explicit
   * `jj` or `git` disables fallback and fails loudly when inapplicable.
   */
  isolationBackend?: IsolationBackend;
  /**
   * Whether an unqualified top-level `Agent` spawn runs detached. Defaults to
   * `true`; nested spawns always default to foreground.
   */
  backgroundByDefault?: boolean;
  /**
   * Master switch for the schedule subagent feature. Defaults to `true`.
   * When `false`: the `Agent` tool's `schedule` param + its guideline are
   * stripped from the tool spec at registration (zero LLM-context cost), the
   * scheduler doesn't bind to the session, and the `/agents → Scheduled jobs`
   * menu entry is hidden. Schema-level removal applies at extension load
   * (next pi session); runtime menu/runtime-fire short-circuit is immediate.
   */
  schedulingEnabled?: boolean;
  /**
   * When true, the effective model of each subagent spawn is validated
   * against `enabledModels` from pi's settings — both global
   * (`<agentDir>/settings.json`) and project-local (`<cwd>/.pi/settings.json`),
   * with project overriding global (mirrors pi's SettingsManager deep-merge).
   *
   * scopeModels guards against runtime LLM choices, not user-level config.
   * Out-of-scope handling reflects this:
   *   - Caller-supplied via `Agent({ model: "..." })` (only when frontmatter
   *     has no `model:`, since frontmatter is authoritative): hard error
   *     returned to the orchestrator, listing the allowed models. The LLM
   *     made an explicit out-of-scope choice and gets explicit feedback.
   *   - Frontmatter-pinned: warning toast + the pinned model runs. The
   *     agent's author/installer chose this; trust it.
   *   - Parent-inherited (neither caller nor frontmatter sets a model):
   *     warning toast + parent's model runs. The user chose the parent's
   *     model when starting the session; trust it.
   *
   * No-op when pi's `enabledModels` is empty or absent — nothing to validate
   * against. Defaults to false: subagents may use any model.
   */
  scopeModels?: boolean;
  /**
   * When true, an unreadable or unparseable agent `.md` aborts extension load
   * instead of being skipped with a warning — pi exits, naming the file.
   *
   * Startup only, by design. Mid-session reloads (one per `Agent` call) keep
   * warning: a bad edit at 3pm should not kill the session on the next
   * unrelated spawn, where the failure would look disconnected from its cause.
   * For a checked-in `.pi/agents/`, failing at startup is the point — the
   * alternative is running a *different* agent than the file names.
   * Defaults to false.
   */
  strictAgentFiles?: boolean;
  /**
   * When true, the three built-in default agents (general-purpose, Explore, Plan)
   * are not registered at startup. User-defined agents from project/global custom
   * agent dirs are completely unaffected — only the hardcoded DEFAULT_AGENTS are suppressed.
   * Defaults to false.
   */
  disableDefaultAgents?: boolean;
  /**
   * Which Agent tool description the LLM sees. "full" (default) is the rich
   * Claude Code-style prompt; "compact" is a ~75% smaller version (one-line
   * agent type list, terse usage notes) for small/local models where tool-spec
   * tokens are expensive; "custom" reads `.pi/agent-tool-description.md`
   * (project, falling back to `<agentDir>/agent-tool-description.md`) with
   * `{{placeholder}}` substitution — a missing/empty file falls back to "full".
   * The mode is read once at tool registration — changing it applies on the
   * next pi session.
   */
  toolDescriptionMode?: ToolDescriptionMode;
  /**
   * Whether the Claude Code-style FleetView (the navigable main+subagents list
   * rendered below the editor) is shown. Defaults to `true`. Pure-UI: when off,
   * the list never registers and the global key handler never captures input.
   */
  fleetView?: boolean;
  /**
   * Whether `@handle message` typed at the prompt is routed to that subagent
   * instead of the main model, and whether `@` offers running agents alongside
   * pi's file completion. Defaults to `model`. Applied live.
   *
   *   - `model`: mentioning an agent that is not running asks the main model to
   *     spawn it with the `Agent` tool, Claude Code's behaviour. Costs a turn,
   *     and the model writes the agent's prompt rather than your text being it.
   *   - `direct`: that agent is started here instead, with the typed message as
   *     its prompt and no main-model turn spent.
   *   - `off`: the input hook falls straight through and the stacked
   *     autocomplete provider delegates everything back to pi's built-in one.
   *
   * Messaging a running agent and resuming a finished one are direct in both
   * `model` and `direct`. The legacy booleans are still accepted: `true` reads
   * as `model`, `false` as `off`.
   */
  agentMentions?: AgentMentionMode;
  /**
   * Whether subagents persist their pi session by default, so `@handle` can
   * reopen an agent's conversation long after its in-memory record is gone.
   * Defaults to `true`. Per-agent `persist_session:` frontmatter overrides it
   * in both directions. Turning it off restores the previous behaviour, where
   * a handle stops resolving roughly ten minutes after the agent finishes and
   * mentioning it starts a fresh run instead. Persisted sessions also appear
   * nested under the spawning session in pi's `/resume`.
   */
  rememberAgents?: boolean;
  /**
   * Display mode for the persistent above-editor agent widget:
   *   - `all`: show every agent (foreground + background).
   *   - `background`: hide foreground agents — they already render inline as the
   *     Agent tool result, so the widget would otherwise double-render them
   *     (#118); everything else (background, queued, scheduled, RPC) stays.
   *   - `off`: hide the widget entirely.
   * Defaults to `background`. Pure-UI and applied live (toggling refreshes the
   * widget).
   */
  widgetMode?: WidgetMode;
  /**
   * Project/global default for writing each subagent's `.output` transcript
   * (a JSON-lines copy of the run, stored under the OS temp dir).
   * Defaults to `true`. Set `false` to make transcripts opt-in for the whole
   * project (e.g. a repo that shouldn't leave run transcripts on disk for backup
   * or DLP tooling to ingest). A custom agent's `output_transcript` frontmatter
   * overrides this per agent. This governs only the transcript — it does NOT
   * affect the persisted pi session (`persist_session`), worktree commits
   * (`isolation: worktree`), or memory files.
   */
  outputTranscript?: boolean;
  /**
   * Whether `isolation: "worktree"` may create a worktree at all. Defaults to
   * `true`. Set `false` on a repo where worktrees are too slow or too large to
   * be worth it (#184): a requested worktree is then dropped and the agent runs
   * in the main checkout.
   *
   * The drop is deliberately silent — there is no per-result note, because the
   * setting exists for projects whose model asks for a worktree on every call,
   * where a note would be noise on every result. What keeps the orchestrator
   * from claiming a `pi-agent-*` branch anyway is that it is never told the
   * capability exists: `isolationParam` (invocation-config.ts) drops the field
   * from both tool schemas, and `isolationGuideline` (index.ts) drops the
   * matching prose from the full and compact descriptions — a custom one opts
   * in via the `{{isolationGuideline}}` placeholder. Anything that
   * reintroduces the prose has to reintroduce a note with it.
   *
   * Deliberately a downgrade rather than an error. The fail-loud rule covers
   * worktrees that *cannot* be created; this is the user declining one, and
   * throwing would reject exactly the calls that the `isolation: "off"` value
   * exists to tolerate. Enforced below the tool boundary, so it also covers the
   * scheduler and the unvalidated cross-extension RPC path.
   */
  worktreeIsolation?: boolean;
  /**
   * Hard ceiling on nested subagent delegation, counted from the main session:
   * main = 0, its subagents = 1, their children = 2. Defaults to `2`; `0` or `1`
   * disables nesting project-wide. Read when a subagent session is built, so a
   * change applies to agents started after it.
   */
  maxSubagentDepth?: number;
  /**
   * Agent type substituted when a caller-supplied `subagent_type` doesn't
   * resolve to exactly one enabled agent (unknown, disabled, or ambiguous by
   * case). Omitted keeps the historical `general-purpose` fallback; a type name
   * routes those calls to that agent instead; `"none"` disables the fallback so
   * dispatch fails closed with an error naming the available types.
   *
   * The boolean `false` is accepted as a spelling of `"none"`, because a boolean
   * would otherwise be dropped as the wrong type and silently leave the
   * PERMISSIVE default in place while the author believes strict dispatch is on
   * — the wrong direction to fail for this setting. Every other value is an
   * agent name, so a mistaken `"off"` fails loudly at dispatch rather than
   * meaning one thing here and another in the resolver.
   */
  fallbackSubagent?: string;
  /**
   * Whether this extension's tool results carry a `usage` field, so subagent
   * spend reaches the parent session's own accounting. Defaults to `false`.
   *
   * Subagents run in their own pi sessions, so by default the parent's footer,
   * statusline and `/cost` show only what the main model spent — a session that
   * delegated most of its work reads as nearly free. Pi folds
   * `toolResult.usage` into `getSessionStats()`, so attaching it makes those
   * surfaces count subagents too, under `/cost`'s "Tools/summaries" bucket.
   *
   * Off by default because it changes numbers the user may already be tracking
   * (a statusline reading session cost will step up), not because the numbers
   * are wrong.
   *
   * Three properties of what gets reported:
   *   - Tokens exclude `cacheRead`, for the reason in `usage.ts` — the parent's
   *     token total therefore rises by billed tokens only.
   *   - Cost is pi's own per-message `usage.cost.total`; we price nothing, and
   *     a model pi has no rates for contributes 0.
   *   - The context-window percentage is untouched. Pi derives it from assistant
   *     messages alone (`getContextUsage`), so a delegating session's context
   *     does not appear to fill up faster.
   */
  reportUsage?: boolean;
  /**
   * Whether the subagent surfaces show an estimated dollar cost next to their
   * token counts (widget, FleetView, conversation viewer, foreground results,
   * completion notifications). Defaults to `false`. Applied live.
   *
   * Rendered as `~$0.0042` — the tilde marks it as pi's reported estimate
   * rather than a billed figure, and it is omitted entirely when the model has
   * no pricing data, so a local model shows tokens and no dollars.
   *
   * Independent of `reportUsage`: this one is what a human reads, that one is
   * what the parent session counts.
   */
  showCost?: boolean;
}

export type ToolDescriptionMode = "full" | "compact" | "custom";

/** Setter hooks used by applySettings to wire persisted values into in-memory state. */
export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setIsolationBackend: (backend: IsolationBackend) => void;
  setBackgroundByDefault: (b: boolean) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setToolDescriptionMode: (mode: ToolDescriptionMode) => void;
  setFleetView: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setFallbackSubagent: (v: string | undefined) => void;
  setReportUsage: (b: boolean) => void;
  setShowCost: (b: boolean) => void;
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

const VALID_JOIN_MODES: ReadonlySet<string> = new Set<JoinMode>(["async", "group", "smart"]);
const VALID_ISOLATION_BACKENDS: ReadonlySet<string> = new Set<IsolationBackend>(["auto", "jj", "git"]);
const VALID_TOOL_DESCRIPTION_MODES: ReadonlySet<string> = new Set<ToolDescriptionMode>(["full", "compact", "custom"]);
const VALID_WIDGET_MODES: ReadonlySet<string> = new Set<WidgetMode>(["all", "background", "off"]);
const VALID_AGENT_MENTION_MODES: ReadonlySet<string> = new Set<AgentMentionMode>(["model", "direct", "off"]);

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const GRACE_TURNS_CEILING = 1_000;
const SUBAGENT_DEPTH_CEILING = 16;

/** Drop fields that don't match the expected shape. Silent — garbage becomes absent. */
function sanitize(raw: unknown): SubagentsSettings {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SubagentsSettings = {};
  if (
    Number.isInteger(r.maxConcurrent) &&
    (r.maxConcurrent as number) >= 1 &&
    (r.maxConcurrent as number) <= MAX_CONCURRENT_CEILING
  ) {
    out.maxConcurrent = r.maxConcurrent as number;
  }
  if (
    Number.isInteger(r.defaultMaxTurns) &&
    (r.defaultMaxTurns as number) >= 0 &&
    (r.defaultMaxTurns as number) <= MAX_TURNS_CEILING
  ) {
    out.defaultMaxTurns = r.defaultMaxTurns as number;
  }
  if (
    Number.isInteger(r.graceTurns) &&
    (r.graceTurns as number) >= 1 &&
    (r.graceTurns as number) <= GRACE_TURNS_CEILING
  ) {
    out.graceTurns = r.graceTurns as number;
  }
  if (
    Number.isInteger(r.maxSubagentDepth) &&
    (r.maxSubagentDepth as number) >= 0 &&
    (r.maxSubagentDepth as number) <= SUBAGENT_DEPTH_CEILING
  ) {
    out.maxSubagentDepth = r.maxSubagentDepth as number;
  }
  if (typeof r.defaultJoinMode === "string" && VALID_JOIN_MODES.has(r.defaultJoinMode)) {
    out.defaultJoinMode = r.defaultJoinMode as JoinMode;
  }
  if (typeof r.isolationBackend === "string" && VALID_ISOLATION_BACKENDS.has(r.isolationBackend)) {
    out.isolationBackend = r.isolationBackend as IsolationBackend;
  }
  if (typeof r.backgroundByDefault === "boolean") {
    out.backgroundByDefault = r.backgroundByDefault;
  }
  if (typeof r.schedulingEnabled === "boolean") {
    out.schedulingEnabled = r.schedulingEnabled;
  }
  if (typeof r.scopeModels === "boolean") {
    out.scopeModels = r.scopeModels;
  }
  if (typeof r.strictAgentFiles === "boolean") {
    out.strictAgentFiles = r.strictAgentFiles;
  }
  if (typeof r.disableDefaultAgents === "boolean") {
    out.disableDefaultAgents = r.disableDefaultAgents;
  }
  if (typeof r.toolDescriptionMode === "string" && VALID_TOOL_DESCRIPTION_MODES.has(r.toolDescriptionMode)) {
    out.toolDescriptionMode = r.toolDescriptionMode as ToolDescriptionMode;
  }
  if (typeof r.fleetView === "boolean") {
    out.fleetView = r.fleetView;
  }
  // Was a boolean before the `model` mode existed. A hand-written or
  // previously-written `true` means "on", which is now the default `model`.
  if (typeof r.agentMentions === "boolean") {
    out.agentMentions = r.agentMentions ? "model" : "off";
  } else if (typeof r.agentMentions === "string" && VALID_AGENT_MENTION_MODES.has(r.agentMentions)) {
    out.agentMentions = r.agentMentions as AgentMentionMode;
  }
  if (typeof r.rememberAgents === "boolean") {
    out.rememberAgents = r.rememberAgents;
  }
  if (typeof r.widgetMode === "string" && VALID_WIDGET_MODES.has(r.widgetMode)) {
    out.widgetMode = r.widgetMode as WidgetMode;
  }
  if (typeof r.outputTranscript === "boolean") {
    out.outputTranscript = r.outputTranscript;
  }
  if (typeof r.worktreeIsolation === "boolean") {
    out.worktreeIsolation = r.worktreeIsolation;
  }
  if (typeof r.reportUsage === "boolean") {
    out.reportUsage = r.reportUsage;
  }
  if (typeof r.showCost === "boolean") {
    out.showCost = r.showCost;
  }
  if (r.fallbackSubagent === false) {
    // The only non-string spelling worth accepting: a boolean would otherwise be
    // dropped, silently leaving the PERMISSIVE default in place. Every string is
    // an agent name except the `none` sentinel, which the resolver recognizes —
    // so a mistaken "off" fails loudly at dispatch instead of meaning something
    // different here than it does there.
    out.fallbackSubagent = NO_FALLBACK;
  } else if (typeof r.fallbackSubagent === "string" && r.fallbackSubagent.trim()) {
    out.fallbackSubagent = r.fallbackSubagent.trim();
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

/**
 * Read a settings file. Missing file is silent (returns `{}`). A file that
 * exists but can't be parsed emits a warning to stderr so users aren't
 * silently reverted to defaults — and still returns `{}` so startup proceeds.
 */
function readSettingsFile(path: string): SubagentsSettings {
  if (!existsSync(path)) return {};
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

/** Load merged settings: global provides defaults, project overrides. */
export function loadSettings(cwd: string = process.cwd()): SubagentsSettings {
  return { ...readSettingsFile(globalPath()), ...readSettingsFile(projectPath(cwd)) };
}

/**
 * Write project-local settings. Global is never touched from code.
 * Returns `true` on success, `false` if the write (or mkdir) failed so the
 * caller can surface a warning — persistence isn't fatal but isn't silent.
 */
export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): boolean {
  const path = projectPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Apply persisted settings to the in-memory state via caller-supplied setters. */
export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (typeof s.maxConcurrent === "number") appliers.setMaxConcurrent(s.maxConcurrent);
  if (typeof s.defaultMaxTurns === "number") appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (typeof s.graceTurns === "number") appliers.setGraceTurns(s.graceTurns);
  if (typeof s.maxSubagentDepth === "number") appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (typeof s.fallbackSubagent === "string") appliers.setFallbackSubagent(s.fallbackSubagent);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (s.isolationBackend) appliers.setIsolationBackend(s.isolationBackend);
  if (typeof s.backgroundByDefault === "boolean") appliers.setBackgroundByDefault(s.backgroundByDefault);
  if (typeof s.schedulingEnabled === "boolean") appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (typeof s.scopeModels === "boolean") appliers.setScopeModels(s.scopeModels);
  if (typeof s.strictAgentFiles === "boolean") appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (typeof s.disableDefaultAgents === "boolean") appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.toolDescriptionMode) appliers.setToolDescriptionMode(s.toolDescriptionMode);
  if (typeof s.fleetView === "boolean") appliers.setFleetView(s.fleetView);
  if (s.agentMentions) appliers.setAgentMentions(s.agentMentions);
  if (typeof s.rememberAgents === "boolean") appliers.setRememberAgents(s.rememberAgents);
  if (s.widgetMode) appliers.setWidgetMode(s.widgetMode);
  if (typeof s.outputTranscript === "boolean") appliers.setOutputTranscript(s.outputTranscript);
  if (typeof s.worktreeIsolation === "boolean") appliers.setWorktreeIsolation(s.worktreeIsolation);
  if (typeof s.reportUsage === "boolean") appliers.setReportUsage(s.reportUsage);
  if (typeof s.showCost === "boolean") appliers.setShowCost(s.showCost);
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of `saveSettings` into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

/**
 * Load merged settings, apply them to in-memory state, and emit the
 * `subagents:settings_loaded` lifecycle event. Returns the loaded settings so
 * callers can log/inspect. Extension init wires this once.
 */
export function applyAndEmitLoaded(
  appliers: SettingsAppliers,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): SubagentsSettings {
  const settings = loadSettings(cwd);
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

/**
 * Persist a settings snapshot, emit the `subagents:settings_changed` event
 * (regardless of persist outcome so listeners see the in-memory change), and
 * return the toast the UI should display. Event payload carries the `persisted`
 * flag so listeners can react to write failures.
 */
export function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): { message: string; level: "info" | "warning" } {
  const persisted = saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
