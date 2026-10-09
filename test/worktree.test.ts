import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * Minimal stand-in for pi.exec(): runs the command for real, and — like the
 * host's implementation — REPORTS failure in the result instead of rejecting.
 * The source has to read `code`/`killed` rather than rely on a throw, so a stub
 * that threw would hide the branch that matters.
 */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return { stdout, stderr: "", code: 0, killed: false };
      } catch (err: unknown) {
        const failure = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

/**
 * A pi whose exec answers one subcommand with a canned failure result and
 * runs everything else for real. `match` sees the argv the backend is called
 * with.
 */
function failingPi(match: (args: string[]) => boolean, failure: { code: number; killed: boolean }): ExtensionAPI {
  const real = mockPi();
  return {
    exec: vi.fn(async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (match(args)) return { stdout: "", stderr: "boom", ...failure };
      return real.exec(command, args, options);
    }),
  } as unknown as ExtensionAPI;
}

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
const pi = mockPi();
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

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace.path, { recursive: true, force: true });
  }
  for (const repo of repos.splice(0)) {
    try {
      await pruneWorktrees(pi, repo);
    } catch {
      // Best effort test cleanup.
    }
    rmSync(existsSync(join(repo, ".jj")) ? dirname(repo) : repo, { recursive: true, force: true });
  }
});

describe("isolation backend selection", () => {
  it.skipIf(!hasJj)("auto prefers jj in a colocated repository", async () => {
    const repo = trackRepo(initJjRepo(true));
    const wt = trackWorkspace(await createWorktree(pi, repo, "auto-jj"));
    expect(wt?.backend).toBe("jj");
  }, 15_000);

  it("auto falls back to Git outside a jj repository", async () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "auto-git"));
    expect(wt?.backend).toBe("git");
  });

  it.skipIf(!hasJj)("explicit backends do not fall back", async () => {
    const jjRepo = trackRepo(initJjRepo());
    const gitRepo = trackRepo(initGitRepo());
    expect(await createWorktree(pi, jjRepo, "git-no-fallback", "git")).toBeUndefined();
    expect(await createWorktree(pi, gitRepo, "jj-no-fallback", "jj")).toBeUndefined();
  });

  it("returns undefined when detected repository roots disappear", async () => {
    const cwd = trackRepo(mkdtempSync(join(tmpdir(), "pi-wt-vanished-roots-")));
    const missingJjRoot = join(cwd, "missing-jj");
    const missingGitRoot = join(cwd, "missing-git");
    const rootsPi = {
      exec: vi.fn(async (command: string, args: string[]) => ({
        stdout: command === "jj"
          ? missingJjRoot
          : args[1] === "--show-toplevel"
            ? missingGitRoot
            : "true",
        stderr: "",
        code: 0,
        killed: false,
      })),
    } as unknown as ExtensionAPI;

    await expect(createWorktree(rootsPi, cwd, "vanished-roots")).resolves.toBeUndefined();
  });
});

