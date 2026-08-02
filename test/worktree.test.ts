import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees, tryCreateWorktree } from "../src/worktree.js";

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
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates a linked worktree from a bare repository with a valid HEAD", () => {
      const bare = mkdtempSync(join(tmpdir(), "pi-wt-bare-"));
      const source = initGitRepo();
      try {
        execFileSync("git", ["clone", "--bare", source, bare], { stdio: "pipe" });
        const result = tryCreateWorktree(bare, "bare-repo");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(existsSync(join(result.worktree.path, "README.md"))).toBe(true);
          execFileSync("git", ["worktree", "remove", "--force", result.worktree.path], {
            cwd: bare,
            stdio: "pipe",
          });
        }
      } finally {
        rmSync(source, { recursive: true, force: true });
        rmSync(bare, { recursive: true, force: true });
      }
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

    it.each(["zh_CN.UTF-8", "C"])(
      "classifies non-git and no-HEAD prerequisites independently of Git locale (%s)",
      (locale) => {
        const previousLcAll = process.env.LC_ALL;
        const previousLang = process.env.LANG;
        process.env.LC_ALL = locale;
        process.env.LANG = locale;
        const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-locale-nongit-"));
        const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-locale-empty-"));
        try {
          execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
          expect(tryCreateWorktree(nonGit, "locale-nongit")).toEqual({
            ok: false,
            reason: "not_git_repo",
          });
          expect(tryCreateWorktree(emptyRepo, "locale-no-head")).toEqual({
            ok: false,
            reason: "no_head",
          });
        } finally {
          if (previousLcAll === undefined) delete process.env.LC_ALL;
          else process.env.LC_ALL = previousLcAll;
          if (previousLang === undefined) delete process.env.LANG;
          else process.env.LANG = previousLang;
          rmSync(nonGit, { recursive: true, force: true });
          rmSync(emptyRepo, { recursive: true, force: true });
        }
      },
    );

    it("distinguishes non-git / no-HEAD prerequisites from worktree-add failure", () => {
      // Structured creation separates prerequisite failures from a genuine
      // `git worktree add` failure for Agent spawn messaging. createWorktree
      // remains a thin success-or-undefined wrapper for other callers.
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-reason-"));
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-reason-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });

        const nonGitResult = tryCreateWorktree(nonGit, "reason-nongit");
        expect(nonGitResult.ok).toBe(false);
        if (!nonGitResult.ok) expect(nonGitResult.reason).toBe("not_git_repo");

        const noHeadResult = tryCreateWorktree(emptyRepo, "reason-nohead");
        expect(noHeadResult.ok).toBe(false);
        if (!noHeadResult.ok) expect(noHeadResult.reason).toBe("no_head");
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("labels repo-root resolution failure separately from git worktree add", () => {
      // Path/root resolution happens before `git worktree add` and must not be
      // reported as an add failure. Use a PATH-shadowing git shim so only
      // --show-toplevel fails after inside-work-tree + HEAD succeed.
      const bin = mkdtempSync(join(tmpdir(), "pi-wt-git-shim-"));
      const shim = join(bin, "git");
      writeFileSync(
        shim,
        `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
  echo true
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  echo abc123def4567890abc123def4567890abc123de
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  echo "simulated toplevel failure" >&2
  exit 128
fi
exec /usr/bin/git "$@"
`,
      );
      chmodSync(shim, 0o755);
      const prevPath = process.env.PATH;
      process.env.PATH = `${bin}:${prevPath ?? ""}`;
      try {
        const result = tryCreateWorktree(repoDir, "path-resolve");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("repo_path_resolution_failed");
        }
      } finally {
        process.env.PATH = prevPath;
        rmSync(bin, { recursive: true, force: true });
      }
    });

    it("keeps an invalid .git marker fail-closed", () => {
      const corrupt = mkdtempSync(join(tmpdir(), "pi-wt-corrupt-marker-"));
      mkdirSync(join(corrupt, ".git"));
      try {
        expect(tryCreateWorktree(corrupt, "corrupt-marker")).toEqual({
          ok: false,
          reason: "git_probe_failed",
        });
      } finally {
        rmSync(corrupt, { recursive: true, force: true });
      }
    });

    it("keeps a corrupt current branch ref fail-closed", () => {
      const corrupt = mkdtempSync(join(tmpdir(), "pi-wt-corrupt-ref-"));
      try {
        execFileSync("git", ["init"], { cwd: corrupt, stdio: "pipe" });
        writeFileSync(join(corrupt, ".git", "refs", "heads", "master"), "invalid-object-name\n");
        expect(tryCreateWorktree(corrupt, "corrupt-ref")).toEqual({
          ok: false,
          reason: "git_probe_failed",
        });
      } finally {
        rmSync(corrupt, { recursive: true, force: true });
      }
    });

    it("classifies infrastructure failure during initial inside-work-tree probe (not not_git_repo)", () => {
      // Timeout / permission / safe.directory / corrupt probe must not look like
      // a confirmed non-Git cwd — dropping isolation would be the wrong guidance.
      const bin = mkdtempSync(join(tmpdir(), "pi-wt-git-infra-inside-"));
      const shim = join(bin, "git");
      writeFileSync(
        shim,
        `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
  echo "fatal: detected dubious ownership in repository" >&2
  exit 128
fi
exec /usr/bin/git "$@"
`,
      );
      chmodSync(shim, 0o755);
      const prevPath = process.env.PATH;
      process.env.PATH = `${bin}:${prevPath ?? ""}`;
      try {
        const result = tryCreateWorktree(repoDir, "infra-inside");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("git_probe_failed");
          expect(result.reason).not.toBe("not_git_repo");
          expect(result.reason).not.toBe("no_head");
        }
      } finally {
        process.env.PATH = prevPath;
        rmSync(bin, { recursive: true, force: true });
      }
    });

    it("classifies infrastructure failure during HEAD probe (not no_head)", () => {
      // After a conclusive inside-work-tree=true, a non-no-HEAD probe failure
      // (timeout/permission/corrupt) must keep isolation guidance.
      const bin = mkdtempSync(join(tmpdir(), "pi-wt-git-infra-head-"));
      const shim = join(bin, "git");
      writeFileSync(
        shim,
        `#!/bin/sh
if [ "$1" = "rev-parse" ] && [ "$2" = "--is-inside-work-tree" ]; then
  echo true
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ]; then
  echo "error: could not lock config file" >&2
  exit 1
fi
exec /usr/bin/git "$@"
`,
      );
      chmodSync(shim, 0o755);
      const prevPath = process.env.PATH;
      process.env.PATH = `${bin}:${prevPath ?? ""}`;
      try {
        const result = tryCreateWorktree(repoDir, "infra-head");
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("git_probe_failed");
          expect(result.reason).not.toBe("no_head");
          expect(result.reason).not.toBe("not_git_repo");
        }
      } finally {
        process.env.PATH = prevPath;
        rmSync(bin, { recursive: true, force: true });
      }
    });

    it("workPath equals path when created from the repo root", () => {
      const wt = createWorktree(repoDir, "root-wp")!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = createWorktree(join(repoDir, "packages", "api"), "subdir-wp")!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
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

    it("commits changes even when a pre-commit hook rejects (--no-verify)", () => {
      // A failing pre-commit hook in the main repo also applies to its
      // worktrees — without --no-verify it would abort the preservation commit.
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const wt = createWorktree(repoDir, "hooked-1")!;
      expect(wt).toBeDefined();
      writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "hook should not block");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-hooked-1");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates branch when worktree is clean but HEAD moved", () => {
      const wt = createWorktree(repoDir, "committed-1")!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim();

      const result = cleanupWorktree(repoDir, wt, "already committed");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toBe("pi-agent-committed-1");

      const branchCommit = execFileSync("git", ["rev-parse", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branchCommit).toBe(agentCommit);
      expect(existsSync(wt.path)).toBe(false);

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
