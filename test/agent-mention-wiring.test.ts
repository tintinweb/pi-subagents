/**
 * agent-mention-wiring.test.ts — the `input` hook that routes `@handle message`
 * to a subagent.
 *
 * This handler sits in front of every prompt the user types, and returning
 * `handled` discards the text. So the two failures that matter are opposite:
 * claiming input that was meant for the main model (silently eating it), and
 * failing to claim a real mention (sending "@explore fix it" to the main model
 * as if it were prose). Each case below pins one side.
 *
 * Booted through the real extension so the assertions cover the actual wiring —
 * handle assignment in AgentManager, resolution, and the steer/resume split.
 */
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

// The clone forks a real pi session and runs a real model turn. What this file
// pins is the wiring around it — when it is called, with what, and what happens
// when it comes back empty. mention-clone.test.ts covers the clone itself.
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

import { getDefaultMaxTurns, resumeAgent, runAgent, setDefaultMaxTurns } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { runMentionClone } from "../src/mention-clone.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  vi.mocked(runMentionClone).mockReset();
  vi.mocked(runMentionClone).mockResolvedValue({ spawned: true });
});

afterEach(async () => {
  // The manager registry is a globalThis symbol claimed by the first activation
  // that finds it free and released only on shutdown. A test that throws before
  // its own shutdown would otherwise leave it pointing at a dead manager, and
  // the NEXT test's `managerRegistry()` would silently read that one instead.
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Enough of an AgentSession for the manager's and index's hooks. */
function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    ...overrides,
  } as any;
}

/** A runAgent that never settles, so the agent stays "running". */
function heldRun(session: any) {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.(session);
      }) as any,
  );
}

/** A runAgent that finishes immediately, leaving a resumable record behind. */
function finishedRun(session: any) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session,
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

/** Boot the real extension. `outputTranscript: false` keeps the run off disk. */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/**
 * Boot with a mention that names a not-yet-running agent starting it HERE
 * rather than through a clone of the conversation. Messaging and resuming are
 * direct in either mode, so only the tests that START an agent by mention need
 * this — every other `boot()` below is on the default `model` mode.
 */
function bootDirect(settings: Record<string, unknown> = {}) {
  return boot({ agentMentions: "direct", ...settings });
}

