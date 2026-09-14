/**
 * workflow-dialog-open-agent.test.ts — the inspector's `c` key, end to end.
 *
 * `workflow-dialog.test.ts` proves the key raises the action and the footer
 * advertises it; this proves the half only the real extension can: that a
 * child's manager record id actually reaches the row (runtime → host →
 * progress entry), that `c` opens THAT record's conversation as a second
 * overlay, and that the dialog hides itself underneath rather than leaving its
 * frame peeking around the viewer.
 *
 * Without the id on the row there is nothing to open, so the run's agents were
 * the one part of the fleet with no way to read what they did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Enough of a pi session for the manager to keep, and the viewer to render. */
const fakeSession = () => ({
  dispose: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  messages: [],
  getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
});

/** One overlay the extension asked `ui.custom` for, held open like a real one. */
interface OpenOverlay {
  options: { overlay?: boolean; onHandle?: (handle: unknown) => void };
  instance: { handleInput?(data: string): void; render?(width: number): string[]; dispose?(): void };
  /** Resolve the overlay's promise, as closing it does. */
  close(): void;
}

/**
 * A ctx whose `ui.custom` keeps overlays OPEN.
 *
 * The other workflow tests close each overlay the moment it is built, which is
 * enough to assert on wiring. Here the dialog has to stay up while a second
 * overlay opens on top of it, because that stacking is the thing under test.
 */
function overlayCtx() {
  const overlays: OpenOverlay[] = [];
  const hidden: boolean[] = [];
  let entryTaken = false;
  const context = ctx({
    ui: {
      notify: vi.fn(),
      select: vi.fn(async (title: string, options: string[]) => {
        if (title !== "Agents" || entryTaken) return undefined;
        entryTaken = true;
        return options.find(option => /^Workflows \(\d+\)$/.test(option));
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: OpenOverlay["options"]) => {
        // `terminal` included: the conversation viewer sizes itself off it, so
        // a bare `requestRender` stub would throw on the second overlay.
        const tui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        return await new Promise(resolve => {
          const instance = factory(tui, theme, undefined, resolve) as OpenOverlay["instance"];
          overlays.push({ options: options ?? {}, instance, close: () => resolve(undefined) });
          options?.onHandle?.({ setHidden: (value: boolean) => hidden.push(value) });
        });
      }),
    },
  });
  return { context, overlays, hidden };
}

describe("the inspector opens a workflow agent's conversation", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { workflowsEnabled: true } });
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      const session = fakeSession();
      opts.onSessionCreated?.(session as any);
      return { responseText: "child done", session: session as any, aborted: false, steered: false };
    });
  });
  afterEach(() => {
    vi.mocked(runAgent).mockReset();
    hermetic.restore();
  });

  /** Boot the extension and start a one-agent run in the background. */
  async function bootWithChild() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const command = booted.commands.get("agents");
    if (!command) throw new Error("the extension did not register /agents");
    await booted.tools.get("SubagentWorkflow").execute(
      "tc-0",
      {
        script:
          'export const meta = { name: "wf", description: "d" };\n' +
          'return await agent("read the routes", { label: "child" });\n',
      },
      undefined,
      undefined,
      ctx({ cwd: hermetic.dir }),
    );
    return { ...booted, command };
  }

  it("carries the child's record id onto the row and opens its conversation on c", async () => {
    const { command } = await bootWithChild();
    const ui = overlayCtx();

    // Not awaited: the dialog overlay stays open, which is the point.
    void command.handler("", ui.context);
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(1));
    const dialog = ui.overlays[0].instance;

    // The footer is live, so waiting on it is waiting for the id to travel
    // host → runtime → progress entry → row. Until it lands there is nothing
    // to open and the key is correctly not advertised.
    await vi.waitFor(() => expect(dialog.render?.(120).at(-1)).toContain("c convo"));

    dialog.handleInput?.("c");
    await vi.waitFor(() => expect(ui.overlays).toHaveLength(2));

    // A second overlay, on the viewer's own terms — not the dialog reused.
    expect(ui.overlays[1].options.overlay).toBe(true);
    expect(ui.overlays[1].instance.constructor.name).toBe("ConversationViewer");
    // ...with the dialog hidden underneath it: the two frames size themselves
    // to different content, so the taller one's edges would show around the
    // shorter.
    expect(ui.hidden).toEqual([true]);

    ui.overlays[1].close();
    // And back, so closing the conversation returns to the run it was opened
    // from rather than to an empty screen.
    await vi.waitFor(() => expect(ui.hidden).toEqual([true, false]));

    ui.overlays[0].close();
  });
});
