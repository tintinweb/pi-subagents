/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { EnvInfo } from "./types.js";

export async function detectEnv(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<EnvInfo> {
  let isGitRepo = false;
  let branch = "";

  try {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000, signal });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch {
    // Not a git repo, git not installed, or aborted — caller checks signal afterwards
  }

  if (isGitRepo) {
    try {
      const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000, signal });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch {
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}
