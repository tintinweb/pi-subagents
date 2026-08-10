import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

interface AgentToolResultMessage {
  isError: boolean;
  details?: { outcome?: { agentId: string; category: string; recovery: string } };
  content: Array<{ type?: string; text?: string }>;
}

function agentResults(session: AgentSession): AgentToolResultMessage[] {
  return session.messages.filter(
    (message): message is AgentSession["messages"][number] & AgentToolResultMessage =>
      message.role === "toolResult" && message.toolName === "Agent",
  );
}

function textOf(result: AgentToolResultMessage): string {
  return result.content.map((block) => block.text ?? "").join("");
}

const FATAL =
  "\u001b[31minvalid request\u001b[0m Authorization: Bearer secret-token " +
  "https://alice:hunter2@example.test/run?api_key=key-123";

describe("Agent lifecycle contract through the real Pi boundary", () => {
  let run: PrintModeRun | undefined;
  let projectDir: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it("marks invocation rejection as isError=true and creates no record", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "invalid model",
          prompt: "Do work.",
          model: "missing/model",
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const [result] = agentResults(run.parentSession);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Model not found");
    expect(run.subagents).toHaveLength(0);
  });

  it("marks fail-closed fallback rejection as isError=true and creates no record", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "subagents-lifecycle-fallback-"));
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify({ fallbackSubagent: false }));
    run = await runPrintMode({
      cwd: projectDir,
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "unknown agent",
          prompt: "Do work.",
          subagent_type: "definitely-missing",
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const [result] = agentResults(run.parentSession);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown or disabled agent type: "definitely-missing"');
    expect(run.subagents).toHaveLength(0);
  });

  it("marks top-level model-scope rejection as isError=true and creates no record", async () => {
    projectDir = mkdtempSync(join(tmpdir(), "subagents-lifecycle-scope-"));
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "subagents.json"), JSON.stringify({ scopeModels: true }));
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["faux/faux-other"] }),
      { mode: 0o600 },
    );
    run = await runPrintMode({
      cwd: projectDir,
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "out-of-scope model",
          prompt: "Do work.",
          model: "faux/faux-1",
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const [result] = agentResults(run.parentSession);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Model not in scope: "faux/faux-1"');
    expect(run.subagents).toHaveLength(0);
  });

  it("marks synchronous startup rejection as isError=true and retains no record", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "startup failure",
          prompt: "Do work.",
          isolation: "worktree",
        }),
        parentFinal: "parent done",
        subagent: "unused",
      }),
    });

    const [result] = agentResults(run.parentSession);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Cannot run with isolation: "worktree"');
    expect(run.subagents).toHaveLength(0);
  });

  it("returns provider failure as a successful tool call with a resumable same-ID outcome", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "provider failure",
          prompt: "Do work.",
        }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    const [result] = agentResults(run.parentSession);
    const text = textOf(result);
    expect(result.isError).toBe(false);
    expect(text).toMatch(/^Agent outcome:/);
    expect(text).toContain("status: error");
    expect(text).toContain("phase: run");
    expect(text).toContain("category: provider");
    expect(text).toContain("retryable: false");
    expect(text).toContain("recovery: resume_same_agent");
    expect(text).toContain("fresh_spawn: forbidden");
    const id = /^\s*agent_id: (\S+)$/m.exec(text)?.[1];
    expect(id).toBeTruthy();
    expect(result.details?.outcome).toEqual(
      expect.objectContaining({ agentId: id, category: "provider", recovery: "resume_same_agent" }),
    );
    expect(text).not.toMatch(/secret-token|alice|hunter2|key-123|\u001b/);
    expect(run.manager?.getRecord(id as string)).toEqual(expect.objectContaining({ id }));
  });

  it("returns a hard max-turn end as a successful same-ID lifecycle outcome", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({
          description: "bounded run",
          prompt: "Do work.",
          max_turns: 1,
        }),
        parentFinal: "parent done",
        subagent: () => fauxToolCall("bash", { command: "true" }),
      }),
      maxModelCalls: 24,
    });

    const [result] = agentResults(run.parentSession);
    const text = textOf(result);
    expect(result.isError).toBe(false);
    expect(text).toContain("status: aborted");
    expect(text).toContain("category: max_turns");
    expect(text).toContain("recovery: resume_same_agent");
    expect(text).toContain("fresh_spawn: forbidden");
    expect(text).toMatch(/^\s*agent_id: \S+$/m);
  });
});
