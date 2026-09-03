/**
 * agent-file-toggle.ts — Pure helpers for the `/agents` file-editing operations:
 * locating an agent's .md file, toggling its `enabled:` frontmatter flag, and
 * serializing an AgentConfig back to frontmatter for eject.
 *
 * These live outside src/index.ts so they can be tested directly: the `/agents`
 * command handler is an ~890-line closure reached only through `registerCommand`,
 * which every test mocks.
 *
 * The read side of this data (src/custom-agents.ts) parses frontmatter with a
 * real YAML parser, so it honors `enabled: false` at any position in the block.
 * This module must agree with it, and splits the work accordingly:
 *
 * - Deciding whether a file is disabled is a *read*, so it calls that same parser
 *   (`isDisabledContent`) instead of mirroring it. A mirror has to be right about
 *   YAML's boolean spellings and about pi's fence scan, and a regex was wrong
 *   about both.
 * - *Editing* cannot go through the parser, because re-serializing a parsed
 *   document would reformat a file the README tells users to hand-author —
 *   discarding their comments, key order, and quoting. So the edits are line-wise
 *   and preserve everything they don't touch.
 *
 * That leaves removal best-effort: it recognizes a lowercase bare `false`, and
 * reports `changed: false` for the spellings it cannot rewrite, so the caller
 * refuses honestly rather than announcing a change it did not make.
 */

import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseAgentFrontmatter } from "./custom-agents.js";
import type { AgentConfig } from "./types.js";

export type AgentFileLocation = "project" | "workspace" | "personal";

export const projectAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".pi", "agents");
export const workspaceAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".agents", "agents");
export const personalAgentsDir = () => join(getAgentDir(), "agents");

/**
 * Find the file path of a custom agent by name, in discovery-precedence order
 * (project, workspace, then global). Mirrors the load-side precedence in
 * src/custom-agents.ts — if the two drift, `/agents` edits a file the loader
 * isn't reading.
 */
export function findAgentFile(
  name: string,
  cwd: string = process.cwd(),
): { path: string; location: AgentFileLocation } | undefined {
  const projectPath = join(projectAgentsDir(cwd), `${name}.md`);
  if (existsSync(projectPath)) return { path: projectPath, location: "project" };
  const workspacePath = join(workspaceAgentsDir(cwd), `${name}.md`);
  if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
  return undefined;
}

/**
 * Find the *editable* file behind a loaded agent, preferring the path the loader
 * actually read (`AgentConfig.sourcePath`) over the `<type>.md` guess.
 *
 * An agent's type comes from its frontmatter `name:` now, so the two can
 * disagree: `reviewer.md` declaring `name: code-reviewer` is loaded as
 * `code-reviewer`, and probing for `code-reviewer.md` finds nothing. That is
 * not a harmless miss — `/agents → Disable` would then take the no-file branch
 * and write a NEW `code-reviewer.md` stub, which loses to `reviewer.md` on
 * load, leaving the agent enabled while reporting success.
 *
 * The probe stays as the fallback: a built-in that was never ejected has no
 * `sourcePath`, and a path can go stale between a load and this call.
 *
 * **A package agent has no editable file.** Its `sourcePath` points inside pi's
 * install root, where an edit is lost on the next `pi update` and a delete is
 * undone by the next `pi install`. Passing `source` lets that rule live here
 * rather than at each `/agents` call site: the package path is ignored, and the
 * name probe runs instead — which finds the local stub shadowing it, if one
 * exists, and otherwise nothing. Callers then take their no-file branch, which
 * is the Eject-or-shadow behaviour a not-yet-ejected builtin already gets.
 */
export function locateAgentFile(
  name: string,
  sourcePath: string | undefined,
  cwd: string = process.cwd(),
  source?: AgentConfig["source"],
): { path: string; location: AgentFileLocation } | undefined {
  if (source !== "package" && sourcePath && existsSync(sourcePath)) {
    return { path: sourcePath, location: classifyAgentDir(sourcePath, cwd) };
  }
  return findAgentFile(name, cwd);
}

/**
 * Which discovery location a loaded agent's file came from. Only ever names
 * a directory in a confirmation prompt, so an unrecognized parent reports as
 * personal rather than widening the type for a case that has no better answer.
 *
 * Package-provided paths never reach here: `locateAgentFile` drops them above,
 * because none of the three locations this classifies is where they live.
 */
function classifyAgentDir(path: string, cwd: string): AgentFileLocation {
  if (path.startsWith(projectAgentsDir(cwd) + sep)) return "project";
  if (path.startsWith(workspaceAgentsDir(cwd) + sep)) return "workspace";
  return "personal";
}

