/**
 * evicted-resume.test.ts — resuming an agent whose live record is gone.
 *
 * The manager evicts a finished record ten minutes after it settles, and a
 * reload or restart drops it at once, but the agent's conversation is still in
 * its saved pi session. `Agent({ resume })` reopens it from the session's
 * `subagents:record` entry, under the same id; a workflow's `resume` reopens a
 * child from what its host kept for the run (#331, #385).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { agentRecordEntryData, worktreeLost } from "../src/agent-record-entry.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;
let sessionDir: string;
/** The child's saved pi session — a real file, since a reopen checks it exists. */
let sessionFile: string;

beforeEach(() => {
  // No transcripts: they would stream from the stub session's events.
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
  sessionDir = mkdtempSync(join(tmpdir(), "pi-evicted-resume-"));
  sessionFile = join(sessionDir, "child.jsonl");
  writeFileSync(sessionFile, "");
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  rmSync(sessionDir, { recursive: true, force: true });
});

/** A finished run whose session was saved to `file` (or kept in memory, for undefined). */
function settleWith(text: string, file: string | undefined) {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
    const session = {
      dispose: vi.fn(),
      messages: [],
      subscribe: vi.fn(() => () => {}),
      sessionManager: { getSessionFile: () => file },
    } as any;
    options.onSessionCreated?.(session);
    return { responseText: text, session, aborted: false, steered: false };
  });
}

/** Boot the extension with `appendEntry` landing on `branch`, as pi's session does. */
function boot(branch: any[]) {
  const { pi, tools, lifecycle } = makePi();
  pi.appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  subagentsExtension(pi);
  booted = lifecycle;
  const context = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
  const agent = (params: Record<string, unknown>) =>
    tools.get("Agent").execute("tc", { description: "Review the change", subagent_type: "Explore", ...params }, undefined, undefined, context);
  return { agent, lifecycle, manager: (globalThis as any)[MANAGER_KEY] };
}

/**
 * Run an agent to completion in one activation, shut it down, and return its
 * id. `inMemory` keeps its session off disk, as `rememberAgents: false` does.
 */
async function finishedAgent(branch: any[], { inMemory = false } = {}): Promise<string> {
  settleWith("FIRST-RUN", inMemory ? undefined : sessionFile);
  const { agent, lifecycle } = boot(branch);
  const res = await agent({ prompt: "Review the change.", run_in_background: false });
  await lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  return (res as any).details.agentId;
}