async function spawnBackground(tools: Map<string, any>, subagent_type = "Explore"): Promise<string> {
  const r = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "find flaky tests", subagent_type, run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const send = (lifecycle: Map<string, any>, text: string, source = "interactive") =>
  lifecycle.get("input")({ type: "input", text, source }, ctx());

describe("messaging a running agent", () => {
  it("steers it, announces it, and spends no main-model turn", async () => {
    const { pi, tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    const uiCtx = ctx();
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore also check the RPC path", source: "interactive" },
      uiCtx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(session.steer).toHaveBeenCalledWith("also check the RPC path");
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Sent to @explore", "info");
    expect(pi.sendMessage).not.toHaveBeenCalled();

  });

  it("un-consumes the result so the agent's reply is still relayed", async () => {
    // get_subagent_result may already have read this agent's last answer, which
    // suppresses its completion notification. Without the reset, the reply to
    // the message just sent would never reach the main loop.
    const { tools, lifecycle } = boot();
    heldRun(fakeSession());

    const id = await spawnBackground(tools);
    await flush();
    const record = (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);
    record.resultConsumed = true;

    await send(lifecycle, "@explore keep going");

    expect(record.resultConsumed).toBe(false);

  });

  it("addresses same-type siblings by their numbered handles", async () => {
    const { tools, lifecycle } = boot();
    const first = fakeSession();
    const second = fakeSession();
    vi.mocked(runAgent)
      .mockImplementationOnce((_c: any, _t: any, _p: any, o: any) => new Promise(() => o.onSessionCreated?.(first)) as any)
      .mockImplementationOnce((_c: any, _t: any, _p: any, o: any) => new Promise(() => o.onSessionCreated?.(second)) as any);

    await spawnBackground(tools);
    await spawnBackground(tools);
    await flush();

    await send(lifecycle, "@explore-2 you take the second half");

    expect(second.steer).toHaveBeenCalledWith("you take the second half");
    expect(first.steer).not.toHaveBeenCalled();

  });
});

describe("messaging a finished agent", () => {
  it("resumes it from its session in the background", async () => {
    const { lifecycle, tools } = boot();
    const session = fakeSession();
    finishedRun(session);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second answer", failure: undefined } as any);

    await spawnBackground(tools);
    await flush();

    const uiCtx = ctx();
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore anything else?", source: "interactive" },
      uiCtx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(resumeAgent).toHaveBeenCalledWith(session, "anything else?", expect.anything());
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Resuming @explore", "info");

  });

  it("honours the agent's output_transcript: false when resuming", async () => {
    // The frontmatter flag overrides the project default (README, Persistent
    // settings), and record.outputFile is the sole gate every downstream
    // consumer keys off — so a resume must not be the path that re-enables a
    // transcript the agent's author switched off.
    hermetic = hermeticDir({
      settings: { outputTranscript: true },
      agentFiles: { quiet: "---\ndescription: writes no transcript\noutput_transcript: false\n---\nbody" },
    });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    finishedRun(fakeSession());
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second answer", failure: undefined } as any);

    const id = await spawnBackground(b.tools, "quiet");
    await flush();
    const record = b.pi.__manager?.getRecord?.(id)
      ?? (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);
    expect(record.outputFile).toBeUndefined(); // spawn honoured it

    await send(b.lifecycle, "@quiet anything else?");

    expect(record.outputFile).toBeUndefined();

  });

  it("does not attribute the new answer to the tool call that spawned it", async () => {
    // The completion notification carries `<tool-use-id>`. A mention-resume has
    // no tool call behind it, so leaving the spawning call's id on the record
    // would point the orchestrator's new result at a call answered runs ago.
    const { pi, lifecycle, tools } = boot();
    finishedRun(fakeSession());
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second answer", failure: undefined } as any);

    await spawnBackground(tools);
    await flush();
    vi.mocked(pi.sendMessage).mockClear();

    await send(lifecycle, "@explore anything else?");
    await new Promise(r => setTimeout(r, 400));

    const [message] = vi.mocked(pi.sendMessage).mock.calls[0];
    expect(message.content).toContain("second answer");
    expect(message.content).not.toContain("<tool-use-id>");

  });

  it("relays the resumed answer through the ordinary completion notification", async () => {
    // The whole point of resuming in the background rather than inline: the
    // main model has to be told the answer came back, or the reply is stranded
    // in the agent's transcript.
    const { pi, lifecycle, tools } = boot();
    finishedRun(fakeSession());
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second answer", failure: undefined } as any);

    await spawnBackground(tools);
    await flush();
    vi.mocked(pi.sendMessage).mockClear();

    await send(lifecycle, "@explore anything else?");
    await new Promise(r => setTimeout(r, 400));

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification", content: expect.stringContaining("second answer") }),
      expect.objectContaining({ triggerTurn: true }),
    );

  });
});

describe("stacking the suggestion provider on pi's", () => {
  /** A session_start ctx with the UI surface the registration path touches. */
  const uiCtx = (mode: string) =>
    ctx({
      mode,
      hasUI: mode !== "print",
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
        onTerminalInput: vi.fn(() => vi.fn()),
        addAutocompleteProvider: vi.fn(),
      },
    });

  it("registers exactly once, however often session_start fires", async () => {
    // pi appends wrappers to a list it never prunes, so a second registration
    // would layer a duplicate provider on top of the first.
    const { lifecycle } = boot();
    const first = uiCtx("tui");
    const second = uiCtx("tui");

    await lifecycle.get("session_start")({ type: "session_start" }, first);
    await lifecycle.get("session_start")({ type: "session_start" }, second);

    expect(first.ui.addAutocompleteProvider).toHaveBeenCalledTimes(1);
    expect(second.ui.addAutocompleteProvider).not.toHaveBeenCalled();

  });

  it("stays out of non-TUI modes, which have no editor to complete into", async () => {
    const { lifecycle } = boot();
    const rpc = uiCtx("rpc");

    await lifecycle.get("session_start")({ type: "session_start" }, rpc);

    expect(rpc.ui.addAutocompleteProvider).not.toHaveBeenCalled();

  });

  it("hands pi a provider that answers a live handle", async () => {
    const { tools, lifecycle } = boot();
    heldRun(fakeSession());
    const tui = uiCtx("tui");

    await lifecycle.get("session_start")({ type: "session_start" }, tui);
    await spawnBackground(tools);
    await flush();

    const factory = vi.mocked(tui.ui.addAutocompleteProvider).mock.calls[0][0] as any;
    const provider = factory({ getSuggestions: vi.fn().mockResolvedValue(null), applyCompletion: vi.fn() });
    const result = await provider.getSuggestions(["@ex"], 0, 3, { signal: new AbortController().signal });

    expect(result.items.map((i: any) => i.value)).toEqual(["@explore"]);

  });
});

