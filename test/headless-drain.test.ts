/**
 * headless-drain.test.ts — the `agent_before_settle` boundary that keeps a
 * headless parent (`pi -p`, JSON mode) open until its background work reports.
 *
 * The end-to-end behaviour — a real print-mode session staying open and the
 * parent reacting to the completion — is covered in
 * `subagents-print-mode-e2e.test.ts`. This file pins the boundary's own rules:
 * which modes drain, and the `headlessWaitMinutes` ceiling.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

// A run that is still going whenever the test looks: busy work in the worker,
// stopped only by the run's abort signal. (`Date.now()` is off-limits in scripts.)
const busyScript =
  'export const meta = { name: "busy", description: "runs until stopped" };\n' +
  "let n = 0; for (let i = 0; i < 1e12; i++) n += i;\nreturn n;\n";

const settleEvent = { entries: [], continue: false, context: {}, outcome: "completed" };

describe("headless drain at agent_before_settle", () => {
  let hermetic: Hermetic;
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await shutdown?.();
    shutdown = undefined;
    await flush();
    // A test that never shut down leaves its manager on the global registry.
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic.restore();
    vi.restoreAllMocks();
  });

  /** Boot with a long-running flag workflow already started. */
  async function boot(mode: string, settings: Record<string, unknown> = {}) {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true, ...settings } });
    const path = join(hermetic.dir, "busy.js");
    writeFileSync(path, busyScript);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode });
    await booted.lifecycle.get("session_start")({}, context);
    await booted.lifecycle.get("agent_start")({}, context);
    shutdown = () => booted.lifecycle.get("session_shutdown")({ reason: "quit" }, context);
    const settle = () => booted.lifecycle.get("agent_before_settle")(settleEvent, context);
    return { booted, settle };
  }

  it.each(["tui", "rpc"])("does not wait in %s mode, where the session stays open", async (mode) => {
    const { settle } = await boot(mode);

    // The workflow is still running; an interactive parent must settle anyway.
    await expect(settle()).resolves.toBeUndefined();
  });

  it("returns nothing when no background work is pending", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const context = ctx({ cwd: hermetic.dir, mode: "print" });
    await booted.lifecycle.get("session_start")({}, context);

    await expect(booted.lifecycle.get("agent_before_settle")(settleEvent, context)).resolves.toBeUndefined();
    expect(stderr.mock.calls.some((c: any[]) => String(c[0]).includes("Waiting for background work"))).toBe(false);
  });

  it("stops the work after headlessWaitMinutes, reports it on stderr, and settles without a turn", async () => {
    const { booted, settle } = await boot("print", { headlessWaitMinutes: 1 });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = settle();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await expect(result).resolves.toBeUndefined();
    const lines = stderr.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some(l => l.includes("Waiting for background work to finish (1 workflow)"))).toBe(true);
    expect(lines.some(l => l.includes("still running after 1 min (1 workflow); stopping it"))).toBe(true);
    // The workflow was stopped, not left running, and settled before the handler returned.
    const entry = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE);
    expect(entry?.[1]).toMatchObject({ name: "busy", status: "killed" });
    // Its "stopped" notification is dropped, not sent later by the outbox's idle timer.
    await new Promise(resolve => setTimeout(resolve, NOTIFICATION_HOLD_MS + 50));
    expect(booted.pi.sendMessage.mock.calls.some((c: any[]) => c[0]?.customType === "subagent-notification")).toBe(false);
  });

  it("stops a background agent at the ceiling too, not only workflows", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false, headlessWaitMinutes: 1 } });
    // A run that only ends when its abort signal fires.
    vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) => new Promise<any>(resolve => {
      opts.signal?.addEventListener("abort", () => resolve({
        responseText: "", session: { dispose: vi.fn() }, aborted: true, steered: false,
      }), { once: true });
    }) as any);
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode: "print" });
    await booted.lifecycle.get("session_start")({}, context);
    await booted.lifecycle.get("agent_start")({}, context);
    shutdown = () => booted.lifecycle.get("session_shutdown")({ reason: "quit" }, context);
    const spawned = await booted.tools.get("Agent").execute(
      "tc-bg",
      { prompt: "spin", description: "spin", subagent_type: "general-purpose", run_in_background: true },
      undefined, undefined, context,
    );
    const id = /Agent ID: (\S+)/.exec(spawned.content[0].text)![1];
    const record = () => (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);
    expect(record().status).toBe("running");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = booted.lifecycle.get("agent_before_settle")(settleEvent, context);
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await expect(result).resolves.toBeUndefined();
    const lines = stderr.mock.calls.map((c: any[]) => String(c[0]));
    expect(lines.some(l => l.includes("still running after 1 min (1 agent); stopping it"))).toBe(true);
    expect(record().status).toBe("stopped");
  });

  it("keeps waiting with headlessWaitMinutes 0, the default", async () => {
    const { settle } = await boot("print");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let settled = false;
    void settle().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    vi.useRealTimers();
    await flush();

    expect(settled).toBe(false);
  });
});
