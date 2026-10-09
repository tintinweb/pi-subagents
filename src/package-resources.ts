/**
 * package-resources.ts — Discover agent and workflow files that installed pi
 * packages declare in their `package.json`.
 *
 * ## Why this exists
 *
 * Pi already ships four resource types inside packages — `extensions`, `skills`,
 * `prompts`, `themes` — resolved from a `pi` manifest key or, when there is no
 * `pi` key at all, from convention directories. Subagents are *our* concept, so
 * pi knows nothing about them and a package author's only option was to copy
 * `.md` files into `.pi/agents/` on every container start (#109).
 *
 * ## The contract
 *
 * Two-sided, deliberately:
 *
 *   1. The package author opts in by naming the paths in `package.json`.
 *   2. The user opts in by running `pi install`, which is already the trust
 *      decision for that package — pi executes its `extensions/` and injects its
 *      `skills/` into the system prompt with no further prompt. A declared `.md`
 *      agent is strictly less privileged than either, so it rides the boundary
 *      the user already crossed rather than inventing a second one.
 *
 * There is deliberately **no convention-directory fallback**. Pi scans `skills/`
 * only when a package has no `pi` key whatsoever; we never scan an undeclared
 * `agents/`. A package that happens to carry an `agents/` folder for some other
 * tool must not start contributing subagents to pi because it was installed for
 * an unrelated reason.
 *
 * ## Which packages are visible
 *
 * Only what pi itself has configured — `settings.json -> packages[]`, global and
 * project — read through pi's own `DefaultPackageManager.listConfiguredPackages()`.
 * That call is synchronous, pure, and never installs anything; it also resolves
 * npm / git / local install roots, pnpm global roots and legacy fallbacks, which
 * is why it is worth borrowing rather than reimplementing.
 *
 * `node_modules` is never scanned. Being a transitive dependency of the user's
 * project means nothing here — the same rule pi applies to itself.
 *
 * ## Accepted manifest spellings
 *
 * All four mean the same thing. The `pi-subagents` top-level key exists for
 * cross-compatibility with `nicobailon/pi-subagents`, which reads the same two
 * shapes, so a package author writes one manifest that works on either extension.
 *
 *   "pi":            { "subagents": { "agents": ["./agents"], "workflows": ["./flows"] } }
 *   "pi":            { "subagents": ["./agents"] }            // shorthand for { agents }
 *   "pi-subagents":  { "agents": ["./agents"] }
 *   "pi-subagents":  ["./agents"]                             // shorthand for { agents }
 *
 * Adding `pi.subagents` is safe for pi itself: its `readPiManifest` reads only
 * `extensions`/`skills`/`prompts`/`themes` and ignores every other key.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DefaultPackageManager, getAgentDir, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Resource kinds a package may declare. Agents are `.md`, workflows are `.js`. */
export type PackageResourceKind = "agents" | "workflows";

/** File extension scanned for each kind, mirroring the local roots for each. */
const KIND_EXTENSION: Record<PackageResourceKind, string> = {
  agents: ".md",
  workflows: ".js",
};

/**
 * Per-file size ceiling for package-provided resources, matching Claude Code's
 * plugin-agent limit. These files come from third-party packages and are read
 * eagerly on every agent load; a pathological one should be skipped, not
 * `readFileSync`'d into the session.
 */
export const MAX_PACKAGE_RESOURCE_BYTES = 1_048_576;

/** One installed pi package that declared something we understand. */
export interface PiPackage {
  /** The settings source string, e.g. `npm:@foo/bar@1.0.0` or an absolute path. */
  source: string;
  /** `package.json` `name`, when the manifest could be read. */
  name?: string;
  /** Unscoped, lowercased short name (`@scope/foo` becomes `foo`) for allowlist matching. */
  shortName?: string;
  /** Which settings scope configured it. */
  scope: "user" | "project";
  /** Absolute path of the installed package root. */
  root: string;
  /**
   * What its manifest declared. Carried here rather than re-read downstream:
   * `listPiPackages` has to parse the manifest anyway to know whether the
   * package declares anything at all, and reading it twice would leave two
   * places that could disagree about what a package said.
   */
  declared: DeclaredEntries;
}