describe("resolving which agent a handle means", () => {
  const managerRegistry = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

  it("matches the handle case-insensitively", async () => {
    // The popup lowercases as you type, but nothing stops you typing it out.
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@EXPLORE shout")).toEqual({ action: "handled" });
    expect(session.steer).toHaveBeenCalledWith("shout");

  });

  it("accepts the raw agent id, which the README offers as a fallback", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    const id = await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, `@${id} by id`)).toEqual({ action: "handled" });
    expect(session.steer).toHaveBeenCalledWith("by id");

  });

  it("queues the message for an agent still waiting on a concurrency slot", async () => {
    // A queued agent has no session yet, so the manager parks the message and
    // flushes it on session creation. Reporting "sent" without that would be a
    // lie the user only discovers when the agent ignores them.
    const { tools, lifecycle } = boot({ maxConcurrent: 1 });
    heldRun(fakeSession());

    await spawnBackground(tools);
    const queuedId = await spawnBackground(tools);
    await flush();

    const queued = managerRegistry().getRecord(queuedId);
    expect(queued.status).toBe("queued");

    expect(await send(lifecycle, "@explore-2 wait for me")).toEqual({ action: "handled" });
    expect(queued.pendingSteers).toEqual(["wait for me"]);

  });

  it("never reaches into a nested child, and starts a top-level agent instead", async () => {
    // Nested agents are hidden from every top-level surface and only their
    // owner may steer them. The handle still resolves — to a NEW top-level
    // Explore — rather than punching through the ownership boundary.
    const { tools, lifecycle } = bootDirect();
    const child = fakeSession();
    heldRun(child);

    const id = await spawnBackground(tools);
    await flush();
    managerRegistry().getRecord(id).parentAgentId = "some-parent";
    vi.mocked(runAgent).mockClear();

    expect(await send(lifecycle, "@explore reach into a child")).toEqual({ action: "handled" });
    expect(child.steer).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(), "Explore", "reach into a child", expect.anything(),
    );
  });

  it("starts a fresh agent once the old record has been evicted", async () => {
    // README: handles live as long as their record, and after that the same
    // mention starts a new agent rather than resurrecting anything.
    const { tools, lifecycle } = bootDirect();
    finishedRun(fakeSession());

    const id = await spawnBackground(tools);
    await flush();
    managerRegistry().getRecord(id).resultConsumed = true;
    await lifecycle.get("session_before_switch")();
    expect(managerRegistry().getRecord(id)).toBeUndefined();

    vi.mocked(resumeAgent).mockClear();
    vi.mocked(runAgent).mockClear();
    heldRun(fakeSession());

    await send(lifecycle, "@explore start over");

    expect(resumeAgent).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "Explore", "start over", expect.anything());

  });
});

describe("mentioning an agent that has never run", () => {
  it("starts one, using the message as its prompt", async () => {
    const { lifecycle } = bootDirect();
    heldRun(fakeSession());

    const uiCtx = ctx();
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore find every retry marker", source: "interactive" },
      uiCtx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "Explore",
      "find every retry marker",
      expect.anything(),
    );
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Started @explore", "info");

  });

  it("leaves model, thinking and max turns to the agent's own config", async () => {
    // runAgent resolves all three from the config when the spawn omits them,
    // so passing anything here would override frontmatter the user wrote.
    const { lifecycle } = bootDirect();
    heldRun(fakeSession());

    await send(lifecycle, "@explore go");

    const opts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(opts.model).toBeUndefined();
    expect(opts.thinkingLevel).toBeUndefined();
    expect(opts.maxTurns).toBeUndefined();

  });

  it("shows the turn limit it will actually be held to (#181)", async () => {
    // The spawn passes no maxTurns on purpose (see the test above), so the
    // tracker has to resolve the same limit runAgent will enforce — otherwise
    // the row reads `↻1` where the Agent tool would read `↻1≤9`.
    const prevMax = getDefaultMaxTurns();
    try {
      const { lifecycle } = bootDirect({ defaultMaxTurns: 9 });
      heldRun(fakeSession());
      let factory: any;
      const uiCtx = ctx({
        hasUI: true,
        ui: {
          setStatus: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn(),
          onTerminalInput: vi.fn(() => vi.fn()), getEditorText: vi.fn(() => ""), custom: vi.fn(),
          setWidget: vi.fn((key: string, content: any) => { if (key === "agents" && content) factory = content; }),
        },
      });
      await lifecycle.get("session_start")({}, uiCtx);

      await lifecycle.get("input")({ type: "input", text: "@explore go", source: "interactive" }, uiCtx);
      await flush();

      const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
      const lines = factory({ terminal: { columns: 200 }, requestRender: vi.fn() }, theme).render().join("\n");
      expect(lines).toContain("≤9");
    } finally {
      setDefaultMaxTurns(prevMax);
    }
  });

  it("tracks its tool activity, so the widget shows what it is doing (#181)", async () => {
    // A mention spawn never passes through the Agent tool, which is where the
    // activity tracker is normally created. Without one the widget and
    // FleetView have no tool name and no turn count for the agent, so its row
    // reads `thinking…` from start to finish.
    const { lifecycle } = bootDirect();
    heldRun(fakeSession());

    await send(lifecycle, "@explore go");

    const opts = vi.mocked(runAgent).mock.calls[0][3] as any;
    expect(opts.onToolActivity).toBeTypeOf("function");
    expect(opts.onTurnEnd).toBeTypeOf("function");
    expect(opts.onSessionCreated).toBeTypeOf("function");
  });

  it("runs it in the background so the prompt is not blocked", async () => {
    const { lifecycle } = bootDirect();
    heldRun(fakeSession());

    await send(lifecycle, "@explore go");
    const record = (globalThis as any)[Symbol.for("pi-subagents:manager")]
      .getRecord(vi.mocked(runAgent).mock.calls[0][3].agentId);

    expect(record.isBackground).toBe(true);
    expect(record.description).toBe("go");

  });

  it("messages the running agent rather than starting a second one", async () => {
    const { lifecycle } = bootDirect();
    const session = fakeSession();
    heldRun(session);

    await send(lifecycle, "@explore first task");
    await flush();
    vi.mocked(runAgent).mockClear();

    await send(lifecycle, "@explore actually do this instead");

    expect(runAgent).not.toHaveBeenCalled();
    expect(session.steer).toHaveBeenCalledWith("actually do this instead");

  });

  it("reports a failed start instead of silently doing nothing", async () => {
    const { lifecycle } = bootDirect();
    vi.mocked(runAgent).mockImplementation(() => {
      throw new Error("worktree unavailable");
    });

    const uiCtx = ctx();
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore go", source: "interactive" },
      uiCtx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not start @explore"),
      "error",
    );

  });
});