export type DisableOutcome = "disabled" | "already-disabled" | "no-frontmatter";

/** A line that sets `enabled: false`, ignoring trailing whitespace / CR. */
const ENABLED_FALSE = /^enabled:[ \t]*false[ \t]*$/;
/** An opening or closing `---` fence line. */
const FENCE = /^---[ \t]*$/;

/**
 * Split a file into its frontmatter lines and everything else, agreeing with
 * what `parseAgentFrontmatter` (the load side) considers a frontmatter block —
 * including its BOM normalisation, which is why the fence test looks past one.
 * The BOM itself stays in `lines[0]`: it belongs to the file's encoding, not to
 * the block, and an edit must not strip it from the user's file.
 *
 * Lines keep their terminators, so an edit preserves the file's existing line
 * endings instead of rewriting CRLF to LF. Returns undefined when there is no
 * usable block.
 */
function splitFrontmatter(content: string):
  | { lines: string[]; openIdx: number; closeIdx: number; eol: string }
  | undefined {
  const lines = content.split(/(?<=\n)/);
  if (lines.length === 0) return undefined;
  // The BOM stays where it is — it belongs to the file, not the block — so the
  // fence test looks past it and every index below is unaffected.
  const bom = content.startsWith("\uFEFF");
  const first = (bom ? lines[0].slice(1) : lines[0]).replace(/\r?\n$/, "");
  if (!FENCE.test(first)) return undefined;
  const closeIdx = lines.findIndex((l, i) => i > 0 && FENCE.test(l.replace(/\r?\n$/, "")));
  if (closeIdx === -1) return undefined;
  return { lines, openIdx: 0, closeIdx, eol: lines[0].endsWith("\r\n") ? "\r\n" : "\n" };
}

/**
 * Does the loader consider this file disabled?
 *
 * Detection is a READ operation, so it asks the same parser the loader uses
 * rather than mirroring it with a regex — that mirror has to be right about
 * YAML's boolean spellings (`False`, `FALSE`, a trailing `# comment`, a quoted
 * key) *and* about pi's fence scan, which closes the block on any line starting
 * `---` and so ends it early on `----`. A throw means the file is already
 * unparseable, which is what the loader sees too: it skips the agent, so there
 * is no "disabled" state to report.
 */
export function isDisabledContent(content: string): boolean {
  try {
    return parseAgentFrontmatter<Record<string, unknown>>(content).frontmatter.enabled === false;
  } catch {
    return false;
  }
}

/**
 * Add `enabled: false` to a file's frontmatter.
 *
 * `outcome` distinguishes a real edit from a no-op so the caller can report
 * honestly instead of unconditionally claiming success.
 */
export function disableInContent(content: string): { content: string; outcome: DisableOutcome } {
  const block = splitFrontmatter(content);
  if (!block) return { content, outcome: "no-frontmatter" };
  if (isDisabledContent(content)) return { content, outcome: "already-disabled" };
  const lines = [...block.lines];
  lines.splice(1, 0, `enabled: false${block.eol}`);
  return { content: lines.join(""), outcome: "disabled" };
}

/**
 * Remove `enabled: false` from a file's frontmatter, wherever it appears in the
 * block — the loader honors the key at any position, so the two must agree or a
 * hand-authored agent can be disabled and never re-enabled.
 *
 * `changed` is false when the key wasn't found, so the caller can avoid
 * reporting "Enabled <name>" for a write that did nothing.
 */
export function enableInContent(content: string): { content: string; changed: boolean } {
  const block = splitFrontmatter(content);
  if (!block) return { content, changed: false };
  const kept = block.lines.filter(
    (l, i) => !(i > 0 && i < block.closeIdx && ENABLED_FALSE.test(l.replace(/\r?\n$/, ""))),
  );
  if (kept.length === block.lines.length) return { content, changed: false };
  return { content: kept.join(""), changed: true };
}

/** Is this the empty stub `/agents` writes when disabling a built-in default? */
export function isEmptyStub(content: string): boolean {
  return content.replace(/\r\n/g, "\n").trim() === "---\n---";
}

/** The answers `/agents → Create agent → Manual` collects, before serialization. */
export interface NewAgentInput {
  description: string;
  /** Already-resolved `tools:` value ("none", "all", or a CSV of tool names). */
  tools: string;
  /** `provider/modelId`, or undefined to inherit the parent's model. */
  model?: string;
  /** A pi thinking level, or undefined to inherit. */
  thinking?: string;
  systemPrompt: string;
}

