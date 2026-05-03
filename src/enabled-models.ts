/**
 * Reads enabledModels from ~/.pi/agent/settings.json and resolves
 * exact model strings to concrete model IDs for scope validation.
 *
 * Ref: pi-coding-agent resolves enabledModels at startup via:
 *   main.js:439  modelPatterns = parsed.models ?? settingsManager.getEnabledModels()
 *   main.js:440  scopedModels = resolveModelScope(modelPatterns, modelRegistry)
 *
 * pi writes exact "provider/modelId" entries to enabledModels
 *
 * Example: enabledModels = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"]
 *   → resolves to {"anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"}
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
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
 * Matching (mirrors pi-coding-agent resolveModelScope → tryMatchModel):
 *   1. Exact "provider/modelId"  (slash present, case-insensitive)
 *   2. Bare "modelId"            (no slash, exact id match)
 *
 *
 * Cache: keyed on settings.json mtime+size + patterns key. Re-reads only when
 * the file or patterns change.
 *
 * Example: "anthropic/claude-sonnet-4-6"
 *   → provider="anthropic", modelId="claude-sonnet-4-6"
 *
 * Returns undefined when no patterns or no matches (scope check becomes no-op).
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
    allowed.add(`${exact.provider}/${exact.id}`.toLowerCase());
  }
}