describe("letting a clone of the conversation start the agent", () => {
  /** The clone stands in for a real forked session; mention-clone.test.ts covers the real one. */
  function cloneReturns(result: { spawned: boolean; error?: string }) {
    vi.mocked(runMentionClone).mockResolvedValue(result);
  }

  it("claims the turn, so nothing about the mention reaches the chat", async () => {
    // The whole point of the clone: the model still decides how to invoke the
    // agent, but it does so somewhere the user is not reading.
    const { pi, lifecycle } = boot();
    cloneReturns({ spawned: true });

    const result = await send(lifecycle, "@explore find the flaky test");
    await flush();

    expect(result).toEqual({ action: "handled" });
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("hands the clone the resolved type, the message and the real Agent tool", async () => {
    // The type, not the handle as typed — `subagent_type` is not lowercased.
    // The tool must be the registered one, or the clone's spawn would be a
    // second implementation rather than an ordinary top-level call.
    const { tools, lifecycle } = boot();
    cloneReturns({ spawned: true });

    await send(lifecycle, "@plan sketch the migration");
    await flush();

    expect(runMentionClone).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "Plan",
        message: "sketch the migration",
        agentTool: tools.get("Agent"),
      }),
    );
  });

  it("does not block the prompt on the clone's turn", async () => {
    // prompt() is suspended until this hook returns, so awaiting a full model
    // turn here would freeze the editor for its duration.
    const { lifecycle } = boot();
    let release: (() => void) | undefined;
    vi.mocked(runMentionClone).mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ spawned: true });
      }),
    );

    const result = await send(lifecycle, "@explore find the flaky test");

    expect(result).toEqual({ action: "handled" });
    release?.();
  });

  it("says the agent is being prompted, not started — nothing runs yet", async () => {
    const { lifecycle } = boot();
    cloneReturns({ spawned: true });

    const uiCtx = ctx();
    await lifecycle.get("input")(
      { type: "input", text: "@explore find the flaky test", source: "interactive" },
      uiCtx,
    );

    // The clone's turn happens first, so the agent does not exist yet. `direct`
    // mode's "Started @explore" is the contrast: there, it does.
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Prompting @explore…", "info");
  });

  it("starts the agent directly when the clone cannot", async () => {
    // A mention that produced a toast and no agent would be the worst outcome:
    // silent, and indistinguishable from success.
    const { lifecycle } = boot();
    heldRun(fakeSession());
    cloneReturns({ spawned: false, error: "no session file" });

    const uiCtx = ctx();
    await lifecycle.get("input")(
      { type: "input", text: "@explore find the flaky test", source: "interactive" },
      uiCtx,
    );
    await flush();

    expect(runAgent).toHaveBeenCalled();
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(
      "Started @explore directly — no session file",
      "warning",
    );
  });

  it("reports a fallback that also fails rather than going quiet", async () => {
    const { lifecycle } = boot();
    vi.mocked(runAgent).mockImplementation(() => {
      throw new Error("worktree unavailable");
    });
    cloneReturns({ spawned: false, error: "no session file" });

    const uiCtx = ctx();
    await lifecycle.get("input")(
      { type: "input", text: "@explore find the flaky test", source: "interactive" },
      uiCtx,
    );
    await flush();

    expect(uiCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not start @explore"),
      "error",
    );
  });

  it("still steers a running agent directly, without cloning anything", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@explore also check the RPC path")).toEqual({ action: "handled" });
    expect(session.steer).toHaveBeenCalledWith("also check the RPC path");
    expect(runMentionClone).not.toHaveBeenCalled();
  });

  it("still resumes a finished agent directly, without cloning anything", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    finishedRun(session);
    vi.mocked(resumeAgent).mockResolvedValue({ text: "second answer", failure: undefined } as any);

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@explore anything else?")).toEqual({ action: "handled" });
    expect(resumeAgent).toHaveBeenCalledWith(session, "anything else?", expect.anything());
    expect(runMentionClone).not.toHaveBeenCalled();
  });

  it("does not clone for a handle that names no agent", async () => {
    // Otherwise `@nosuchagent hello` would spin up a conversation copy to
    // invoke an agent that does not exist, and eat the prompt doing it.
    const { lifecycle } = boot();

    expect(await send(lifecycle, "@nosuchagent hello")).toEqual({ action: "continue" });
    expect(runMentionClone).not.toHaveBeenCalled();
  });

  it("works headlessly, where the visible-turn version never could", async () => {
    // The TUI-only guard exists because a claimed turn answers `pi -p` with
    // silence. The clone starts a real agent whose completion still reports.
    const { lifecycle } = boot();
    cloneReturns({ spawned: true });

    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore find the flaky test", source: "interactive" },
      ctx({ mode: "print" }),
    );
    await flush();

    expect(result).toEqual({ action: "handled" });
    expect(runMentionClone).toHaveBeenCalled();
  });

  it("leaves a running agent alone headlessly rather than starting a rival", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore also check the RPC path", source: "interactive" },
      ctx({ mode: "print" }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(session.steer).not.toHaveBeenCalled();
    expect(runMentionClone).not.toHaveBeenCalled();
  });

  it("clones nothing when mentions are off", async () => {
    const { lifecycle } = boot({ agentMentions: "off" });

    expect(await send(lifecycle, "@explore find the flaky test")).toEqual({ action: "continue" });
    expect(runMentionClone).not.toHaveBeenCalled();
  });

  it("starts the agent here instead when the mode is direct", async () => {
    const { lifecycle } = bootDirect();
    heldRun(fakeSession());

    expect(await send(lifecycle, "@explore find the flaky test")).toEqual({ action: "handled" });
    expect(runAgent).toHaveBeenCalled();
    expect(runMentionClone).not.toHaveBeenCalled();
  });
});