/**
 * The gate for one resource kind, as persisted in our settings:
 * `true` (default) = every declaring package, `false` = none, `string[]` =
 * only packages whose short name, full name, or source matches an entry.
 */
export type PackageGate = boolean | string[] | undefined;

export interface PackageDiscoveryOptions {
  /**
   * Pi's project-trust state for `cwd`, from `ctx.isProjectTrusted()`. When
   * false, `.pi/settings.json` is not read — so a package configured only by an
   * untrusted project is invisible to us, exactly as it is to pi. Omitted falls
   * back to the session state set by {@link setProjectTrusted}.
   */
  projectTrusted?: boolean;
  /** Gate override. Omitted falls back to the session state for the kind. */
  gate?: PackageGate;
}

// ---- Session state ----
//
// Held here rather than threaded through every caller, matching how the rest of
// this extension carries session-wide settings (`setMaxSubagentDepth`,
// `setWorktreeIsolationEnabled`, ...). The alternative was an options bag
// travelling from `index.ts` through `resolveWorkflowScript`,
// `resolveWorkflowSource`, `readSavedWorkflow` and `listSavedWorkflows` purely
// so a gate could be consulted at the bottom.
//
// Both gates start `undefined`, which reads as `true`: absent settings mean
// every declaring package contributes, matching pi's own default for the
// resources it owns.

let agentsGate: PackageGate;
let workflowsGate: PackageGate;
/**
 * Defaults to `false` — an extension activates before any session context
 * exists, and reading an untrusted project's package list only to take it away
 * again is the wrong direction to fail. `index.ts` corrects it from
 * `ctx.isProjectTrusted()` on `session_start`.
 */
let projectTrustedState = false;

/** Apply the `packageAgents` setting. Drops the cache, since roots may change. */
export function setPackageAgentsGate(gate: PackageGate): void {
  agentsGate = gate;
  invalidatePackageCache();
}

/** Apply the `packageWorkflows` setting. Drops the cache, since roots may change. */
export function setPackageWorkflowsGate(gate: PackageGate): void {
  workflowsGate = gate;
  invalidatePackageCache();
}

export function getPackageAgentsGate(): PackageGate {
  return agentsGate;
}

export function getPackageWorkflowsGate(): PackageGate {
  return workflowsGate;
}

/**
 * Seed the trust state from pi's *saved* decision, before any session exists.
 *
 * The correction on `session_start` is too late for one thing that matters: the
 * `Agent` tool's description — the list of agent types the model is told about —
 * is built once at activation, so an agent registered after it never reaches the
 * model even though dispatch would accept it. That is exactly the shape a team
 * ships agents in: a package named in a committed `.pi/settings.json`, which is
 * invisible until the project is trusted.
 *
 * Pi keeps that decision in `<agentDir>/trust.json`, keyed by canonical path
 * with the nearest ancestor winning, so on the second and every later session in
 * a trusted repo the answer is already on disk. No saved decision falls back to
 * the global `defaultProjectTrust`, which is what pi does; `"ask"` resolves to
 * untrusted here, because the prompt has not been answered yet and guessing yes
 * would be the wrong direction to guess.
 *
 * Best-effort by design: any failure leaves the state untrusted, and
 * `session_start` still delivers pi's real answer either way.
 */
export function seedProjectTrust(cwd: string): void {
  try {
    if (typeof ProjectTrustStore !== "function") return;
    const agentDir = getAgentDir();
    const saved = new ProjectTrustStore(agentDir).get(cwd);
    if (typeof saved === "boolean") {
      setProjectTrusted(saved);
      return;
    }
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    setProjectTrusted(settings.getGlobalSettings().defaultProjectTrust === "always");
  } catch {
    // Leave it untrusted; session_start corrects it.
  }
}

/**
 * Record pi's project-trust answer. Drops the cache when the answer changes,
 * since a project's `packages[]` becomes visible or invisible with it. A repeat
 * of the same answer is a no-op — `session_start` fires on every new, resumed
 * and forked session, and it has its own reason to invalidate.
 */
