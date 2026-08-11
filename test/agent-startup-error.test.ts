/**
 * agent-startup-error.test.ts — a spawn that never starts must fail the tool
 * call, not return a message (#179).
 *
 * The assertion is `rejects`, and that is the whole point: pi marks a tool
 * result failed only when `execute` throws (`isError` on a returned result is
 * discarded), so a returned diagnostic reaches the parent model as a subagent
 * that ran and reported this — and the model retries the same doomed call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return { ...actual, createWorktree: vi.fn(() => undefined) };
});

import subagentsExtension from "../src/index.js";

function boot() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return tools;
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("Agent startup failures fail the tool call (#179)", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "startup-error-"));
    process.chdir(cwd);
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  for (const background of [false, true]) {
    it(`rejects instead of returning the diagnostic (run_in_background: ${background})`, async () => {
      const tools = boot();

      await expect(
        tools.get("Agent").execute(
          "tc-1",
          {
            prompt: "do it",
            description: "worktree probe",
            subagent_type: "general-purpose",
            isolation: "worktree",
            run_in_background: background,
          },
          undefined, undefined, ctx(),
        ),
      ).rejects.toThrow('Cannot run with isolation: "worktree"');
    });
  }
});
