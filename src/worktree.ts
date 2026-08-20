/**
 * worktree.ts — Configurable Git worktree / Jujutsu workspace isolation.
 *
 * Creates a temporary repository workspace so an agent works on an isolated
 * copy. Clean workspaces are removed; changed work is preserved on a Git branch
 * or Jujutsu bookmark before removal.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
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
  /** Commit used as the workspace's original parent. */
  baseRevision: string;
  /** Change id of the workspace's original parent. */
  baseChangeId: string;
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

function run(command: string, args: string[], cwd: string, timeout = 10_000): string {
  return execFileSync(command, args, { cwd, stdio: "pipe", timeout }).toString().trim();
}

function jjRoot(cwd: string): string | undefined {
  try {
    return run("jj", ["root", "--ignore-working-copy"], cwd, 5000);
  } catch {
    return undefined;
  }
}

function gitRoot(cwd: string): string | undefined {
  try {
    run("git", ["rev-parse", "--is-inside-work-tree"], cwd, 5000);
    return run("git", ["rev-parse", "--show-toplevel"], cwd, 5000);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(realpathSync(parent), realpathSync(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function backendOrder(cwd: string, requested: IsolationBackend): ResolvedIsolationBackend[] {
  if (requested !== "auto") {
    const detected = requested === "jj" ? jjRoot(cwd) : gitRoot(cwd);
    return detected ? [requested] : [];
  }

  const detectedJjRoot = jjRoot(cwd);
  const detectedGitRoot = gitRoot(cwd);
  if (!detectedJjRoot) return detectedGitRoot ? ["git"] : [];
  if (!detectedGitRoot) return ["jj"];

  // A nested repository is the repository that owns cwd. At the same root,
  // prefer jj as requested; otherwise do not let an ancestor jj repository
  // mask a nearer nested Git checkout (or vice versa).
  const realJjRoot = realpathSync(detectedJjRoot);
  const realGitRoot = realpathSync(detectedGitRoot);
  if (realJjRoot === realGitRoot) return ["jj", "git"];
  return isWithin(realJjRoot, realGitRoot) ? ["git"] : ["jj"];
}

/**
 * Create a temporary isolated workspace. `auto` chooses the nearest repository;
 * at a colocated root it prefers Jujutsu, then Git.
 */
export function createWorktree(
  cwd: string,
  agentId: string,
  requestedBackend: IsolationBackend = "auto",
): WorktreeInfo | undefined {
  const suffix = randomUUID().slice(0, 8);
  const workspaceName = `pi-agent-${agentId}-${suffix}`;
  const workspacePath = join(tmpdir(), workspaceName);
  const ref = `pi-agent-${agentId}`;

  for (const backend of backendOrder(cwd, requestedBackend)) {
    const worktree = backend === "jj"
      ? createJjWorkspace(cwd, workspacePath, workspaceName, ref)
      : createGitWorktree(cwd, workspacePath, ref);
    if (worktree) return worktree;
  }
  return undefined;
}

function createGitWorktree(cwd: string, path: string, ref: string): WorktreeInfo | undefined {
  try {
    const baseRevision = run("git", ["rev-parse", "HEAD"], cwd, 5000);
    const root = run("git", ["rev-parse", "--show-toplevel"], cwd, 5000);
    const subdir = relative(realpathSync(root), realpathSync(cwd));

    run("git", ["worktree", "add", "--detach", path, "HEAD"], cwd, 30_000);
    const workPath = subdir ? join(path, subdir) : path;
    if (!existsSync(workPath)) {
      removeGitWorktree(cwd, path);
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

function createJjWorkspace(
  cwd: string,
  path: string,
  workspaceName: string,
  ref: string,
): WorktreeInfo | undefined {
  let created = false;
  try {
    const root = run("jj", ["root", "--ignore-working-copy"], cwd, 5000);
    const subdir = relative(realpathSync(root), realpathSync(cwd));
    const baseCount = Number(run(
      "jj",
      ["log", "--ignore-working-copy", "-r", "@-", "--count"],
      cwd,
      5000,
    ));
    if (baseCount !== 1) return undefined;
    const [baseRevision, baseChangeId, baseParentCount] = run(
      "jj",
      [
        "log",
        "--ignore-working-copy",
        "-r",
        "@-",
        "--no-graph",
        "-T",
        'commit_id ++ "\\0" ++ change_id ++ "\\0" ++ parents.len() ++ "\\n"',
      ],
      cwd,
      5000,
    ).split("\0");
    if (Number(baseParentCount) === 0) return undefined;

    // Match the Git backend's fixed committed base: the agent workspace is a
    // sibling of the caller's mutable @, not its descendant. Parent snapshots
    // therefore cannot auto-rebase edits or conflicts into a running agent.
    run("jj", ["workspace", "add", "--name", workspaceName, "-r", baseRevision, path], cwd, 30_000);
    created = true;
    const initial = readJjRevision(path, true);
    const workPath = subdir ? join(path, subdir) : path;
    if (!existsSync(workPath)) throw new Error(`Isolated work path does not exist: ${workPath}`);
    return {
      backend: "jj",
      path,
      ref,
      baseRevision,
      baseChangeId,
      initialChangeId: initial.changeId,
      workspaceName,
      workPath,
    };
  } catch {
    // Only remove the path after `workspace add` succeeded. If creation itself
    // failed, the randomly generated destination may predate this attempt and
    // must never be deleted as best-effort cleanup.
    if (created) forgetJjWorkspace(cwd, workspaceName, path);
    return undefined;
  }
}

/**
 * Clean up an isolated workspace, preserving changed work on a backend ref.
 * This remains synchronous so the completion result cannot race preservation;
 * expensive jj steps get 30-second per-command budgets rather than short probes.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  return worktree.backend === "jj"
    ? cleanupJjWorkspace(cwd, worktree, agentDescription)
    : cleanupGitWorktree(cwd, worktree, agentDescription);
}

function cleanupGitWorktree(
  cwd: string,
  worktree: GitWorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) return { hasChanges: false, backend: "git" };

  let hasChanges = false;
  try {
    const status = run("git", ["status", "--porcelain"], worktree.path);
    if (status) {
      hasChanges = true;
      run("git", ["add", "-A"], worktree.path);
      run(
        "git",
        ["commit", "--no-verify", "-m", `pi-agent: ${agentDescription.slice(0, 200)}`],
        worktree.path,
      );
    } else {
      const currentRevision = run("git", ["rev-parse", "HEAD"], worktree.path, 5000);
      hasChanges = currentRevision !== worktree.baseRevision;
      if (!hasChanges) {
        removeGitWorktree(cwd, worktree.path);
        return { hasChanges: false, backend: "git" };
      }
    }

    const ref = createUniqueRef("git", worktree.path, worktree.ref, "HEAD");
    removeGitWorktree(cwd, worktree.path);
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

interface JjRevisionInfo {
  changeId: string;
  empty: boolean;
  conflicted: boolean;
  parentCount: number;
  description: string;
}

function readJjRevision(cwd: string, ignoreWorkingCopy = false): JjRevisionInfo {
  const output = run(
    "jj",
    [
      "log",
      ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
      "-r",
      "@",
      "--no-graph",
      "-T",
      'change_id ++ "\\0" ++ empty ++ "\\0" ++ conflict ++ "\\0" ++ parents.len() ++ "\\0" ++ description ++ "\\n"',
    ],
    cwd,
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

function cleanupJjWorkspace(
  cwd: string,
  worktree: JjWorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    forgetJjWorkspace(cwd, worktree.workspaceName, worktree.path);
    return { hasChanges: false, backend: "jj" };
  }

  try {
    const revision = readJjRevision(worktree.path);
    // The initial workspace commit is empty. Its commit id can still change if
    // repository metadata evolves, so identity + emptiness — not commit id —
    // determines whether the agent produced work.
    if (revision.empty && revision.changeId === worktree.initialChangeId) {
      forgetJjWorkspace(cwd, worktree.workspaceName, worktree.path);
      return { hasChanges: false, backend: "jj" };
    }

    let target = "@";
    if (!revision.empty && !revision.description.trim()) {
      run("jj", ["describe", "-m", `pi-agent: ${agentDescription.slice(0, 200)}`], worktree.path);
    } else if (revision.empty && revision.changeId !== worktree.initialChangeId && revision.parentCount === 1) {
      target = "@-";
    }

    let baseDrifted = true;
    try {
      const currentBase = run(
        "jj",
        ["log", "--ignore-working-copy", "-r", worktree.baseChangeId, "--no-graph", "-T", 'commit_id ++ "\\n"'],
        worktree.path,
        5000,
      );
      baseDrifted = currentBase !== worktree.baseRevision;
    } catch {
      // The original base change was abandoned/hidden. Preserve the agent's
      // bookmark anyway and report the base as drifted.
    }
    const ref = createUniqueRef("jj", worktree.path, worktree.ref, target);
    forgetJjWorkspace(cwd, worktree.workspaceName, worktree.path);
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

function createUniqueRef(
  backend: ResolvedIsolationBackend,
  cwd: string,
  requested: string,
  revision: string,
): string {
  try {
    createRef(backend, cwd, requested, revision);
    return requested;
  } catch {
    const unique = `${requested}-${Date.now()}`;
    createRef(backend, cwd, unique, revision);
    return unique;
  }
}

function createRef(
  backend: ResolvedIsolationBackend,
  cwd: string,
  name: string,
  revision: string,
): void {
  if (backend === "jj") {
    run("jj", ["bookmark", "create", name, "-r", revision], cwd, 30_000);
  } else {
    run("git", ["branch", name, revision], cwd, 5000);
  }
}

function removeGitWorktree(cwd: string, path: string): void {
  try {
    run("git", ["worktree", "remove", "--force", path], cwd);
  } catch {
    try {
      run("git", ["worktree", "prune"], cwd, 5000);
    } catch {
      // Best effort cleanup.
    }
  }
}

function forgetJjWorkspace(cwd: string, workspaceName: string, path: string): void {
  try {
    run("jj", ["workspace", "forget", workspaceName, "--ignore-working-copy"], cwd, 30_000);
  } catch {
    // A later prune can remove a stale registration.
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

/** Prune orphaned Git worktrees and plugin-created Jujutsu workspaces. */
export function pruneWorktrees(cwd: string): void {
  try {
    run("git", ["worktree", "prune"], cwd, 5000);
  } catch {
    // Not a Git repository or Git unavailable.
  }

  try {
    const workspaces = run(
      "jj",
      ["workspace", "list", "--ignore-working-copy", "-T", 'name ++ "\\0" ++ if(root, root, "") ++ "\\n"'],
      cwd,
      5000,
    )
      .split("\n")
      .map((line) => line.split("\0", 2) as [string, string])
      .filter(([name]) => name.startsWith("pi-agent-"));
    for (const [name, root] of workspaces) {
      if (!root || !existsSync(root)) {
        try {
          run("jj", ["workspace", "forget", name, "--ignore-working-copy"], cwd, 30_000);
        } catch {
          // A concurrently cleaned workspace is already gone.
        }
      }
    }
  } catch {
    // Not a Jujutsu repository or jj unavailable.
  }
}
