/**
 * Reads enabledModels from pi's global settings (`~/.pi/agent/settings.json`)
 * and resolves entries to concrete `provider/modelId` keys for scope validation.
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

/** Read enabledModels from global pi settings. Undefined when file missing or field absent. */
export function readEnabledModels(): string[] | undefined {
  const path = join(getAgentDir(), "settings.json");
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
 * Resolve enabledModels patterns → Set<"provider/modelId"> (lowercase keys).
 *
 * Only exact `provider/modelId` patterns are matched (case-insensitive).
 * Patterns without a slash, with glob characters, or with a `:thinking`
 * suffix are silently dropped. See module-level docstring for rationale.
 *
 * Cache: keyed on settings.json mtime+size + JSON.stringify(patterns).
 * Re-resolves only when the file changes or the patterns argument differs.
 *
 * Returns undefined when no patterns are provided or no patterns match
 * (scope check becomes a no-op at the call site).
 */

// Module-level cache — invalidated when settings.json changes or patterns differ.
let cachedAllowed: Set<string> | undefined;
let cachedHash = "";
let cachedPatternsKey = "";

export function resolveEnabledModels(
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
): Set<string> | undefined {
  // Fast path: check cache
  const patternsKey = JSON.stringify(patterns);
  const settingsPath = join(getAgentDir(), "settings.json");
  let fileHash: string;
  try {
    const stat = statSync(settingsPath);
    fileHash = `${stat.mtimeMs}-${stat.size}`;
  } catch {
    fileHash = "missing";
  }

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


