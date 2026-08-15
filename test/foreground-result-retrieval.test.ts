/**
 * foreground-result-retrieval.test.ts — issue #174, via the REAL Agent tool +
 * the REAL get_subagent_result tool.
 *
 * Report: a FOREGROUND agent that wraps up at max_turns returns its partial
 * result inline, but a get_subagent_result for "that agent ID" immediately
 * afterwards answers `Agent not found ... It may have been cleaned up.` — with
 * no /new, /resume or session switch in between.
 *
 * Tracing says the premise can't hold, and these tests pin both halves of why:
 *
 *   1. The record is NOT cleaned up. Foreground completion mutates the record
 *      in place (agent-manager.ts startAgent's .then) — nothing deletes it. So
 *      a lookup with the REAL id succeeds.
 *   2. The model never HAD the real id. Foreground returns the result text
 *      only; the id travels in `details`, which is renderer metadata and never
 *      reaches the API (only `content` is serialized). The background path is
 *      the one that puts `Agent ID: ...` in the text.
 *
 * Together: whatever id the reporter's model passed, it wasn't one we issued,
 * and "not found" was the correct answer. Test 3 pins the eviction rule that
 * DOES apply, so the two are not confused again.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { FOREGROUND_TIMEOUT_CEILING_MS } from "../src/settings.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, commands };
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

/**
 * Run a FOREGROUND agent that wraps up at the turn limit — the exact #174
 * shape. `steered: true` is what agent-manager turns into status "steered",
 * which is what produces the reporter's "(wrapped up at the turn limit —
 * output may be partial)" note.
 *
 * Returns the tool result plus the id read out of `details` — the only place
 * a foreground id exists, which is the point of test 2.
 */
async function runForegroundSteeredAgent(tools: Map<string, any>) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-RESULT-PAYLOAD",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: true,
  });
  const res = await tools.get("Agent").execute(
    "tc-fg",
    {
      prompt: "Perform a very thorough read-only codebase exploration.",
      description: "Locate organization-scope changes",
      subagent_type: "Explore",
      max_turns: 20,
    },
    undefined,
    undefined,
    ctx(),
  );
  const id = (res as any).details?.agentId as string | undefined;
  expect(id, "foreground spawn should have produced a record id in details").toBeTruthy();
  return { res, id: id as string };
}