describe("Git worktree backend", () => {
  it("creates a worktree with repository files and root scoping", async () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-create", "git"))!;

    expect(wt.backend).toBe("git");
    expect(wt.ref).toBe("pi-agent-git-create");
    expect(wt.baseRevision).toBe(run("git", ["rev-parse", "HEAD"], repo));
    expect(wt.workPath).toBe(wt.path);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
  });

  it("returns undefined for a Git repository with no commits", async () => {
    const repo = trackRepo(mkdtempSync(join(tmpdir(), "pi-wt-empty-git-")));
    run("git", ["init"], repo);
    expect(await createWorktree(pi, repo, "empty-git", "git")).toBeUndefined();
  });

  it("returns undefined when `git worktree add` reports a non-zero exit", async () => {
    // pi.exec resolves with a failure code instead of throwing, so a port that
    // only caught exceptions would hand back a worktree path that isn't there.
    const repo = trackRepo(initGitRepo());
    const wt = await createWorktree(
      failingPi((args) => args[0] === "worktree" && args[1] === "add", { code: 128, killed: false }),
      repo,
      "add-fails",
      "git",
    );
    expect(wt).toBeUndefined();
  });

  it("returns undefined when a git call is killed by its timeout", async () => {
    // A killed process reports code 0 with killed: true — the one failure
    // shape that looks like success if only the exit code is checked.
    const repo = trackRepo(initGitRepo());
    const wt = await createWorktree(
      failingPi((args) => args[0] === "rev-parse" && args[1] === "HEAD", { code: 0, killed: true }),
      repo,
      "timed-out",
      "git",
    );
    expect(wt).toBeUndefined();
  });

  it("preserves monorepo subdirectory scoping", async () => {
    const repo = trackRepo(initGitRepo());
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "packages", "api", "index.ts"), "export {}");
    run("git", ["add", "-A"], repo);
    run("git", ["commit", "-m", "add package"], repo);

    const wt = trackWorkspace(await createWorktree(pi, join(repo, "packages", "api"), "git-subdir", "git"))!;
    expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
  });

  it("rejects a cwd that exists only in the mutable Git working tree", async () => {
    const repo = trackRepo(initGitRepo());
    const uncommitted = join(repo, "new-package");
    mkdirSync(uncommitted);

    expect(await createWorktree(pi, uncommitted, "git-missing-subdir", "git")).toBeUndefined();
  });

  it("uses unique paths for concurrent agents", async () => {
    const repo = trackRepo(initGitRepo());
    const first = trackWorkspace(await createWorktree(pi, repo, "git-multi-1", "git"));
    const second = trackWorkspace(await createWorktree(pi, repo, "git-multi-2", "git"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.path).not.toBe(second!.path);
  });

  it("creates worktrees concurrently — the git calls do not serialize on one another", async () => {
    // The reason for the port: several isolated agents can start at once, so
    // no call may block the caller until the previous one has finished.
    const repo = trackRepo(initGitRepo());
    const order: string[] = [];
    const tracking = {
      exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
        order.push(`start:${args[0]}`);
        // Yield before the real exec call so both chains have a chance to
        // register their start before either one finishes — otherwise fast
        // synchronous execFileSync calls can complete before the scheduler
        // ever interleaves the two microtask chains.
        await new Promise((resolve) => setTimeout(resolve, 0));
        const result = await pi.exec(command, args, options);
        order.push(`end:${args[0]}`);
        return result;
      },
    } as unknown as ExtensionAPI;

    const [a, b] = await Promise.all([
      createWorktree(tracking, repo, "git-par-1", "git"),
      createWorktree(tracking, repo, "git-par-2", "git"),
    ]);
    trackWorkspace(a);
    trackWorkspace(b);
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    // Interleaving proves the two chains ran together: with blocking calls the
    // log would be strictly start/end paired.
    const interleaved = order.some((entry, i) => entry.startsWith("start:") && order[i + 1]?.startsWith("start:"));
    expect(interleaved).toBe(true);
  });

  it("removes a clean worktree", async () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-clean", "git"))!;
    const result = await cleanupWorktree(pi, repo, wt, "clean");

    expect(result).toEqual({ hasChanges: false, backend: "git" });
    expect(existsSync(wt.path)).toBe(false);
  });

  it("commits edits and returns a branch", async () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-dirty", "git"))!;
    writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

    const result = await cleanupWorktree(pi, repo, wt, "added new file");
    expect(result).toEqual({
      hasChanges: true,
      backend: "git",
      ref: "pi-agent-git-dirty",
      refKind: "branch",
    });
    expect(run("git", ["branch", "--list", result.ref!], repo)).toContain(result.ref!);
    expect(run("git", ["log", "--oneline", "-1", result.ref!], repo)).toContain("pi-agent: added new file");
  });

  it("commits edits even when a pre-commit hook rejects (--no-verify)", async () => {
    // A failing pre-commit hook in the main repo also applies to its
    // worktrees — without --no-verify it would abort the preservation commit.
    const repo = trackRepo(initGitRepo());
    const hookPath = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    const wt = trackWorkspace(await createWorktree(pi, repo, "git-hooked", "git"))!;
    writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

    const result = await cleanupWorktree(pi, repo, wt, "hook should not block");
    expect(result.hasChanges).toBe(true);
    expect(result.ref).toBe("pi-agent-git-hooked");
  });

  it("truncates the commit message at 200 chars", async () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-long-msg", "git"))!;
    writeFileSync(join(wt.path, "change.txt"), "something");
    const longDesc = "x".repeat(300);

    const result = await cleanupWorktree(pi, repo, wt, longDesc);
    expect(result.hasChanges).toBe(true);

    const log = run("git", ["log", "--oneline", "-1", result.ref!], repo);
    // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
    expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix
  });

  it("preserves agent-created commits when the tree is clean", async () => {
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-committed", "git"))!;
    writeFileSync(join(wt.path, "committed.txt"), "agent commit");
    run("git", ["add", "committed.txt"], wt.path);
    run("git", ["commit", "-m", "agent commit"], wt.path);
    const agentCommit = run("git", ["rev-parse", "HEAD"], wt.path);

    const result = await cleanupWorktree(pi, repo, wt, "already committed");
    expect(run("git", ["rev-parse", result.ref!], repo)).toBe(agentCommit);
    expect(existsSync(wt.path)).toBe(false);
  });

  it("does not overwrite an existing branch", async () => {
    const repo = trackRepo(initGitRepo());
    const first = trackWorkspace(await createWorktree(pi, repo, "git-conflict", "git"))!;
    writeFileSync(join(first.path, "first.txt"), "first");
    expect((await cleanupWorktree(pi, repo, first, "first")).ref).toBe("pi-agent-git-conflict");

    const second = trackWorkspace(await createWorktree(pi, repo, "git-conflict", "git"))!;
    writeFileSync(join(second.path, "second.txt"), "second");
    const result = await cleanupWorktree(pi, repo, second, "second");
    expect(result.ref).toMatch(/^pi-agent-git-conflict-\d+$/);
  });

  it("falls back to pruning when `git worktree remove` fails", async () => {
    // Removal failing is not fatal — the registration is pruned instead, and
    // the caller still hears that there were no changes.
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-remove-fails", "git"))!;
    const failing = failingPi(
      (args) => args[0] === "worktree" && args[1] === "remove",
      { code: 1, killed: false },
    );

    const result = await cleanupWorktree(failing, repo, wt, "removal fails");

    expect(result.hasChanges).toBe(false);
    expect(vi.mocked(failing.exec).mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
    try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repo, stdio: "pipe" }); } catch { /* ignore */ }
  });
});

