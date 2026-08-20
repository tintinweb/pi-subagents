import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeIsolationEnabled,
  type WorktreeInfo,
} from "../src/worktree.js";

// Real jj workspace operations can exceed Vitest's 5-second default under the
// full suite's CPU and filesystem contention.
vi.setConfig({ testTimeout: 30_000 });

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, stdio: "pipe" }).toString().trim();
}

function initGitRepo(dir = mkdtempSync(join(tmpdir(), "pi-wt-git-test-"))): string {
  mkdirSync(dir, { recursive: true });
  run("git", ["init"], dir);
  run("git", ["config", "user.email", "test@test.com"], dir);
  run("git", ["config", "user.name", "Test"], dir);
  run("git", ["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), "# Test repo");
  run("git", ["add", "README.md"], dir);
  run("git", ["commit", "-m", "initial"], dir);
  return dir;
}

function initJjRepo(colocated = false): string {
  const parent = mkdtempSync(join(tmpdir(), "pi-wt-jj-test-"));
  const dir = join(parent, "repo");
  run("jj", ["git", "init", colocated ? "--colocate" : "--no-colocate", dir], parent);
  writeFileSync(join(dir, "README.md"), "# Test repo");
  run("jj", ["describe", "-m", "initial"], dir);
  run("jj", ["new"], dir);
  return dir;
}

function jjWorkspaceNames(repo: string): string[] {
  return run("jj", ["workspace", "list", "-T", 'name ++ "\\n"'], repo).split("\n");
}

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
const repos: string[] = [];
const workspaces: WorktreeInfo[] = [];

function trackRepo(path: string): string {
  repos.push(path);
  return path;
}

function trackWorkspace(worktree: WorktreeInfo | undefined): WorktreeInfo | undefined {
  if (worktree) workspaces.push(worktree);
  return worktree;
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace.path, { recursive: true, force: true });
  }
  for (const repo of repos.splice(0)) {
    try {
      pruneWorktrees(repo);
    } catch {
      // Best effort test cleanup.
    }
    rmSync(existsSync(join(repo, ".jj")) ? dirname(repo) : repo, { recursive: true, force: true });
  }
});

describe("isolation backend selection", () => {
  it.skipIf(!hasJj)("auto prefers jj in a colocated repository", () => {
    const repo = trackRepo(initJjRepo(true));
    const wt = trackWorkspace(createWorktree(repo, "auto-jj"));
    expect(wt?.backend).toBe("jj");
  }, 15_000);

  it("auto falls back to Git outside a jj repository", () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(createWorktree(repo, "auto-git"));
    expect(wt?.backend).toBe("git");
  });

  it.skipIf(!hasJj)("explicit backends do not fall back", () => {
    const jjRepo = trackRepo(initJjRepo());
    const gitRepo = trackRepo(initGitRepo());
    expect(createWorktree(jjRepo, "git-no-fallback", "git")).toBeUndefined();
    expect(createWorktree(gitRepo, "jj-no-fallback", "jj")).toBeUndefined();
  });

});