describe("Agent({ resume }) once the live record is gone", () => {
  it("reopens the saved session after a reload, under the same id", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    settleWith("RESUMED-RUN", sessionFile);
    const { agent } = boot(branch);
    const res = await agent({ prompt: "Now check the tests.", resume: id, run_in_background: false });

    const [, type, prompt, options] = vi.mocked(runAgent).mock.lastCall!;
    expect(type).toBe("Explore");
    expect(prompt).toBe("Now check the tests.");
    expect(options.resumeSessionFile).toBe(sessionFile);
    expect(options.agentId).toBe(id);
    expect((res as any).details.agentId).toBe(id);
    expect(textOf(res)).toContain("RESUMED-RUN");
  });

  it("reopens in the background and reports the same id", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    settleWith("RESUMED-RUN", sessionFile);
    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id, run_in_background: true });

    expect(textOf(res)).toContain("resumed from its saved session in background");
    expect(textOf(res)).toContain(`Agent ID: ${id}`);
    expect(vi.mocked(runAgent).mock.lastCall![3].resumeSessionFile).toBe(sessionFile);
  });

  it("reopens an agent the ten-minute cleanup evicted in this activation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const branch: any[] = [];
    settleWith("FIRST-RUN", sessionFile);
    const { agent, manager } = boot(branch);
    const id = (await agent({ prompt: "Review the change.", run_in_background: false }) as any).details.agentId;

    vi.advanceTimersByTime(11 * 60_000);
    expect(manager.getRecord(id)).toBeUndefined();

    settleWith("RESUMED-RUN", sessionFile);
    const res = await agent({ prompt: "Continue.", resume: id, run_in_background: false });

    expect(vi.mocked(runAgent).mock.lastCall![3].resumeSessionFile).toBe(sessionFile);
    expect((res as any).details.agentId).toBe(id);
  });

  it("appends to the agent's transcript instead of starting it over", async () => {
    writeFileSync(join(hermetic!.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, outputTranscript: true }));
    const branch: any[] = [];
    settleWith("FIRST-RUN", sessionFile);
    const first = boot(branch);
    const res = await first.agent({ prompt: "Review the change.", run_in_background: false });
    const id = (res as any).details.agentId;
    const transcript = first.manager.getRecord(id).outputFile;
    await first.lifecycle.get("session_shutdown")?.();
    delete (globalThis as any)[MANAGER_KEY];

    settleWith("RESUMED-RUN", sessionFile);
    const { agent } = boot(branch);
    await agent({ prompt: "Continue.", resume: id, run_in_background: false });

    expect(readFileSync(transcript, "utf-8")).toContain("Review the change.");
  });

  it("gives the reopened agent a fresh handle when a live agent took its old one", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    settleWith("OTHER", undefined);
    const { agent, manager } = boot(branch);
    const other = (await agent({ prompt: "Something else.", run_in_background: false }) as any).details.agentId;
    expect(manager.getRecord(other).handle).toBe("explore");

    settleWith("RESUMED-RUN", sessionFile);
    await agent({ prompt: "Continue.", resume: id, run_in_background: false });

    expect(manager.getRecord(id).handle).not.toBe("explore");
  });

  it("stays resumable after a reopen that failed before its session existed", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);

    // The reopen dies before pi hands back a session, so the run never learns
    // which file it was continuing. Its saved record must still name one.
    vi.mocked(runAgent).mockRejectedValueOnce(new Error("provider unavailable"));
    const second = boot(branch);
    await second.agent({ prompt: "Continue.", resume: id, run_in_background: false });
    await second.lifecycle.get("session_shutdown")?.();
    delete (globalThis as any)[MANAGER_KEY];

    settleWith("RESUMED-RUN", sessionFile);
    const { agent } = boot(branch);
    const res = await agent({ prompt: "Try again.", resume: id, run_in_background: false });

    expect(vi.mocked(runAgent).mock.lastCall![3].resumeSessionFile).toBe(sessionFile);
    expect(textOf(res)).toContain("RESUMED-RUN");
  });

  it("refuses, starting nothing, when the saved session file is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    rmSync(sessionFile);

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toBe(`Agent "${id}" cannot be resumed — its session is gone.`);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses, starting nothing, when the agent kept no saved session", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, { inMemory: true });

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toContain(`Agent "${id}" cannot be resumed — its conversation was not saved`);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("refuses, starting nothing, when the agent's work lived in a worktree that is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    branch.at(-1).data.worktreeLost = true;

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id });

    expect(textOf(res)).toBe(`Agent "${id}" cannot be resumed — its worktree no longer exists.`);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("still refuses to combine resume with schedule", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    writeFileSync(join(hermetic!.dir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: true, outputTranscript: false }));

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: id, schedule: "+5m" });

    expect(textOf(res)).toContain("Cannot combine `schedule` with `resume`");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("still reports an id with no saved record as not found", async () => {
    const branch: any[] = [];
    await finishedAgent(branch);

    const { agent } = boot(branch);
    const res = await agent({ prompt: "Continue.", resume: "3f1320a7-74ec-422" });

    expect(textOf(res)).toContain("Agent not found");
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});

describe("worktreeLost", () => {
  const wt = { path: "/wt/a", branch: "pi-agent-a", baseSha: "abc", workPath: "/wt/a" };

  it("is set only when a worktree held the agent's work", () => {
    expect(worktreeLost({})).toBe(false);
    expect(worktreeLost({ worktree: wt, worktreeResult: { hasChanges: false } })).toBe(false);
    expect(worktreeLost({ worktree: wt, worktreeResult: { hasChanges: true, branch: "pi-agent-a" } })).toBe(true);
    // Failed before cleanup reported anything: its edits may be anywhere.
    expect(worktreeLost({ worktree: wt })).toBe(true);
  });

  it("is saved in the record entry only when set", () => {
    const base = { id: "a", type: "Explore", description: "d", status: "completed", startedAt: 0 } as AgentRecord;
    expect(agentRecordEntryData(base)).not.toHaveProperty("worktreeLost", expect.anything());
    expect(agentRecordEntryData({ ...base, worktree: wt, worktreeResult: { hasChanges: true } }).worktreeLost).toBe(true);
  });
});