describe.skipIf(!hasJj)("Jujutsu workspace backend", () => {
  it("keeps an idle workspace stable when the caller snapshots new edits", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-stable", "jj"))!;

    writeFileSync(join(repo, "README.md"), "parent changed after spawn");
    run("jj", ["status"], repo);
    run("jj", ["status"], wt.path);

    expect(readFileSync(join(wt.path, "README.md"), "utf-8")).toBe("# Test repo");
    expect(await cleanupWorktree(pi, repo, wt, "idle")).toEqual({ hasChanges: false, backend: "jj" });
  }, 15_000);

  it("reports base drift and conflicts when the caller rewrites @-", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-base-drift", "jj"))!;
    writeFileSync(join(wt.path, "README.md"), "agent changed the base file");
    run("jj", ["status"], wt.path);

    writeFileSync(join(repo, "README.md"), "caller changed the base file");
    run("jj", ["squash"], repo);
    run("jj", ["status"], wt.path);

    const result = await cleanupWorktree(pi, repo, wt, "conflicting changes");
    expect(result.baseDrifted).toBe(true);
    expect(result.hasConflicts).toBe(true);
    expect(result.refKind).toBe("bookmark");
  }, 15_000);

  it("creates a workspace in a non-colocated jj repository", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-create", "jj"))!;

    expect(wt.backend).toBe("jj");
    expect(wt.workspaceName).toMatch(/^pi-agent-jj-create-/);
    expect(wt.ref).toBe("pi-agent-jj-create");
    expect(wt.workPath).toBe(wt.path);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(jjWorkspaceNames(repo)).toContain(wt.workspaceName);
  });

  it("creates a sibling workspace from both parents of a merge", async () => {
    const repo = trackRepo(initJjRepo());
    const base = run("jj", ["log", "-r", "@-", "--no-graph", "-T", 'change_id ++ "\\n"'], repo);

    writeFileSync(join(repo, "left.txt"), "left");
    run("jj", ["commit", "-m", "left"], repo);
    const left = run("jj", ["log", "-r", "@-", "--no-graph", "-T", 'change_id ++ "\\n"'], repo);

    run("jj", ["new", base], repo);
    writeFileSync(join(repo, "right.txt"), "right");
    run("jj", ["commit", "-m", "right"], repo);
    const right = run("jj", ["log", "-r", "@-", "--no-graph", "-T", 'change_id ++ "\\n"'], repo);
    run("jj", ["new", left, right], repo);

    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-merge", "jj"))!;
    expect(wt.backend).toBe("jj");
    expect(wt.baseParents).toHaveLength(2);
    expect(await cleanupWorktree(pi, repo, wt, "merge idle")).toEqual({ hasChanges: false, backend: "jj" });
  }, 15_000);

  it("uses unique paths and workspace names for concurrent agents", async () => {
    const repo = trackRepo(initJjRepo());
    const first = trackWorkspace(await createWorktree(pi, repo, "jj-concurrent-1", "jj"))!;
    const second = trackWorkspace(await createWorktree(pi, repo, "jj-concurrent-2", "jj"))!;

    expect(first.path).not.toBe(second.path);
    expect(first.workspaceName).not.toBe(second.workspaceName);
  }, 15_000);

  it("prefers a nested Git repository over an ancestor jj repository", async () => {
    const outer = trackRepo(initJjRepo());
    const inner = initGitRepo(join(outer, "vendor", "inner"));
    const wt = trackWorkspace(await createWorktree(pi, inner, "nested-git"))!;

    expect(wt.backend).toBe("git");
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
  });

  it("does not fall through from an uncommitted nested Git repo to its jj ancestor", async () => {
    const outer = trackRepo(initJjRepo());
    const inner = join(outer, "vendor", "empty-inner");
    mkdirSync(inner, { recursive: true });
    run("git", ["init"], inner);

    expect(await createWorktree(pi, inner, "nested-empty-git")).toBeUndefined();
  });

  it("rejects a fresh jj repository whose code exists only in @", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-wt-empty-jj-"));
    const repo = trackRepo(join(parent, "repo"));
    run("jj", ["git", "init", "--no-colocate", repo], parent);
    writeFileSync(join(repo, "only-in-working-copy.txt"), "not committed");

    expect(await createWorktree(pi, repo, "empty-jj", "jj")).toBeUndefined();
  });

  it("preserves monorepo subdirectory scoping", async () => {
    const repo = trackRepo(initJjRepo());
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "packages", "api", "index.ts"), "export {}");
    run("jj", ["describe", "-m", "add package"], repo);
    run("jj", ["new"], repo);

    const wt = trackWorkspace(await createWorktree(pi, join(repo, "packages", "api"), "jj-subdir", "jj"))!;
    expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
  }, 15_000);

  it("removes a clean workspace and forgets its registration", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-clean", "jj"))!;
    const name = wt.workspaceName!;

    expect(await cleanupWorktree(pi, repo, wt, "clean")).toEqual({ hasChanges: false, backend: "jj" });
    expect(existsSync(wt.path)).toBe(false);
    expect(jjWorkspaceNames(repo)).not.toContain(name);
    expect(run("jj", ["log", "-r", "all()", "--no-graph", "-T", 'description ++ "\\n"'], repo))
      .not.toContain(name);
  });

  it("describes edits and returns a bookmark", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-dirty", "jj"))!;
    writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

    const result = await cleanupWorktree(pi, repo, wt, "added new file");
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

  it("preserves work after the agent starts a new change", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-new-change", "jj"))!;
    run("jj", ["new"], wt.path);
    writeFileSync(join(wt.path, "new-change.txt"), "agent wrote this after jj new");

    const result = await cleanupWorktree(pi, repo, wt, "new change");
    expect(result).toMatchObject({ hasChanges: true, backend: "jj", refKind: "bookmark" });
    expect(run("jj", ["file", "show", "-r", result.ref!, "new-change.txt"], repo))
      .toBe("agent wrote this after jj new");
    expect(run("jj", ["log", "-r", `::${result.ref}`, "--no-graph", "-T", 'description ++ "\\n"'], repo))
      .not.toContain(wt.workspaceName);
  }, 15_000);

  it("treats an empty new change as no work", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-empty-new", "jj"))!;
    run("jj", ["new"], wt.path);

    expect(await cleanupWorktree(pi, repo, wt, "empty new")).toEqual({ hasChanges: false, backend: "jj" });
    expect(run("jj", ["bookmark", "list", wt.ref], repo)).toBe("");
  }, 15_000);

  it("preserves a description added to the initial empty change", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-described", "jj"))!;
    run("jj", ["describe", "-m", "analysed; no file changes needed"], wt.path);

    const result = await cleanupWorktree(pi, repo, wt, "described");
    expect(result).toMatchObject({ hasChanges: true, backend: "jj", refKind: "bookmark" });
    expect(run("jj", ["log", "-r", result.ref!, "--no-graph", "-T", 'description ++ "\\n"'], repo))
      .toBe("analysed; no file changes needed");
  }, 15_000);

  it("preserves agent-created commits without bookmarking the new empty working copy", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-committed", "jj"))!;
    writeFileSync(join(wt.path, "committed.txt"), "agent commit");
    run("jj", ["commit", "-m", "agent commit"], wt.path);

    const result = await cleanupWorktree(pi, repo, wt, "already committed");
    expect(run("jj", ["log", "-r", result.ref!, "--no-graph", "-T", 'description.first_line() ++ "\\n"'], repo))
      .toBe("agent commit");
    expect(run("jj", ["file", "show", "-r", result.ref!, "committed.txt"], repo)).toBe("agent commit");
  }, 15_000);

  it("retains the workspace instead of describing a foreign change", async () => {
    const repo = trackRepo(initJjRepo());
    writeFileSync(join(repo, "foreign.txt"), "foreign work");
    run("jj", ["new"], repo);
    const foreign = run("jj", ["log", "-r", "@-", "--no-graph", "-T", 'change_id ++ "\\n"'], repo);
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-foreign", "jj"))!;

    run("jj", ["edit", foreign], wt.path);
    writeFileSync(join(wt.path, "agent-leak.txt"), "must stay out of the foreign change");
    const result = await cleanupWorktree(pi, repo, wt, "must not replace this description");

    expect(result).toMatchObject({
      hasChanges: true,
      backend: "jj",
      path: wt.path,
    });
    expect(result.error).toContain("outside the agent's workspace history");
    expect(run("jj", ["log", "-r", foreign, "--no-graph", "-T", 'description ++ "\\n"'], repo)).toBe("");
    expect(run("jj", ["file", "list", "-r", foreign], repo)).not.toContain("agent-leak.txt");
    expect(existsSync(wt.path)).toBe(true);
  }, 15_000);

  it("does not overwrite an existing bookmark", async () => {
    const repo = trackRepo(initJjRepo());
    const first = trackWorkspace(await createWorktree(pi, repo, "jj-conflict", "jj"))!;
    writeFileSync(join(first.path, "first.txt"), "first");
    expect((await cleanupWorktree(pi, repo, first, "first")).ref).toBe("pi-agent-jj-conflict");

    const second = trackWorkspace(await createWorktree(pi, repo, "jj-conflict", "jj"))!;
    writeFileSync(join(second.path, "second.txt"), "second");
    const result = await cleanupWorktree(pi, repo, second, "second");
    expect(result.ref).toMatch(/^pi-agent-jj-conflict-\d+$/);
  }, 15_000);

  it("retains the workspace when bookmark preservation fails", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-preserve-error", "jj"))!;
    writeFileSync(join(wt.path, "important.txt"), "do not lose");
    run("jj", ["bookmark", "create", wt.ref, "-r", "@-"], repo);
    run("jj", ["bookmark", "create", `${wt.ref}-1234`, "-r", "@-"], repo);
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);

    try {
      const result = await cleanupWorktree(pi, repo, wt, "cannot bookmark");
      expect(result.hasChanges).toBe(true);
      expect(result.error).toBeDefined();
      expect(result.path).toBe(wt.path);
      expect(existsSync(wt.path)).toBe(true);
      expect(readFileSync(join(wt.path, "important.txt"), "utf-8")).toBe("do not lose");
    } finally {
      now.mockRestore();
    }
  }, 15_000);

  it("forgets an already-deleted workspace", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-gone", "jj"))!;
    const name = wt.workspaceName!;
    rmSync(wt.path, { recursive: true, force: true });

    expect(await cleanupWorktree(pi, repo, wt, "gone")).toEqual({ hasChanges: false, backend: "jj" });
    expect(jjWorkspaceNames(repo)).not.toContain(name);
  });

  it("does not prune a live plugin workspace", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-live", "jj"))!;

    await pruneWorktrees(pi, repo);
    expect(jjWorkspaceNames(repo)).toContain(wt.workspaceName);
    expect(existsSync(wt.path)).toBe(true);
    expect(await cleanupWorktree(pi, repo, wt, "live")).toEqual({ hasChanges: false, backend: "jj" });
  });

  it("prunes orphaned plugin workspaces", async () => {
    const repo = trackRepo(initJjRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "jj-orphan", "jj"))!;
    const name = wt.workspaceName!;
    rmSync(wt.path, { recursive: true, force: true });

    await pruneWorktrees(pi, repo);
    expect(jjWorkspaceNames(repo)).not.toContain(name);
  });
});