describe("input that is not a mention", () => {
  it("passes an unknown handle to the main model rather than eating it", async () => {
    const { lifecycle } = boot();

    expect(await send(lifecycle, "@nosuchagent hello")).toEqual({ action: "continue" });
  });

  it("passes a bare handle to the main model", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@explore")).toEqual({ action: "continue" });
    expect(session.steer).not.toHaveBeenCalled();

  });

  it("leaves a leading file attachment alone", async () => {
    const { tools, lifecycle } = boot();
    heldRun(fakeSession());

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@src/index.ts summarize this")).toEqual({ action: "continue" });

  });

  it("ignores input the extension layer submitted", async () => {
    // pi.sendMessage text arrives through the same hook; a notification that
    // happened to start with @something must not be re-routed at an agent.
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@explore relayed text", "extension")).toEqual({ action: "continue" });
    expect(session.steer).not.toHaveBeenCalled();

  });

  it("leaves a headless prompt to the main model", async () => {
    // Pi defaults session.prompt() to source "interactive", so `pi -p "@explore
    // …"` lands in this hook too. Claiming it there would answer with silence:
    // the agent detaches, notify is a no-op outside the TUI, and print mode
    // exits having printed nothing. Only `direct` has that problem — the model
    // mode's headless behaviour is pinned separately below.
    const { lifecycle } = bootDirect();
    heldRun(fakeSession());

    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore go", source: "interactive" },
      ctx({ mode: "print" }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(runAgent).not.toHaveBeenCalled();

  });

  it("leaves an RPC-driven prompt to the main model", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore also check this", source: "rpc" },
      ctx({ mode: "rpc" }),
    );

    expect(result).toEqual({ action: "continue" });
    expect(session.steer).not.toHaveBeenCalled();

  });

  it("falls through entirely when mentions are disabled", async () => {
    const { tools, lifecycle } = boot({ agentMentions: false });
    const session = fakeSession();
    heldRun(session);

    await spawnBackground(tools);
    await flush();

    expect(await send(lifecycle, "@explore do this")).toEqual({ action: "continue" });
    expect(session.steer).not.toHaveBeenCalled();

  });

  it("disabled also blocks starting an agent, not just messaging one", async () => {
    // The guard sits ahead of the parse, so every action is covered — but the
    // start branch is the one that would otherwise spawn work nobody asked for.
    const { lifecycle } = boot({ agentMentions: false });
    heldRun(fakeSession());

    expect(await send(lifecycle, "@explore go")).toEqual({ action: "continue" });
    expect(runAgent).not.toHaveBeenCalled();

  });

  it("disabled also blocks resuming a finished agent", async () => {
    const { tools, lifecycle } = boot({ agentMentions: false });
    finishedRun(fakeSession());

    await spawnBackground(tools);
    await flush();
    vi.mocked(resumeAgent).mockClear();

    expect(await send(lifecycle, "@explore anything else?")).toEqual({ action: "continue" });
    expect(resumeAgent).not.toHaveBeenCalled();

  });

  it("the suggestion popup goes quiet too, so @ means only 'attach a file'", async () => {
    const { tools, lifecycle } = boot({ agentMentions: false });
    heldRun(fakeSession());
    const tui = ctx({
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        onTerminalInput: vi.fn(() => vi.fn()), addAutocompleteProvider: vi.fn(),
      },
    });

    await lifecycle.get("session_start")({ type: "session_start" }, tui);
    await spawnBackground(tools);
    await flush();

    const factory = vi.mocked(tui.ui.addAutocompleteProvider).mock.calls[0][0] as any;
    const files = { items: [{ value: "@src/x.ts", label: "src/x.ts" }], prefix: "@ex" };
    const provider = factory({ getSuggestions: vi.fn().mockResolvedValue(files), applyCompletion: vi.fn() });

    expect(await provider.getSuggestions(["@ex"], 0, 3, { signal: new AbortController().signal })).toBe(files);

  });
});

