/**
 * Regression for issue #179: immediate Agent startup failures must remain
 * failed tool results at the parent Pi session protocol boundary.
 *
 * This drives the real registered Agent tool through the real print-mode host
 * from a temporary non-Git cwd. Worktree isolation therefore fails before a
 * child session can start, which exercises the synchronous startup catch.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type PrintModeRun, routeBySession, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const STARTUP_ERROR_FRAGMENT = 'Cannot run with isolation: "worktree"';

type AgentToolResult = {
  isError?: boolean;
  content: Array<{ type?: string; text?: string }>;
};

function latestAgentToolResult(session: AgentSession): AgentToolResult {
  const message = [...session.messages].reverse().find(
    (entry) => entry.role === "toolResult" && (entry as { toolName?: string }).toolName === "Agent",
  );
  if (!message) throw new Error("parent session has no Agent tool result");
  return message as AgentToolResult;
}

describe("issue #179 — Agent startup failures preserve tool error status", () => {
  let run: PrintModeRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it.each([
    ["foreground", false],
    ["immediate background", true],
  ])("reports a %s worktree startup failure as an error tool result", async (_mode, runInBackground) => {
    run = await runPrintMode({
      // The default runner cwd is a fresh temporary directory, deliberately
      // not a Git repository, so isolation startup fails synchronously.
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "startup failure",
          prompt: "Do work.",
          isolation: "worktree",
          run_in_background: runInBackground,
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const result = latestAgentToolResult(run.parentSession);
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => block.text ?? "").join("");
    expect(text).toContain(STARTUP_ERROR_FRAGMENT);
    // Non-Git cwd: one safe corrective path — retry once without isolation.
    // Do not suggest initializing/committing solely to enable worktree isolation.
    expect(text.toLowerCase()).toMatch(/retry the agent call once without/);
    expect(text.toLowerCase()).toMatch(/without [`']?isolation[`']?/);
    expect(text).not.toMatch(/Initialize git and commit at least once/);
    expect(text.toLowerCase()).not.toMatch(/initialize git|git init|commit at least once/);
  });
});