describe("Git worktree backend", () => {
  it("creates a worktree with repository files and root scoping", () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(createWorktree(repo, "git-create", "git"))!;

    expect(wt.backend).toBe("git");
    expect(wt.ref).toBe("pi-agent-git-create");
    expect(wt.baseRevision).toBe(run("git", ["rev-parse", "HEAD"], repo));
    expect(wt.workPath).toBe(wt.path);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
  });

  it("returns undefined for a Git repository with no commits", () => {
    const repo = trackRepo(mkdtempSync(join(tmpdir(), "pi-wt-empty-git-")));
    run("git", ["init"], repo);
    expect(createWorktree(repo, "empty-git", "git")).toBeUndefined();
  });

  it("preserves monorepo subdirectory scoping", () => {
    const repo = trackRepo(initGitRepo());
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "packages", "api", "index.ts"), "export {}");
    run("git", ["add", "-A"], repo);
    run("git", ["commit", "-m", "add package"], repo);

    const wt = trackWorkspace(createWorktree(join(repo, "packages", "api"), "git-subdir", "git"))!;
    expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
  });

  it("rejects a cwd that exists only in the mutable Git working tree", () => {
    const repo = trackRepo(initGitRepo());
    const uncommitted = join(repo, "new-package");
    mkdirSync(uncommitted);

    expect(createWorktree(uncommitted, "git-missing-subdir", "git")).toBeUndefined();
  });

  it("removes a clean worktree", () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(createWorktree(repo, "git-clean", "git"))!;
    const result = cleanupWorktree(repo, wt, "clean");

    expect(result).toEqual({ hasChanges: false, backend: "git" });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("commits edits and returns a branch", () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(createWorktree(repo, "git-dirty", "git"))!;
    writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

    const result = cleanupWorktree(repo, wt, "added new file");
    expect(result).toEqual({
      hasChanges: true,
      backend: "git",
      ref: "pi-agent-git-dirty",
      refKind: "branch",
    });
    expect(run("git", ["branch", "--list", result.ref!], repo)).toContain(result.ref!);
    expect(run("git", ["log", "--oneline", "-1", result.ref!], repo)).toContain("pi-agent: added new file");
  });

  it("preserves agent-created commits when the tree is clean", () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(createWorktree(repo, "git-committed", "git"))!;
    writeFileSync(join(wt.path, "committed.txt"), "agent commit");
    run("git", ["add", "committed.txt"], wt.path);
    run("git", ["commit", "-m", "agent commit"], wt.path);
    const agentCommit = run("git", ["rev-parse", "HEAD"], wt.path);

    const result = cleanupWorktree(repo, wt, "already committed");
    expect(run("git", ["rev-parse", result.ref!], repo)).toBe(agentCommit);
  });

  it("does not overwrite an existing branch", () => {
    const repo = trackRepo(initGitRepo());
    const first = trackWorkspace(createWorktree(repo, "git-conflict", "git"))!;
    writeFileSync(join(first.path, "first.txt"), "first");
    expect(cleanupWorktree(repo, first, "first").ref).toBe("pi-agent-git-conflict");

    const second = trackWorkspace(createWorktree(repo, "git-conflict", "git"))!;
    writeFileSync(join(second.path, "second.txt"), "second");
    const result = cleanupWorktree(repo, second, "second");
    expect(result.ref).toMatch(/^pi-agent-git-conflict-\d+$/);
  });
});

