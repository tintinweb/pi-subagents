/**
 * foreground-detach-wiring.test.ts — `b` (send a live foreground run to the
 * background) through the REAL extension.
 *
 * The manager-level contract is covered in `foreground-detach.test.ts`. What is
 * only reachable here is the half the extension owns: what the blocked `Agent`
 * tool call RETURNS once the run is handed off, and whether the surfaces that
 * call normally tears down in its `finally` survive an agent that is still
 * working. Getting that wrong does not fail a manager test — it silently
 * freezes the widget row and drops the completion notification.
 *
 * The handoff is driven through the callback the extension hands FleetView —
 * the same function `/agents` and FleetView both call — rather than through
 * overlay keystrokes. The key-to-callback path is pinned in
 * `fleet-list.test.ts`; replaying it here would test the overlay twice and the
 * tool result not at all. The manager registry can't drive it: that façade is a
 * deliberately narrow cross-extension surface and does not expose this.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

/**
 * Stubbed for two reasons: the `onBackground` callback the extension supplies
 * is otherwise unreachable, and `onAgentFinished` is the observable proof that
 * the `Agent` tool's `finally` did not tear down a run that is still going.
 */
let sendToBackground: ((record: any) => boolean) | undefined;
let fleet: { onAgentFinished: ReturnType<typeof vi.fn> } | undefined;
vi.mock("../src/ui/fleet-list.js", () => ({
  FleetList: class {
    constructor(_m: unknown, _a: unknown, _c: unknown, onBackground?: (r: any) => boolean) {
      sendToBackground = onBackground;
      fleet = this as any;
    }
    setUICtx = vi.fn();
    setEnabled = vi.fn();
    update = vi.fn();
    ensureTimer = vi.fn();
    onAgentFinished = vi.fn();
    dispose = vi.fn();
  },
}));

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
/** The narrow cross-extension façade — `getRecord` is all this file needs. */
const registry = (): { getRecord(id: string): AgentRecord | undefined } =>
  (globalThis as any)[MANAGER_KEY];

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  sendToBackground = undefined;
  fleet = undefined;
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, schedulingEnabled: false, defaultJoinMode: "async", ...settings },
  });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** A single run that settles only when `finish` is called. */
function controllableRun() {
  let agentId = "";
  const session = {
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  };
  let finish!: (text: string) => void;
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, _p: any, opts: any) =>
    new Promise<any>(resolve => {
      agentId = opts.agentId;
      opts.onSessionCreated?.(session);
      finish = (text: string) => resolve({
        responseText: text, session, aborted: false, steered: false,
      });
    }) as any,
  );
  return { session, agentId: () => agentId, finish: (text: string) => finish(text) };
}

/** Explicitly foreground: background is the default since #232/#237. */
const runForeground = (tools: Map<string, any>, signal?: AbortSignal) =>
  tools.get("Agent").execute(
    "tc-1",
    {
      prompt: "long job",
      description: "long job",
      subagent_type: "general-purpose",
      run_in_background: false,
    },
    signal,
    undefined,
    ctx(),
  );

describe("Agent tool — foreground run sent to the background", () => {
  it("returns the agent id instead of the result, and notifies once on completion", async () => {
    const run = controllableRun();
    const { pi, tools } = boot();

    const execution = runForeground(tools);
    await flush();

    const record = registry().getRecord(run.agentId())!;
    expect(sendToBackground!(record)).toBe(true);

    const output = textOf(await execution);
    expect(output).toContain("Agent sent to background");
    expect(output).toContain(`Agent ID: ${record.id}`);
    expect(output).toContain("long job");
    // The inline result the caller would otherwise have received is absent —
    // it does not exist yet.
    expect(output).not.toContain("DONE-SAME-RUN");
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Still the same live agent, reachable by id like any background one.
    const status = await tools.get("get_subagent_result").execute(
      "tc-2", { agent_id: record.id }, undefined, undefined, ctx(),
    );
    expect(textOf(status)).toContain("Status: running");

    // The tool call ended; the AGENT did not. Tearing its live surfaces down
    // here would freeze the widget row and lose the activity the background
    // completion still reports.
    expect(fleet!.onAgentFinished).not.toHaveBeenCalled();

    run.finish("DONE-SAME-RUN");
    await flush();
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    expect(pi.sendMessage.mock.calls[0][0].content).toContain("DONE-SAME-RUN");
    // ...and the normal background completion path does that cleanup instead.
    expect(fleet!.onAgentFinished).toHaveBeenCalledWith(record.id);
  });

  it("keeps the tool call's Esc from reaching the agent afterwards", async () => {
    const run = controllableRun();
    const { tools } = boot();
    const parent = new AbortController();

    const execution = runForeground(tools, parent.signal);
    await flush();
    const record = registry().getRecord(run.agentId())!;
    expect(sendToBackground!(record)).toBe(true);
    await execution;

    parent.abort();
    await flush();
    expect(record.status).toBe("running");
  });

  it("leaves the run blocking and reporting inline when nothing hands it off", async () => {
    const run = controllableRun();
    const { pi, tools } = boot();

    const execution = runForeground(tools);
    await flush();

    let settled = false;
    void execution.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    run.finish("INLINE-RESULT");
    const output = textOf(await execution);
    expect(output).toContain("INLINE-RESULT");
    expect(output).not.toContain("Agent sent to background");
    // The un-handed-off path still tears down on return, as it always has.
    expect(fleet!.onAgentFinished).toHaveBeenCalledWith(run.agentId());
    // Inline delivery — the completion must NOT also arrive as a notification.
    await flush();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});
