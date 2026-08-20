/**
 * worktree-isolation-e2e.test.ts — `isolation: "worktree"` through the real
 * stack: a real git repo, a real pi-mono session, the real extension, real
 * `createWorktree`/`cleanupWorktree`, on a faux model.
 *
 * Coverage sat on either side of this seam and never joined it.
 * test/worktree.test.ts drives real git but calls createWorktree/cleanupWorktree
 * directly, with no agent anywhere. test/agent-manager.test.ts (and -gc, and
 * agent-startup-error) mock ../src/worktree.js entirely and assert only the gate
 * and the fail-loud throw. So the chain the feature actually promises was never
 * pinned end to end: spawn → the child's cwd IS the copy → its edits stay out of
 * the main checkout → cleanup commits them to a branch the result names → the
 * copy is gone. Every link was tested; the chain was not.
 *
 * Deliberately faux, not live: a live model may decline to spawn at all, which
 * would look like a pass. Each run pins `live: false` rather than trusting the
 * env var to leave it alone — the pre-publish smoke sets PI_E2E_LIVE globally.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";
import { agentCall, type FauxReply, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

/** The child creates this in whatever cwd it was actually given. */
const MARKER_FILE = "agent-work.txt";
/** Emitted by the child once its edit has landed. */
const CHILD_MARKER = "CHILD-EDITED-ITS-TREE";
const CHILD_PROMPT = "Create the marker file.";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10_000 }).toString().trim();
}

/** A real repo with one commit — `git worktree add` needs a HEAD to branch from. */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-iso-e2e-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Test repo");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
  return dir;
}

function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

function toolResultNames(context: Context): string[] {
  return context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => (m as { toolName?: string }).toolName ?? "");
}

/** Every Agent tool result the parent session received, concatenated. */
function agentResultText(session: Context): string {
  return session.messages
    .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent")
    .flatMap((m) => ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? ""))
    .join("\n");
}

/**
 * One responder for both sessions, split on the first user message.
 *
 * The child writes through the REAL bash tool rather than having the test touch
 * the filesystem for it: the whole question is which directory the agent's own
 * tools resolve against, and writing the file from the test would answer it by
 * assumption.
 */
function respondSpawning(isolation: "worktree" | undefined): (context: Context) => FauxReply {
  return (context: Context): FauxReply => {
    if (firstUserText(context).includes(CHILD_PROMPT)) {
      if (!toolResultNames(context).includes("bash")) {
        return fauxToolCall("bash", { command: `echo isolated > ${MARKER_FILE}` });
      }
      return CHILD_MARKER;
    }
    // Parent: spawn once, then echo the tool result so a lost one fails loudly.
    if (toolResultNames(context).includes("Agent")) {
      return `parent saw: ${agentResultText(context)}`;
    }
    return agentCall({
      // Foreground: this test reads the child's marker out of the parent's
      // inline Agent tool result, which a background spawn replaces with a
      // "started in background" receipt.
      run_in_background: false,
      description: "worktree work",
      prompt: CHILD_PROMPT,
      ...(isolation ? { isolation } : {}),
    });
  };
}

describe("worktree isolation e2e (real git, real pi-mono, faux model)", () => {
  let run: PrintModeRun | undefined;
  const repos: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    // Module-level switch: applySettings only applies keys that are PRESENT, so
    // a later run without the key would otherwise inherit whatever this one set.
    setWorktreeIsolationEnabled(true);
    for (const dir of repos.splice(0)) {
      try { git(dir, "worktree", "prune"); } catch { /* repo may be gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the child in the copy and lands its changes on a branch, not the main checkout", async () => {
    const repo = initGitRepo();
    repos.push(repo);

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd: repo,
      respond: respondSpawning("worktree"),
      live: false,
    });

    // The child's own tools resolved against the copy — the main checkout never
    // saw the file. This is the guarantee; everything below is its bookkeeping.
    expect(existsSync(join(repo, MARKER_FILE))).toBe(false);

    const result = agentResultText(run.parentSession);
    expect(result).toContain(CHILD_MARKER);

    // The result names a branch and the command to merge it — the only artifact,
    // since the worktree directory does not survive.
    const branch = /Changes saved to branch `(pi-agent-[^`]+)`/.exec(result)?.[1];
    expect(branch).toBeTruthy();
    expect(result).toContain(`git merge ${branch}`);

    // That branch exists in the MAIN repo and carries the child's file.
    expect(git(repo, "branch", "--list", branch!)).toContain(branch!);
    expect(git(repo, "ls-tree", "--name-only", branch!)).toContain(MARKER_FILE);

    // And the copy is gone: `git worktree list` is down to the main checkout.
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("downgrades to the main checkout when the project set worktreeIsolation: false", async () => {
    const repo = initGitRepo();
    repos.push(repo);
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".pi", "subagents.json"), JSON.stringify({ worktreeIsolation: false }));

    // The caller passes `isolation: "worktree"` even though the setting drops
    // the parameter from the schema — exactly what a model holding a cached tool
    // spec does, and the case the downgrade (rather than a throw) exists for.
    //
    // Mutation note: the resolver gate (invocation-config) and the manager gate
    // (agent-manager) are redundant on THIS path, so removing either one alone
    // leaves this test green — verified, not assumed. That is the point of the
    // second gate, which exists for cross-extension RPC, where options skip the
    // resolver entirely. This test pins the behaviour and goes red when both are
    // gone; each gate is pinned individually by its own unit test.
    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd: repo,
      respond: respondSpawning("worktree"),
      live: false,
    });

    const result = agentResultText(run.parentSession);
    expect(result).toContain(CHILD_MARKER);

    // Ran in the main checkout: the file is right there, and no branch was made.
    expect(existsSync(join(repo, MARKER_FILE))).toBe(true);
    expect(git(repo, "branch", "--list", "pi-agent-*")).toBe("");
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);

    // Silent by design — no per-result note, which is why the tool description
    // drops the isolation bullet alongside the parameter (see index.ts).
    expect(result).not.toContain("Changes saved to branch");
  });
});
