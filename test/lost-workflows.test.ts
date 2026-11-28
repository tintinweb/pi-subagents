/**
 * lost-workflows.test.ts — telling the model about `SubagentWorkflow` runs a
 * previous session lost, and resuming them after a reload or a restart.
 *
 * A run saves a `subagents:workflow-run` record when it starts and again when
 * it settles. The in-memory run is gone after a reload or a restart, but that
 * record and the run's journal are not: the next session reports a run that
 * never settled, once, and `resumeFromRunId` finds it from the record — what
 * Claude Code does for a workflow on a plain local resume.
 *
 * The runs are real (a worker thread per run); only `runAgent` is mocked, as
 * the lever on when each of a run's agents settles.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { findLostWorkflowRuns, WORKFLOW_RUN_ENTRY_TYPE } from "../src/workflow/entry.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

const script =
  'export const meta = { name: "audit", description: "two steps" };\n' +
  'await agent("first", { label: "a" });\n' +
  'await agent("second", { label: "b" });\n' +
  "return 1;\n";

let hermetic: Hermetic;
/** Every activation booted, so teardown stops their worker threads. */
let activations: (() => Promise<void>)[] = [];

beforeEach(() => {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true, outputTranscript: false } });
  vi.mocked(runAgent).mockReset();
  activations = [];
});

afterEach(async () => {
  for (const shutdown of activations) await shutdown();
  await flush();
  delete (globalThis as any)[MANAGER_KEY];
  hermetic.restore();
});

const done = { responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false };
/** Agents settle in order: the first `settled` of them at once, the rest never. */
function agentsSettle(settled: number) {
  let calls = 0;
  vi.mocked(runAgent).mockImplementation(() => (++calls <= settled ? Promise.resolve(done as any) : new Promise(() => {})) as any);
}