describe("@main — the escape hatch", () => {
  it("strips the prefix and sends the rest to the main model", async () => {
    // Without this there is no way to type text that merely *looks* like a
    // mention. `transform`, not `handled`: the model must still get the turn.
    const { lifecycle } = boot();

    const result = await send(lifecycle, "@main @explore is not a mention");

    expect(result).toEqual({ action: "transform", text: "@explore is not a mention" });
  });

  it("carries attachments through with the text", async () => {
    const { lifecycle } = boot();
    const images = [{ type: "image", data: "x" }] as any;

    const result = await lifecycle.get("input")(
      { type: "input", text: "@main look at this", source: "interactive", images },
      ctx(),
    );

    expect(result).toEqual({ action: "transform", text: "look at this", images });
  });

  it("never starts an agent, even when a type would slug to main", async () => {
    const { pi, lifecycle } = boot();

    const result = await send(lifecycle, "@main do the thing");

    expect(result).toMatchObject({ action: "transform" });
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("leaves a bare @main to the main model untouched", async () => {
    // No message body is not a mention at all, reserved handle or not.
    const { lifecycle } = boot();

    expect(await send(lifecycle, "@main")).toEqual({ action: "continue" });
  });
});

describe("@agent-<type> — Claude Code's manual spelling", () => {
  it("starts the agent the unprefixed handle would have", async () => {
    const { lifecycle } = bootDirect();
    finishedRun(fakeSession());

    const result = await send(lifecycle, "@agent-explore find the flaky test");
    await flush();

    expect(result).toEqual({ action: "handled" });
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      expect.anything(), "Explore", "find the flaky test", expect.anything(),
    );
  });

  it("reaches a running agent, not a second copy of it", async () => {
    const { tools, lifecycle } = boot();
    const session = fakeSession();
    heldRun(session);
    await spawnBackground(tools);
    await flush();

    await send(lifecycle, "@agent-explore also check the RPC path");

    expect(session.steer).toHaveBeenCalledWith("also check the RPC path");
  });

  it("prefers an agent literally named agent-<x> over the unwrapped spelling", async () => {
    // Both could answer `@agent-explore`. The literal name has to win, or an
    // agent the model deliberately called `agent-explore` is unreachable.
    const { tools, lifecycle } = boot();
    const literal = fakeSession();
    const plain = fakeSession();
    vi.mocked(runAgent)
      .mockImplementationOnce((_c: any, _t: any, _p: any, o: any) => new Promise(() => o.onSessionCreated?.(plain)) as any)
      .mockImplementationOnce((_c: any, _t: any, _p: any, o: any) => new Promise(() => o.onSessionCreated?.(literal)) as any);

    await spawnBackground(tools); // plain Explore → @explore
    await tools.get("Agent").execute(
      "tc-named",
      { prompt: "go", description: "named", subagent_type: "Plan", name: "agent-explore", run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();

    await send(lifecycle, "@agent-explore over here");

    expect(literal.steer).toHaveBeenCalledWith("over here");
    expect(plain.steer).not.toHaveBeenCalled();
  });

  it("still falls through when nothing answers either spelling", async () => {
    const { lifecycle } = boot();

    expect(await send(lifecycle, "@agent-nosuchtype hello")).toEqual({ action: "continue" });
  });
});

describe("resuming an evicted agent by name", () => {
  // Only the GC interval and Date are faked: `flush()` runs on setImmediate,
  // and the manager's cleanup timer is started in its constructor, so the
  // fake clock has to be installed before boot().
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  /**
   * Age the record past the cutoff and let the real GC evict it. The session
   * file has to exist on disk: the dispatcher refuses to resume one it cannot
   * find, so a fictional path would take the "session is gone" branch and
   * every resume assertion below would pass for the wrong reason.
   */
  async function evict(id: string) {
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = manager.getRecord(id);
    record.sessionFile = sessionPath();
    writeFileSync(record.sessionFile, "");
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    return manager;
  }

  /** Inside the hermetic cwd, so teardown takes it with the rest. */
  const sessionPath = () => join(process.cwd(), "explore-session.jsonl");

  it("reopens the conversation instead of starting a fresh agent", async () => {
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    const manager = await evict(id);
    expect(manager.getRecord(id)).toBeUndefined();
    vi.mocked(runAgent).mockClear();

    const uiCtx = ctx();
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore anything else?", source: "interactive" },
      uiCtx,
    );
    await flush();

    expect(result).toEqual({ action: "handled" });
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      expect.anything(),
      "Explore",
      "anything else?",
      expect.objectContaining({ resumeSessionFile: sessionPath() }),
    );
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Resuming @explore", "info");
  });

  it("lets the Agent tool resume the persisted conversation by its old id", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    const id = await spawnBackground(tools);
    await flush();
    await evict(id);
    vi.mocked(runAgent).mockClear();
    finishedRun(fakeSession());

    const result = await tools.get("Agent").execute(
      "tc-resume",
      {
        prompt: "anything else?",
        description: "Continue review",
        subagent_type: "Explore",
        resume: id,
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    expect(textOf(result)).toContain("resumed from its persisted session");
    expect(textOf(result)).toContain(`Agent ID: ${id}`);
    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      expect.anything(),
      "Explore",
      "anything else?",
      expect.objectContaining({ resumeSessionFile: sessionPath() }),
    );
  });

  it("hands the resumed agent the handle back instead of numbering it", async () => {
    // Otherwise the resume lands on `@explore-2` and the tombstone keeps
    // `@explore`, so the name the user just typed still points at the corpse.
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();
    vi.mocked(runAgent).mockClear();
    heldRun(fakeSession());

    await send(lifecycle, "@explore anything else?");
    await flush();

    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    expect(manager.getRecord(resumedId).handle).toBe("explore");
  });

  it("stops resolving to the tombstone once the resume has taken the name", async () => {
    // The fork this prevents: every later `@explore` reopening the SAME stale
    // transcript, discarding whatever the resumed agent did in between.
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();
    vi.mocked(runAgent).mockClear();
    const resumed = fakeSession();
    heldRun(resumed);

    await send(lifecycle, "@explore anything else?");
    await flush();
    const uiCtx = ctx();
    await lifecycle.get("input")(
      { type: "input", text: "@explore and one more thing", source: "interactive" },
      uiCtx,
    );

    // Steered, not resumed again — and runAgent was called exactly once.
    expect(resumed.steer).toHaveBeenCalledWith("and one more thing");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(1);
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Sent to @explore", "info");
  });

  it("gives a named agent its alias back too", async () => {
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    const spawned = await tools.get("Agent").execute(
      "tc-named",
      { prompt: "audit", description: "audit the auth flow", subagent_type: "Explore", name: "auth-audit", run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();
    await evict(/Agent ID: (\S+)/.exec(textOf(spawned))![1]);
    await flush();
    vi.mocked(runAgent).mockClear();
    heldRun(fakeSession());

    await send(lifecycle, "@auth-audit anything else?");
    await flush();

    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    expect(manager.getRecord(resumedId)).toMatchObject({ handle: "explore", alias: "auth-audit" });
  });

  it("refuses to reopen a conversation under a substitute agent", async () => {
    // resolveSpawnType falls back to general-purpose for a type it cannot
    // resolve (#183) — and "cannot resolve" includes merely disabled, which
    // `/agents → Disable` does at any time. Inheriting that here would reopen
    // an Explore transcript under general-purpose's prompt and tools while
    // announcing "Resuming @scout", then re-tombstone under the substitute so
    // the handle never finds its way back.
    hermetic = hermeticDir({
      settings: { outputTranscript: false },
      agentFiles: { scout: "---\ndescription: scouts\n---\nbody" },
    });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    finishedRun(fakeSession());
    await evict(await spawnBackground(b.tools, "scout"));
    await flush();
    vi.mocked(runAgent).mockClear();
    writeFileSync(
      join(process.cwd(), ".pi", "agents", "scout.md"),
      "---\ndescription: scouts\nenabled: false\n---\nbody",
    );

    const uiCtx = ctx();
    await b.lifecycle.get("input")(
      { type: "input", text: "@scout anything else?", source: "interactive" },
      uiCtx,
    );

    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(
      "Could not resume @scout — the scout agent is no longer available.", "warning",
    );
  });

  it("resumes again once the agent is re-enabled", async () => {
    // So the refusal keeps the tombstone: dropping it would make a temporary
    // `/agents → Disable` permanently lose the conversation.
    hermetic = hermeticDir({
      settings: { outputTranscript: false },
      agentFiles: { scout: "---\ndescription: scouts\nenabled: false\n---\nbody" },
    });
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    // Spawn while it is still enabled, then disable, mention, re-enable.
    const file = join(process.cwd(), ".pi", "agents", "scout.md");
    writeFileSync(file, "---\ndescription: scouts\n---\nbody");
    finishedRun(fakeSession());
    await evict(await spawnBackground(b.tools, "scout"));
    await flush();
    writeFileSync(file, "---\ndescription: scouts\nenabled: false\n---\nbody");
    await b.lifecycle.get("input")({ type: "input", text: "@scout hi", source: "interactive" }, ctx());

    writeFileSync(file, "---\ndescription: scouts\n---\nbody");
    vi.mocked(runAgent).mockClear();
    heldRun(fakeSession());
    const uiCtx = ctx();
    await b.lifecycle.get("input")({ type: "input", text: "@scout hi again", source: "interactive" }, uiCtx);
    await flush();

    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      expect.anything(), "scout", "hi again",
      expect.objectContaining({ resumeSessionFile: sessionPath() }),
    );
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Resuming @scout", "info");
  });

  it("keeps the agent resolvable when the resume itself fails", async () => {
    // The type can have been deleted or disabled since the original run, and
    // resolveSpawnType then refuses it. Dropping the tombstone on that path
    // would lose the conversation for good, so the drop happens only after a
    // spawn that actually succeeded.
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();
    vi.mocked(runAgent).mockClear();
    // Stands in for any spawn-time throw: startAgent calls runAgent inline, so
    // a synchronous throw propagates back out of spawn().
    vi.mocked(runAgent).mockImplementationOnce(() => { throw new Error("Unknown agent type"); });

    const uiCtx = ctx();
    await lifecycle.get("input")(
      { type: "input", text: "@explore anything else?", source: "interactive" },
      uiCtx,
    );
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not resume @explore"),
      "warning",
    );

    // Still reachable: try again and it reopens the same conversation.
    heldRun(fakeSession());
    await send(lifecycle, "@explore try again");
    await flush();

    expect(vi.mocked(runAgent)).toHaveBeenLastCalledWith(
      expect.anything(), "Explore", "try again",
      expect.objectContaining({ resumeSessionFile: sessionPath() }),
    );
  });

  it("keeps the original description rather than relabelling from the message", async () => {
    // The row already says what this agent is; a resume is the same work
    // continuing, not a new task.
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();
    vi.mocked(runAgent).mockClear();

    await send(lifecycle, "@explore anything else?");
    await flush();

    // runAgent receives the new record's id, which is the only handle a test
    // has on an agent the dispatcher spawned without returning anything.
    const resumedId = (vi.mocked(runAgent).mock.calls[0][3] as any).agentId;
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(manager.getRecord(resumedId).description).toBe("find flaky tests");
  });

  it("does not let the tools steer or read an agent that is gone", async () => {
    // A mention can resurrect it, but there is no live record to interrupt and
    // no result to return — so the tools must say so rather than resolve to a
    // tombstone and act on stale data.
    const { tools } = boot();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();

    const steered = await tools.get("steer_subagent").execute(
      "tc", { agent_id: "explore", message: "hi" }, undefined, undefined, ctx(),
    );
    const read = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: "explore" }, undefined, undefined, ctx(),
    );

    expect(textOf(steered)).toContain("Agent not found");
    expect(textOf(read)).toContain("Agent not found");
  });

  it("reports a session that is gone, rather than starting something else", async () => {
    // SessionManager.open runs inside runAgent, so a missing file rejects that
    // promise as an ordinary agent error — the dispatcher never sees it. The
    // check has to happen before the spawn, or this reports nothing at all.
    const { lifecycle, tools } = boot();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();
    vi.mocked(runAgent).mockClear();
    unlinkSync(sessionPath());

    const uiCtx = ctx();
    const result = await lifecycle.get("input")(
      { type: "input", text: "@explore anything else?", source: "interactive" },
      uiCtx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(uiCtx.ui.notify).toHaveBeenCalledWith(
      "Could not resume @explore — its session is gone.", "warning",
    );
  });

  it("forgets an unopenable session so the next mention starts fresh", async () => {
    // A row that can only ever fail is worse than no row: it holds the handle
    // and refuses every message sent to it.
    const { lifecycle, tools } = bootDirect();
    finishedRun(fakeSession());
    await evict(await spawnBackground(tools));
    await flush();
    unlinkSync(sessionPath());
    await send(lifecycle, "@explore anything else?");
    vi.mocked(runAgent).mockClear();
    heldRun(fakeSession());

    const uiCtx = ctx();
    await lifecycle.get("input")(
      { type: "input", text: "@explore start over", source: "interactive" },
      uiCtx,
    );
    await flush();

    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      expect.anything(), "Explore", "start over",
      expect.not.objectContaining({ resumeSessionFile: expect.anything() }),
    );
    expect(uiCtx.ui.notify).toHaveBeenCalledWith("Started @explore", "info");
  });
});

