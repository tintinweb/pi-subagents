/**
 * agent-diff.ts — Compare a user's replace-mode override against its bundled default.
 *
 * Read-only: no metadata, no state, no side effects.
 */

import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import type { AgentConfig } from "./types.js";

/** A single field-level difference between a local override and its bundled default. */
export interface DiffEntry {
  field: string;
  local: string;
  default: string;
}

/** Normalized snapshot of a config's behavior-relevant fields. */
interface NormalizedConfig {
  builtinToolNames: string;
  description: string;
  displayName: string;
  systemPrompt: string;
  model: string | undefined;
  thinking: string | undefined;
  maxTurns: number | undefined;
  extensions: string;
  skills: string;
  extSelectors: string | undefined;
  inheritContext: string | undefined;
  runInBackground: string | undefined;
  isolated: string | undefined;
  memory: string | undefined;
  isolation: string | undefined;
  recoverOnAbort: string | undefined;
  disallowedTools: string | undefined;
}

/**
 * Normalize a config's behavior-relevant fields so YAML formatting or
 * omitted-equals-default fields do not create false positives.
 *
 * All values are stringified for comparison and display; no raw objects.
 */
function normalize(cfg: AgentConfig): NormalizedConfig {
  const extSel = cfg.extSelectors;
  const fmtArr = (arr: string[] | undefined) => arr?.length ? [...arr].sort().join(", ") : undefined;
  const fmtBool = (v: boolean | undefined) => v === undefined ? undefined : String(v);
  return {
    builtinToolNames: [...(cfg.builtinToolNames ?? BUILTIN_TOOL_NAMES)].sort().join(", "),
    description: cfg.description,
    displayName: cfg.displayName ?? cfg.name,
    systemPrompt: cfg.systemPrompt,
    model: cfg.model ?? undefined,
    thinking: cfg.thinking ?? undefined,
    maxTurns: cfg.maxTurns ?? undefined,
    extensions: JSON.stringify(cfg.extensions ?? true),
    skills: JSON.stringify(cfg.skills ?? true),
    extSelectors: fmtArr(extSel),
    inheritContext: fmtBool(cfg.inheritContext),
    runInBackground: fmtBool(cfg.runInBackground),
    isolated: fmtBool(cfg.isolated),
    memory: cfg.memory ?? undefined,
    isolation: cfg.isolation ?? undefined,
    recoverOnAbort: fmtBool(cfg.recoverOnAbort),
    disallowedTools: fmtArr(cfg.disallowedTools),
  };
}

/** Human-readable label for a config field. */
const FIELD_LABELS: Record<keyof NormalizedConfig, string> = {
  builtinToolNames: "Tools",
  description: "Description",
  displayName: "Display name",
  systemPrompt: "System prompt",
  model: "Model",
  thinking: "Thinking",
  maxTurns: "Max turns",
  extensions: "Extensions",
  skills: "Skills",
  extSelectors: "Extension selectors",
  inheritContext: "Inherit context",
  runInBackground: "Run in background",
  isolated: "Isolated",
  memory: "Memory",
  isolation: "Isolation",
  recoverOnAbort: "Recover on abort",
  disallowedTools: "Disallowed tools",
};

/**
 * Format the systemPrompt diff: first differing line and character counts.
 * Never dumps the full prompt body.
 */
function fmtPromptDiff(local: string, def: string): string {
  const localLines = local.split("\n");
  const defLines = def.split("\n");
  const maxIdx = Math.min(localLines.length, defLines.length);
  let line = 1;
  for (; line <= maxIdx; line++) {
    if (localLines[line - 1] !== defLines[line - 1]) break;
  }
  if (line > maxIdx) line = Math.min(localLines.length, defLines.length) + 1;
  return `first difference at line ${line} (local: ${local.length} chars, default: ${def.length} chars)`;
}

/** Format a scalar field value for display — omit "undefined". */
function fmtVal(v: string | number | boolean | undefined): string {
  if (v === undefined) return "(not set)";
  return String(v);
}

/**
 * Return field-level differences between a replace-mode override and its
 * bundled default, or null when identical / not an applicable override.
 *
 * Same gates as differsFromDefault: excludes isDefault, append-mode,
 * disabled stubs, custom agents with no matching default.
 */
export function diffFromDefault(cfg: AgentConfig): DiffEntry[] | null {
  if (cfg.isDefault) return null;
  if (cfg.promptMode !== "replace") return null;
  if (cfg.enabled === false) return null;
  if (cfg.source !== "project" && cfg.source !== "global") return null;

  const def = DEFAULT_AGENTS.get(cfg.name);
  if (!def) return null;

  const a = normalize(cfg);
  const b = normalize(def);

  const entries: DiffEntry[] = [];

  const compare = (field: keyof NormalizedConfig) => {
    const av = a[field];
    const bv = b[field];
    if (av === bv) return;
    if (field === "systemPrompt") {
      entries.push({ field: FIELD_LABELS[field], local: fmtPromptDiff(av as string, bv as string), default: "" });
    } else {
      entries.push({ field: FIELD_LABELS[field], local: fmtVal(av), default: fmtVal(bv) });
    }
  };

  compare("description");
  compare("displayName");
  compare("model");
  compare("thinking");
  compare("maxTurns");
  compare("builtinToolNames");
  compare("extensions");
  compare("skills");
  compare("extSelectors");
  compare("inheritContext");
  compare("runInBackground");
  compare("isolated");
  compare("memory");
  compare("isolation");
  compare("recoverOnAbort");
  compare("disallowedTools");
  compare("systemPrompt"); // last — longest output

  return entries.length > 0 ? entries : null;
}

/**
 * Returns true when `cfg` is a replace-mode override of a bundled default
 * and its behavior-relevant fields differ from that default.
 *
 * Derived from diffFromDefault so the two cannot drift.
 */
export function differsFromDefault(cfg: AgentConfig): boolean {
  return diffFromDefault(cfg) !== null;
}
