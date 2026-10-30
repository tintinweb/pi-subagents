/**
 * foreground-detach-wiring.test.ts — ctrl+b and the viewer's `b` (send a live
 * foreground run to the background) through the REAL extension.
 *
 * The manager-level contract is covered in `foreground-detach.test.ts`. What is
 * only reachable here is the half the extension owns: what the blocked `Agent`
 * tool call RETURNS once the run is handed off, and whether the surfaces that
 * call normally tears down in its `finally` survive an agent that is still
 * working. Getting that wrong does not fail a manager test — it silently
 * freezes the widget row and drops the completion notification.
 *
 * ctrl+b is driven through the terminal-input listener the extension installs
 * on the session UI. The viewer's `b` is driven through the action the
 * extension hands FleetView — the same factory `/agents` uses — rather than
 * through overlay keystrokes; the key-to-action path is pinned in
 * `conversation-viewer.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

/**
 * Stubbed for two reasons: the background action the extension supplies is
 * otherwise unreachable, and `onAgentFinished` is the observable proof that
 * the `Agent` tool's `finally` did not tear down a run that is still going.
 */
type BackgroundActionFor = (record: any, notify: (message: string) => void) => ViewerBackgroundAction;
let backgroundActionFor: BackgroundActionFor | undefined;
let fleet: { onAgentFinished: ReturnType<typeof vi.fn>; editorHasFocus: ReturnType<typeof vi.fn> } | undefined;
vi.mock("../src/ui/fleet-list.js", () => ({
  FleetList: class {
    constructor(...args: unknown[]) {
      backgroundActionFor = args[6] as BackgroundActionFor;
      fleet = this as any;
    }
    setUICtx = vi.fn();
    setWorkflowSource = vi.fn();
    /** The real one peeks at the TUI's focused component; tests flip this. */
    editorHasFocus = vi.fn(() => true);
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
import type { ViewerBackgroundAction } from "../src/ui/conversation-viewer.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
/** The narrow cross-extension façade — `getRecord` is all this file needs. */
const registry = (): { getRecord(id: string): AgentRecord | undefined } =>
  (globalThis as any)[MANAGER_KEY];

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  backgroundActionFor = undefined;
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

/** Runs that settle only when `finish(prompt, text)` is called. */
function controllableRuns() {
  const ids = new Map<string, string>();
  const options = new Map<string, any>();
  const finishers = new Map<string, (text: string) => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any, opts: any) =>
    new Promise<any>(resolve => {
      const session = {
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        messages: [],
        getActiveToolNames: vi.fn(() => []),
      };
      ids.set(prompt, opts.agentId);
      options.set(prompt, opts);
      opts.onSessionCreated?.(session);
      finishers.set(prompt, (text: string) => resolve({
        responseText: text, session, aborted: false, steered: false,
      }));
    }) as any,
  );
  return {
    agentId: (prompt: string) => ids.get(prompt)!,
    /** The options the manager handed `runAgent` — the child's event callbacks. */
    options: (prompt: string) => options.get(prompt)!,
    finish: (prompt: string, text: string) => finishers.get(prompt)!(text),
  };
}

/** Explicitly foreground: background is the default since #232/#237. */
const runAgentTool = (tools: Map<string, any>, prompt: string, opts: { signal?: AbortSignal; background?: boolean; toolCallId?: string; onUpdate?: (u: any) => void } = {}) =>
  tools.get("Agent").execute(
    opts.toolCallId ?? `tc-${prompt}`,
    {
      prompt,
      description: prompt,
      subagent_type: "general-purpose",
      run_in_background: opts.background ?? false,
    },
    opts.signal,
    opts.onUpdate,
    ctx(),
  );

/** Enough of pi's Theme for a real ConversationViewer. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const CTRL_B = "\x02";
/** ctrl+b RELEASE under the Kitty keyboard protocol (codepoint 98, ctrl, event 3). */
const CTRL_B_RELEASE = "\x1b[98;5:3u";

/** A session UI whose terminal-input listeners the test can feed keys to. */
function terminalUi() {
  const listeners: ((data: string) => { consume?: boolean } | undefined)[] = [];
  const ui = {
    setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn(),
    onTerminalInput: vi.fn((handler: (data: string) => { consume?: boolean } | undefined) => {
      listeners.push(handler);
      return () => { listeners.splice(listeners.indexOf(handler), 1); };
    }),
  };
  /** Feed one key; returns whether a listener consumed it. */
  const press = (data: string) => listeners.some(l => l(data)?.consume === true);
  return { ui, press };
}

describe("Agent tool — foreground run sent to the background", () => {
  it("ctrl+b returns every pending call as a background spawn, and each notifies once", async () => {
    const runs = controllableRuns();
    const { pi, tools, lifecycle } = boot();
    const { ui, press } = terminalUi();
    await lifecycle.get("tool_execution_start")({}, ctx({ ui }));

    const first = runAgentTool(tools, "first job");
    const second = runAgentTool(tools, "second job");
    await flush();

    expect(press(CTRL_B)).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith("Sent 2 agents to the background.", "info");

    for (const [execution, prompt] of [[first, "first job"], [second, "second job"]] as const) {
      const result = await execution;
      const output = textOf(result);
      // The text a spawn-time background agent gets — the model sees one kind
      // of agent from here on, as in Claude Code.
      expect(output).toContain("Agent started in background.");
      expect(output).toContain(`Agent ID: ${runs.agentId(prompt)}`);
      expect(result.details).toMatchObject({ status: "background", agentId: runs.agentId(prompt) });
    }
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // The tool calls ended; the AGENTS did not. Tearing their live surfaces
    // down here would freeze the widget rows.
    expect(fleet!.onAgentFinished).not.toHaveBeenCalled();
    const status = await tools.get("get_subagent_result").execute(
      "tc-status", { agent_id: runs.agentId("first job") }, undefined, undefined, ctx(),
    );
    expect(textOf(status)).toContain("Status: running");

    runs.finish("first job", "DONE-SAME-RUN");
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
    const notification = pi.sendMessage.mock.calls[0][0].content;
    expect(notification).toContain("DONE-SAME-RUN");
    // The notification names the tool call that started it, like any
    // background spawn's.
    expect(notification).toContain("<tool-use-id>tc-first job</tool-use-id>");
    expect(fleet!.onAgentFinished).toHaveBeenCalledWith(runs.agentId("first job"));

    runs.finish("second job", "SECOND");
    await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
  });

  it("ctrl+b passes through when no foreground call is pending", async () => {
    const runs = controllableRuns();
    const { tools, lifecycle } = boot();
    const { ui, press } = terminalUi();
    await lifecycle.get("tool_execution_start")({}, ctx({ ui }));

    // Nothing running: the key is pi's cursor-left.
    expect(press(CTRL_B)).toBe(false);

    // A background spawn is not a foreground call either.
    await runAgentTool(tools, "bg job", { background: true });
    await flush();
    expect(press(CTRL_B)).toBe(false);

    // Other keys pass through while a foreground call IS pending.
    const execution = runAgentTool(tools, "fg job");
    await flush();
    expect(press("b")).toBe(false);

    runs.finish("fg job", "INLINE");
    await execution;
    expect(press(CTRL_B)).toBe(false);
    runs.finish("bg job", "BG");
  });

  it("the viewer's `b` hands off just that run", async () => {
    const runs = controllableRuns();
    const { tools } = boot();

    const kept = runAgentTool(tools, "kept job");
    const handed = runAgentTool(tools, "handed job");
    await flush();

    const notify = vi.fn();
    const keptAction = backgroundActionFor!(registry().getRecord(runs.agentId("kept job")), notify);
    const handedAction = backgroundActionFor!(registry().getRecord(runs.agentId("handed job")), notify);
    expect(keptAction.available()).toBe(true);
    expect(handedAction.available()).toBe(true);

    handedAction.send();
    expect(notify).toHaveBeenCalledWith('Sent "handed job" to the background.');
    expect(textOf(await handed)).toContain("Agent started in background.");
    // Gone the instant the handoff lands; the other run is still offered.
    expect(handedAction.available()).toBe(false);
    expect(keptAction.available()).toBe(true);

    runs.finish("kept job", "KEPT-INLINE");
    expect(textOf(await kept)).toContain("KEPT-INLINE");
    expect(keptAction.available()).toBe(false);
    runs.finish("handed job", "HANDED");
  });

  it("shows the ctrl+b hint on a running row only once it can be handed off", async () => {
    const runs = controllableRuns();
    const { tools } = boot();
    const onUpdate = vi.fn();

    const execution = runAgentTool(tools, "long job", { onUpdate });
    // The first update goes out before the run exists: nothing to hand off yet.
    expect(onUpdate.mock.calls[0][0].details.backgroundHint).toBe(false);
    await flush();
    // The renderer keys the ctrl+b hint off this.
    await vi.waitFor(() => expect(onUpdate.mock.lastCall?.[0].details.backgroundHint).toBe(true));

    runs.finish("long job", "DONE");
    await execution;
  });

  it("offers no handoff for a background spawn", async () => {
    const runs = controllableRuns();
    const { tools } = boot();
    await runAgentTool(tools, "bg job", { background: true });
    await flush();

    const action = backgroundActionFor!(registry().getRecord(runs.agentId("bg job")), vi.fn());
    expect(action.available()).toBe(false);
    runs.finish("bg job", "BG");
  });

  it("keeps the tool call's Esc from reaching the agent afterwards", async () => {
    const runs = controllableRuns();
    const { tools } = boot();
    const parent = new AbortController();

    const execution = runAgentTool(tools, "long job", { signal: parent.signal });
    await flush();
    const record = registry().getRecord(runs.agentId("long job"))!;
    backgroundActionFor!(record, vi.fn()).send();
    await execution;

    parent.abort();
    await flush();
    expect(record.status).toBe("running");
    runs.finish("long job", "DONE");
  });

  it("leaves the run blocking and reporting inline when nothing hands it off", async () => {
    const runs = controllableRuns();
    const { pi, tools } = boot();

    const execution = runAgentTool(tools, "long job");
    await flush();

    let settled = false;
    void execution.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);

    runs.finish("long job", "INLINE-RESULT");
    const output = textOf(await execution);
    expect(output).toContain("INLINE-RESULT");
    expect(output).not.toContain("in background");
    // The un-handed-off path still tears down on return, as it always has.
    expect(fleet!.onAgentFinished).toHaveBeenCalledWith(runs.agentId("long job"));
    // Inline delivery — the completion must NOT also arrive as a notification.
    await flush();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
  it("shows one hint per batch, moving it on when that call is handed off", async () => {
    const runs = controllableRuns();
    const { tools } = boot();
    const firstUpdates = vi.fn();
    const secondUpdates = vi.fn();

    const first = runAgentTool(tools, "first job", { onUpdate: firstUpdates });
    const second = runAgentTool(tools, "second job", { onUpdate: secondUpdates });
    await flush();
    await vi.waitFor(() => expect(firstUpdates.mock.lastCall?.[0].details.backgroundHint).toBe(true));
    await vi.waitFor(() => expect(secondUpdates.mock.lastCall?.[0].details).toBeDefined());
    expect(secondUpdates.mock.lastCall?.[0].details.backgroundHint).toBe(false);

    backgroundActionFor!(registry().getRecord(runs.agentId("first job")), vi.fn()).send();
    await first;
    await vi.waitFor(() => expect(secondUpdates.mock.lastCall?.[0].details.backgroundHint).toBe(true));

    runs.finish("second job", "DONE");
    await second;
    runs.finish("first job", "DONE");
  });

  it("stops building tool updates once the call has returned", async () => {
    const runs = controllableRuns();
    const { tools } = boot();
    const onUpdate = vi.fn();

    const execution = runAgentTool(tools, "long job", { onUpdate });
    await flush();
    backgroundActionFor!(registry().getRecord(runs.agentId("long job")), vi.fn()).send();
    await execution;
    onUpdate.mockClear();

    // The child keeps streaming; the returned call's update handle is dead.
    const opts = runs.options("long job");
    opts.onTextDelta?.("more", "more");
    opts.onToolActivity?.({ type: "start", toolName: "read" });
    expect(onUpdate).not.toHaveBeenCalled();
    runs.finish("long job", "DONE");
  });

  it("announces a handed-off run as a background agent", async () => {
    const runs = controllableRuns();
    const { pi, tools, lifecycle } = boot();
    const { ui, press } = terminalUi();
    await lifecycle.get("tool_execution_start")({}, ctx({ ui }));

    const execution = runAgentTool(tools, "long job");
    await flush();
    pi.events.emit.mockClear();
    press(CTRL_B);
    await execution;

    const created = pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:created");
    expect(created).toEqual([["subagents:created", {
      id: runs.agentId("long job"), type: "general-purpose", description: "long job", isBackground: true,
    }]]);
    runs.finish("long job", "DONE");
  });

  it("leaves ctrl+b to whatever has focus when it is not the prompt editor", async () => {
    const runs = controllableRuns();
    const { tools, lifecycle } = boot();
    const { ui, press } = terminalUi();
    await lifecycle.get("tool_execution_start")({}, ctx({ ui }));

    const execution = runAgentTool(tools, "long job");
    await flush();
    // A dialog or the viewer's composer: there ctrl+b is cursor-left.
    fleet!.editorHasFocus.mockReturnValue(false);
    expect(press(CTRL_B)).toBe(false);
    expect(registry().getRecord(runs.agentId("long job"))?.isBackground).toBe(false);

    fleet!.editorHasFocus.mockReturnValue(true);
    expect(press(CTRL_B)).toBe(true);
    await execution;
    runs.finish("long job", "DONE");
  });

  it("acts on the ctrl+b press, not its key release", async () => {
    const runs = controllableRuns();
    const { tools, lifecycle } = boot();
    const { ui, press } = terminalUi();
    await lifecycle.get("tool_execution_start")({}, ctx({ ui }));

    const execution = runAgentTool(tools, "long job");
    await flush();
    expect(press(CTRL_B_RELEASE)).toBe(false);
    expect(registry().getRecord(runs.agentId("long job"))?.isBackground).toBe(false);

    runs.finish("long job", "INLINE");
    expect(textOf(await execution)).toContain("INLINE");
  });

  it("claims ctrl+b from session start, before any tool has run", async () => {
    const runs = controllableRuns();
    const { tools, lifecycle } = boot();
    const { ui, press } = terminalUi();
    await lifecycle.get("session_start")({}, ctx({ hasUI: true, ui }));

    const execution = runAgentTool(tools, "long job");
    await flush();
    expect(press(CTRL_B)).toBe(true);
    expect(textOf(await execution)).toContain("Agent started in background.");
    runs.finish("long job", "DONE");
  });

  it("wires `b` in the /agents viewer to the same handoff", async () => {
    const runs = controllableRuns();
    const { tools, commands } = boot();

    const execution = runAgentTool(tools, "long job");
    await flush();

    let viewer: { handleInput(data: string): void } | undefined;
    let closeViewer: (() => void) | undefined;
    const picks = [(o: string[]) => o.find(x => x.startsWith("Running agents ("))];
    const ui = {
      setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn(),
      select: vi.fn(async (_title: string, options: string[]) => picks.shift()?.(options)),
      custom: vi.fn((factory: any) => new Promise<unknown>(resolve => {
        const done = (result: unknown) => resolve(result);
        closeViewer = () => done(undefined);
        viewer = factory({ mode: "regular", requestRender() {}, terminal: { columns: 120, rows: 40 } }, theme, undefined, done);
      })),
    };
    const menu = commands.get("agents").handler("", ctx({ hasUI: true, ui }));
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(1));
    viewer!.handleInput("\r"); // Running-agent list → view picker.
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(2));
    viewer!.handleInput("t"); // View picker → Transcript.
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(3));

    viewer!.handleInput("b");
    expect(ui.notify).toHaveBeenCalledWith('Sent "long job" to the background.', "info");
    expect(textOf(await execution)).toContain("Agent started in background.");

    closeViewer!();
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(4));
    viewer!.handleInput("\x1b"); // Back at the running-agent list.
    await menu;
    runs.finish("long job", "DONE");
  });
});