/**
 * Build the .md file the create wizard writes.
 *
 * `description` and `model` come straight from a free-text prompt, so they are
 * quoted rather than interpolated — `serializeAgentFile` above quotes the
 * description for the same reason. An unquoted YAML scalar mishandles ordinary
 * input in two ways, and both are silent: a colon ("Scout: find things") makes
 * the file unparseable, and since #212 an unparseable agent file is *skipped*,
 * so the wizard reports success for an agent that does not exist; a `#`
 * ("audit #security") opens a comment and truncates the value. `model` can
 * carry a colon too — pi accepts a `provider/model:thinking` suffix.
 *
 * `tools` and `thinking` are not quoted: both are chosen from fixed menus, and
 * `tools` is a CSV that must stay a bare scalar for the loader's parser.
 */
export function buildNewAgentFile(input: NewAgentInput): string {
  const modelLine = input.model ? `\nmodel: ${JSON.stringify(input.model)}` : "";
  const thinkingLine = input.thinking ? `\nthinking: ${input.thinking}` : "";
  return `---
description: ${JSON.stringify(input.description)}
tools: ${input.tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${input.systemPrompt}
`;
}

/** Render a built-in tool list as a `tools:` frontmatter value. */
/**
 * Rebuild the `tools:` CSV from the two halves the loader split it into.
 *
 * `extSelectors` has to come back with the built-ins: `parseToolsField` splits
 * `tools: read, ext:mcp/github` into `["read"]` and `["ext:mcp/github"]`, so
 * writing only the first half hands the ejected copy a *narrower* toolset than
 * the file it came from. That was invisible while Eject only ever ran on
 * built-in defaults, which carry no selectors; a package agent can.
 *
 * Zero built-ins with selectors present is not `none` — `none` means no tools at
 * all, while `ext:` entries alone mean "extension tools only", which the loader
 * reads back from a `tools:` line carrying just those entries.
 */
function formatToolsField(tools: string[] | undefined, extSelectors?: string[]): string {
  const selectors = extSelectors ?? [];
  if (tools === undefined) return selectors.length > 0 ? ["*", ...selectors].join(", ") : "all";
  if (tools.length === 0) return selectors.length > 0 ? selectors.join(", ") : "none";
  return [...tools, ...selectors].join(", ");
}

/** Serialize an AgentConfig to a full .md file (frontmatter + system prompt) for eject. */
export function serializeAgentFile(cfg: AgentConfig): string {
  const fmFields: string[] = [];
  fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
  if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
  if (cfg.color) fmFields.push(`color: ${JSON.stringify(cfg.color)}`);
  // Absent means "all built-ins"; an EMPTY list means explicitly zero. Writing
  // `all` for both would hand a deliberately tool-less agent the whole toolbox
  // the first time it is ejected.
  fmFields.push(`tools: ${formatToolsField(cfg.builtinToolNames, cfg.extSelectors)}`);
  if (cfg.model) fmFields.push(`model: ${cfg.model}`);
  if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
  if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
  if (cfg.allowedSubagents !== undefined) {
    fmFields.push(`allowed_subagents: ${cfg.allowedSubagents === "all" ? "all" : cfg.allowedSubagents.join(", ")}`);
  }
  fmFields.push(`prompt_mode: ${cfg.promptMode}`);
  if (cfg.extensions === false) fmFields.push("extensions: false");
  else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
  if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
  if (cfg.skills === false) fmFields.push("skills: false");
  else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
  if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
  if (cfg.inheritContext) fmFields.push("inherit_context: true");
  // Both cases, not just `true`: with `backgroundByDefault` on, omitting the
  // field means background, so `false` is the only way to pin an agent file to
  // foreground and is no longer interchangeable with absence. Reachable since
  // package agents became ejectable — a built-in default omits the field.
  if (cfg.runInBackground !== undefined) fmFields.push(`run_in_background: ${cfg.runInBackground}`);
  if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
  if (cfg.isolated) fmFields.push("isolated: true");
  if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
  if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);
  // Also only reachable through a package agent: no built-in default sets
  // either. Omitting them would have the ejected copy silently stop persisting
  // its session, or write it somewhere else.
  if (cfg.persistSession !== undefined) fmFields.push(`persist_session: ${cfg.persistSession}`);
  if (cfg.sessionDir) fmFields.push(`session_dir: ${JSON.stringify(cfg.sessionDir)}`);

  return `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;
}
