/**
 * workflow-command.test.ts — the `/agents → Workflows` run inspector.
 *
 * The dialog itself is covered by workflow-dialog.test.ts; what is untested
 * until here is the screen around it: what happens with no runs, one run, or
 * several, and that stopping from the dialog actually aborts the run rather
 * than only looking like it did.
 *
 * It is reached through the agents menu rather than its own command, so every
 * test here drives `/agents` and picks the entry — which also pins that the
 * entry exists and is spelled the way the menu router expects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Boot the real extension and hand back its `/agents` command. */
function bootCommand() {
  const booted = makePi();
  subagentsExtension(booted.pi);
  const command = booted.commands.get("agents");
  if (!command) throw new Error("the extension did not register /agents");
  return { ...booted, command };
}

/** The agents-menu entry that opens the inspector. */
const WORKFLOWS_ENTRY = /^Workflows \(\d+\)$/;

/**
 * A command ctx whose `ui.custom` immediately builds the component, captures it,
 * and closes it — enough to exercise the wiring without a terminal.
 */
function commandCtx() {
  const notes: { text: string; level?: string }[] = [];
  const built: unknown[] = [];
  const customOptions: unknown[] = [];
  let selectFrom: string[] = [];
  let selectPick: string | undefined;
  let entryTaken = false;
  let agentsOptions: string[] = [];
  const context = ctx({
    ui: {
      notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
      // Two different pickers come through here: the agents menu, then the
      // inspector's own "which run". Take the Workflows entry exactly once, so
      // the menu closes on the way back out instead of looping.
      select: vi.fn(async (title: string, options: string[]) => {
        if (title === "Agents") {
          agentsOptions = options;
          if (entryTaken) return undefined;
          entryTaken = true;
          return options.find(option => WORKFLOWS_ENTRY.test(option));
        }
        selectFrom = options;
        return selectPick;
      }),
      custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: unknown) => {
        const tui = { requestRender: () => {} };
        const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        const instance = factory(tui, theme, {}, () => {}) as { dispose?: () => void };
        built.push(instance);
        customOptions.push(options);
        instance.dispose?.();
        return undefined;
      }),
    },
  });
  return {
    context,
    notes,
    built,
    customOptions,
    setPick: (value: string | undefined) => { selectPick = value; },
    offered: () => selectFrom,
    /** What the agents menu listed — the entry has to be there to be reachable. */
    agentsMenu: () => agentsOptions,
    /** Whether the inspector's own picker ran, as opposed to the agents menu. */
    askedWhichRun: () => selectFrom.length > 0,
    /** Arm the one-shot entry pick again, for a second trip through the menu. */
    reopen: () => { entryTaken = false; },
  };
}

