/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/, plus the shared .agents/agents/ workspace) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations, plus any installed pi package that declares them (see package-resources.ts).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import {
  isPackageResourceExcluded,
  MAX_PACKAGE_RESOURCE_BYTES,
  packageAgentDirs,
  packageAgentFiles,
} from "./package-resources.js";
import type { AgentConfig, IsolationMode, MemoryScope, ThinkingLevel } from "./types.js";

/**
 * The one thing a declared `name:` may not contain, matching Claude Code
 * exactly: it reserves `:` for plugin-scoped identifiers (`my-plugin:reviewer`)
 * and refuses to load a file whose name uses one.
 *
 * Nothing else is rejected. Claude Code's docs describe names as "lowercase
 * letters and hyphens", but that is guidance — the only stated load failure is
 * the colon, so `name: Code Reviewer` must work here too. (The stricter
 * letters/digits/underscore/hyphen regex in Claude Code applies to the Agent
 * tool's spawn-time `name` parameter, which is a different field.) Mixed case
 * has to be allowed regardless: the built-in types `Explore` and `Plan` use it,
 * and a file must be able to override one.
 */
const RESERVED_IN_TYPE = ":";

/** Where an agent file was found. Widens `AgentConfig.source` for the loader. */
type AgentSource = "project" | "global" | "package";

/** Answers whether a `!` entry in some package manifest excludes this path. */
type Excluder = (path: string) => boolean;

/**
 * Overrides for the package tier. The gate and project-trust state normally come
 * from the session values in package-resources.ts, so these exist for tests and
 * for a caller that has to pin a scan it already performed.
 */
export interface LoadCustomAgentsOptions {
  /** Explicit package directories, bypassing discovery. */
  packageDirs?: string[];
  /** Explicit package files, bypassing discovery. */
  packageFiles?: string[];
  /** Explicit `!` exclusion predicate, bypassing discovery. */
  packageExcluded?: Excluder;
}

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project:   <cwd>/.pi/agents/*.md (authoritative — also where /agents writes)
 *   2. Workspace: <cwd>/.agents/agents/*.md (shared cross-tool .agents workspace, read-only)
 *   3. Global:    $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *   4. Package:   paths declared by an installed pi package (read-only)
 *
 * Project-level agents override global ones with the same name. On a name clash
 * between the two project locations, .pi/agents wins — .pi stays the project
 * authority; .agents/agents is an additional read location.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 *
 * Package agents load *first*, so everything the user or project wrote outranks
 * them. That is what makes them safe to adopt: a package can offer a `reviewer`,
 * and a `.pi/agents/reviewer.md` silently takes it back. It mirrors pi's own
 * resource precedence, where package-provided skills rank below every user and
 * project one, and Claude Code's, where a plugin agent is the lowest tier.
 *
 * An agent's type comes from its frontmatter `name:`, falling back to the
 * filename — Claude Code's rule, where "the filename doesn't have to match".
 * Because the type is now declared rather than derived from a unique path, two
 * files can claim the same one; the later load wins, as it always has for a
 * filename clash, and `warnSkippedOverride` reports the substitution.
 */
export function loadCustomAgents(
  cwd: string,
  strict = false,
  opts: LoadCustomAgentsOptions = {},
): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const workspaceProjectDir = join(cwd, ".agents", "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const pkgDirs = opts.packageDirs ?? packageAgentDirs(cwd);
  const pkgFiles = opts.packageFiles ?? packageAgentFiles(cwd);
  // `!./agents/wip.md` alongside `./agents` excludes one file out of a directory
  // that is only enumerated here, so the check has to run per file.
  const excluded: Excluder = opts.packageExcluded ?? (path => isPackageResourceExcluded(path, cwd, "agents"));

  const agents = new Map<string, AgentConfig>();
  for (const dir of pkgDirs) loadFromDir(dir, agents, "package", strict, excluded); // lowest priority
  for (const file of pkgFiles) loadOneFile(file, agents, "package", strict);
  loadFromDir(globalDir, agents, "global", strict);
  loadFromDir(workspaceProjectDir, agents, "project", strict); // shared workspace
  loadFromDir(projectDir, agents, "project", strict);          // highest priority (overwrites)

  warnedLastLoad = warnedThisLoad;
  warnedThisLoad = new Set();
  return agents;
}

/** Load agent configs from a directory into the map, skipping any `excluded` path. */
function loadFromDir(
  dir: string,
  agents: Map<string, AgentConfig>,
  source: AgentSource,
  strict: boolean,
  excluded?: Excluder,
): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".md"));
  } catch {
    return;
  }

  for (const file of files) {
    const path = join(dir, file);
    if (excluded?.(path)) continue;
    loadOneFile(path, agents, source, strict);
  }
}

/**
 * Load one agent file into the map.
 *
 * Split out of `loadFromDir` because a package manifest may name an individual
 * `.md` rather than a directory, and because the size guard below has to apply
 * to both paths.
 */