describe("issue #174: foreground agent that hits max_turns", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off — same isolation as
    // clear-completed-wiring.test.ts, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-174-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-174-agentdir-"));
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
    vi.useRealTimers();
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("is NOT cleaned up — get_subagent_result with the real id still resolves it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runForegroundSteeredAgent(tools);

    // The inline result is the turn-limit wrap-up the reporter described.
    expect(textOf(res)).toContain("wrapped up at the turn limit");

    // No /new, no /resume, no session switch — exactly the reporter's sequence.
    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("never hands the model an agent id — the id lives only in renderer details", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { res, id } = await runForegroundSteeredAgent(tools);

    // `content` is the only thing serialized to the API. If the id isn't here,
    // the model cannot have obtained it — any id it passes is invented.
    expect(textOf(res)).not.toContain(id);
    expect(textOf(res)).not.toMatch(/Agent ID:/);

    // An invented id is correctly rejected — this is the reporter's error,
    // reproduced WITHOUT any record having been cleaned up.
    const bogus = await tools.get("get_subagent_result").execute(
      "tc-bogus",
      { agent_id: "3f1320a7-74ec-422" },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(bogus)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("survives a subagent session's OWN activation lifecycle (adversarial: cross-activation eviction)", async () => {
    // The one mechanism that could produce the reported symptom with no
    // user-visible session change: a second activation of this extension in the
    // same process. Child sessions no longer reach it — activation returns early
    // under `inChildSessionContext()` — but any other in-process activation still
    // can, and if its session_start / session_shutdown reached the PARENT's
    // manager, that activation ending would wipe the parent's records.
    const parent = makePi();
    subagentsExtension(parent.pi);
    await parent.lifecycle.get("session_start")?.({}, ctx());
    const { id } = await runForegroundSteeredAgent(parent.tools);

    // A child activation runs its full lifecycle, as a subagent session does.
    const child = makePi();
    subagentsExtension(child.pi);
    await child.lifecycle.get("session_start")?.({}, ctx());
    await child.lifecycle.get("session_shutdown")?.({}, ctx());

    // The parent's record must be untouched — separate manager per activation.
    const read = await parent.tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    const out = textOf(read);
    expect(out).not.toContain("Agent not found");
    expect(out).toContain("THE-RESULT-PAYLOAD");

    await parent.lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("applies foregroundTimeoutMs and returns the live run as background", async () => {
    vi.useFakeTimers();
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async", foregroundTimeoutMs: 1_000 }),
    );
    const session = { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) } as any;
    let finish!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finish = resolve; });
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const parent = new AbortController();
    const execution = tools.get("Agent").execute(
      "tc-timeout",
      { prompt: "keep working", description: "long task", subagent_type: "general-purpose" },
      parent.signal,
      undefined,
      ctx(),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await execution;
    const output = textOf(result);
    expect(output).toContain("Agent sent to background");
    const id = output.match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    // Esc after the tool returned cannot stop the detached child.
    parent.abort();
    const running = await tools.get("get_subagent_result").execute(
      "tc-status",
      { agent_id: id },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(running)).toContain("Status: running");

    finish({ responseText: "FINISHED-SAME-RUN", session, aborted: false, steered: false });
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage.mock.calls[0][0].content).toContain("FINISHED-SAME-RUN");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("releases a blocked foreground tool call and bounds shutdown when its runner hangs", async () => {
    vi.useFakeTimers();
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, foregroundTimeoutMs: 0, outputTranscript: false }),
    );
    const session = { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) } as any;
    let childSignal: AbortSignal | undefined;
    let childId: string | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      childSignal = options.signal;
      childId = options.agentId;
      options.onSessionCreated?.(session);
      return new Promise(() => {});
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const execution = tools.get("Agent").execute(
      "tc-blocked-shutdown",
      { prompt: "hang", description: "blocked foreground", subagent_type: "general-purpose" },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(childSignal).toBeDefined();
    expect(childId).toBeDefined();
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = registry.getRecord(childId) as any;
    const cleanup = vi.fn();
    record.outputCleanup = cleanup;

    const shutdown = lifecycle.get("session_shutdown")?.({}, ctx());
    const result = await execution;

    expect(childSignal?.aborted).toBe(true);
    expect(textOf(result)).toContain("STOPPED BY THE USER");
    expect(cleanup).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(cleanup).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(record.outputCleanup).toBeUndefined();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      session.dispose.mock.invocationCallOrder[0],
    );
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("clears pending smart-join batch finalization on shutdown", async () => {
    vi.useFakeTimers();
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "smart", outputTranscript: false }),
    );
    const session = { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) } as any;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      options.onSessionCreated?.(session);
      return Promise.resolve({ responseText: "done", session, aborted: false, steered: false });
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    await tools.get("Agent").execute(
      "tc-batch-shutdown",
      {
        prompt: "finish now",
        description: "pending batch",
        subagent_type: "general-purpose",
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx(),
    );

    await lifecycle.get("session_shutdown")?.({}, ctx());
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("disposes an active join group and suppresses its late completion", async () => {
    vi.useFakeTimers();
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "smart", outputTranscript: false }),
    );
    const sessions = [
      { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) },
      { dispose: vi.fn(), messages: [], subscribe: vi.fn(() => vi.fn()) },
    ] as any[];
    let finishSecond!: (value: any) => void;
    let secondSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options: any) => {
      const session = prompt === "first" ? sessions[0] : sessions[1];
      options.onSessionCreated?.(session);
      if (prompt === "first") {
        return Promise.resolve({ responseText: "first done", session, aborted: false, steered: false });
      }
      secondSignal = options.signal;
      return new Promise(resolve => { finishSecond = resolve; });
    });

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    for (const prompt of ["first", "second"]) {
      await tools.get("Agent").execute(
        `tc-group-${prompt}`,
        {
          prompt,
          description: `${prompt} group member`,
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        undefined,
        undefined,
        ctx(),
      );
    }
    await vi.advanceTimersByTimeAsync(100);

    const shutdown = lifecycle.get("session_shutdown")?.({}, ctx());
    expect(secondSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;

    finishSecond({ responseText: "late second", session: sessions[1], aborted: true, steered: false });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("stops a detached foreground run cleanly on session shutdown without notifying", async () => {
    vi.useFakeTimers();
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({
        schedulingEnabled: false,
        defaultJoinMode: "async",
        foregroundTimeoutMs: 1,
        outputTranscript: false,
      }),
    );
    const session = {
      dispose: vi.fn(),
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
    } as any;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) =>
      new Promise(resolve => {
        options.onSessionCreated?.(session);
        options.signal.addEventListener("abort", () => {
          resolve({ responseText: "partial", session, aborted: true, steered: false });
        }, { once: true });
      }),
    );

    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const execution = tools.get("Agent").execute(
      "tc-shutdown",
      { prompt: "keep working", description: "shutdown task", subagent_type: "general-purpose" },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    await vi.advanceTimersByTimeAsync(1);
    const result = await execution;
    const id = textOf(result).match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const record = registry.getRecord(id) as any;
    const cleanup = vi.fn();
    record.outputCleanup = cleanup;

    await lifecycle.get("session_shutdown")?.({}, ctx());
    await record.promise;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(record.status).toBe("stopped");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(record.outputCleanup).toBeUndefined();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("shows and persists Foreground timeout in /agents Settings", async () => {
    initTheme(undefined, false);
    const { pi, lifecycle, commands } = makePi();
    subagentsExtension(pi);
    const rendered: string[] = [];
    const select = vi.fn()
      .mockResolvedValueOnce("Settings")
      .mockResolvedValueOnce(undefined);
    const invalidTimeout = String(FOREGROUND_TIMEOUT_CEILING_MS + 1);
    const validTimeout = String(FOREGROUND_TIMEOUT_CEILING_MS);
    const input = vi.fn()
      .mockResolvedValueOnce(invalidTimeout)
      .mockResolvedValueOnce(validTimeout);
    const notify = vi.fn();
    const custom = vi.fn()
      .mockImplementationOnce((factory: any) => new Promise(resolve => {
        const component = factory(
          { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } },
          {},
          undefined,
          resolve,
        );
        rendered.push(...component.render(120));
        component.handleInput("\x1b[B"); // Foreground timeout is the second numeric row.
        component.handleInput("\r");
      }))
      .mockImplementationOnce(async (factory: any) => {
        const component = factory(
          { requestRender: vi.fn(), terminal: { rows: 40, columns: 120 } },
          {},
          undefined,
          vi.fn(),
        );
        rendered.push(...component.render(120));
        return undefined;
      });
    const commandCtx = {
      ...ctx(),
      hasUI: true,
      ui: {
        ...ctx().ui,
        select,
        input,
        custom,
        notify,
      },
    } as any;

    await commands.get("agents").handler("", commandCtx);

    expect(rendered.join("\n")).toContain("Foreground timeout");
    const label = "Foreground timeout in milliseconds (0 = disabled)";
    expect(input.mock.calls).toEqual([
      [label, "0"],
      [label, invalidTimeout],
    ]);
    expect(JSON.parse(readFileSync(join(tmpDir, ".pi", "subagents.json"), "utf-8")).foregroundTimeoutMs)
      .toBe(FOREGROUND_TIMEOUT_CEILING_MS);
    expect(notify).toHaveBeenCalledWith(
      `Foreground timeout set to ${FOREGROUND_TIMEOUT_CEILING_MS} ms`,
      "info",
    );
    expect(notify.mock.calls.flat().join(" ")).not.toContain(invalidTimeout);
    await lifecycle.get("session_shutdown")?.({}, commandCtx);
  });

  it("IS evicted by a session switch — its result was already delivered inline", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const { id } = await runForegroundSteeredAgent(tools);

    // Foreground results count as consumed the moment they're returned inline,
    // so clearCompleted(true)'s #108 preservation deliberately does not cover
    // them. This is the ONLY path that makes a foreground id stop resolving.
    await lifecycle.get("session_before_switch")?.();

    const read = await tools.get("get_subagent_result").execute("tc-read", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain("Agent not found");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