describe("reclaiming an id", () => {
  it("refuses an id that is still live, rather than replacing its record", async () => {
    settleWith("FIRST-RUN", sessionFile);
    const manager = new AgentManager();
    const { id } = await manager.spawnAndWait({} as any, ctx(), "general-purpose", "go", { description: "first" });

    expect(() =>
      manager.spawn({} as any, ctx(), "general-purpose", "again", { description: "second", reclaim: { id }, resumeSessionFile: sessionFile }),
    ).toThrow(id);
    expect(manager.getRecord(id)?.description).toBe("first");
    manager.dispose();
  });
});

describe("a workflow's resume once the manager evicted the child", () => {
  /** A stub manager whose resume finds nothing live, as after eviction. */
  function evictingManager(file: string | undefined, firstRun: Partial<AgentRecord> = {}) {
    const settled = (overrides: Partial<AgentRecord> = {}) =>
      ({
        id: "child-7",
        type: "general-purpose",
        description: "worker",
        status: "completed",
        result: "done",
        toolUses: 0,
        startedAt: 0,
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0,
        sessionFile: file,
        ...overrides,
      }) as AgentRecord;
    const spawnAndWait = vi.fn(async (_pi: any, _ctx: any, _type: string, _prompt: string, options: any, onSpawned?: (id: string) => void) => {
      const record = settled(options.reclaim ? { result: "fixed" } : firstRun);
      onSpawned?.(record.id);
      return { id: record.id, record };
    });
    const resume = vi.fn(async () => undefined);
    return { manager: { spawnAndWait, resume, abort: vi.fn() } as unknown as AgentManager, spawnAndWait, resume };
  }

  const request = { agentId: "wf-agent-0", index: 0, prompt: "build it", label: "worker", agentType: "general-purpose" };

  it("reopens the child's saved session under the same id, still owned by the run", async () => {
    const stub = evictingManager(sessionFile);
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager, workflowId: "wf-1" });

    await host.spawnAgent(request);
    const resumed = await host.resumeAgent?.("wf-agent-0", "fix the review findings");

    const [, , type, prompt, options] = stub.spawnAndWait.mock.calls[1];
    expect(type).toBe("general-purpose");
    expect(prompt).toBe("fix the review findings");
    expect(options).toMatchObject({ resumeSessionFile: sessionFile, reclaim: { id: "child-7" }, workflowId: "wf-1" });
    expect(resumed).toMatchObject({ ok: true, text: "fixed" });
  });

  const wt = { path: "/wt/c", branch: "pi-agent-c", baseSha: "abc", workPath: "/wt/c" };

  it("refuses, starting nothing, when the child's worktree held its work", async () => {
    const stub = evictingManager(sessionFile, { worktree: wt, worktreeResult: { hasChanges: true, branch: "pi-agent-c" } });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager, workflowId: "wf-1" });

    await host.spawnAgent(request);
    const resumed = await host.resumeAgent?.("wf-agent-0", "fix it");

    expect(resumed).toEqual({ ok: false, error: "Agent child-7 cannot be resumed — its worktree no longer exists." });
    expect(stub.spawnAndWait).toHaveBeenCalledTimes(1);
  });

  it("reopens a child whose worktree was removed clean", async () => {
    const stub = evictingManager(sessionFile, { worktree: wt, worktreeResult: { hasChanges: false } });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager, workflowId: "wf-1" });

    await host.spawnAgent(request);
    const resumed = await host.resumeAgent?.("wf-agent-0", "fix it");

    expect(resumed).toMatchObject({ ok: true, text: "fixed" });
  });

  it("refuses, starting nothing, when the child's session file is gone", async () => {
    const stub = evictingManager(sessionFile);
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request);
    rmSync(sessionFile);
    const resumed = await host.resumeAgent?.("wf-agent-0", "fix it");

    expect(resumed).toEqual({ ok: false, error: "Agent child-7 cannot be resumed — its session is gone." });
    expect(stub.spawnAndWait).toHaveBeenCalledTimes(1);
  });
});
