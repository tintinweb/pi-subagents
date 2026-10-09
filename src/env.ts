/**
 * env.ts — Detect repository and platform information for subagent prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EnvInfo } from "./types.js";

export async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  let isJjRepo = false;
  let change = "";
  let isGitRepo = false;
  let branch = "";

  try {
    const result = await pi.exec("jj", ["root", "--ignore-working-copy"], { cwd, timeout: 5000 });
    isJjRepo = result.code === 0;
  } catch {
    // Not a jj repo or jj not installed.
  }

  if (isJjRepo) {
    try {
      const result = await pi.exec(
        "jj",
        [
          "log",
          "--ignore-working-copy",
          "-r",
          "@",
          "--no-graph",
          "-T",
          'change_id.short() ++ " " ++ description.first_line() ++ "\\n"',
        ],
        { cwd, timeout: 5000 },
      );
      change = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch {
      change = "unknown";
    }
  }

  try {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 });
    isGitRepo = result.code === 0 && result.stdout.trim() === "true";
  } catch {
    // Not a Git repo or Git not installed.
  }

  if (isGitRepo) {
    try {
      const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000 });
      branch = result.code === 0 ? result.stdout.trim() : "unknown";
    } catch {
      branch = "unknown";
    }
  }

  return {
    isGitRepo,
    branch,
    vcs: isJjRepo ? "jj" : isGitRepo ? "git" : undefined,
    change,
    platform: process.platform,
  };
}
