/**
 * lost-agents.test.ts — telling the model about background agents a previous
 * session lost.
 *
 * A top-level background agent writes a `running` record once its session
 * exists. If the process dies before the agent settles, or the session shuts
 * down while it runs, the next session finds that record (or the shutdown's
 * `stopped` + `session_end` one) and reports the agent once, as a `stopped`
 * task notification delivered with the next user turn — what Claude Code does
 * on a plain local resume. Nothing is resumed automatically; the notice says
 * how, and `Agent({ resume })` reopens the saved session under the same id.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE, findLostAgentEntries } from "../src/agent-record-entry.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;
let sessionDir: string;
/** The child's saved pi session — a real file, since a reopen checks it exists. */
let sessionFile: string;

beforeEach(() => {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false } });
  sessionDir = mkdtempSync(join(tmpdir(), "pi-lost-agents-"));
  sessionFile = join(sessionDir, "child.jsonl");
  writeFileSync(sessionFile, "");
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  rmSync(sessionDir, { recursive: true, force: true });
});

function stubSession(file: string | undefined) {
  return { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => () => {}), sessionManager: { getSessionFile: () => file } } as any;
}

/** A run that creates its session and then works until it is aborted. */
function runUntilAborted(file: string | undefined) {
  vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
    const session = stubSession(file);
    options.onSessionCreated?.(session);
    return new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => resolve({ responseText: "", session, aborted: true, steered: false }));
    });
  });
}

/** A run that finishes at once. */
function settleWith(text: string, file: string | undefined) {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
    const session = stubSession(file);
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
    tools.get("Agent").execute("tc", { description: "Audit the parser", subagent_type: "Explore", ...params }, undefined, undefined, context);
  const start = () => lifecycle.get("session_start")?.({ type: "session_start", reason: "resume" }, context);
  return { pi, tools, lifecycle, context, agent, start };
}

/** The process dies: no shutdown, no settle. */
function crash() {
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
}

const records = (branch: any[]) => branch.filter((e) => e.customType === AGENT_RECORD_ENTRY_TYPE).map((e) => e.data);
/** The lost-agent notices sent on session_start, as `[message, options]`. */
const lostNotices = (pi: any) =>
  pi.sendMessage.mock.calls.filter(([m]: any[]) => m.customType === "subagent-notification" && String(m.content).includes("previous session ended"));

/** Start a background agent in a first activation and return its id. */
async function startBackground(branch: any[], file: string | undefined = sessionFile) {
  runUntilAborted(file);
  const first = boot(branch);
  const res = await first.agent({ prompt: "Audit the parser.", run_in_background: true });
  return { id: (res as any).details.agentId as string, first };
}