/** Boot with `appendEntry` landing on `branch`, as pi's session does. */
function boot(branch: any[]) {
  delete (globalThis as any)[MANAGER_KEY];
  const { pi, tools, lifecycle } = makePi();
  pi.appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  subagentsExtension(pi);
  const context = ctx({ cwd: hermetic.dir, sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
  const shutdown = () => lifecycle.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
  activations.push(shutdown);
  const workflow = (params: Record<string, unknown>) => tools.get("SubagentWorkflow").execute("tc-wf", params, undefined, undefined, context);
  const start = () => lifecycle.get("session_start")?.({ type: "session_start", reason: "resume" }, context);
  return { pi, workflow, start, shutdown };
}

const runs = (branch: any[]) => branch.filter((e) => e.customType === WORKFLOW_RUN_ENTRY_TYPE).map((e) => e.data);
const lostNotices = (pi: any) =>
  pi.sendMessage.mock.calls.filter(([m]: any[]) => m.customType === "subagent-notification" && String(m.content).includes("previous session ended"));

/** Start the run in a first activation, wait until `agents` of its agents were called. */
async function startRun(branch: any[], agents: number) {
  const first = boot(branch);
  const res = await first.workflow({ script });
  const runId = (res as any).details.taskId as string;
  await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(agents), { timeout: 3000 });
  await flush();
  return { runId, first };
}

describe("a workflow run the previous session lost", () => {
  it("saves a running record, then its final one", async () => {
    agentsSettle(2);
    const branch: any[] = [];
    const { runId } = await startRun(branch, 2);

    await vi.waitFor(() => expect(runs(branch)).toHaveLength(2), { timeout: 3000 });
    expect(runs(branch).map((r) => [r.runId, r.status])).toEqual([[runId, "running"], [runId, "completed"]]);
    expect(runs(branch)[0].journalPath).toMatch(new RegExp(`${runId}\\.workflow\\.jsonl$`));
  });

  it("is reported once after a crash, and resumes from its journal", async () => {
    agentsSettle(1);
    const branch: any[] = [];
    const { runId } = await startRun(branch, 2);
    expect(existsSync(runs(branch)[0].journalPath)).toBe(true);

    // The process dies: the second activation starts on the same session.
    const second = boot(branch);
    await second.start();

    const notices = lostNotices(second.pi);
    expect(notices).toHaveLength(1);
    const [message, options] = notices[0];
    expect(options).toEqual({ deliverAs: "nextTurn" });
    expect(message.content).toContain(`<task-id>${runId}</task-id>`);
    expect(message.content).toContain(`Background workflow "audit" (run ${runId}) didn't finish before the previous session ended`);
    expect(message.content).toContain("call SubagentWorkflow with `resumeFromRunId` set to its run id");
    expect(message.details.resultPreview.split("\n")[0]).toBe("lost when the previous session ended — resume with resumeFromRunId");
    expect(runs(branch).at(-1)).toMatchObject({ runId, status: "killed", stopReason: "session_end", lostNoticeSent: true });

    agentsSettle(2);
    const resumed = textOf(await second.workflow({ resumeFromRunId: runId }));
    expect(resumed).toContain(`Resuming ${runId}: 1 recorded call(s) available to replay.`);
  });

  it("says there is nothing to replay when no agent had finished", async () => {
    agentsSettle(0);
    const branch: any[] = [];
    const { runId } = await startRun(branch, 1);

    const second = boot(branch);
    await second.start();

    const [message] = lostNotices(second.pi)[0];
    expect(message.content).toContain("Nothing of it can be replayed");
    expect(message.content).not.toContain("resumeFromRunId");
    // A resume still runs: the tool says plainly that every agent runs live.
    agentsSettle(2);
    expect(textOf(await second.workflow({ resumeFromRunId: runId }))).toContain(`Nothing to replay from ${runId}`);
  });

  it("is reported after the session shut down while it ran", async () => {
    agentsSettle(1);
    const branch: any[] = [];
    const { runId, first } = await startRun(branch, 2);
    await first.shutdown();
    await vi.waitFor(() => expect(runs(branch).at(-1)).toMatchObject({ runId, status: "killed", stopReason: "session_end" }), { timeout: 3000 });

    const second = boot(branch);
    await second.start();

    expect(lostNotices(second.pi)).toHaveLength(1);
  });

  it("is not reported again when the session is reopened a second time", async () => {
    agentsSettle(1);
    const branch: any[] = [];
    await startRun(branch, 2);
    await boot(branch).start();

    const third = boot(branch);
    await third.start();

    expect(lostNotices(third.pi)).toHaveLength(0);
  });
});

describe("a lost workflow run while workflows are off", () => {
  const workflowsEnabled = (on: boolean) =>
    writeFileSync(
      join(hermetic.dir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, workflowsEnabled: on, outputTranscript: false }),
    );

  it("is not reported until workflows are back on", async () => {
    agentsSettle(1);
    const branch: any[] = [];
    const { runId } = await startRun(branch, 2);

    // Off: there is no SubagentWorkflow to resume with, so nothing points at it.
    workflowsEnabled(false);
    const off = boot(branch);
    await off.start();
    expect(lostNotices(off.pi)).toHaveLength(0);
    expect(runs(branch).at(-1)).toMatchObject({ runId, status: "running" });

    workflowsEnabled(true);
    const on = boot(branch);
    await on.start();
    expect(lostNotices(on.pi)).toHaveLength(1);
    expect(lostNotices(on.pi)[0][0].content).toContain(`<task-id>${runId}</task-id>`);
  });
});

describe("findLostWorkflowRuns", () => {
  const entry = (data: Record<string, unknown>) => ({
    type: "custom",
    customType: WORKFLOW_RUN_ENTRY_TYPE,
    data: { name: "w", startTime: 0, ...data },
  });

  it("counts the latest record of each run, and only a loss", () => {
    const lost = findLostWorkflowRuns(
      [
        entry({ runId: "settled", status: "running" }),
        entry({ runId: "settled", status: "completed" }),
        entry({ runId: "crashed", status: "running" }),
        entry({ runId: "user-kill", status: "killed" }),
        entry({ runId: "shutdown", status: "killed", stopReason: "session_end" }),
        entry({ runId: "told", status: "killed", stopReason: "session_end", lostNoticeSent: true }),
        entry({ runId: "live", status: "running" }),
      ],
      (runId) => runId === "live",
    );

    expect(lost.map((e) => e.runId)).toEqual(["crashed", "shutdown"]);
  });
});