// Claude Code's names work for the model as well as the human, because its
// `@` is backed by the same SendMessage the LLM calls. These give ours the
// same property: one name space, whoever is doing the addressing.
describe("handles as tool arguments", () => {
  it("steers by handle, not just by raw id", async () => {
    const { tools, lifecycle: _l } = boot();
    const session = fakeSession();
    heldRun(session);
    await spawnBackground(tools);
    await flush();

    const r = await tools.get("steer_subagent").execute(
      "tc", { agent_id: "explore", message: "look at the RPC path" }, undefined, undefined, ctx(),
    );

    expect(session.steer).toHaveBeenCalledWith("look at the RPC path");
    expect(textOf(r)).not.toContain("Agent not found");
  });

  it("steers by the name the model gave the agent", async () => {
    const { tools } = boot();
    const session = fakeSession();
    heldRun(session);
    await tools.get("Agent").execute(
      "tc-named",
      { prompt: "go", description: "audit", subagent_type: "Explore", name: "auth-audit", run_in_background: true },
      undefined, undefined, ctx(),
    );
    await flush();

    await tools.get("steer_subagent").execute(
      "tc", { agent_id: "auth-audit", message: "keep going" }, undefined, undefined, ctx(),
    );

    expect(session.steer).toHaveBeenCalledWith("keep going");
  });

  it("reads a result by handle", async () => {
    const { tools } = boot();
    finishedRun(fakeSession());
    await spawnBackground(tools);
    await flush();

    const r = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: "explore" }, undefined, undefined, ctx(),
    );

    expect(textOf(r)).toContain("first answer");
  });

  it("still reports an unknown reference as not found", async () => {
    const { tools } = boot();

    const r = await tools.get("steer_subagent").execute(
      "tc", { agent_id: "nosuchagent", message: "hi" }, undefined, undefined, ctx(),
    );

    expect(textOf(r)).toContain("Agent not found");
  });
});
