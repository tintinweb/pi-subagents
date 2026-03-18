/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

type ToolFactory = (cwd: string) => AgentTool<any>;

const TOOL_FACTORIES: Record<string, ToolFactory> = {
  read: (cwd) => createReadTool(cwd),
  bash: (cwd) => createBashTool(cwd),
  edit: (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  grep: (cwd) => createGrepTool(cwd),
  find: (cwd) => createFindTool(cwd),
  ls: (cwd) => createLsTool(cwd),
};

/** All known built-in tool names, derived from the factory registry. */
export const BUILTIN_TOOL_NAMES = Object.keys(TOOL_FACTORIES);

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();

  // Start with defaults
  for (const [name, config] of DEFAULT_AGENTS) {
    agents.set(name, config);
  }

  // Overlay user agents (overrides defaults with same name)
  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const key = resolveKey(type);
  if (!key) return false;
  return agents.get(key)?.enabled !== false;
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get the tools needed for memory management (read, write, edit).
 * Only returns tools that are NOT already in the provided set.
 */
export function getMemoryTools(cwd: string, existingToolNames: Set<string>): AgentTool<any>[] {
  return MEMORY_TOOL_NAMES
    .filter(n => !existingToolNames.has(n) && n in TOOL_FACTORIES)
    .map(n => TOOL_FACTORIES[n](cwd));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get only the read tool for read-only memory access.
 * Only returns tools that are NOT already in the provided set.
 */
export function getReadOnlyMemoryTools(cwd: string, existingToolNames: Set<string>): AgentTool<any>[] {
  return READONLY_MEMORY_TOOL_NAMES
    .filter(n => !existingToolNames.has(n) && n in TOOL_FACTORIES)
    .map(n => TOOL_FACTORIES[n](cwd));
}

/** Get built-in tools for a type (case-insensitive). */
export function getToolsForType(type: string, cwd: string): AgentTool<any>[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  const toolNames = config?.builtinToolNames?.length ? config.builtinToolNames : BUILTIN_TOOL_NAMES;
  return toolNames.filter((n) => n in TOOL_FACTORIES).map((n) => TOOL_FACTORIES[n](cwd));
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to general-purpose. */
export function getConfig(type: string): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  // Fallback for unknown/disabled types — general-purpose config
  const gp = agents.get("general-purpose");
  if (gp && gp.enabled !== false) {
    return {
      displayName: gp.displayName ?? gp.name,
      description: gp.description,
      builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: gp.extensions,
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

