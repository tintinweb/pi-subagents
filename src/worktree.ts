/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_WORKTREE_TIMEOUT_SETTING,
  isValidWorktreeTimeoutSetting,
  type WorktreeTimeoutSetting,
} from "./settings.js";

const AUTO_WORKTREE_TIMEOUT_MIN_MS = 60_000;
const AUTO_WORKTREE_TIMEOUT_PER_FILE_MS = 5;
const AUTO_WORKTREE_TIMEOUT_MAX_MS = 30 * 60_000;
const AUTO_WORKTREE_TIMEOUT_FALLBACK_MS = 5 * 60_000;
const TRACKED_FILE_COUNT_TIMEOUT_MS = 10_000;
const TRACKED_FILE_COUNT_MAX_BUFFER = 64 * 1024 * 1024;

let worktreeTimeoutSetting: WorktreeTimeoutSetting = DEFAULT_WORKTREE_TIMEOUT_SETTING;

export function getWorktreeTimeoutSetting(): WorktreeTimeoutSetting {
  return worktreeTimeoutSetting;
}

export function setWorktreeTimeoutSetting(setting: WorktreeTimeoutSetting): void {
  if (!isValidWorktreeTimeoutSetting(setting)) {
    throw new Error(`Invalid worktree timeout setting: ${String(setting)}`);
  }
  worktreeTimeoutSetting = setting;
}

function getTrackedFileCount(cwd: string): number | undefined {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd,
      stdio: "pipe",
      timeout: TRACKED_FILE_COUNT_TIMEOUT_MS,
      maxBuffer: TRACKED_FILE_COUNT_MAX_BUFFER,
    });
    let count = 0;
    for (const byte of output) {
      if (byte === 0) count++;
    }
    return count;
  } catch {
    return undefined;
  }
}

/** Calculate an auto timeout with a one-minute floor and a thirty-minute cap. */
export function calculateAutoWorktreeTimeoutMs(trackedFileCount: number): number {
  const safeFileCount = Number.isFinite(trackedFileCount) ? Math.max(0, Math.floor(trackedFileCount)) : 0;
  return Math.min(
    AUTO_WORKTREE_TIMEOUT_MAX_MS,
    Math.max(AUTO_WORKTREE_TIMEOUT_MIN_MS, AUTO_WORKTREE_TIMEOUT_MIN_MS + safeFileCount * AUTO_WORKTREE_TIMEOUT_PER_FILE_MS),
  );
}

/** Resolve the configured timeout. Auto scales with the repository's tracked file count. */
export function resolveWorktreeTimeoutMs(
  cwd: string,
  setting: WorktreeTimeoutSetting = worktreeTimeoutSetting,
): number {
  if (setting !== "auto") return setting * 1000;
  const trackedFileCount = getTrackedFileCount(cwd);
  return trackedFileCount === undefined
    ? AUTO_WORKTREE_TIMEOUT_FALLBACK_MS
    : calculateAutoWorktreeTimeoutMs(trackedFileCount);
}

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

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. Ask Git for the relative prefix rather
    // than comparing Windows paths directly: Git may emit the repository root
    // with the long username form while cwd uses an 8.3 short path.
    const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = prefix.replace(/[\\/]+$/, "");
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);
  const timeoutMs = resolveWorktreeTimeoutMs(cwd);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: timeoutMs,
    });
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch (error) {
    // A timed-out checkout can leave a child git process and a locked partial
    // worktree on Windows. Kill the process tree first, then remove both the
    // worktree registration and any partially checked-out files.
    cleanupFailedWorktree(cwd, worktreePath, error);
    return undefined;
  }
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ETIMEDOUT";
}

function getChildProcessPid(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const pid = (error as { pid?: unknown }).pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function terminateTimedOutProcess(error: unknown): void {
  const pid = getChildProcessPid(error);
  if (pid === undefined || pid === process.pid) return;

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // The process may already have exited; cleanup below is still attempted.
  }
}

function cleanupFailedWorktree(cwd: string, worktreePath: string, error: unknown): void {
  if (isTimeoutError(error)) terminateTimedOutProcess(error);

  try {
    // Two --force flags also remove a worktree locked while Git is initializing.
    execFileSync("git", ["worktree", "remove", "--force", "--force", worktreePath], {
      cwd,
      stdio: "ignore",
      timeout: 10000,
    });
  } catch {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "ignore", timeout: 5000 });
    } catch {
      // Best effort; the filesystem cleanup below may still succeed.
    }
  }

  if (existsSync(worktreePath)) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