function loadOneFile(path: string, agents: Map<string, AgentConfig>, source: AgentSource, strict: boolean): void {
  const filenameType = basename(path, ".md");

  // Package files are third-party content read on every `Agent` call, so a
  // pathological one is skipped rather than pulled into the session. Claude
  // Code applies the same 1 MB ceiling to plugin-provided agents. Local files
  // are the user's own and stay unbounded, as they always have been.
  if (source === "package" && !withinSizeLimit(path)) {
    warnIfNew(`Skipping package agent ${path}: not a regular file, or larger than ${MAX_PACKAGE_RESOURCE_BYTES} bytes.`);
    return;
  }

  // `strict` is deliberately not passed for a package file. Failing activation
  // over a broken agent file is right for a checked-in `.pi/agents/` — the point
  // is that a repo's own file cannot silently fall through to a same-named one
  // elsewhere. A file inside a third-party package is not the user's to fix, and
  // one bad `.md` in any installed package would otherwise stop pi from
  // starting at all. Warn and skip, as for a non-strict local file.
  const parsed = readAgentFile(path, strict && source !== "package");
  if (!parsed) {
    warnSkippedOverride(filenameType, agents);
    return;
  }
  const { frontmatter: fm, body } = parsed;

  // Claude Code's rule: `name:` IS the agent type, and the filename need not
  // match. Absent, the filename stands in — Claude Code requires the field,
  // but most files here predate it and must keep loading.
  const declared = str(fm.name)?.trim();
  if (declared?.includes(RESERVED_IN_TYPE)) {
    // Refusing beats silently substituting: the file would otherwise load
    // under its filename, so `Agent({subagent_type})` would succeed against
    // an agent whose declared identity nothing honoured.
    warnIfNew(
      `Agent file ${path} declares name "${declared}", which contains "${RESERVED_IN_TYPE}" — reserved for `
      + "plugin-scoped identifiers. Rename it, or move the label to `display_name:`. Skipping.",
    );
    // No `warnSkippedOverride`: this file would have registered under its
    // *declared* name, which nothing else can hold (a colon keeps it out of
    // the registry), so it shadowed nothing. Passing the filename instead
    // would report a substitution of an unrelated agent that never happened.
    return;
  }
  // `||`, not `??`: a quoted empty or all-whitespace `name:` would otherwise
  // register the agent under the empty type — unspawnable, and it takes the
  // filename-derived one down with it.
  const name = declared || filenameType;

  const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

  agents.set(name, {
    name,
    // Only `display_name` now: `name` is the type, and `getConfig` already
    // falls back to the type when no label is set — so a Claude Code file
    // with `name: code-reviewer` still badges as "code-reviewer".
    displayName: str(fm.display_name),
    color: str(fm.color),
    description: str(fm.description) ?? name,
    builtinToolNames,
    extSelectors,
    disallowedTools: csvListOptional(fm.disallowed_tools),
    extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
    excludeExtensions: csvListOptional(fm.exclude_extensions),
    skills: inheritField(fm.skills ?? fm.inherit_skills),
    model: str(fm.model),
    thinking: str(fm.thinking) as ThinkingLevel | undefined,
    maxTurns: nonNegativeInt(fm.max_turns),
    persistSession: fm.persist_session != null ? fm.persist_session === true : undefined,
    outputTranscript: fm.output_transcript != null ? fm.output_transcript !== false : undefined,
    sessionDir: str(fm.session_dir),
    allowedSubagents: parseAllowedSubagents(fm.allowed_subagents),
    systemPrompt: body.trim(),
    promptMode: fm.prompt_mode === "append" ? "append" : "replace",
    inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
    runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
    isolated: fm.isolated != null ? fm.isolated === true : undefined,
    memory: parseMemory(fm.memory),
    isolation: parseIsolation(fm.isolation),
    enabled: fm.enabled !== false,  // default true; explicitly false disables
    source,
    sourcePath: path,
  });
}

/**
 * True when `path` is a regular file within the package-resource size ceiling.
 *
 * Only applied to package-provided files: they arrive from a third party and are
 * re-read on every `Agent` call, so a 500 MB `.md` — or a fifo that never ends —
 * must not be reachable from a spawn. A stat failure counts as "not within",
 * because the alternative is reading something we could not describe.
 */
