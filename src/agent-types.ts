/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md, .agents/agents/*.md, and global agents.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

/** `fallbackSubagent` value that disables the fallback entirely (strict dispatch). */
export const NO_FALLBACK = "none";

/**
 * Build a registry map: DEFAULT_AGENTS first (unless disabled via settings),
 * then user agents overlaid on top (same name overrides the default).
 * Pure — every caller builds registries for its own root: the per-session
 * state below for the session's config root, nested delegation for its own.
 */
export function buildAgentRegistry(
  userAgents: Map<string, AgentConfig>,
  disableDefaults = false,
): Map<string, AgentConfig> {
  const registry = new Map<string, AgentConfig>();
  if (!disableDefaults) {
    for (const [name, config] of DEFAULT_AGENTS) registry.set(name, config);
  }
  for (const [name, config] of userAgents) registry.set(name, config);
  return registry;
}

/** Case-insensitive key resolution within a registry. */
function resolveKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of registry.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Resolve a type name case-insensitively in a registry. Returns the canonical key or undefined. */
export function resolveTypeIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  return resolveKeyIn(registry, name);
}

/** Get the agent config for a type (case-insensitive) from a registry. */
export function getAgentConfigIn(registry: Map<string, AgentConfig>, name: string): AgentConfig | undefined {
  const key = resolveKeyIn(registry, name);
  return key ? registry.get(key) : undefined;
}

/** Check if a type is valid and enabled (case-insensitive) in a registry. */
export function isValidTypeIn(registry: Map<string, AgentConfig>, type: string): boolean {
  const key = resolveKeyIn(registry, type);
  if (!key) return false;
  return registry.get(key)?.enabled !== false;
}

/** Get all enabled type names in a registry (for spawning and tool descriptions). */
export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/**
 * Case-insensitive resolution that refuses to guess. An exact match always wins;
 * otherwise the name must match exactly one key. Two agents differing only in
 * case are reachable (`loadCustomAgents` keys by filename across three
 * directories), and picking whichever came first would silently dispatch a
 * different agent, model and tool policy than the caller meant.
 */
function resolveUnambiguousKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...registry.keys()].filter(key => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The canonical key for a caller-supplied name that identifies exactly one
 * ENABLED agent, or undefined. Strict by construction: no fallback, no guessing
 * between case-variants. Nested delegation resolves with this directly, since
 * "unknown types are rejected rather than falling back" is its own contract.
 */
export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): string | undefined {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return undefined;
  const key = resolveUnambiguousKeyIn(registry, raw);
  return key !== undefined && registry.get(key)?.enabled !== false ? key : undefined;
}

/** Outcome of resolving a caller-supplied `subagent_type` into a spawnable type. */
export type SpawnTypeResolution =
  /** Spawn this type. `fellBackFrom` is set when it isn't what the caller asked for. */
  | { ok: true; type: string; fellBackFrom?: string }
  /** Refuse the spawn and return this message to the caller. */
  | { ok: false; message: string };

/**
 * Resolve a caller-supplied agent type against a registry, applying the
 * `fallbackSubagent` policy. The single decision point for every caller-supplied
 * spawn — the Agent tool, the scheduler, cross-extension RPC, and the nested
 * tools — so a type that fails here never reaches `runAgent`, where `getConfigIn`
 * would silently substitute general-purpose.
 *
 * Unknown, disabled, and case-ambiguous names are all treated the same way:
 * the caller named something that doesn't identify exactly one enabled agent.
 *
 * Pure over `registry` and `fallbackSubagent` — callers that need fresh agent
 * files reload before calling (the Agent tool already does, per spawn).
 * Reloading here would mean importing custom-agents.ts, which imports this
 * module.
 *
 * `fallbackSubagent` is the type substituted when the requested one doesn't
 * resolve: `undefined` keeps the historical behavior (general-purpose);
 * `NO_FALLBACK` makes dispatch fail closed. Set from `subagents.json`.
 */
export function resolveSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
  fallbackSubagent?: string,
): SpawnTypeResolution {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";

  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };

  // A missing type follows the same policy as a wrong one rather than always
  // erroring: before this setting existed an empty type fell back like any
  // other unresolvable name, and only opting in should change that.
  const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";

  // Trimmed like `requested`: a padded value set programmatically would
  // otherwise be reported as a missing agent.
  const configured = typeof fallbackSubagent === "string" ? fallbackSubagent.trim() : undefined;

  if (configured !== undefined && configured.toLowerCase() === NO_FALLBACK) {
    return { ok: false, message: `${reason} Available: ${available()}.` };
  }

  if (configured !== undefined) {
    // An explicitly configured fallback that is itself unusable is a
    // misconfiguration, not a second chance to guess — say so rather than
    // quietly dropping to general-purpose.
    const fallbackKey = resolveUnambiguousKeyIn(registry, configured);
    if (fallbackKey === undefined || registry.get(fallbackKey)?.enabled === false) {
      return {
        ok: false,
        message:
          `${reason} The configured fallbackSubagent "${configured}" is itself ` +
          `unknown or disabled. Available: ${available()}.`,
      };
    }
    return { ok: true, type: fallbackKey, fellBackFrom: raw };
  }

  // Unset: historical behavior, deliberately unchanged. #183 asks for the
  // fallback to remain the default, so the pre-existing hole it leaves — an
  // unregistered general-purpose resolving to `getConfig`'s all-tools hardcoded
  // tier — is what `fallbackSubagent: none` is for, not something to close
  // under everyone silently.
  return { ok: true, type: "general-purpose", fellBackFrom: raw };
}

