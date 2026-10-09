/**
 * worktree.ts — Configurable Git worktree / Jujutsu workspace isolation.
 *
 * Creates a temporary repository workspace so an agent works on an isolated
 * copy. Clean workspaces are removed; changed work is preserved on a Git branch
 * or Jujutsu bookmark before removal.
 *
 * Repository commands run through `pi.exec` so copying several isolated
 * workspaces does not block or serialize work on the TUI event loop.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IsolationBackend } from "./types.js";

export type ResolvedIsolationBackend = Exclude<IsolationBackend, "auto">;

interface BaseWorktreeInfo {
  /** Absolute path to the isolated workspace root. */
  path: string;
  /** Desired branch/bookmark name if changes exist. */
  ref: string;
  /**
   * Where the agent should work inside the isolated workspace: the equivalent
   * of the cwd from which it was created. Equals `path` at the repository root.
   */
  workPath: string;
}

export interface GitWorktreeInfo extends BaseWorktreeInfo {
  backend: "git";
  /** Commit from which the detached worktree was created. */
  baseRevision: string;
}

export interface JjWorktreeInfo extends BaseWorktreeInfo {
  backend: "jj";
  /** Parent revisions shared with the caller's working copy at creation. */
  baseParents: { revision: string; changeId: string }[];
  /** Initial isolated working-copy change id. */
  initialChangeId: string;
  /** Name registered in the Jujutsu repository. */
  workspaceName: string;
}

export type WorktreeInfo = GitWorktreeInfo | JjWorktreeInfo;

/** Project-wide switch for repository workspace isolation. */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Whether changes or new history were found. */
  hasChanges: boolean;
  /** Backend used by this workspace. */
  backend: ResolvedIsolationBackend;
  /** Preserved branch or bookmark name. */
  ref?: string;
  /** Kind of ref returned in `ref`. */
  refKind?: "branch" | "bookmark";
  /** Workspace path when cleanup failed and the workspace was kept. */
  path?: string;
  /** The jj workspace's original base was rewritten while the agent ran. */
  baseDrifted?: boolean;
  /** The preserved jj bookmark contains conflicts. */
  hasConflicts?: boolean;
  /** Cleanup/preservation error; work remains at `path` when present. */
  error?: string;
}

