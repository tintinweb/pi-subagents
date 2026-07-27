/**
 * nico-overrides.ts — Read and apply agent overrides from `npm:pi-subagents`-style
 * `settings.json` (`subagents.agentOverrides`).
 *
 * Priority (after `@tintinweb/pi-subagents` has resolved its own .md chain):
 *   1. Local  JSON  (.pi/settings.json)  ← highest
 *   2. Global JSON  (~/.pi/agent/settings.json)
 *
 * Overrides are applied to matching agents in the registry. If an agent name
 * from the overrides does not exist in the registry, it is auto-registered
 * using the override fields as the full definition (no .md file needed).
 *
 * Skill mapping (Nico string[] → tintinweb true | string[] | false):
 *   ["*"]     → true   (all skills)
 *   ["foo"]   → ["foo"] (only listed)
 *   [] | false → false  (none)
 *   omitted   → true   (all, fallback)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type { AgentConfig } from "./types.js";

// ============================================================================
// Types matching npm:pi-subagents's settings.json schema
// ============================================================================

export interface NicoAgentOverride {
  model?: string | false;
  thinking?: string | false;
  fallbackModels?: string[];
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork" | false;
  disabled?: boolean;
  skills?: string[] | false;
  tools?: string[] | false;
  completionGuard?: boolean;
  toolBudget?: Record<string, unknown>;
}

interface NicoSubagentsSettings {
  defaultModel?: string;
  disableBuiltins?: boolean;
  disableThinking?: boolean;
  agentOverrides?: Record<string, NicoAgentOverride>;
}

interface NicoSettingsFile {
  subagents?: NicoSubagentsSettings;
}

// ============================================================================
// Reader
// ============================================================================

/**
 * Read subagents.agentOverrides and subagents.defaultModel from both local
 * and global Nico-style settings.json. Local overrides global on key collision.
 */
export function readNicoAgentOverrides(cwd: string): {
  overrides: Record<string, NicoAgentOverride>;
  defaultModel: string | undefined;
} {
  const merged: Record<string, NicoAgentOverride> = {};
  let defaultModel: string | undefined;

  // Global: ~/.pi/agent/settings.json
  const globalPath = join(getAgentDir(), "settings.json");
  const globalSettings = readNicoSettingsFile(globalPath);
  if (globalSettings) {
    mergeOverrides(merged, globalSettings.agentOverrides);
    if (defaultModel === undefined) defaultModel = globalSettings.defaultModel;
  }

  // Local: .pi/settings.json
  const localPath = join(cwd, ".pi", "settings.json");
  if (existsSync(localPath)) {
    const localSettings = readNicoSettingsFile(localPath);
    if (localSettings) {
      mergeOverrides(merged, localSettings.agentOverrides);
      if (localSettings.defaultModel !== undefined) defaultModel = localSettings.defaultModel;
    }
  }

  return { overrides: merged, defaultModel };
}

function readNicoSettingsFile(filePath: string): NicoSubagentsSettings | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as NicoSettingsFile;
    const sub = raw?.subagents;
    if (!sub || typeof sub !== "object") return undefined;
    return sub;
  } catch {
    // Silently skip — bad Nico config must not break tintinweb
    return undefined;
  }
}

function mergeOverrides(
  target: Record<string, NicoAgentOverride>,
  source: Record<string, NicoAgentOverride> | undefined,
): void {
  if (!source) return;
  for (const [name, override] of Object.entries(source)) {
    target[name] = { ...target[name], ...override };
  }
}

// ============================================================================
// Skill converter: Nico string[] → tintinweb true | string[] | false
// ============================================================================

export function resolveNicoSkills(
  skills: string[] | false | undefined,
): true | string[] | false {
  // Not set → inherit all (tintinweb default)
  if (skills === undefined) return true;

  // Explicit false / empty array → none
  if (skills === false || skills.length === 0) return false;

  // ["*"] → all skills
  if (skills.length === 1 && skills[0] === "*") return true;

  // Specific list
  return [...skills];
}

// ============================================================================
// Applier — override existing agent
// ============================================================================

/**
 * Apply a Nico-style override to an existing tintinweb AgentConfig.
 * JSON values directly overwrite the config (highest priority).
 */
export function applyNicoOverride(
  agent: AgentConfig,
  override: NicoAgentOverride,
  nicoDefaultModel?: string,
): AgentConfig {
  let modified = false;
  let next: AgentConfig = agent;

  // model: explicit override wins; else use defaultModel when agent has none
  if (override.model !== undefined) {
    next = { ...next, model: override.model === false ? undefined : override.model };
    modified = true;
  } else if (nicoDefaultModel !== undefined && next.model === undefined) {
    next = { ...next, model: nicoDefaultModel };
    modified = true;
  }

  if (override.thinking !== undefined) {
    next = { ...next, thinking: override.thinking === false ? undefined : override.thinking as AgentConfig["thinking"] };
    modified = true;
  }

  if (override.systemPrompt !== undefined) {
    next = { ...next, systemPrompt: override.systemPrompt };
    modified = true;
  }

  if (override.disabled !== undefined) {
    next = { ...next, enabled: !override.disabled };
    modified = true;
  }

  if (override.tools !== undefined) {
    next = { ...next, builtinToolNames: override.tools === false ? [] : [...override.tools] };
    modified = true;
  }

  return modified ? next : agent;
}

// ============================================================================
// Auto-register — create AgentConfig from override when agent doesn't exist
// ============================================================================

function createAgentFromOverride(
  name: string,
  override: NicoAgentOverride,
  defaultModel?: string,
): AgentConfig {
  return {
    name,
    displayName: name,
    description: `Auto-registered from npm:pi-subagents JSON settings`,
    builtinToolNames: override.tools !== undefined
      ? (override.tools === false ? [] : [...override.tools])
      : [...BUILTIN_TOOL_NAMES],
    extensions: true,
    skills: resolveNicoSkills(override.skills),
    model: override.model !== undefined ? (override.model === false ? undefined : override.model) : defaultModel,
    thinking: override.thinking !== undefined
      ? (override.thinking === false ? undefined : override.thinking as AgentConfig["thinking"])
      : undefined,
    systemPrompt: override.systemPrompt ?? "",
    promptMode: override.systemPromptMode === "append" ? "append" : "replace",
    enabled: !(override.disabled ?? false),
    source: "global",
    isDefault: false,
  };
}

// ============================================================================
// Bulk apply
// ============================================================================

/**
 * Apply all Nico overrides to a map of agents (mutating in-place).
 * Agents that don't exist yet are auto-registered from the override.
 */
export function applyNicoOverridesToMap(
  agents: Map<string, AgentConfig>,
  overrides: Record<string, NicoAgentOverride>,
  defaultModel?: string,
): void {
  for (const [name, override] of Object.entries(overrides)) {
    const existing = agents.get(name);
    if (existing) {
      agents.set(name, applyNicoOverride(existing, override, defaultModel));
    } else {
      agents.set(name, createAgentFromOverride(name, override, defaultModel));
    }
  }
}