/** Get all type names in a registry, including disabled (for UI listing). */
export function getAllTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.keys()];
}

/** Get names of default agents in a registry. */
export function getDefaultAgentNamesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) in a registry. */
export function getUserAgentNamesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Get built-in tool names for a type (case-insensitive) from a registry. */
export function getToolNamesForTypeIn(registry: Map<string, AgentConfig>, type: string): string[] {
  const key = resolveKeyIn(registry, type);
  const raw = key ? registry.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  // `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
  // (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
  return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object) from a registry. Falls back to general-purpose. */
export function getConfigIn(registry: Map<string, AgentConfig>, type: string): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKeyIn(registry, type);
  const config = key ? registry.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      excludeExtensions: config.excludeExtensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  // Fallback for unknown/disabled types — general-purpose config
  const gp = registry.get("general-purpose");
  if (gp && gp.enabled !== false) {
    return {
      displayName: gp.displayName ?? gp.name,
      description: gp.description,
      builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: gp.extensions,
      excludeExtensions: gp.excludeExtensions,
      skills: gp.skills,
      promptMode: gp.promptMode,
    };
  }

  // Absolute fallback (should never happen)
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
    promptMode: "append",
  };
}

/**
 * Per-session agent-type state: the registry plus the two settings that shape
 * it (`disableDefaultAgents`, `fallbackSubagent`).
 *
 * One instance lives in the extension's activation closure — activation is
 * per-session, so sessions in one embedding host process (SDK: several
 * concurrent `createAgentSession`s in different directories) each resolve
 * against their own registry instead of a process-wide singleton, where
 * per-session reloads would be last-writer-wins. In the CLI (one session,
 * `process.cwd() === ctx.cwd`) behavior is unchanged.
 *
 * `registry()` returns a stable Map reference that `register()` mutates in
 * place, so a spawn queued with the reference observes mid-session reloads —
 * the same live semantics the process-wide registry had.
 */
export interface AgentTypeState {
  /** The live registry. Stable reference; contents replaced by `register()`. */
  registry(): Map<string, AgentConfig>;
  /** Rebuild the registry from user agents (defaults first unless disabled). */
  register(userAgents: Map<string, AgentConfig>): void;
  isDefaultsDisabled(): boolean;
  setDefaultsDisabled(b: boolean): void;
  getFallbackSubagent(): string | undefined;
  setFallbackSubagent(v: string | undefined): void;
  resolveType(name: string): string | undefined;
  getAgentConfig(name: string): AgentConfig | undefined;
  getAvailableTypes(): string[];
  getAllTypes(): string[];
  getDefaultAgentNames(): string[];
  getUserAgentNames(): string[];
  isValidType(type: string): boolean;
  getToolNamesForType(type: string): string[];
  getConfig(type: string): ReturnType<typeof getConfigIn>;
  resolveSpawnType(requested: unknown): SpawnTypeResolution;
}

/** Create an empty per-session agent-type state. */
export function createAgentTypeState(): AgentTypeState {
  const agents = new Map<string, AgentConfig>();
  let disableDefaults = false;
  let fallbackSubagent: string | undefined;

  return {
    registry: () => agents,
    register(userAgents) {
      agents.clear();
      for (const [name, config] of buildAgentRegistry(userAgents, disableDefaults)) {
        agents.set(name, config);
      }
    },
    isDefaultsDisabled: () => disableDefaults,
    setDefaultsDisabled(b) { disableDefaults = b; },
    getFallbackSubagent: () => fallbackSubagent,
    setFallbackSubagent(v) { fallbackSubagent = v; },
    resolveType: (name) => resolveTypeIn(agents, name),
    getAgentConfig: (name) => getAgentConfigIn(agents, name),
    getAvailableTypes: () => getAvailableTypesIn(agents),
    getAllTypes: () => getAllTypesIn(agents),
    getDefaultAgentNames: () => getDefaultAgentNamesIn(agents),
    getUserAgentNames: () => getUserAgentNamesIn(agents),
    isValidType: (type) => isValidTypeIn(agents, type),
    getToolNamesForType: (type) => getToolNamesForTypeIn(agents, type),
    getConfig: (type) => getConfigIn(agents, type),
    resolveSpawnType: (requested) => resolveSpawnTypeIn(agents, requested, fallbackSubagent),
  };
}