export function setProjectTrusted(trusted: boolean): void {
  if (projectTrustedState === trusted) return;
  projectTrustedState = trusted;
  invalidatePackageCache();
}

/** Reset every session-scoped value. Tests only — the extension never un-loads. */
export function resetPackageState(): void {
  agentsGate = undefined;
  workflowsGate = undefined;
  projectTrustedState = false;
  invalidatePackageCache();
}

/** What a package declared, after normalising the accepted spellings. */
export interface DeclaredEntries {
  agents?: string[];
  workflows?: string[];
}

/** Absolute paths a declaration resolved to, split by what the loader needs. */
export interface ResolvedResourcePaths {
  dirs: string[];
  files: string[];
  /**
   * Canonical paths of `!` entries. Kept separate from `dirs`/`files` rather
   * than subtracted from them because an exclusion usually names a file *inside*
   * an included directory, which is not enumerated until load time.
   */
  excluded: ReadonlySet<string>;
}

// ---- Manifest reading ----

/** A string array, or undefined for anything else. Mirrors pi's `readPiManifest` strictness. */
function stringArray(val: unknown): string[] | undefined {
  return Array.isArray(val) && val.every(e => typeof e === "string") ? (val as string[]) : undefined;
}

/**
 * Normalize one accepted spelling into `{ agents, workflows }`.
 * A bare array is the `agents` shorthand — the only kind that existed when the
 * shorthand was worth having, and the shape the other fork's docs show.
 */
function normalizeDeclaration(val: unknown): DeclaredEntries | undefined {
  const asArray = stringArray(val);
  if (asArray) return { agents: asArray };
  if (!val || typeof val !== "object" || Array.isArray(val)) return undefined;
  const obj = val as Record<string, unknown>;
  const agents = stringArray(obj.agents);
  const workflows = stringArray(obj.workflows);
  if (!agents && !workflows) return undefined;
  return { agents, workflows };
}

/**
 * Read the subagent declaration out of a parsed `package.json`.
 *
 * `pi.subagents` wins over the top-level `pi-subagents` when a package carries
 * both — the pi-namespaced key is the primary spelling here, and a package that
 * writes both almost certainly means them to be identical anyway.
 */
export function readSubagentManifest(pkg: unknown): DeclaredEntries | undefined {
  if (!pkg || typeof pkg !== "object") return undefined;
  const obj = pkg as Record<string, unknown>;
  const piKey = obj.pi;
  if (piKey && typeof piKey === "object" && !Array.isArray(piKey)) {
    const nested = normalizeDeclaration((piKey as Record<string, unknown>).subagents);
    if (nested) return nested;
  }
  return normalizeDeclaration(obj["pi-subagents"]);
}

/** Parse `<root>/package.json`, or undefined when it is missing or malformed. */
function readPackageJson(root: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `@scope/foo` becomes `foo`, lowercased. The name a user types in an allowlist. */
export function unscopedShortName(name: string): string {
  const short = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  return short.toLowerCase();
}

// ---- Path resolution ----

/**
 * Canonical absolute path, resolving symlinks as far as the path exists.
 *
 * A plain `realpathSync` is not enough: an exclusion may name a file the package
 * does not ship yet, and a bare `resolve()` fallback would leave it uncanonical
 * — which on macOS means `/var/...` compared against a canonical `/private/var/...`
 * root, so the containment check below rejects it. Canonicalizing the nearest
 * existing ancestor and re-appending the rest keeps both sides comparable.
 */
function realOrSelf(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realOrSelf(parent), basename(abs));
  }
}

/**
 * True when `candidate` is inside `root`. Package manifests are third-party
 * input, so `"../../.ssh"` must not become a scanned directory — pi refuses the
 * same shape with "Refusing to use path outside package install root".
 *
 * Compared on canonical paths, because `..` is not the only way out: a symlinked
 * `agents/` pointing at `/etc` is textually inside the root, and `readdirSync`
 * follows it. Both sides are canonicalized so a package installed *under* a
 * symlink (`/var` → `/private/var` on macOS) still matches itself.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(realOrSelf(root), realOrSelf(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve one manifest entry against the package root, returning the path only
 * when it stays inside the package and exists.
 *
 * Globs are deliberately not supported. Pi's own manifest expands them because
 * it resolves four resource types across arbitrary layouts; here the entries are
 * one or two directories, and a glob would mean walking a third-party tree to
 * answer. A directory or a file path covers the declared use cases.
 */
