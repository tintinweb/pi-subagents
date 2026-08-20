import { execFileSync, execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { detectEnv } from "../src/env.js";

const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;

/** Minimal mock of pi.exec() backed by child_process argv execution. */
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
      } catch (err: any) {
        return { stdout: "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
      }
    },
  } as unknown as ExtensionAPI;
}

describe("detectEnv", () => {
  it("detects git repo in current project", async () => {
    const env = await detectEnv(mockPi(), process.cwd());
    expect(env.isGitRepo).toBe(true);
    expect(env.platform).toBe(process.platform);
  });

  it("returns branch name when on a branch", async () => {
    // Create a temp repo on a known branch to test branch detection
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-branch-"));
    try {
      execSync("git init && git config user.email test@test.com && git config user.name Test && git config commit.gpgsign false && git checkout -b test-branch && git commit --allow-empty -m init", {
        cwd: tmpDir, stdio: "pipe",
      });
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(true);
      expect(env.vcs).toBe("git");
      expect(env.branch).toBe("test-branch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJj)("detects a non-colocated jj repository", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-env-jj-test-"));
    const repo = join(parent, "repo");
    try {
      execFileSync("jj", ["git", "init", "--no-colocate", repo], { stdio: "pipe" });
      const env = await detectEnv(mockPi(), repo);
      expect(env.vcs).toBe("jj");
      expect(env.isGitRepo).toBe(false);
      expect(env.change).toBeTruthy();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("detects non-version-controlled directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-test-"));
    try {
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(false);
      expect(env.branch).toBe("");
      expect(env.platform).toBe(process.platform);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