/** Run a repository command and throw unless it exits cleanly. */
async function run(
  pi: ExtensionAPI,
  command: ResolvedIsolationBackend,
  cwd: string,
  args: string[],
  timeout = 10_000,
): Promise<string> {
  const result = await pi.exec(command, args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

async function jjRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  try {
    return await run(pi, "jj", cwd, ["root", "--ignore-working-copy"], 5000);
  } catch {
    return undefined;
  }
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  try {
    await run(pi, "git", cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    return await run(pi, "git", cwd, ["rev-parse", "--show-toplevel"], 5000);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(realpathSync(parent), realpathSync(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function backendOrder(
  pi: ExtensionAPI,
  cwd: string,
  requested: IsolationBackend,
): Promise<ResolvedIsolationBackend[]> {
  if (requested !== "auto") {
    const detected = requested === "jj" ? await jjRoot(pi, cwd) : await gitRoot(pi, cwd);
    return detected ? [requested] : [];
  }

  const [detectedJjRoot, detectedGitRoot] = await Promise.all([jjRoot(pi, cwd), gitRoot(pi, cwd)]);
  if (!detectedJjRoot) return detectedGitRoot ? ["git"] : [];
  if (!detectedGitRoot) return ["jj"];

  // A nested repository is the repository that owns cwd. At the same root,
  // prefer jj as requested; otherwise do not let an ancestor jj repository
  // mask a nearer nested Git checkout (or vice versa).
  try {
    const realJjRoot = realpathSync(detectedJjRoot);
    const realGitRoot = realpathSync(detectedGitRoot);
    if (realJjRoot === realGitRoot) return ["jj", "git"];
    return isWithin(realJjRoot, realGitRoot) ? ["git"] : ["jj"];
  } catch {
    // A detected root disappeared or its symlink broke between the command and
    // filesystem check. Let strict isolation report the usual curated failure.
    return [];
  }
}

/**
 * Create a temporary isolated workspace. `auto` chooses the nearest repository;
 * at a colocated root it prefers Jujutsu, then Git.
 */
export async function createWorktree(
  pi: ExtensionAPI,
  cwd: string,
  agentId: string,
  requestedBackend: IsolationBackend = "auto",
): Promise<WorktreeInfo | undefined> {
  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `pi-agent-${agentId}-${suffix}`;
  const workspacePath = join(tmpdir(), workspaceName);
  const ref = `pi-agent-${agentId}`;

  for (const backend of await backendOrder(pi, cwd, requestedBackend)) {
    const worktree = backend === "jj"
      ? await createJjWorkspace(pi, cwd, workspacePath, workspaceName, ref)
      : await createGitWorktree(pi, cwd, workspacePath, ref);
    if (worktree) return worktree;
  }
  return undefined;
}

async function createGitWorktree(
  pi: ExtensionAPI,
  cwd: string,
  path: string,
  ref: string,
): Promise<GitWorktreeInfo | undefined> {
  try {
    const baseRevision = await run(pi, "git", cwd, ["rev-parse", "HEAD"], 5000);
    const root = await run(pi, "git", cwd, ["rev-parse", "--show-toplevel"], 5000);
    const subdir = relative(realpathSync(root), realpathSync(cwd));

    await run(pi, "git", cwd, ["worktree", "add", "--detach", path, "HEAD"], 30_000);
    const workPath = subdir ? join(path, subdir) : path;
    if (!existsSync(workPath)) {
      await removeGitWorktree(pi, cwd, path);
      return undefined;
    }
    return {
      backend: "git",
      path,
      ref,
      baseRevision,
      workPath,
    };
  } catch {
    return undefined;
  }
}

async function createJjWorkspace(
  pi: ExtensionAPI,
  cwd: string,
  path: string,
  workspaceName: string,
  ref: string,
): Promise<JjWorktreeInfo | undefined> {
  let created = false;
  try {
    const root = await run(pi, "jj", cwd, ["root", "--ignore-working-copy"], 5000);
    const subdir = relative(realpathSync(root), realpathSync(cwd));

    // With no -r, jj creates the new working copy as a sibling of the caller's
    // mutable @ and gives both working copies the same parent set. This handles
    // ordinary and merge working copies without allowing later parent snapshots
    // to auto-rebase edits or conflicts into a running agent.
    await run(
      pi,
      "jj",
      cwd,
      ["workspace", "add", "--name", workspaceName, "-m", jjWorkspaceDescription(workspaceName), path],
      30_000,
    );
    created = true;
    const baseParents = await readJjParents(pi, path);
    // A fresh repository has only the root commit under @. Match the Git
    // backend's requirement for at least one committed change.
    if (!baseParents.some(parent => parent.parentCount > 0)) {
      throw new Error("Jujutsu repository has no committed change");
    }
    const initial = await readJjRevision(pi, path, true);
    const workPath = subdir ? join(path, subdir) : path;
    if (!existsSync(workPath)) throw new Error(`Isolated work path does not exist: ${workPath}`);
    return {
      backend: "jj",
      path,
      ref,
      baseParents: baseParents.map(({ revision, changeId }) => ({ revision, changeId })),
      initialChangeId: initial.changeId,
      workspaceName,
      workPath,
    };
  } catch {
    // Only remove the path after `workspace add` succeeded. If creation itself
    // failed, the randomly generated destination may predate this attempt and
    // must never be deleted as best-effort cleanup.
    if (created) await forgetJjWorkspace(pi, cwd, workspaceName, path);
    return undefined;
  }
}

/** Clean up an isolated workspace, preserving changed work on a backend ref. */
export async function cleanupWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  return worktree.backend === "jj"
    ? cleanupJjWorkspace(pi, cwd, worktree, agentDescription)
    : cleanupGitWorktree(pi, cwd, worktree, agentDescription);
}

async function cleanupGitWorktree(
  pi: ExtensionAPI,
  cwd: string,
  worktree: GitWorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) return { hasChanges: false, backend: "git" };

  try {
    const status = await run(pi, "git", worktree.path, ["status", "--porcelain"]);
    if (status) {
      await run(pi, "git", worktree.path, ["add", "-A"]);
      await run(
        pi,
        "git",
        worktree.path,
        ["commit", "--no-verify", "-m", `pi-agent: ${agentDescription.slice(0, 200)}`],
      );
    } else {
      const currentRevision = await run(pi, "git", worktree.path, ["rev-parse", "HEAD"], 5000);
      if (currentRevision === worktree.baseRevision) {
        await removeGitWorktree(pi, cwd, worktree.path);
        return { hasChanges: false, backend: "git" };
      }
    }

    const ref = await createUniqueRef(pi, "git", worktree.path, worktree.ref, "HEAD");
    await removeGitWorktree(pi, cwd, worktree.path);
    return { hasChanges: true, backend: "git", ref, refKind: "branch" };
  } catch (err) {
    return {
      // The workspace still exists and its state could not be classified safely.
      // Treat it as changed so callers surface the retained path instead of
      // silently deleting potentially recoverable work.
      hasChanges: true,
      backend: "git",
      path: worktree.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface JjParentInfo {
  revision: string;
  changeId: string;
  parentCount: number;
}

async function readJjParents(pi: ExtensionAPI, cwd: string): Promise<JjParentInfo[]> {
  const output = await run(
    pi,
    "jj",
    cwd,
    [
      "log",
      "--ignore-working-copy",
      "-r",
      "@-",
      "--no-graph",
      "-T",
      'commit_id ++ "\\0" ++ change_id ++ "\\0" ++ parents.len() ++ "\\n"',
    ],
    5000,
  );
  return output.split("\n").filter(Boolean).map((line) => {
    const [revision, changeId, parentCount] = line.split("\0");
    return { revision, changeId, parentCount: Number(parentCount) };
  });
}

interface JjRevisionInfo {
  changeId: string;
  empty: boolean;
  conflicted: boolean;
  parentCount: number;
  description: string;
}

async function readJjRevision(
  pi: ExtensionAPI,
  cwd: string,
  ignoreWorkingCopy = false,
  revision = "@",
): Promise<JjRevisionInfo> {
  const output = await run(
    pi,
    "jj",
    cwd,
    [
      "log",
      ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "-r",
      revision,
      "--no-graph",
      "-T",
      'change_id ++ "\\0" ++ empty ++ "\\0" ++ conflict ++ "\\0" ++ parents.len() ++ "\\0" ++ description ++ "\\n"',
    ],
    ignoreWorkingCopy ? 5000 : 30_000,
  );
  const [changeId, empty, conflicted, parentCount, description = ""] = output.split("\0");
  return {
    changeId,
    empty: empty === "true",
    conflicted: conflicted === "true",
    parentCount: Number(parentCount),
    description,
  };
}

function jjWorkspaceDescription(workspaceName: string): string {
  return `pi-agent workspace ${workspaceName}`;
}

async function isOwnedJjRevision(
  pi: ExtensionAPI,
  worktree: JjWorktreeInfo,
  revision: string,
  changeId?: string,
): Promise<boolean> {
  if (changeId === worktree.initialChangeId) return true;
  try {
    return Number(await run(
      pi,
      "jj",
      worktree.path,
      ["log", "--ignore-working-copy", "-r", `${revision} & ${worktree.initialChangeId}::`, "--count"],
      5000,
    )) === 1;
  } catch {
    return false;
  }
}

async function clearJjWorkspaceDescription(pi: ExtensionAPI, worktree: JjWorktreeInfo): Promise<void> {
  const initial = await readJjRevision(pi, worktree.path, true, worktree.initialChangeId);
  if (initial.description === jjWorkspaceDescription(worktree.workspaceName)) {
    await run(pi, "jj", worktree.path, ["describe", "-r", worktree.initialChangeId, "-m", ""], 30_000);
  }
}

async function cleanupJjWorkspace(
  pi: ExtensionAPI,
  cwd: string,
  worktree: JjWorktreeInfo,
  agentDescription: string,
): Promise<WorktreeCleanupResult> {
  if (!existsSync(worktree.path)) {
    await forgetJjWorkspace(pi, cwd, worktree.workspaceName, worktree.path);
    return { hasChanges: false, backend: "jj" };
  }

  try {
    // Check ownership before a normal jj command snapshots filesystem edits.
    // If the agent moved @ to a foreign change and then wrote files, snapshotting
    // first would commit those files into history outside the isolation line.
    const observed = await readJjRevision(pi, worktree.path, true);
    if (!await isOwnedJjRevision(pi, worktree, "@", observed.changeId)) {
      throw new Error("Isolated workspace moved to a revision outside the agent's workspace history");
    }

    const revision = await readJjRevision(pi, worktree.path);
    if (!await isOwnedJjRevision(pi, worktree, "@", revision.changeId)) {
      throw new Error("Isolated workspace moved to a revision outside the agent's workspace history");
    }
    // The initial workspace commit is empty. Its commit id can still change if
    // repository metadata evolves, so identity + emptiness — not commit id —
    // determines whether the agent produced work.
    const initialMarker = jjWorkspaceDescription(worktree.workspaceName);
    if (
      revision.empty &&
      revision.changeId === worktree.initialChangeId &&
      (!revision.description.trim() || revision.description === initialMarker)
    ) {
      await clearJjWorkspaceDescription(pi, worktree);
      await forgetJjWorkspace(pi, cwd, worktree.workspaceName, worktree.path);
      return { hasChanges: false, backend: "jj" };
    }

    // A committed agent change leaves a new empty @ above it, so preserve @-.
    // An empty merge @, or a described initial @, is itself meaningful and
    // remains the target.
    const target = revision.empty &&
        revision.changeId !== worktree.initialChangeId &&
        revision.parentCount === 1
      ? "@-"
      : "@";
    if (!await isOwnedJjRevision(pi, worktree, target)) {
      throw new Error("Isolated workspace moved to a revision outside the agent's workspace history");
    }
    const targetRevision = target === "@"
      ? revision
      : await readJjRevision(pi, worktree.path, true, target);
    if (
      targetRevision.empty &&
      targetRevision.changeId === worktree.initialChangeId &&
      targetRevision.description === initialMarker
    ) {
      await clearJjWorkspaceDescription(pi, worktree);
      await forgetJjWorkspace(pi, cwd, worktree.workspaceName, worktree.path);
      return { hasChanges: false, backend: "jj" };
    }

    if (
      !targetRevision.empty &&
      (!targetRevision.description.trim() ||
        (targetRevision.changeId === worktree.initialChangeId && targetRevision.description === initialMarker))
    ) {
      await run(
        pi,
        "jj",
        worktree.path,
        ["describe", "-r", target, "-m", `pi-agent: ${agentDescription.slice(0, 200)}`],
        30_000,
      );
    }
    // The temporary description keeps the initial empty change addressable
    // while the agent works. Remove it before preservation so it does not leave
    // an internal marker in the user's visible history.
    await clearJjWorkspaceDescription(pi, worktree);

    let baseDrifted = false;
    for (const parent of worktree.baseParents) {
      try {
        const currentBase = await run(
          pi,
          "jj",
          worktree.path,
          ["log", "--ignore-working-copy", "-r", parent.changeId, "--no-graph", "-T", 'commit_id ++ "\\n"'],
          5000,
        );
        if (currentBase !== parent.revision) {
          baseDrifted = true;
          break;
        }
      } catch {
        // The original base change was abandoned/hidden. Preserve the agent's
        // bookmark anyway and report the base as drifted.
        baseDrifted = true;
        break;
      }
    }
    const ref = await createUniqueRef(pi, "jj", worktree.path, worktree.ref, target);
    await forgetJjWorkspace(pi, cwd, worktree.workspaceName, worktree.path);
    return {
      hasChanges: true,
      backend: "jj",
      ref,
      refKind: "bookmark",
      ...(baseDrifted && { baseDrifted: true }),
      ...(revision.conflicted && { hasConflicts: true }),
    };
  } catch (err) {
    return {
      // As with Git, an unreadable workspace is retained and reported as
      // changed so cleanup uncertainty cannot erase agent work.
      hasChanges: true,
      backend: "jj",
      path: worktree.path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function createUniqueRef(
  pi: ExtensionAPI,
  backend: ResolvedIsolationBackend,
  cwd: string,
  requested: string,
  revision: string,
): Promise<string> {
  try {
    await createRef(pi, backend, cwd, requested, revision);
    return requested;
  } catch {
    const unique = `${requested}-${Date.now()}`;
    await createRef(pi, backend, cwd, unique, revision);
    return unique;
  }
}

async function createRef(
  pi: ExtensionAPI,
  backend: ResolvedIsolationBackend,
  cwd: string,
  name: string,
  revision: string,
): Promise<void> {
  if (backend === "jj") {
    await run(pi, "jj", cwd, ["bookmark", "create", name, "-r", revision], 30_000);
  } else {
    await run(pi, "git", cwd, ["branch", name, revision], 5000);
  }
}

async function removeGitWorktree(pi: ExtensionAPI, cwd: string, path: string): Promise<void> {
  try {
    await run(pi, "git", cwd, ["worktree", "remove", "--force", path]);
  } catch {
    try {
      await run(pi, "git", cwd, ["worktree", "prune"], 5000);
    } catch {
      // Best effort cleanup.
    }
  }
}

async function forgetJjWorkspace(
  pi: ExtensionAPI,
  cwd: string,
  workspaceName: string,
  path: string,
): Promise<void> {
  try {
    await run(pi, "jj", cwd, ["workspace", "forget", workspaceName, "--ignore-working-copy"], 30_000);
  } catch {
    // A later prune can remove a stale registration.
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

/** Prune orphaned Git worktrees and plugin-created Jujutsu workspaces. */
export async function pruneWorktrees(pi: ExtensionAPI, cwd: string): Promise<void> {
  try {
    await run(pi, "git", cwd, ["worktree", "prune"], 5000);
  } catch {
    // Not a Git repository or Git unavailable.
  }

  try {
    const workspaces = (await run(
      pi,
      "jj",
      cwd,
      ["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\0" ++ if(root, root, "") ++ "\\n"'],
      5000,
    ))
      .split("\n")
      .map((line) => line.split("\0", 2) as [string, string])
      .filter(([name]) => name.startsWith("pi-agent-"));
    for (const [name, root] of workspaces) {
      // An absent root can mean either an older live workspace whose root was
      // never recorded or a deleted workspace. Plugin workspaces always use
      // tmpdir/name, so that path distinguishes those cases conservatively.
      const workspacePath = root || join(tmpdir(), name);
      if (!existsSync(workspacePath)) {
        try {
          await run(pi, "jj", cwd, ["workspace", "forget", name, "--ignore-working-copy"], 30_000);
        } catch {
          // A concurrently cleaned workspace is already gone.
        }
      }
    }
  } catch {
    // Not a Jujutsu repository or jj unavailable.
  }
}