function expandEntry(root: string, entry: string): string | undefined {
  const target = resolve(root, entry);
  if (!isInside(root, target) || !existsSync(target)) return undefined;
  return target;
}

/**
 * Resolve one kind's declared entries into concrete absolute paths inside the
 * package: directories to scan, and individual files.
 *
 * Split into `{ dirs, files }` rather than a flat list because the agent loader
 * takes directories (it does its own `readdirSync` and frontmatter handling),
 * while a manifest entry naming a single file has to be surfaced on its own.
 *
 * `!entry` marks an exclusion. Exact paths only — pi's own `!` is gitignore-style
 * glob negation, and globs are not supported here for the reason above.
 */
export function resolveDeclaredPaths(
  root: string,
  entries: string[] | undefined,
  kind: PackageResourceKind,
): ResolvedResourcePaths {
  const dirs: string[] = [];
  const files: string[] = [];
  const excluded = new Set<string>();
  if (!entries) return { dirs, files, excluded };

  // Exclusions are collected first and stored canonically, so `!./agents/wip.md`
  // matches the same file however the loader spelled its way to it. They do not
  // have to exist: a package may exclude a path it ships conditionally.
  for (const entry of entries) {
    if (!entry.startsWith("!")) continue;
    const target = resolve(root, entry.slice(1));
    if (isInside(root, target)) excluded.add(realOrSelf(target));
  }

  const ext = KIND_EXTENSION[kind];
  for (const entry of entries) {
    if (entry.startsWith("!")) continue;
    const path = expandEntry(root, entry);
    if (!path || excluded.has(realOrSelf(path))) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (!dirs.includes(path)) dirs.push(path);
    } else if (stat.isFile() && path.endsWith(ext) && !files.includes(path)) {
      files.push(path);
    }
  }
  return { dirs, files, excluded };
}

// ---- Package enumeration ----

