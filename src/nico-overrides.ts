/**
 * nico-overrides.ts — Read and apply agent overrides from `npm:pi-subagents`-style
 * `settings.json` (`subagents.agentOverrides`).
 *
 * Priority (after `@tintinweb/pi-subagents` has resolved its own .md chain):
 *   1. Local  JSON  (.pi/settings.json)  ← highest
 *   2. Global JSON  (~/.pi/agent/settings.json)
 *
 * Each layer's `agentOverrides` directly overlays onto the matching AgentConfig
 * (model, thinking, systemPrompt, tools, enabled). `subagents.defaultModel` is
 * also respected when the agent has no model of its own.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

  // Local: .pi/settings.json (resolve project root upward)
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
// Applier
// ============================================================================

/**
 * Apply a Nico-style override to a tintinweb AgentConfig.
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
    // false means "clear thinking" → undefined
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
    // Nico-style `tools: ["read", "bash"]` maps to tintinweb's `builtinToolNames`
    next = {
      ...next,
      builtinToolNames: override.tools === false ? [] : [...override.tools],
    };
    modified = true;
  }

  return modified ? next : agent;
}

/**
 * Apply all Nico overrides to a map of agents (mutating in-place).
 */
export function applyNicoOverridesToMap(
  agents: Map<string, AgentConfig>,
  overrides: Record<string, NicoAgentOverride>,
  defaultModel?: string,
): void {
  for (const [name, override] of Object.entries(overrides)) {
    const existing = agents.get(name);
    if (!existing) continue; // agent not found → skip silently
    agents.set(name, applyNicoOverride(existing, override, defaultModel));
  }
}