describe.skipIf(!hasJj)("Jujutsu workspace backend", () => {
  it("keeps an idle workspace stable when the caller snapshots new edits", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-stable", "jj"))!;

    writeFileSync(join(repo, "README.md"), "parent changed after spawn");
    run("jj", ["status"], repo);
    run("jj", ["status"], wt.path);

    expect(readFileSync(join(wt.path, "README.md"), "utf-8")).toBe("# Test repo");
    expect(cleanupWorktree(repo, wt, "idle")).toEqual({ hasChanges: false, backend: "jj" });
  }, 15_000);

  it("reports base drift and conflicts when the caller rewrites @-", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-base-drift", "jj"))!;
    writeFileSync(join(wt.path, "README.md"), "agent changed the base file");
    run("jj", ["status"], wt.path);

    writeFileSync(join(repo, "README.md"), "caller changed the base file");
    run("jj", ["squash"], repo);
    run("jj", ["status"], wt.path);

    const result = cleanupWorktree(repo, wt, "conflicting changes");
    expect(result.baseDrifted).toBe(true);
    expect(result.hasConflicts).toBe(true);
    expect(result.refKind).toBe("bookmark");
  }, 15_000);

  it("creates a workspace in a non-colocated jj repository", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-create", "jj"))!;

    expect(wt.backend).toBe("jj");
    expect(wt.workspaceName).toMatch(/^pi-agent-jj-create-/);
    expect(wt.ref).toBe("pi-agent-jj-create");
    expect(wt.workPath).toBe(wt.path);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(jjWorkspaceNames(repo)).toContain(wt.workspaceName);
  });

  it("uses unique paths and workspace names for concurrent agents", () => {
    const repo = trackRepo(initJjRepo());
    const first = trackWorkspace(createWorktree(repo, "jj-concurrent-1", "jj"))!;
    const second = trackWorkspace(createWorktree(repo, "jj-concurrent-2", "jj"))!;

    expect(first.path).not.toBe(second.path);
    expect(first.workspaceName).not.toBe(second.workspaceName);
  }, 15_000);

  it("prefers a nested Git repository over an ancestor jj repository", () => {
    const outer = trackRepo(initJjRepo());
    const inner = initGitRepo(join(outer, "vendor", "inner"));
    const wt = trackWorkspace(createWorktree(inner, "nested-git"))!;

    expect(wt.backend).toBe("git");
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
  });

  it("does not fall through from an uncommitted nested Git repo to its jj ancestor", () => {
    const outer = trackRepo(initJjRepo());
    const inner = join(outer, "vendor", "empty-inner");
    mkdirSync(inner, { recursive: true });
    run("git", ["init"], inner);

    expect(createWorktree(inner, "nested-empty-git")).toBeUndefined();
  });

  it("rejects a fresh jj repository whose code exists only in @", () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-wt-empty-jj-"));
    const repo = trackRepo(join(parent, "repo"));
    run("jj", ["git", "init", "--no-colocate", repo], parent);
    writeFileSync(join(repo, "only-in-working-copy.txt"), "not committed");

    expect(createWorktree(repo, "empty-jj", "jj")).toBeUndefined();
  });

  it("preserves monorepo subdirectory scoping", () => {
    const repo = trackRepo(initJjRepo());
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "packages", "api", "index.ts"), "export {}");
    run("jj", ["describe", "-m", "add package"], repo);
    run("jj", ["new"], repo);

    const wt = trackWorkspace(createWorktree(join(repo, "packages", "api"), "jj-subdir", "jj"))!;
    expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
  }, 15_000);

  it("removes a clean workspace and forgets its registration", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-clean", "jj"))!;
    const name = wt.workspaceName!;

    expect(cleanupWorktree(repo, wt, "clean")).toEqual({ hasChanges: false, backend: "jj" });
    expect(existsSync(wt.path)).toBe(false);
    expect(jjWorkspaceNames(repo)).not.toContain(name);
  });

  it("describes edits and returns a bookmark", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-dirty", "jj"))!;
    writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

    const result = cleanupWorktree(repo, wt, "added new file");
    expect(result).toEqual({
      hasChanges: true,
      backend: "jj",
      ref: "pi-agent-jj-dirty",
      refKind: "bookmark",
    });
    expect(run("jj", ["bookmark", "list", result.ref!], repo)).toContain(result.ref!);
    expect(run("jj", ["log", "-r", result.ref!, "--no-graph", "-T", 'description.first_line() ++ "\\n"'], repo))
      .toBe("pi-agent: added new file");
    expect(run("jj", ["file", "show", "-r", result.ref!, "new-file.txt"], repo)).toBe("agent wrote this");
  }, 15_000);

  it("preserves agent-created commits without bookmarking the new empty working copy", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-committed", "jj"))!;
    writeFileSync(join(wt.path, "committed.txt"), "agent commit");
    run("jj", ["commit", "-m", "agent commit"], wt.path);

    const result = cleanupWorktree(repo, wt, "already committed");
    expect(run("jj", ["log", "-r", result.ref!, "--no-graph", "-T", 'description.first_line() ++ "\\n"'], repo))
      .toBe("agent commit");
    expect(run("jj", ["file", "show", "-r", result.ref!, "committed.txt"], repo)).toBe("agent commit");
  }, 15_000);

  it("does not overwrite an existing bookmark", () => {
    const repo = trackRepo(initJjRepo());
    const first = trackWorkspace(createWorktree(repo, "jj-conflict", "jj"))!;
    writeFileSync(join(first.path, "first.txt"), "first");
    expect(cleanupWorktree(repo, first, "first").ref).toBe("pi-agent-jj-conflict");

    const second = trackWorkspace(createWorktree(repo, "jj-conflict", "jj"))!;
    writeFileSync(join(second.path, "second.txt"), "second");
    const result = cleanupWorktree(repo, second, "second");
    expect(result.ref).toMatch(/^pi-agent-jj-conflict-\d+$/);
  }, 15_000);

  it("retains the workspace when bookmark preservation fails", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-preserve-error", "jj"))!;
    writeFileSync(join(wt.path, "important.txt"), "do not lose");
    run("jj", ["bookmark", "create", wt.ref, "-r", "@-"], repo);
    run("jj", ["bookmark", "create", `${wt.ref}-1234`, "-r", "@-"], repo);
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);

    try {
      const result = cleanupWorktree(repo, wt, "cannot bookmark");
      expect(result.hasChanges).toBe(true);
      expect(result.error).toBeDefined();
      expect(result.path).toBe(wt.path);
      expect(existsSync(wt.path)).toBe(true);
      expect(readFileSync(join(wt.path, "important.txt"), "utf-8")).toBe("do not lose");
    } finally {
      now.mockRestore();
    }
  }, 15_000);

  it("forgets an already-deleted workspace", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-gone", "jj"))!;
    const name = wt.workspaceName!;
    rmSync(wt.path, { recursive: true, force: true });

    expect(cleanupWorktree(repo, wt, "gone")).toEqual({ hasChanges: false, backend: "jj" });
    expect(jjWorkspaceNames(repo)).not.toContain(name);
  });

  it("prunes orphaned plugin workspaces", () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(createWorktree(repo, "jj-orphan", "jj"))!;
    const name = wt.workspaceName!;
    rmSync(wt.path, { recursive: true, force: true });

    pruneWorktrees(repo);
    expect(jjWorkspaceNames(repo)).not.toContain(name);
  });
});

