/**
 * Reads `enabledModels` from pi's settings (global `<agentDir>/settings.json`
 * + project-local `<cwd>/.pi/settings.json`, project wins) and resolves
 * entries to concrete `provider/modelId` keys for scope validation.
 *
 * **Project overrides global**, mirroring pi's own `SettingsManager`
 * deep-merge behavior and matching the precedence we use for our own
 * `subagents.json` settings (see `src/settings.ts:loadSettings`). If
 * project file has `enabledModels` set, it wholly replaces global's
 * (array fields are replaced, not concatenated).
 *
 * **Limited subset of upstream's resolveModelScope.** We support exact
 * `provider/modelId` matching only. Upstream (pi-coding-agent's
 * `core/model-resolver.ts`) additionally supports glob patterns
 * (`*sonnet*`, `anthropic/*`), bare model IDs without provider, and
 * thinking-level suffixes (`provider/*:high`). Those forms are silently
 * ignored here.
 *
 * In practice, pi's `/scoped-models` picker writes exact `provider/modelId`
 * entries, so the limitation is invisible for users who configure scope
 * through pi's UI. Hand-edited settings using globs or bare IDs will
 * produce an empty allowed set (scope check becomes a no-op).
 *
 * Example:
 *   enabledModels = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]
 *   → resolves to { "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6" }
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelEntry } from "./model-resolver.js";

/** Minimal registry shape — only the methods resolveEnabledModels actually calls. */
export interface ModelRegistryRef {
  getAll(): unknown[];
  getAvailable?(): unknown[];
}

/** Paths to pi's settings.json files: [project, global] (project takes precedence). */
function settingsPaths(cwd: string): [project: string, global: string] {
  return [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ];
}

/** Read `enabledModels` from a single settings.json file. Undefined when missing or absent. */
function readField(path: string): string[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(raw?.enabledModels)) return raw.enabledModels as string[];
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

/**
 * Read enabledModels from pi's settings — project-local overrides global.
 * Mirrors pi's SettingsManager deep-merge for the `enabledModels` field
 * (and matches our own loadSettings precedence in src/settings.ts).
 * Returns undefined when neither file has the field.
 */
export function readEnabledModels(cwd: string): string[] | undefined {
  const [project, global] = settingsPaths(cwd);
  return readField(project) ?? readField(global);
}

/**
 * Resolve enabledModels patterns → Set<"provider/modelId"> (lowercase keys).
 *
 * Only exact `provider/modelId` patterns are matched (case-insensitive).
 * Patterns without a slash, with glob characters, or with a `:thinking`
 * suffix are silently dropped. See module-level docstring for rationale.
 *
 * Cache: keyed on JSON.stringify(patterns) + mtime/size of *both*
 * project and global settings.json files. Re-resolves when either file
 * changes or the patterns argument differs.
 *
 * Returns undefined when no patterns are provided or no patterns match
 * (scope check becomes a no-op at the call site).
 */

// Module-level cache — invalidated when either settings.json changes or patterns differ.
let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

/** mtime+size hash of one file, or "missing" if absent. */
function hashOf(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}-${s.size}`;
  } catch {
    return "missing";
  }
}

export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
  cwd: string,
): Set<string> | undefined {
  // Fast path: check cache (stat both project and global settings.json files)
  const patternsKey = JSON.stringify(patterns);
  const [project, global] = settingsPaths(cwd);
  const fileHash = `${hashOf(project)};${hashOf(global)}`;

  if (fileHash === cachedHash && patternsKey === cachedPatternsKey) {
    return cachedAllowed;
  }

  // Cache miss — resolve
  if (!patterns || patterns.length === 0) {
    cachedHash = fileHash;
    cachedPatternsKey = patternsKey;
    cachedAllowed = undefined;
    return undefined;
  }

  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const allowed = new Set<string>();

  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;  // skip empty/whitespace
    resolveExact(trimmed, available, allowed);
  }

  const result = allowed.size > 0 ? allowed : undefined;
  cachedHash = fileHash;
  cachedPatternsKey = patternsKey;
  cachedAllowed = result;
  return result;
}



/**
 * True when `model` is in the allowed set. Centralizes the key format
 * (`provider/id` lowercase) so callers don't have to reproduce it —
 * both set-building (resolveExact) and lookup go through `modelKey`.
 */
export function isModelInScope(
  model: { provider: string; id: string },
  allowed: Set<string>,
): boolean {
  return allowed.has(modelKey(model));
}

/** Canonical lowercase `provider/id` key for the allowed set. */
function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`.toLowerCase();
}

/**
 * Resolve exact model pattern. Example: "google/gemma-4-31b-it".
 */
function resolveExact(
  pattern: string,
  available: ModelEntry[],
  allowed: Set<string>,
): void {
  // "provider/modelId" — exact (colon is part of id, not split)
  const slashIdx = pattern.indexOf("/");
  if (slashIdx === -1) return; // bare modelId not supported

  const provider = pattern.slice(0, slashIdx).toLowerCase();
  const modelId = pattern.slice(slashIdx + 1).toLowerCase();
  const exact = available.find(
    m => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
  );
  if (exact) {
    allowed.add(modelKey(exact));
  }
}


