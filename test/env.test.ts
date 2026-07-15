import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { detectEnv } from "../src/env.js";

/** Minimal mock of pi.exec() that shells out via child_process. */
function mockPi(): ExtensionAPI {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execSync(`${command} ${args.join(" ")}`, {
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
      execSync("git init && git config user.email test@test.com && git config user.name Test && git checkout -b test-branch && git commit --allow-empty -m init", {
        cwd: tmpDir, stdio: "pipe",
      });
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(true);
      expect(env.branch).toBe("test-branch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detects non-git directory", async () => {
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

  it("passes the abort signal through to pi.exec", async () => {
    const execMock = vi.fn(async () => ({ code: 0, stdout: "true", stderr: "", killed: false }));
    const pi = { exec: execMock } as unknown as ExtensionAPI;
    const ac = new AbortController();

    await detectEnv(pi, "/tmp", ac.signal);

    // Both calls should receive the signal in their options
    const revParseCall = execMock.mock.calls[0];
    expect(revParseCall[2]).toMatchObject({ signal: ac.signal });
    const branchCall = execMock.mock.calls[1];
    expect(branchCall[2]).toMatchObject({ signal: ac.signal });
  });

  it("degrades gracefully when exec rejects due to abort", async () => {
    const ac = new AbortController();
    ac.abort();

    const execMock = vi.fn(async (_cmd: string, _args: string[], opts?: { signal?: AbortSignal }) => {
      if (opts?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      return { code: 0, stdout: "true", stderr: "", killed: false };
    });
    const pi = { exec: execMock } as unknown as ExtensionAPI;

    const env = await detectEnv(pi, "/tmp", ac.signal);

    expect(env.isGitRepo).toBe(false);
    expect(env.branch).toBe("");
    expect(env.platform).toBe(process.platform);
  });
});
