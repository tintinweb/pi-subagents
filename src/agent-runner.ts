/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type EventBus,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { SubagentType, ThinkingLevel } from "./types.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);
const GOAL_TOOL_NAMES = ["goal_complete", "goal_blocked"] as const;
const GOAL_TERMINAL_STATUSES = new Set([
  "complete",
  "blocked",
  "paused",
  "usage_limited",
  "budget_limited",
]);

type GoalState = {
  goalId: string;
  status: string;
  summary?: string;
  reason?: string;
};

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@tintinweb/pi-subagents`, so a looser rule would misattribute every
 * co-located file to `pi-subagents`.
 */
function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  /** Run the child through @narumitw/pi-goal until it reaches a terminal state. */
  goal?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

function isGoalExtension(path: string, tools: Map<string, unknown>): boolean {
  const names = extensionCanonicalNames(path);
  return names.includes("pi-goal") || (
    names.includes("goal") && GOAL_TOOL_NAMES.every((name) => tools.has(name))
  );
}

function isGoalState(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return typeof state.goalId === "string" && typeof state.status === "string";
}

function formatGoalResult(state: GoalState): string {
  const detail = state.summary ?? state.reason;
  return `Goal ${state.status.replaceAll("_", " ")}${detail ? `: ${detail}` : ""}`;
}

async function runGoal(
  eventBus: EventBus,
  objective: string,
  signal?: AbortSignal,
): Promise<GoalState> {
  const requestId = randomUUID();
  return new Promise((resolveGoal, rejectGoal) => {
    let goalId: string | undefined;
    let started = false;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeReply = () => {};
    let unsubscribeState = () => {};
    const pendingTerminal = new Map<string, GoalState>();

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      unsubscribeReply();
      unsubscribeState();
    };
    const finish = (state: GoalState) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveGoal(state);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectGoal(error);
    };
    const onAbort = () => {
      if (!started) {
        fail(new Error("Goal-mode agent was aborted before it started"));
        return;
      }
      if (timeout) clearTimeout(timeout);
      const reason = typeof signal?.reason === "string" ? signal.reason : "agent run aborted";
      eventBus.emit("pi-goal:rpc:pause", { goalId, reason });
      timeout = setTimeout(() => {
        fail(new Error("pi-goal did not acknowledge the goal pause request"));
      }, 1_000);
    };

    unsubscribeState = eventBus.on("pi-goal:state", (value) => {
      if (!isGoalState(value) || !GOAL_TERMINAL_STATUSES.has(value.status)) return;
      if (goalId === value.goalId) finish(value);
      else pendingTerminal.set(value.goalId, value);
    });
    unsubscribeReply = eventBus.on(`pi-goal:rpc:start:reply:${requestId}`, (value) => {
      if (!value || typeof value !== "object") return;
      const reply = value as {
        success?: unknown;
        error?: unknown;
        data?: { goalId?: unknown; status?: unknown };
      };
      if (reply.success !== true) {
        fail(new Error(typeof reply.error === "string" ? reply.error : "pi-goal rejected the objective"));
        return;
      }
      if (typeof reply.data?.goalId !== "string" || typeof reply.data.status !== "string") {
        fail(new Error("pi-goal returned an invalid start reply"));
        return;
      }
      goalId = reply.data.goalId;
      if (timeout) clearTimeout(timeout);
      const pending = pendingTerminal.get(goalId);
      if (pending) finish(pending);
      else if (GOAL_TERMINAL_STATUSES.has(reply.data.status)) {
        finish({ goalId, status: reply.data.status });
      }
    });
    timeout = setTimeout(() => {
      fail(new Error("pi-goal is loaded but does not support goal-mode RPC; update @narumitw/pi-goal"));
    }, 1_000);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    started = true;
    eventBus.emit("pi-goal:rpc:start", { requestId, objective });
  });
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  if (options.goal && options.isolated) {
    throw new Error("Cannot combine goal mode with isolated: true because pi-goal is an extension");
  }

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  // Nulling excludes under isolated also suppresses the orphaned-exclude warning —
  // isolation is an intentional override, not a misconfiguration.
  const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
  const skills = options.isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tool names (read/write/edit)
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      // Read-only memory: only add read tool name, use read-only prompt
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(
    options.isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
  // Plain canonical names only (case-insensitive). Note: excluded extensions'
  // factories still run once during reload() (see comment above) — exclusion
  // suppresses handler binding and tool registration; it is not a sandbox.
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  // The override filters loaded extensions down to `keepNames` minus `excludeNames`.
  // It's only needed when we're neither loading everything without excludes
  // (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  const eventBus = options.goal ? createEventBus() : undefined;
  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    eventBus,
    agentDir,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  if (
    options.goal &&
    !loader.getExtensions().extensions.some((extension) =>
      isGoalExtension(extension.path, extension.tools)
    )
  ) {
    throw new Error("Goal mode requires @narumitw/pi-goal to be loaded by this agent");
  }

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. Two distinct misconfigurations to catch:
  //   - `extensions: [foo]` but no extension named foo was discovered (typo or
  //     path that failed to load — path entries fold their canonical name into
  //     `keepNames`, so this covers them too).
  //   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
  //     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
  //     loading is `extensions:`-authoritative.
  // An exclude_extensions: alongside extensions: false is contradictory — nothing
  // loads, so there is nothing to exclude.
  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  // Exclude typo check: compares against the PRE-filter discovered set (an excluded
  // name absent from the surviving set is the exclude working as intended). Also
  // flags path-like and "*" entries — excludes are plain names only.
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  // Enumerate extension-registered tool names from the loaded resource loader.
  // Extensions populate `extension.tools` during `loader.reload()` and the set
  // is stable afterwards — `bindExtensions` does not register new tools.
  //
  // Opt-in flip: when any `ext:` selector is present, extension tools become an
  // explicit allowlist — a loaded extension not named by a selector contributes
  // no tools (its handlers still ran), and `ext:foo/bar` narrows `foo` to `bar`.
  const extensionToolNames: string[] = [];
  if (!noExtensions) {
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      const requiredForGoal = options.goal && isGoalExtension(extension.path, extension.tools);
      if (optInActive && !requiredForGoal && !canons.some((c) => extNames.has(c))) continue;
      // First alias that carries a narrowing set — a user won't narrow one
      // extension under two different names, so first-match is correct.
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const toolName of extension.tools.keys()) {
        if (narrowed && !narrowed.has(toolName)) continue;
        extensionToolNames.push(toolName);
      }
    }
  }

  // Build the master tool allowlist applied at session construction.
  // pi-mono's `allowedToolNames` gates BOTH registration and the initial active
  // set, so listing the exact final set here means the session is correctly
  // scoped from the first instant — no post-construction narrowing required.
  const builtinToolNameSet = new Set(toolNames);
  const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {
    if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
    if (disallowedSet?.has(t)) return false;
    if (builtinToolNameSet.has(t)) return true;
    // Reached only for extension tools. The extension set was already filtered
    // at the loader (extensionsOverride / noExtensions) and at enumeration
    // (`ext:` opt-in flip), so any extension tool in `extensionToolNames` is allowed.
    return !noExtensions;
  });
  if (options.goal && !GOAL_TOOL_NAMES.every((name) => allowedTools.includes(name))) {
    throw new Error("Goal mode requires goal_complete and goal_blocked in the active tool allowlist");
  }

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  const sessionManager = agentConfig?.persistSession
    ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir)
    : SessionManager.inMemory(effectiveCwd);

  // Pi 0.80.8 replaced createAgentSession's modelRegistry option with
  // modelRuntime, but ExtensionContext still exposes only the registry facade.
  // Pass both so the full supported Pi range retains the parent's providers.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
    modelRuntime?: unknown;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime }),
    model,
    tools: allowedTools,
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Tool gating already happened
  // at session construction via the `tools:` allowlist above — no separate
  // post-bind filter is needed. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  const goalAbortController = options.goal ? new AbortController() : undefined;
  const abortGoalFromParent = () => goalAbortController?.abort("agent run aborted");
  if (options.signal?.aborted) abortGoalFromParent();
  else options.signal?.addEventListener("abort", abortGoalFromParent, { once: true });

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
          goalAbortController?.abort("turn limit reached");
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this run's output (a fresh session, so usually 0).
  const startLen = session.messages.length;
  let goalState: GoalState | undefined;
  try {
    if (options.goal) {
      if (!eventBus) throw new Error("Goal mode event bus was not initialized");
      goalState = await runGoal(eventBus, effectivePrompt, goalAbortController?.signal);
    } else {
      await session.prompt(effectivePrompt);
    }
  } finally {
    try {
      if (options.goal) await session.waitForIdle();
    } finally {
      options.signal?.removeEventListener("abort", abortGoalFromParent);
      unsubTurns();
      collector.unsubscribe();
      cleanupAbort();
    }
  }

  const responseText = goalState
    ? formatGoalResult(goalState)
    : collector.getText().trim() || getLastAssistantText(session, startLen);
  const failure = goalState && goalState.status !== "complete"
    ? responseText
    : finalTurnError(session, startLen);
  return { responseText, session, aborted, steered: softLimitReached, failure };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ text: string; failure?: string }> {
  // Boundary for the history fallback: the session already holds prior turns,
  // so only assistant text produced by THIS resume prompt counts as its output
  // — a failed resume must not surface the previous turn's answer (#144).
  const startLen = session.messages.length;
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubEvents = (options.onToolActivity || options.onAssistantUsage || options.onCompaction)
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const u = (event.message as any).usage;
          if (u) options.onAssistantUsage?.({
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
          });
        }
        if (event.type === "compaction_end" && !event.aborted && event.result) {
          options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
        }
      })
    : () => {};

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubEvents();
    cleanupAbort();
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    failure: finalTurnError(session, startLen),
  };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