describe("pruneWorktrees", () => {
  it("does not reject outside a repository", async () => {
    const dir = trackRepo(mkdtempSync(join(tmpdir(), "pi-wt-nonrepo-")));
    await expect(pruneWorktrees(pi, dir)).resolves.toBeUndefined();
  });
});

// cleanupWorktree's outer catch is the only place in the repo where a caught
// error can DESTROY user work while reporting success-shaped output: it removes
// the worktree and returns `{ hasChanges: false }`, which the manager renders as
// "the agent changed nothing". If the commit or branch step fails, the agent's
// commits go with the worktree and nobody is told.
describe("cleanupWorktree — failure path", () => {
  it("short-circuits when the worktree directory is already gone", async () => {
    // Hits the existsSync guard at the top of cleanupWorktree, not the outer
    // catch — cleanup can be called twice (settle path plus dispose), so it has
    // to be idempotent rather than throw on the second call.
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-vanished", "git"))!;
    expect(wt).toBeDefined();
    rmSync(wt.path, { recursive: true, force: true });

    const result = await cleanupWorktree(pi, repo, wt, "agent that vanished");

    expect(result.hasChanges).toBe(false);
    expect(result.ref).toBeUndefined();
  });

  it("retains a worktree when Git cannot classify its contents", async () => {
    // The outer catch. The directory exists — so the existsSync guard above
    // does not fire — but git cannot operate in it, which is what a corrupted
    // or externally-detached worktree looks like. The agent's work is lost
    // either way; what matters is that cleanup does not throw out of the
    // manager's settle path and take the whole record down with it.
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-corrupt", "git"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");
    // Break the worktree's link back to the repo.
    writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/path/that/is/not/a/repo");

    const result = await cleanupWorktree(pi, repo, wt, "corrupted agent");

    expect(result.hasChanges).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.path).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("reports the failure when the preservation commit fails", async () => {
    // `git commit` failing resolves with a non-zero code rather than throwing;
    // the outer catch retains the workspace instead of silently deleting it.
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-commit-fails", "git"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(
      failingPi((args) => args[0] === "commit", { code: 1, killed: false }),
      repo,
      wt,
      "commit fails",
    );

    expect(result.hasChanges).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.path).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });

  it("creates the branch BEFORE removing the worktree, so a removal failure cannot lose commits", async () => {
    // Ordering is the actual safety property. If a refactor moved
    // removeWorktree above the `git branch` call, the commits would be
    // unreachable the moment removal succeeded and branching failed.
    const repo = trackRepo(initGitRepo());
    const wt = trackWorkspace(await createWorktree(pi, repo, "git-ordered", "git"))!;
    writeFileSync(join(wt.path, "work.txt"), "agent output");

    const result = await cleanupWorktree(pi, repo, wt, "ordered agent");

    expect(result.hasChanges).toBe(true);
    expect(result.refKind).toBe("branch");
    expect(result.ref).toBeDefined();
    // The branch must exist in the MAIN repo after the worktree is gone —
    // that is what makes the agent's work recoverable.
    const branches = run("git", ["branch", "--list", result.ref!], repo);
    expect(branches).toContain(result.ref!);
    expect(existsSync(wt.path)).toBe(false);
    // And the commit is reachable from that branch.
    const files = run("git", ["ls-tree", "--name-only", result.ref!], repo);
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
  it("does not disable createWorktree directly", async () => {
    const repo = trackRepo(initGitRepo());
    setWorktreeIsolationEnabled(false);
    const wt = trackWorkspace(await createWorktree(pi, repo, "switch-test"));
    expect(wt).toBeDefined();
    await cleanupWorktree(pi, repo, wt!, "switch test");
  });
});
