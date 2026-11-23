/**
 * workflow-stale-pi.test.ts — a workflow that settles after its session was
 * replaced (/new, /reload) holds a stale `pi`, whose UI calls throw (#309).
 * `notifyWorkflowFinished`'s redraws run inside a detached promise, so an
 * unguarded throw there escapes as an unhandled rejection. This pins the guard:
 * the settle swallows the stale redraw and still hands the completion to the
 * outbox.
 *
 * The workflow is held open by a mocked agent that resolves only when the test
 * says so, so `stale` is in effect before the run settles — no completion race.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

// Awaits one agent, then settles. The agent is the test's lever on when the
// whole run completes.
const script =
  'export const meta = { name: "quick", description: "settles when its agent does" };\n' +
  'await agent("hi", { label: "a" });\nreturn 1;\n';

describe("workflow completion on a stale pi", () => {
  let hermetic: Hermetic;

  afterEach(async () => {
    await flush();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic.restore();
    vi.restoreAllMocks();
  });

  it("swallows the stale redraw and still notifies, with no unhandled rejection", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true, outputTranscript: false } });

    // The agent stays pending until the test resolves it, holding the run open.
    let resolveAgent: (v: any) => void = () => {};
    vi.mocked(runAgent).mockImplementation(() => new Promise<any>(resolve => { resolveAgent = resolve; }) as any);

    // The UI the session bound; healthy until the session is replaced, then its
    // calls throw the way a disposed pi context does.
    let stale = false;
    const throwIfStale = () => { if (stale) throw new Error("stale pi context (#309)"); };
    const ui = {
      setStatus: vi.fn(throwIfStale),
      setWidget: vi.fn(throwIfStale),
      notify: vi.fn(),
      addAutocompleteProvider: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
    };

    const booted = makePi();
    // Non-fullscreen, so renderResult tracks the card and returns early.
    booted.pi.getSettings.mockReturnValue({ tuiMode: "regular" });
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode: "tui", hasUI: true, ui });
    await booted.lifecycle.get("session_start")({}, context);
    await booted.lifecycle.get("agent_start")({}, context);

    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      // Launch time: the tool's own widget.update() runs here, UI still healthy.
      const started = await booted.tools.get("SubagentWorkflow").execute(
        "tc-wf", { script }, undefined, undefined, context,
      );
      expect(started.content[0].text).toContain("started in the background");

      // Render the run's card so a redraw handle (renderContext.invalidate) is
      // tracked for it — that handle is what notifyWorkflowFinished's
      // workflowCards.flush() calls, and the one that throws once stale.
      const theme = { fg: (_cls: string, text: string) => text } as any;
      booted.tools.get("SubagentWorkflow").renderResult(
        started, {}, theme, { isError: false, invalidate: throwIfStale },
      );

      // Wait until the run's agent is actually in flight (the worker has reached
      // `agent()`), so resolving it settles the whole run.
      await vi.waitFor(() => expect(vi.mocked(runAgent)).toHaveBeenCalled(), { timeout: 2000 });

      // The session is replaced before the run settles: its captured UI is stale.
      // The agent's own completion redraws are guarded by the manager; the one
      // under test is the workflow's notifyWorkflowFinished.
      stale = true;
      // Release the agent → the workflow returns and settles against the stale UI.
      resolveAgent({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });

      // notifyWorkflowFinished fires the stale redraw, then queues the outbox
      // notification. The parent is mid-run, so the outbox holds until a
      // boundary: drive turn_end (a no-op until the item lands) until the
      // notification sends. Its arrival proves the settle survived the redraw
      // throw and reached outbox.add.
      await vi.waitFor(
        async () => {
          await flush();
          await booted.lifecycle.get("turn_end")({ message: { role: "assistant", stopReason: "end_turn" } }, context);
          expect(
            booted.pi.sendMessage.mock.calls.some((c: any[]) => c[0]?.customType === "subagent-notification"),
          ).toBe(true);
        },
        { timeout: 2000 },
      );

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
