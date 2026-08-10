/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
}

/** Why worktree isolation could not be established. */
export type WorktreeCreateFailureReason =
  | "not_git_repo"
  | "no_head"
  | "git_probe_failed"
  | "repo_path_resolution_failed"
  | "worktree_add_failed";

export type WorktreeCreateResult =
  | { ok: true; worktree: WorktreeInfo }
  | { ok: false; reason: WorktreeCreateFailureReason };

const GIT_PROBE_TIMEOUT_MS = 5000;

/** Outcome of a conclusive `git rev-parse` classification probe. */
type GitProbeResult<
  TSuccess extends string = string,
  TNegative extends WorktreeCreateFailureReason = WorktreeCreateFailureReason,
> =
  | { kind: "success"; value: TSuccess; bare?: boolean }
  | { kind: "negative"; reason: TNegative }
  | { kind: "infrastructure" };

function runGitProbe(cwd: string, args: string[], timeoutMs = GIT_PROBE_TIMEOUT_MS) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    // Capture streams without unbounded throws; force Git's stable C messages
    // where stderr is needed to distinguish prerequisites from infrastructure.
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
}

function probeStdout(result: ReturnType<typeof runGitProbe>): string {
  return (result.stdout ?? "").trim();
}

type GitMarkerState = "present" | "absent" | "infrastructure";

function gitMarkerState(cwd: string): GitMarkerState {
  let current = resolve(cwd);
  while (true) {
    try {
      lstatSync(join(current, ".git"));
      return "present";
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return "infrastructure";
    }
    const parent = dirname(current);
    if (parent === current) return "absent";
    current = parent;
  }
}

/**
 * Conclusive inside-work-tree probe.
 * - success true → Git work tree
 * - success false / conclusive "not a git repository" → not_git_repo
 * - spawn/timeout/permission/safe.directory/corrupt/malformed → infrastructure
 */
function probeInsideWorkTree(cwd: string): GitProbeResult<"true", "not_git_repo"> {
  const result = runGitProbe(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (result.error || result.signal) return { kind: "infrastructure" };

  const status = result.status;
  const out = probeStdout(result);

  if (status === 0) {
    if (out === "true") return { kind: "success", value: "true" };
    // Bare repositories report false but can still create a linked worktree.
    if (out === "false") return { kind: "success", value: "true", bare: true };
    return { kind: "infrastructure" };
  }

  // Only absence of a .git marker throughout the cwd's ancestor chain proves
  // a repository prerequisite miss. Corrupt, broken, or unreadable markers stay
  // fail-closed instead of being mistaken for a safe unisolated retry.
  if (
    status === 128 &&
    !process.env.GIT_DIR &&
    !process.env.GIT_WORK_TREE &&
    gitMarkerState(cwd) === "absent"
  ) {
    return { kind: "negative", reason: "not_git_repo" };
  }

  return { kind: "infrastructure" };
}

/** Full object name as produced by `git rev-parse HEAD` on a valid commit. */
const FULL_OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i; // SHA-1 (40) or SHA-256 (64)

/**
 * Conclusive HEAD probe (requires a prior confirmed work tree).
 * - success + full object name → base SHA
 * - conclusive missing/unborn revision → no_head
 * - spawn/timeout/permission/corrupt/malformed → infrastructure
 */
function probeHead(cwd: string): GitProbeResult<string, "no_head"> {
  const result = runGitProbe(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (result.error || result.signal) return { kind: "infrastructure" };

  const status = result.status;
  const out = probeStdout(result);

  if (status === 0) {
    if (FULL_OBJECT_NAME.test(out)) return { kind: "success", value: out };
    return { kind: "infrastructure" };
  }

  // A genuine unborn branch has a valid symbolic HEAD whose branch ref does
  // not exist. Existing malformed, dangling, or non-commit refs remain
  // infrastructure failures rather than prerequisite misses.
  if (status === 128) {
    const symbolic = runGitProbe(cwd, ["symbolic-ref", "-q", "HEAD"]);
    const ref = probeStdout(symbolic);
    if (!symbolic.error && !symbolic.signal && symbolic.status === 0 && ref.startsWith("refs/heads/")) {
      const format = runGitProbe(cwd, ["check-ref-format", ref]);
      if (!format.error && !format.signal && format.status === 0) {
        const exists = runGitProbe(cwd, ["show-ref", "--verify", "--quiet", ref]);
        if (!exists.error && !exists.signal && exists.status === 1) {
          return { kind: "negative", reason: "no_head" };
        }
      }
    }
  }

  return { kind: "infrastructure" };
}

/**
 * Create a temporary git worktree for an agent, with a structured failure reason.
 * Distinguishes confirmed non-Git / missing-HEAD prerequisites from Git probe
 * infrastructure failures and a genuine `git worktree add` failure.
 * Never silently falls back.
 */
export function tryCreateWorktree(cwd: string, agentId: string): WorktreeCreateResult {
  const inside = probeInsideWorkTree(cwd);
  if (inside.kind === "infrastructure") {
    return { ok: false, reason: "git_probe_failed" };
  }
  if (inside.kind === "negative") {
    return { ok: false, reason: inside.reason };
  }

  const head = probeHead(cwd);
  if (head.kind === "infrastructure") {
    return { ok: false, reason: "git_probe_failed" };
  }
  if (head.kind === "negative") {
    return { ok: false, reason: head.reason };
  }
  const baseSha = head.value;

  // Where cwd sits inside the repo ("" at the root): the agent must work at
  // the same subdirectory inside the copy, or a monorepo-package cwd would
  // silently widen to the whole repo. realpath both sides — git emits
  // resolved paths while cwd may arrive through a symlink (macOS /tmp).
  let subdir = "";
  if (!inside.bare) {
    try {
      const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        stdio: "pipe",
        timeout: 5000,
      })
        .toString()
        .trim();
      subdir = relative(realpathSync(topLevel), realpathSync(cwd));
    } catch {
      // Top-level/path resolution failed after HEAD succeeded — worktree add was not attempted.
      return { ok: false, reason: "repo_path_resolution_failed" };
    }
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return {
      ok: true,
      worktree: {
        path: worktreePath,
        branch,
        baseSha,
        workPath: subdir ? join(worktreePath, subdir) : worktreePath,
      },
    };
  } catch {
    return { ok: false, reason: "worktree_add_failed" };
  }
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree info, or undefined when isolation cannot be established.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  const result = tryCreateWorktree(cwd, agentId);
  return result.ok ? result.worktree : undefined;
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    // Check for uncommitted changes in the worktree
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();

    if (status) {
      // Changes exist — stage, commit, and create a branch
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      // Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    } else {
      const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree
        removeWorktree(cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    }
    // Update branch name in worktree info for the caller
    worktree.branch = branchName;

    // Remove the worktree (branch persists in main repo)
    removeWorktree(cwd, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      path: worktree.path,
    };
  } catch {
    // Best effort cleanup on error
    try { removeWorktree(cwd, worktree.path); } catch { /* ignore */ }
    return { hasChanges: false };
  }
}

/**
 * Force-remove a worktree.
 */
function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // If git worktree remove fails, try pruning
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    } catch { /* ignore */ }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
}