function withinSizeLimit(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size <= MAX_PACKAGE_RESOURCE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Read and parse one agent file, or warn and return undefined for the caller to
 * skip. One bad file must not take the whole extension down with it — an
 * unparseable `.md` used to abort activation, so pi exited before the TUI.
 *
 * The path is as much of the fix as the recovery: a bare YAML error ("line 2,
 * column 14") is unactionable when agents come from three directories at once,
 * and the only other symptom is `Unknown agent type`, which reads like a typo.
 *
 * Under `strict` the same failure rethrows, still naming the path, so callers
 * that opted into failing closed stop rather than run a substituted agent.
 */
/**
 * Parse an agent file's frontmatter, tolerating a leading UTF-8 BOM.
 *
 * Editors across the Windows/CJK world write UTF-8 with a BOM by default, and
 * pi's parser did not look past one before 0.84.3: the fence never matched, so
 * the frontmatter came back empty and the *whole file* — YAML and all — became
 * the body. An agent authored that way silently lost every field. `tools: none`
 * going missing is the sharp edge: the agent registers with the default
 * toolset rather than none, which is a wider grant than its author wrote.
 *
 * Stripped here rather than detected per pi version, because this is the only
 * place agent files are read and the BOM is a file-encoding artifact, not
 * content — normalising it at the boundary keeps one behaviour across the whole
 * supported peer range instead of forking on what happens to be installed.
 */
export function parseAgentFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
  return parseFrontmatter<T>(content.startsWith("\uFEFF") ? content.slice(1) : content);
}

function readAgentFile(path: string, strict: boolean): { frontmatter: Record<string, unknown>; body: string } | undefined {
  try {
    return parseAgentFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (strict) throw new Error(`${path}: ${reason}`);
    warnIfNew(`Skipping agent file ${path}: ${reason}`);
    return undefined;
  }
}

/**
 * A skipped file that was overriding an already-loaded agent leaves the name
 * pointing at a *different* file — its own prompt, model and tools. Nothing
 * downstream can flag that: unlike an unknown type, the `Agent` call succeeds.
 */
function warnSkippedOverride(name: string, agents: Map<string, AgentConfig>): void {
  const surviving = agents.get(name);
  // Nothing shadowed, or what it shadowed is disabled: dispatch refuses the type
  // either way (see resolveEnabledTypeIn), so there is no substitution to report.
  if (!surviving?.sourcePath || surviving.enabled === false) return;
  warnIfNew(`Agent "${name}" now loads from ${surviving.sourcePath} instead`);
}

let warnedLastLoad = new Set<string>();
let warnedThisLoad = new Set<string>();

/**
 * Agents reload on activation and again on every `Agent` call, so an unchanged
 * problem would re-warn all session — over a painted TUI, since pi does not
 * redirect console output. Compare against the previous load rather than every
 * load ever, so a file that is fixed and then broken again still reports.
 */
function warnIfNew(message: string): void {
  warnedThisLoad.add(message);
  if (warnedLastLoad.has(message)) return;
  console.warn(`[pi-subagents] ${message}`);
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === "none") return undefined;
  const items = s.split(",").map(t => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * Parse the nested-delegation allowlist. Single field, default-off:
 * omitted/empty/"none"/`false` → undefined (no nested tools); "all"/"*"/`true`
 * → "all" (any enabled agent); csv → only the listed types.
 *
 * Booleans are accepted because `extensions:`/`skills:` take them and users
 * generalize: without this, YAML's `true` stringifies into an agent type
 * literally named "true", so the tools appear and every spawn is refused.
 */
function parseAllowedSubagents(val: unknown): "all" | string[] | undefined {
  if (typeof val === "boolean") return val ? "all" : undefined;
  const items = parseCsvField(val);
  if (!items) return undefined;
  return items.some(i => i === "*" || i.toLowerCase() === "all") ? "all" : items;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseCsvField(val) ?? [];
}

/**
 * Partition the `tools:` CSV into the built-in tool allowlist and raw `ext:` selectors.
 * `*` (and the case-insensitive alias `all`, for `tools: all`) expands to all
 * built-ins; plain entries are built-in names; `ext:` entries are extension-tool
 * selectors parsed later by the runner. omitted → all built-ins, no selectors.
 * `tools:` present with only `ext:` entries → zero built-ins (use `*`).
 */
function parseToolsField(val: unknown): { builtinToolNames: string[]; extSelectors: string[] | undefined } {
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter(e => !isWildcard(e) && !e.startsWith("ext:"));
  const extEntries = entries.filter(e => e.startsWith("ext:"));
  return {
    builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

/**
 * Parse a memory scope field.
 * omitted → undefined; "user"/"project"/"local" → MemoryScope.
 */
function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === "user" || val === "project" || val === "local") return val;
  return undefined;
}

/**
 * Parse the `isolation` frontmatter field.
 *
 * `off` is kept as a value rather than folded into `undefined` because the two
 * do not mean the same thing here: agent config outranks tool-call params, so
 * `off` vetoes a caller's `worktree` while an absent field lets it through.
 *
 * pi's frontmatter parser is not YAML 1.1 — bare `off` and `no` arrive as
 * strings and only `false` becomes a boolean — so all three spellings are
 * accepted rather than leaving an author's intent silently dropped. Anything
 * else stays `undefined`, as before.
 */
function parseIsolation(val: unknown): IsolationMode | undefined {
  if (val === "worktree") return "worktree";
  if (val === "off" || val === "none" || val === "no" || val === false) return "off";
  return undefined;
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === "none") return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