interface ConfiguredPackageRow {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

/**
 * Build a read-only view of pi's configured packages.
 *
 * Feature-detected rather than assumed: the peer floor is `>=0.84.0` and this
 * API is not exercised by CI across that whole range, so a host that does not
 * expose it contributes no packages instead of failing activation.
 */
function configuredPackages(cwd: string, projectTrusted: boolean): ConfiguredPackageRow[] {
  try {
    if (typeof DefaultPackageManager !== "function") return [];
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    if (typeof manager.listConfiguredPackages !== "function") return [];
    return manager.listConfiguredPackages();
  } catch {
    return [];
  }
}

/**
 * Every installed pi package that declares subagent resources, in pi's own
 * order (global entries first, then project). Duplicates by root are collapsed —
 * a package listed in both scopes is one package on disk.
 */
export function listPiPackages(cwd: string, projectTrusted = false): PiPackage[] {
  const seen = new Set<string>();
  const out: PiPackage[] = [];
  for (const entry of configuredPackages(cwd, projectTrusted)) {
    const root = entry.installedPath;
    if (!root || seen.has(root)) continue;
    const manifest = readPackageJson(root);
    const declared = manifest ? readSubagentManifest(manifest) : undefined;
    if (!manifest || !declared) continue;
    seen.add(root);
    const name = typeof manifest.name === "string" ? manifest.name : undefined;
    out.push({
      source: entry.source,
      name,
      shortName: name ? unscopedShortName(name) : undefined,
      scope: entry.scope,
      root,
      declared,
    });
  }
  return out;
}

/**
 * Whether `pkg` passes the gate. `true`/omitted admits everything; an array
 * matches case-insensitively against the unscoped short name, the full package
 * name, or the settings source string — users reach for whichever of the three
 * they happen to have in front of them.
 */
export function packageAllowed(pkg: PiPackage, gate: PackageGate): boolean {
  if (gate === false) return false;
  if (gate === undefined || gate === true) return true;
  const candidates = new Set(
    [pkg.shortName, pkg.name?.toLowerCase(), pkg.source.toLowerCase()].filter(
      (v): v is string => typeof v === "string",
    ),
  );
  return gate.some(allowed => candidates.has(allowed.trim().toLowerCase()));
}

// ---- Caching ----

/** An admitted package's install root and the name to show for it. */
interface PackageOwner {
  /** Normalized, so it compares against a normalized candidate path. */
  root: string;
  name: string;
}

/**
 * `loadCustomAgents` runs on activation and again on every `Agent` call, so an
 * uncached scan would re-read pi's settings and every package manifest per
 * spawn. What is cached is only the *root list* — which packages declare what —
 * because that changes when settings change, not when a file is edited. The
 * agent files themselves are still re-read on every load, so editing a linked
 * package's agent still takes effect immediately.
 *
 * Keyed by cwd because nested subagents load from `context.configCwd`, which is
 * not necessarily the main session's directory, and by the gate because a
 * settings change must not be served a stale allowlist.
 */
interface CacheEntry {
  agents: ResolvedResourcePaths;
  workflows: ResolvedResourcePaths;
  /**
   * Every package the gate admitted, longest root first, so a path can be
   * traced back to the package that contributed it. Recorded during the scan
   * that already enumerated them rather than re-derived later: a second pass
   * would re-read pi's settings and every manifest, and could disagree with
   * this entry about which packages the gate let through.
   */
  owners: PackageOwner[];
}

/** A resolved-paths value with nothing in it. Fresh each call — callers get copies. */
function emptyPaths(): ResolvedResourcePaths {
  return { dirs: [], files: [], excluded: new Set() };
}

/** A whole cache entry with nothing in it, for a gate that admits no package. */
function emptyEntry(): CacheEntry {
  return { agents: emptyPaths(), workflows: emptyPaths(), owners: [] };
}
const cache = new Map<string, CacheEntry>();

/** Drop the memoized package scan. Called on `/reload` and after settings changes. */
export function invalidatePackageCache(): void {
  cache.clear();
}

function scan(cwd: string, projectTrusted: boolean, gate: PackageGate): CacheEntry {
  const entry = emptyEntry();
  for (const pkg of listPiPackages(cwd, projectTrusted)) {
    if (!packageAllowed(pkg, gate)) continue;
    // The root is normalized here, not at lookup time: the declared paths below
    // go through `resolve(root, entry)`, so a root that arrived with a trailing
    // separator would never prefix-match the very paths it produced.
    //
    // `name` is absent only when the manifest had no usable `name` string; the
    // settings source (`npm:@foo/bar@1.0.0`) is the last resort, which is what
    // pi itself falls back to when it labels a package-provided resource.
    entry.owners.push({ root: resolve(pkg.root), name: pkg.name ?? pkg.shortName ?? pkg.source });
    for (const kind of ["agents", "workflows"] as const) {
      const resolvedPaths = resolveDeclaredPaths(pkg.root, pkg.declared[kind], kind);
      entry[kind].dirs.push(...resolvedPaths.dirs);
      entry[kind].files.push(...resolvedPaths.files);
      // One flat set across packages: an exclusion is an absolute path, so it
      // can only ever match inside the package that wrote it.
      for (const path of resolvedPaths.excluded) (entry[kind].excluded as Set<string>).add(path);
    }
  }
  // Longest root first, so a package installed inside another's `node_modules`
  // claims its own files rather than losing them to its host.
  entry.owners.sort((a, b) => b.root.length - a.root.length);
  return entry;
}

function cacheEntryFor(cwd: string, kind: PackageResourceKind, opts: PackageDiscoveryOptions): CacheEntry {
  const gate = opts.gate ?? (kind === "agents" ? agentsGate : workflowsGate);
  // An empty allowlist matches nothing, like `false` — see `sanitizePackageGate`
  // in settings.ts for why an empty array is kept rather than dropped.
  if (gate === false || (Array.isArray(gate) && gate.length === 0)) return emptyEntry();
  const projectTrusted = opts.projectTrusted ?? projectTrustedState;
  // `\u0000` written as an escape, not a raw byte: a literal NUL makes this
  // whole file read as binary to grep, ripgrep and git, which silently drops
  // it from search results.
  const key = `${cwd}\u0000${projectTrusted ? 1 : 0}\u0000${JSON.stringify(gate ?? true)}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = scan(cwd, projectTrusted, gate);
    cache.set(key, hit);
  }
  return hit;
}

function resolved(cwd: string, kind: PackageResourceKind, opts: PackageDiscoveryOptions): ResolvedResourcePaths {
  return cacheEntryFor(cwd, kind, opts)[kind];
}

/**
 * Name of the installed package that provided `path`, or undefined when no
 * admitted package owns it. What `/agents` shows so a package agent can name its
 * origin, and what a user needs in order to write a `packageAgents` allowlist.
 *
 * `kind` selects which gate to consult, because the two are configured
 * separately: a package may be admitted for agents but not for workflows.
 *
 * A plain prefix test is enough. `resolveDeclaredPaths` builds every declared
 * path as `resolve(root, entry)` without canonicalizing it — only the
 * containment check and the exclusion set go through `realOrSelf` — so a
 * `sourcePath` the loader derived from one is textually inside the root it came
 * from. The `sep` anchor keeps `…/node_modules/foo` from claiming
 * `…/node_modules/foo-bar`.
 */
export function packageNameForPath(
  path: string,
  cwd: string,
  kind: PackageResourceKind = "agents",
  opts: PackageDiscoveryOptions = {},
): string | undefined {
  const abs = resolve(path);
  return cacheEntryFor(cwd, kind, opts).owners.find(
    o => abs === o.root || abs.startsWith(o.root + sep),
  )?.name;
}

/**
 * Directories of package-declared agent files, lowest-precedence first.
 * Fed to `loadCustomAgents` ahead of the global and project roots.
 */
export function packageAgentDirs(cwd: string, opts: PackageDiscoveryOptions = {}): string[] {
  // A copy: the cache holds this array for the rest of the session, so a caller
  // that sorted or spliced it would corrupt every later load.
  return [...resolved(cwd, "agents", opts).dirs];
}

/** Individually declared agent `.md` files (a manifest entry naming a file, not a directory). */
export function packageAgentFiles(cwd: string, opts: PackageDiscoveryOptions = {}): string[] {
  return [...resolved(cwd, "agents", opts).files];
}

/**
 * Whether a `!` entry in some package manifest excludes this path.
 *
 * Checked at load time rather than subtracted during resolution, because the
 * common exclusion — `["./agents", "!./agents/wip.md"]` — names a file inside a
 * directory that is not enumerated until the loader reads it.
 */
export function isPackageResourceExcluded(
  path: string,
  cwd: string,
  kind: PackageResourceKind,
  opts: PackageDiscoveryOptions = {},
): boolean {
  const excluded = resolved(cwd, kind, opts).excluded;
  return excluded.size > 0 && excluded.has(realOrSelf(path));
}

/**
 * Directories of package-declared workflow scripts, appended to
 * `savedWorkflowRoots` so a name resolves there last.
 */
export function packageWorkflowDirs(cwd: string, opts: PackageDiscoveryOptions = {}): string[] {
  return [...resolved(cwd, "workflows", opts).dirs];
}

/**
 * Individually declared workflow scripts, as `name -> absolute path`.
 *
 * A name lookup wants a directory, and a declared *file* has none — but standing
 * its parent directory in as a root would make every sibling `.js` resolvable,
 * so `workflows: ["./one.js"]` would quietly offer the package's other scripts
 * too, and `["./index.js"]` would offer everything at the package root. That is
 * the opposite of the rule the whole feature rests on, that a package only
 * contributes what it names. An exact map keeps the declaration honest, and
 * matches how a declared agent file is already handled.
 *
 * Later entries lose a name clash, so a package's own directory-sourced script
 * is not displaced by a file entry from a package resolved after it.
 */
export function packageWorkflowFiles(cwd: string, opts: PackageDiscoveryOptions = {}): Map<string, string> {
  const out = new Map<string, string>();
  for (const path of resolved(cwd, "workflows", opts).files) {
    const name = basename(path, KIND_EXTENSION.workflows);
    if (!out.has(name)) out.set(name, path);
  }
  return out;
}