describe("/agents → Workflows", () => {
  let hermetic: Hermetic;

  // Workflows are opt-in, so every test that expects the feature to exist has
  // to turn it on — the same thing a user does once in /agents → Settings.
  beforeEach(() => { hermetic = hermeticDir({ settings: { workflowsEnabled: true } }); });
  afterEach(() => { hermetic.restore(); });

  it("registers no top-level /workflows command", () => {
    // It lives under /agents instead, deliberately: pi renames a duplicate
    // command to `/workflows:1` and `/workflows:2`, which breaks the bare name
    // for both extensions. Pinned because re-adding it would be silent.
    const booted = bootCommand();
    expect(booted.commands.has("workflows")).toBe(false);
  });

  it("offers the entry in the agents menu", async () => {
    const { command } = bootCommand();
    const ui = commandCtx();

    await command.handler("", ui.context);

    expect(ui.agentsMenu().some(option => WORKFLOWS_ENTRY.test(option))).toBe(true);
  });

  it("hides the entry when workflows are off", async () => {
    hermetic.restore();
    hermetic = hermeticDir({ settings: { workflowsEnabled: false } });
    const { command } = bootCommand();
    const ui = commandCtx();

    await command.handler("", ui.context);

    // The menu never advertises a switched-off feature; Settings is where it
    // gets turned on, and that entry is right there.
    expect(ui.agentsMenu().some(option => WORKFLOWS_ENTRY.test(option))).toBe(false);
  });

  it("says so when the session has no workflows", async () => {
    const { command } = bootCommand();
    const ui = commandCtx();
    await command.handler("", ui.context);
    expect(ui.notes.map(n => n.text).join("\n")).toMatch(/No workflows/i);
    // Nothing to inspect, so no dialog should have been opened.
    expect(ui.built).toHaveLength(0);
  });

  it("does not prompt for a choice when there is nothing to choose", async () => {
    const { command } = bootCommand();
    const ui = commandCtx();
    await command.handler("", ui.context);
    expect(ui.askedWhichRun()).toBe(false);
  });

  describe("with runs in the session", () => {
    const script = (name: string) =>
      `export const meta = { name: "${name}", description: "d" };\nreturn 1;\n`;

    /** Boot, then start `count` workflows so the session has tasks to inspect. */
    async function withRuns(count: number) {
      const booted = bootCommand();
      const runCtx = ctx({ cwd: hermetic.dir });
      for (let i = 0; i < count; i++) {
        await booted.tools.get("SubagentWorkflow").execute(`tc-${i}`, { script: script(`wf-${i}`) }, undefined, undefined, runCtx);
      }
      return booted;
    }

    it("opens the dialog directly when exactly one run exists", async () => {
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      // Straight to the dialog — asking which of one is noise.
      expect(ui.askedWhichRun()).toBe(false);
      expect(ui.built).toHaveLength(1);
    });

    it("asks which run when several exist, newest first", async () => {
      const { command } = await withRuns(3);
      const ui = commandCtx();
      ui.setPick(undefined);
      await command.handler("", ui.context);
      const offered = ui.offered();
      expect(offered).toHaveLength(3);
      // Most recent at the top: that is nearly always the one being asked about.
      expect(offered[0]).toContain("wf-2");
      expect(offered[2]).toContain("wf-0");
      // Cancelling the picker must not open anything.
      expect(ui.built).toHaveLength(0);
    });

    it("actually aborts the run when stopped from the dialog", async () => {
      // The consequential action: it must abort, not merely look like it did.
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const dialog = ui.built[0] as { handleInput(data: string): void };
      dialog.handleInput("x");
      expect(ui.notes.map(n => n.text).join("\n")).toMatch(/Stopped workflow "wf-0"/);
    });

    it("does not re-announce a stop for an already-aborted run", async () => {
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const dialog = ui.built[0] as { handleInput(data: string): void };
      dialog.handleInput("x");
      dialog.handleInput("x");
      const stops = ui.notes.filter(n => /Stopped workflow/.test(n.text));
      expect(stops).toHaveLength(1);
    });

    it("keeps the labels distinct so identical runs do not collide", async () => {
      // Two runs of the same script share a name, a status and an agent count,
      // and `select` hands back the string — so without the run id the picker
      // would open the first whichever the user chose.
      const { command } = await withRuns(2);
      const ui = commandCtx();
      await command.handler("", ui.context);

      const offered = ui.offered();
      expect(new Set(offered).size).toBe(offered.length);
      for (const label of offered) expect(label).toMatch(/wf_[0-9a-f]+$/);
    });

    it("opens the run the user picked", async () => {
      const { command } = await withRuns(2);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const offered = ui.offered();
      ui.setPick(offered[1]);
      ui.reopen();
      await command.handler("", ui.context);
      expect(ui.built).toHaveLength(1);
    });

    it("pauses and resumes the run from the dialog", async () => {
      // The whole path: the key reaches the task, the task reaches the run's
      // control surface, and the run's new state comes back out in the footer.
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);
      const dialog = ui.built[0] as { handleInput(d: string): void; render(w: number): string[] };
      expect(dialog.render(100).at(-1)).toContain("p pause");

      dialog.handleInput("p");
      // Said plainly: "paused" on a run whose agents are still finishing
      // promises more than it delivers.
      expect(ui.notes.at(-1)?.text).toMatch(/Paused — running agents finish/);
      expect(dialog.render(100).at(-1)).toContain("p resume");

      dialog.handleInput("p");
      expect(ui.notes.at(-1)?.text).toMatch(/Resumed/);
      expect(dialog.render(100).at(-1)).toContain("p pause");
    });

    it("opens as a centered overlay, like the conversation viewer beside it", async () => {
      // Not an overlay means inline: the frame renders into the conversation
      // and stays in the scrollback afterwards, and opening a run from the
      // fleet list behaves unlike opening the agent row directly above it.
      const { command } = await withRuns(1);
      const ui = commandCtx();
      await command.handler("", ui.context);

      const options = ui.customOptions[0] as {
        overlay?: boolean;
        overlayOptions?: { anchor?: string; width?: string; maxHeight?: string };
      };
      expect(options?.overlay).toBe(true);
      expect(options?.overlayOptions?.anchor).toBe("center");
    });
  });
});
