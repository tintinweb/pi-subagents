/**
 * clear-completed-wiring.test.ts — reproduces issue #108 end-to-end through the
 * REAL session lifecycle handlers + the REAL get_subagent_result tool.
 *
 * Bug: a background agent that has COMPLETED but whose result the LLM hasn't read
 * yet (resultConsumed=false) was wiped by clearCompleted() on session_start /
 * session_before_switch, so the next get_subagent_result returned "Agent not
 * found". The fix makes both handlers call clearCompleted(true), preserving
 * unread records (the 10-minute timer evicts them later).
 *
 * These tests exercise the wiring, not the manager method in isolation: spawn a
 * real background agent, let it complete, fire the real session event, then read
 * it back through the real tool — the exact path the reporter hit.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_before_switch, session_shutdown
  const events = new Map<string, any>(); // pi.events.on(...) — subagents:rpc:*, etc.
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        events.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, events };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;
// Let runAgent's resolved .then() chain settle so the record reaches "completed".
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

// Spawn a real background agent and drive it to status "completed" with
// resultConsumed=false (only get_subagent_result sets that flag for background).
async function spawnCompletedBackgroundAgent(tools: Map<string, any>): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  });
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "Review monero_en.rs in depth", subagent_type: "general-purpose", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  await flush();
  return id as string;
}

describe("issue #108: unread completed background agents survive session events", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem — isolates the clearCompleted path.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-108-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-108-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("session_before_switch (user switches sessions) does NOT wipe the unread result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    // The exact #108 trigger: a session switch fires before the LLM read the result.
    await lifecycle.get("session_before_switch")?.();

    const res = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(res);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("session_start (/resume) does NOT wipe the unread result", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    await lifecycle.get("session_start")?.({}, ctx());

    const res = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(res);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("once read, a session switch DOES evict it — the fix stays surgical, no leak", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const id = await spawnCompletedBackgroundAgent(tools);

    // LLM reads the result → resultConsumed=true.
    const first = await tools.get("get_subagent_result").execute("tc-read1", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(first)).toContain("THE-RESULT-PAYLOAD");

    // Now a session switch SHOULD clean it up (consumed records are not preserved).
    await lifecycle.get("session_before_switch")?.();

    const second = await tools.get("get_subagent_result").execute("tc-read2", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(second)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
