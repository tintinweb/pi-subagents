import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/worktree.js";

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo();
  });

  afterEach(() => {
    // Clean up any lingering worktrees first, then remove repo
    try { pruneWorktrees(repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", () => {
      const wt = createWorktree(repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("returns undefined for non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = createWorktree(nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = createWorktree(emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("uses unique paths for multiple worktrees", () => {
      const wt1 = createWorktree(repoDir, "multi-1");
      const wt2 = createWorktree(repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", () => {
      const wt = createWorktree(repoDir, "clean-1")!;
      expect(wt).toBeDefined();

      const result = cleanupWorktree(repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
    });

    it("commits changes and creates branch when changes exist", () => {
      const wt = createWorktree(repoDir, "dirty-1")!;
      expect(wt).toBeDefined();

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      // Verify the commit message
      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("does not force-overwrite existing branch", () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = createWorktree(repoDir, "conflict-1")!;
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = cleanupWorktree(repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = createWorktree(repoDir, "conflict-1")!;
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = cleanupWorktree(repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("handles already-deleted worktree gracefully", () => {
      const wt = createWorktree(repoDir, "gone-1")!;
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = cleanupWorktree(repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
    });

    it("truncates commit message at 200 chars", () => {
      const wt = createWorktree(repoDir, "long-msg")!;
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = cleanupWorktree(repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not throw on a clean repo", () => {
      expect(() => pruneWorktrees(repoDir)).not.toThrow();
    });

    it("does not throw on non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(() => pruneWorktrees(nonGit)).not.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});