describe("pruneWorktrees", () => {
  it("does not throw outside a repository", () => {
    const dir = trackRepo(mkdtempSync(join(tmpdir(), "pi-wt-nonrepo-")));
    expect(() => pruneWorktrees(dir)).not.toThrow();
  });
});

// Cleanup must never destroy uncertain user work. A failure to classify,
// commit, or preserve a still-present workspace is returned as changed with an
// error and retained path; successful preservation creates the ref before the
// workspace is removed.
describe("cleanupWorktree — failure path", () => {
  let repoDir: string;

  beforeEach(() => { repoDir = initGitRepo(); });
  afterEach(() => {
    try { pruneWorktrees(repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("short-circuits when the worktree directory is already gone", () => {
    // Hits the existsSync guard at the top of cleanupWorktree, not the outer
    // catch — cleanup can be called twice (settle path plus dispose), so it has
    // to be idempotent rather than throw on the second call.
    const wt = createWorktree(repoDir, "vanished")!;
    expect(wt).toBeDefined();
    rmSync(wt.path, { recursive: true, force: true });

    const result = cleanupWorktree(repoDir, wt, "agent that vanished");

    expect(result.hasChanges).toBe(false);
    expect(result.ref).toBeUndefined();
  });

  it("retains a worktree when Git cannot classify its contents", () => {
    const wt = trackWorkspace(createWorktree(repoDir, "corrupt"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    // Break the worktree's link back to the repo.
    writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

    const result = cleanupWorktree(repoDir, wt, "corrupted agent");

    expect(result.hasChanges).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.path).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("creates the branch BEFORE removing the worktree, so a removal failure cannot lose commits", () => {
    // Ordering is the actual safety property. If a refactor moved
    // removeWorktree above the `git branch` call, the commits would be
    // unreachable the moment removal succeeded and branching failed.
    const wt = createWorktree(repoDir, "ordered")!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = cleanupWorktree(repoDir, wt, "ordered agent");

    expect(result.hasChanges).toBe(true);
    expect(result.refKind).toBe("branch");
    expect(result.ref).toBeDefined();
    // The branch must exist in the MAIN repo after the worktree is gone —
    // that is what makes the agent's work recoverable.
    const branches = execFileSync("git", ["branch", "--list", result.ref!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(branches).toContain(result.ref!);
    expect(existsSync(wt.path)).toBe(false);
    // And the commit is reachable from that branch.
    const files = execFileSync("git", ["ls-tree", "--name-only", result.ref!], {
      cwd: repoDir, stdio: "pipe",
    }).toString();
    expect(files).toContain("work.txt");
  });
});

/**
 * The project switch itself (`worktreeIsolation`, #184). Its consumers —
 * agent-manager, both tool schemas, the invocation resolver — all mock this
 * module, so without this block the real singleton is never executed and its
 * default is never exercised. That default is what every "worktree isolation
 * still behaves as before" claim rests on.
 */
describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  // The switch gates callers; it deliberately does not disarm createWorktree
  // itself, so a caller that has already decided (agent-manager checks first)
  // still gets a real worktree rather than a silent no-op.
  it("does not disable createWorktree directly", () => {
    const repoDir = initGitRepo();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = createWorktree(repoDir, "switch-test");
      expect(wt).toBeDefined();
      cleanupWorktree(repoDir, wt!, "switch test");
    } finally {
      pruneWorktrees(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