describe("a background agent the previous session lost", () => {
  it("leaves a running record once its session exists", async () => {
    const branch: any[] = [];
    const { id } = await startBackground(branch);

    expect(records(branch)).toEqual([expect.objectContaining({ id, status: "running", sessionFile })]);
  });

  it("is reported after a crash, once, with the next user turn", async () => {
    const branch: any[] = [];
    const { id } = await startBackground(branch);
    crash();

    const second = boot(branch);
    await second.start();

    const notices = lostNotices(second.pi);
    expect(notices).toHaveLength(1);
    const [message, options] = notices[0];
    expect(options).toEqual({ deliverAs: "nextTurn" });
    expect(message.content).toContain(`<task-id>${id}</task-id>`);
    expect(message.content).toContain("<status>stopped</status>");
    expect(message.content).toContain(`Background agent "Audit the parser" didn't finish before the previous session ended`);
    expect(message.content).toContain("Resume it by calling the Agent tool with `resume` set to its id");
    expect(message.details).toMatchObject({ id, status: "stopped" });
    expect(records(branch).at(-1)).toMatchObject({ id, status: "stopped", stopReason: "session_end", lostNoticeSent: true });
  });

  it("is reported after the session shut down while it ran", async () => {
    const branch: any[] = [];
    const { id, first } = await startBackground(branch);
    await first.lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    delete (globalThis as any)[MANAGER_KEY];
    booted = undefined;
    // The stop reached the session here; it must still read as lost, not as the user's.
    expect(records(branch).at(-1)).toMatchObject({ id, status: "stopped", stopReason: "session_end" });

    const second = boot(branch);
    await second.start();

    expect(lostNotices(second.pi)).toHaveLength(1);
    expect(lostNotices(second.pi)[0][0].content).toContain(`<task-id>${id}</task-id>`);
  });

  it("is not reported again when the session is reopened a second time", async () => {
    const branch: any[] = [];
    await startBackground(branch);
    crash();
    const second = boot(branch);
    await second.start();
    crash();

    const third = boot(branch);
    await third.start();

    expect(lostNotices(third.pi)).toHaveLength(0);
  });

  it("says it cannot be resumed when its session file is gone", async () => {
    const branch: any[] = [];
    await startBackground(branch);
    crash();
    rmSync(sessionFile);

    const second = boot(branch);
    await second.start();

    const [message] = lostNotices(second.pi)[0];
    expect(message.content).toContain("It cannot be resumed — its session is gone.");
    expect(message.content).not.toContain("Resume it by calling");
  });

  it("can be reopened with Agent({ resume }) under the same id", async () => {
    const branch: any[] = [];
    const { id } = await startBackground(branch);
    crash();
    const second = boot(branch);
    await second.start();

    settleWith("PICKED UP WHERE IT STOPPED", sessionFile);
    const res = await second.agent({ prompt: "Status report, then continue.", resume: id, run_in_background: false });

    const options = vi.mocked(runAgent).mock.lastCall![3];
    expect(options.resumeSessionFile).toBe(sessionFile);
    expect(options.agentId).toBe(id);
    expect(textOf(res)).toContain("PICKED UP WHERE IT STOPPED");
  });

  it("reads as stopped by the session ending in get_subagent_result, not as running", async () => {
    const branch: any[] = [];
    const { id } = await startBackground(branch);
    crash();

    const second = boot(branch);
    const out = textOf(
      await second.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, second.context),
    );

    expect(out).toContain("Status: stopped (stopped when the previous session ended");
    expect(out).not.toContain("STOPPED BY THE USER");
    expect(out).not.toContain("(running)");
  });

  it("is summed up in one notice when more than 20 were lost", async () => {
    const branch: any[] = Array.from({ length: 21 }, (_, i) => ({
      type: "custom",
      customType: AGENT_RECORD_ENTRY_TYPE,
      data: { id: `agent-${i}`, type: "Explore", description: `task ${i}`, status: "running", startedAt: 0 },
    }));

    const session = boot(branch);
    await session.start();

    const notices = lostNotices(session.pi);
    expect(notices).toHaveLength(1);
    expect(notices[0][0].content).toContain("21 background agents didn't finish before the previous session ended");
    expect(notices[0][0].content).toContain("agent-20: task 20");
    expect(notices[0][0].content).not.toContain("<task-id>");
  });

  it("does not carry a resumed agent's previous run into its running record", async () => {
    const branch: any[] = [];
    settleWith("FIRST ANSWER", sessionFile);
    const first = boot(branch);
    const res = await first.agent({ prompt: "Audit the parser.", run_in_background: false });
    const id = (res as any).details.agentId as string;
    vi.mocked(resumeAgent).mockImplementation((_session, _prompt, options: any) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ text: "", aborted: true, steered: false }));
      }),
    );

    await first.agent({ prompt: "Continue.", resume: id, run_in_background: true });

    const running = records(branch).at(-1);
    expect(running).toMatchObject({ id, status: "running" });
    expect(running.result).toBeUndefined();
    expect(running.completedAt).toBeUndefined();
  });

  it("writes no running record for a foreground agent", async () => {
    const branch: any[] = [];
    settleWith("DONE", sessionFile);
    const session = boot(branch);

    await session.agent({ prompt: "Audit the parser.", run_in_background: false });

    expect(records(branch).map((r) => r.status)).toEqual(["completed"]);
  });
});

describe("findLostAgentEntries", () => {
  const entry = (data: Record<string, unknown>) => ({
    type: "custom",
    customType: AGENT_RECORD_ENTRY_TYPE,
    data: { type: "Explore", description: "d", startedAt: 0, ...data },
  });

  it("counts the latest entry of each id, and only a loss", () => {
    const lost = findLostAgentEntries(
      [
        entry({ id: "settled", status: "running" }),
        entry({ id: "settled", status: "completed" }),
        entry({ id: "crashed", status: "running" }),
        entry({ id: "user-stop", status: "stopped" }),
        entry({ id: "shutdown", status: "stopped", stopReason: "session_end" }),
        entry({ id: "told", status: "stopped", stopReason: "session_end", lostNoticeSent: true }),
        entry({ id: "live", status: "running" }),
      ],
      (id) => id === "live",
    );

    expect(lost.map((e) => e.id)).toEqual(["crashed", "shutdown"]);
  });
});

describe("AgentManager", () => {
  it("stamps abortAll's reason, and leaves a user stop unmarked", () => {
    runUntilAborted(sessionFile);
    const manager = new AgentManager();
    const pi = makePi().pi as any;
    const context = ctx() as any;
    const userStopped = manager.spawn(pi, context, "Explore", "a", { description: "a", isBackground: true });
    const shutdown = manager.spawn(pi, context, "Explore", "b", { description: "b", isBackground: true });

    manager.abort(userStopped);
    manager.abortAll("session_end");

    expect(manager.getRecord(userStopped)?.stopReason).toBeUndefined();
    expect(manager.getRecord(shutdown)?.stopReason).toBe("session_end");
    manager.dispose();
  });

  it("reports a foreground run handed to the background as session-ready", async () => {
    runUntilAborted(sessionFile);
    const onSessionReady = vi.fn();
    const manager = new AgentManager(undefined, undefined, undefined, undefined, undefined, undefined, onSessionReady);
    void manager.spawnAndWait(makePi().pi as any, ctx() as any, "Explore", "a", { description: "a" });
    await vi.waitFor(() => expect(onSessionReady).toHaveBeenCalledTimes(1));
    const [record] = manager.listAgents();
    expect(onSessionReady.mock.lastCall![0].isBackground).toBeFalsy();

    expect(manager.sendToBackground(record.id)).toBe(true);

    expect(onSessionReady).toHaveBeenCalledTimes(2);
    expect(onSessionReady.mock.lastCall![0]).toMatchObject({ id: record.id, isBackground: true });
    manager.abortAll();
    manager.dispose();
  });
});
