import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { getDisplayName } from "../src/ui/agent-widget.js";
import {
  FleetList,
  type FleetUICtx,
  type FleetWorkflow,
  formatFleetElapsed,
  formatFleetTokens,
} from "../src/ui/fleet-list.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE for ↓ (event type 3) — listeners receive these too.
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

/** An agent that renders as a badge — no default agent configures a color. */
const BADGED_TYPE = "colored-reviewer";
const PURPLE_BACKGROUND = "\u001b[48;2;130;125;189m";
const BADGED_CONFIG: AgentConfig = {
  name: BADGED_TYPE,
  displayName: "Code Reviewer",
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

/**
 * Visible text of a rendered row: ANSI stripped, along with this theme's fake
 * `<color>` / `*bold*` markers — all three stand in for zero-width escapes.
 */
function plain(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

/** A no-op session so a record is "openable" by default (the list hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: () => true,
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  /** Replace the workflow runs the list sees, and re-render. */
  setWorkflows: (list: FleetWorkflow[]) => void;
  /** Ids the list asked the extension to open, in order. */
  openedWorkflows: () => string[];
  /** Settle the workflow dialog the list last opened; flushes the close microtask. */
  closeWorkflowDialog: () => Promise<void>;
  /** The overlay component (a real ConversationViewer) once one is opened. */
  overlayComponent: () => { handleInput(data: string): void } | undefined;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  /** Render the currently-registered below-editor widget at the given width. */
  render: (width?: number) => string[];
  setEditorText: (t: string) => void;
  /** Whether an overlay has been opened. */
  overlayOpened: () => boolean;
  /** Whether the most recently opened overlay's `done` was invoked (closed). */
  overlayClosed: () => boolean;
  /** Simulate the viewer closing itself (Esc → done); flushes the close microtask. */
  closeOverlay: () => Promise<void>;
  /** The fake `tui` handed to the widget factory; tests set `focusedComponent` on it. */
  widgetTui: { requestRender(): void; focusedComponent?: unknown };
}

function makeWorkflow(over: Partial<FleetWorkflow> = {}): FleetWorkflow {
  return {
    id: "wf_abc123",
    name: "audit-src",
    status: "running",
    doneCount: 1,
    totalCount: 3,
    startedAt: Date.now() - 32_000,
    tokens: 26_400,
    ...over,
  };
}

function harness(agents: AgentRecord[]): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
  let overlayComponent: { handleInput(data: string): void } | undefined;
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    setWidget: (_key, content) => { widgetFactory = content as any; },
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    notify: () => {},
    custom: ((factory: any) => {
      opened = true;
      return new Promise<undefined>((resolve) => {
        const done = (r: undefined) => { closed = true; overlayDone = undefined; resolve(r); };
        overlayDone = done;
        // Construct the overlay component so the controller wires viewerClose,
        // and keep it so tests can drive the real ConversationViewer's input.
        overlayComponent = factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, new Map());
  fleet.setUICtx(ui);
  let workflows: FleetWorkflow[] = [];
  const openedWorkflows: string[] = [];
  let closeWorkflowDialog: (() => void) | undefined;
  fleet.setWorkflowSource(() => workflows, id => {
    openedWorkflows.push(id);
    // The real opener hands back the dialog's promise, so the list can put the
    // cursor back when it closes. Held open here until a test resolves it.
    return new Promise<void>(resolve => { closeWorkflowDialog = () => resolve(); });
  });
  fleet.update();

  return {
    fleet,
    setWorkflows: (list: FleetWorkflow[]) => { workflows = list; fleet.update(); },
    openedWorkflows: () => openedWorkflows,
    closeWorkflowDialog: async () => { closeWorkflowDialog?.(); await Promise.resolve(); },
    ui,
    manager,
    overlayComponent: () => overlayComponent,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
    widgetTui: fakeTui,
  };
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList navigation", () => {
  it("does not register a widget when there are no agents", () => {
    const h = harness([]);
    expect(h.render()).toEqual([]);
  });

  it("hides nested child records from the coordinator fleet", () => {
    const h = harness([
      makeRecord({ id: "top", description: "top-level" }),
      makeRecord({ id: "nested", description: "nested-child", parentAgentId: "top" }),
    ]);
    const output = h.render().join("\n");
    expect(output).toContain("top-level");
    expect(output).not.toContain("nested-child");
  });

  it("activates on ↓ at an empty prompt, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(DOWN);
    expect(res).toEqual({ consume: true });
    // main selected, list active → nav hint shown
    expect(h.render().some(l => l.includes("enter view"))).toBe(true);
  });

  it("also activates on ← (matches the '← for agents' hint)", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("does NOT activate when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(DOWN)).toBeUndefined();
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN);          // activate → selection on main (idx 0)
    h.press(DOWN_RELEASE);  // release half of the SAME tap — must be a no-op
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    h.press(DOWN);          // a real second tap → first agent
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });

  it("renders the whole selected row in the theme's primary text color (#230)", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.press(DOWN); // activate → main
    h.press(DOWN); // → a1
    const selected = h.render().find(l => l.includes("one"))!;
    // Selection marker keeps accent color; row content uses primary text color.
    expect(selected).toContain("<accent>●</accent>");
    expect(selected).toContain("<text>one</text>");
    expect(selected).toMatch(/<text>\d+s · ↓ [\d.]+k? tokens<\/text>/);
    // Agent display name rendered with the text token too (this type has no badge).
    expect(selected).toContain(`<text>${getDisplayName("general-purpose")}</text>`);
    // Inactive rows keep the muted/dim treatment.
    const unselected = h.render().find(l => l.includes("two"))!;
    expect(unselected).toContain("<dim>○</dim>");
    expect(unselected).toMatch(/<dim>\d+s · ↓ [\d.]+k? tokens<\/dim>/);
    expect(unselected).not.toContain("<text>");
  });

  it("keeps a color badge on the selected row, bolded, without shifting it (#230)", () => {
    registerAgents(new Map([[BADGED_TYPE, BADGED_CONFIG]]));
    try {
      const h = harness([
        makeRecord({ id: "a1", type: BADGED_TYPE, description: "one" }),
        makeRecord({ id: "a2", type: BADGED_TYPE, description: "two" }),
      ]);
      h.press(DOWN); // activate → main
      const before = h.render().find(l => l.includes("one"))!;
      expect(before).toContain(`${PURPLE_BACKGROUND}`);
      expect(before).toContain(` ${BADGED_CONFIG.displayName} `);

      h.press(DOWN); // → a1
      const selected = h.render().find(l => l.includes("one"))!;
      // Selection bolds the badge rather than repainting it (Claude Code's FleetView) …
      expect(selected).toContain(PURPLE_BACKGROUND);
      expect(selected).toContain(`* ${BADGED_CONFIG.displayName} *`);
      expect(selected).not.toContain(`<text>${BADGED_CONFIG.displayName}`);
      // … so the description stays in the same column as when unselected.
      expect(plain(selected).indexOf("one")).toBe(plain(before).indexOf("one"));
    } finally {
      registerAgents(new Map());
    }
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate → index 0 (main)
    h.press(DOWN); // → 1 (a1)
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    h.press(DOWN); // → 2 (a2)
    h.press(DOWN); // clamp at 2
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("one"))).toContain("○");
  });

  it("↑ above 'main' deactivates (returns to the prompt)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // activate, index 0
    expect(h.press(UP)).toEqual({ consume: true });
    // back to inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("Esc deactivates", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(ESC)).toEqual({ consume: true });
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("passes non-nav keys through and cancels navigation", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN);
    expect(h.press(RIGHT)).toBeUndefined();
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("ignores all input while disabled and hides the widget", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.render()).toEqual([]);
  });

  it("re-arms the refresh timer when the list is re-shown (toggle off→on)", () => {
    vi.useFakeTimers();
    try {
      const agents = [makeRecord({ id: "a1" })];
      const listAgents = vi.fn(() => agents);
      const manager = { listAgents, abort: () => true } as unknown as AgentManager;
      const fleet = new FleetList(manager, new Map());
      fleet.setUICtx({
        setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "",
        notify: () => {}, custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
      });
      fleet.update();          // shows list, arms the timer
      fleet.setEnabled(false); // hides, clears the timer
      fleet.setEnabled(true);  // re-shows — must re-arm the timer
      const before = listAgents.mock.calls.length;
      vi.advanceTimersByTime(250); // a tick should fire and re-read the roster
      expect(listAgents.mock.calls.length).toBeGreaterThan(before);
      fleet.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** A minimal real Editor — what pi focuses at the prompt (CustomEditor extends it). */
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  /** Hand the fleet list its `tui` (happens on first widget render in pi) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.widgetTui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ↓ from a focused selector (activation)", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(DOWN)).toBeUndefined(); // must flow through to the selector
  });

  it("does not steal navigation keys from a selector opened while the list was active", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true }); // activate at the prompt
    focusInHarness(h, { kind: "selector" });          // a dialog takes focus
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // and the list dropped back to its inactive hint
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("still activates when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(DOWN)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No render yet → the list has never seen a tui: activation must still work.
    expect(h.press(DOWN)).toEqual({ consume: true });
  });
});

describe("FleetList rendering", () => {
  it("renders main + agent rows with markers, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    // hint + blank + main + one agent
    expect(lines[0]).toContain("← for agents");
    expect(lines.find(l => l.includes("main"))).toContain("●"); // main selected by default
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("○");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("↓ 13.1k tokens");
    expect(agentLine).toMatch(/\d+s · ↓/); // "<seconds>s · ↓ ..." (timing-agnostic)
  });

  it("orders agents earliest-launched first (top)", () => {
    const agents = [
      makeRecord({ id: "new", description: "newest", startedAt: 2000 }),
      makeRecord({ id: "old", description: "oldest", startedAt: 1000 }),
    ];
    const lines = harness(agents).render();
    const oldIdx = lines.findIndex(l => l.includes("oldest"));
    const newIdx = lines.findIndex(l => l.includes("newest"));
    expect(oldIdx).toBeGreaterThanOrEqual(0);
    expect(oldIdx).toBeLessThan(newIdx); // earliest sits above the later one
  });

  it("hides agents that have no session yet (pending)", () => {
    const agents = [
      makeRecord({ id: "live", description: "running one" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ];
    const lines = harness(agents).render();
    expect(lines.some(l => l.includes("running one"))).toBe(true);
    expect(lines.some(l => l.includes("queued one"))).toBe(false);
  });

  it("collapses overflow into a '↓ N more' indicator", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    const lines = h.render(120);
    // 8 agents, cap 5 visible → "↓ 3 more"
    expect(lines.some(l => l.includes("↓ 3 more"))).toBe(true);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  it("windows the visible agents so the selection stays on screen", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.press(DOWN); // activate (main)
    // step down to the last agent (8 agents → roster index 8)
    for (let i = 0; i < 8; i++) h.press(DOWN);
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("●");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
  });
});

describe("FleetList overlay lifecycle", () => {
  it("Enter on 'main' just deactivates (no overlay)", () => {
    const h = harness([makeRecord()]);
    h.press(DOWN); // active, index 0 (main)
    h.press(ENTER);
    expect(h.overlayOpened()).toBe(false); // never opened an overlay
    expect(h.render().some(l => l.includes("← for agents"))).toBe(true);
  });

  it("keeps the cursor on the viewed agent after closing, even if the list reordered", async () => {
    const fakeSession = { subscribe: () => () => {}, messages: [] };
    const agents = [
      makeRecord({ id: "a1", description: "one", session: fakeSession as any }),
      makeRecord({ id: "a2", description: "two", session: fakeSession as any }),
      makeRecord({ id: "a3", description: "three", session: fakeSession as any }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate (main, idx 0)
    h.press(DOWN); // a1 (idx 1)
    h.press(DOWN); // a2 (idx 2)
    h.press(ENTER); // open a2
    // a1 finishes and drops out while viewing → a2 shifts from idx 2 to idx 1.
    agents.splice(0, 1);
    await h.closeOverlay();
    // Selection follows a2 ("two") to its new position, not whatever is at idx 2 now.
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    expect(h.render().find(l => l.includes("three"))).toContain("○");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN);  // activate (main)
    h.press(DOWN);  // → the agent
    h.press(ENTER); // open the conversation viewer

    const viewer = h.overlayComponent();
    expect(viewer).toBeDefined();
    viewer!.handleInput("\r");                       // Enter → open composer
    for (const ch of "go left") viewer!.handleInput(ch);
    viewer!.handleInput("\r");                       // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    h.press(DOWN); // active (main)
    h.press(DOWN); // → the agent
    h.press(ENTER); // opens overlay
    expect(h.overlayOpened()).toBe(true);
    // The agent finishes, well past the linger window...
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlayClosed()).toBe(false);                          // viewer stays open
    expect(h.render().some(l => l.includes("the one"))).toBe(true); // and stays listed while viewed
  });

  it("lingers a finished agent in the list, then drops it after the window", () => {
    const recent = makeRecord({ id: "r", description: "recent done", status: "completed", completedAt: Date.now() });
    expect(harness([recent]).render().some(l => l.includes("recent done"))).toBe(true);
    const old = makeRecord({ id: "o", description: "old done", status: "completed", completedAt: Date.now() - 60_000 });
    expect(harness([old]).render().some(l => l.includes("old done"))).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Workflow runs
 * ------------------------------------------------------------------------- */

describe("FleetList workflow rows", () => {
  it("renders identically with no workflow source and an empty one", () => {
    // The contract: a session without workflows behaves exactly as it did
    // before they existed. Asserted as an equality rather than an absence, so
    // a future change to the roster cannot quietly alter the agents-only path.
    const withNone = harness([makeRecord({ id: "a1", description: "one" })]);
    const before = withNone.render().join("\n");
    expect(before).not.toContain("workflow");

    const withEmpty = harness([makeRecord({ id: "a1", description: "one" })]);
    withEmpty.setWorkflows([]);
    expect(withEmpty.render().join("\n")).toBe(before);
  });

  it("navigates agents exactly as before when no run is present", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.setWorkflows([]);

    expect(h.press(DOWN)?.consume).toBe(true);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);

    // The second agent, not a run and not `main`.
    expect(h.overlayOpened()).toBe(true);
    expect(h.openedWorkflows()).toEqual([]);
  });

  it("clears the widget when the last run and the last agent both go", () => {
    const h = harness([]);
    h.setWorkflows([makeWorkflow()]);
    expect(h.render().length).toBeGreaterThan(0);

    h.setWorkflows([]);
    expect(h.render()).toEqual([]);
  });

  it("lists a run above the agents, with its counts and stats", () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([makeWorkflow()]);

    const rows = h.render().map(plain).filter(row => row.trim() !== "");
    const run = rows.find(row => row.includes("audit-src"))!;
    const agent = rows.findIndex(row => row.includes("one"));
    expect(run).toContain("workflow");
    expect(run).toContain("1/3 agents");
    expect(run).toContain("26.4k tokens");
    // A run owns most of the agents under it, so the container comes first.
    expect(rows.findIndex(row => row.includes("audit-src"))).toBeLessThan(agent);
  });

  it("agrees with itself about a single-agent run", () => {
    const h = harness([]);
    h.setWorkflows([makeWorkflow({ doneCount: 1, totalCount: 1 })]);
    expect(h.render().map(plain).join("\n")).toContain("1/1 agent ");
  });

  it("hides the run's own agents — the run is the row that represents them", () => {
    // A 40-agent fan-out would otherwise push every other agent off the list,
    // and each child is already reachable inside the workflow dialog.
    const h = harness([
      makeRecord({ id: "a1", description: "mine" }),
      makeRecord({ id: "w1", description: "the workflow's", workflowId: "wf_abc123" }),
    ]);
    h.setWorkflows([makeWorkflow()]);

    const rendered = h.render().map(plain).join("\n");
    expect(rendered).toContain("mine");
    expect(rendered).toContain("audit-src");
    expect(rendered).not.toContain("the workflow's");
  });

  it("moves into the list when the only row is a run", () => {
    // The regression this guards: activation counted agents, so a session
    // running nothing but a workflow rendered the row and then refused to
    // move into it.
    const h = harness([]);
    h.setWorkflows([makeWorkflow({ id: "wf_only" })]);

    // The first ↓ moves focus into the list and lands on `main`, as it always
    // has; the second reaches the only other row.
    expect(h.press(DOWN)?.consume, "↓ at an empty prompt has somewhere to go").toBe(true);
    h.press(DOWN);
    h.press(ENTER);

    expect(h.openedWorkflows()).toEqual(["wf_only"]);
  });

  it("still does nothing at an empty prompt with no rows at all", () => {
    const h = harness([]);
    expect(h.press(DOWN)?.consume).toBeFalsy();
  });

  it("opens the selected run rather than a conversation viewer", () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([makeWorkflow({ id: "wf_pick" })]);

    h.press(LEFT);
    h.press(DOWN);
    h.press(ENTER);

    expect(h.openedWorkflows()).toEqual(["wf_pick"]);
    // The workflow dialog owns its own overlay; the list must not open one.
    expect(h.overlayOpened()).toBe(false);
  });

  const NOW = Date.now();

  /** Open the second of two runs, leaving the inspector up. */
  function openSecondRun() {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([
      makeWorkflow({ id: "wf_a", name: "audit-src", startedAt: NOW - 30_000 }),
      makeWorkflow({ id: "wf_b", name: "review-changes", startedAt: NOW - 20_000 }),
    ]);
    h.render();
    h.press(LEFT);
    h.press(DOWN);
    h.press(DOWN);
    expect(h.openedWorkflows()).toEqual([]);
    h.press(ENTER);
    expect(h.openedWorkflows()).toEqual(["wf_b"]);
    return h;
  }

  it("keeps its hands off the keyboard while the inspector is up", () => {
    // The list only stays out of an overlay's keys when it knows one is open.
    // Focus alone is not enough: `editorHasFocus` reads unknowable focus as
    // the editor's, which is exactly the state a fresh overlay leaves behind,
    // and the list would then eat the arrow keys the dialog is waiting for.
    const h = openSecondRun();

    expect(h.press(DOWN)?.consume, "the dialog's keys are not the list's").toBeFalsy();
    expect(h.press(ENTER)?.consume).toBeFalsy();
    // And nothing moved behind it — one ENTER opened one run.
    expect(h.openedWorkflows()).toEqual(["wf_b"]);
  });

  it("comes back to the same run when the inspector closes", async () => {
    // Runs settle and start while the dialog is open, so the row the reader
    // came from is not reliably where it was. The agent path re-finds its row
    // by id for the same reason; a run has to be findable the same way.
    const h = openSecondRun();

    h.setWorkflows([
      makeWorkflow({ id: "wf_a", name: "audit-src", startedAt: NOW - 30_000 }),
      makeWorkflow({ id: "wf_new", name: "started-meanwhile", startedAt: NOW - 25_000 }),
      makeWorkflow({ id: "wf_b", name: "review-changes", startedAt: NOW - 20_000 }),
    ]);
    await h.closeWorkflowDialog();

    expect(h.render().find(l => l.includes("review-changes"))).toContain("●");
    expect(h.render().find(l => l.includes("started-meanwhile"))).not.toContain("●");
  });

  it("still opens an agent's viewer when the selection is past the runs", () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([makeWorkflow()]);

    h.press(LEFT);
    h.press(DOWN);
    h.press(DOWN);
    h.press(ENTER);

    expect(h.openedWorkflows()).toEqual([]);
    expect(h.overlayOpened()).toBe(true);
  });

  it("drops a settled run once it stops lingering, and keeps a live one", () => {
    const h = harness([]);
    h.setWorkflows([
      makeWorkflow({ id: "wf_old", name: "old", status: "completed", completedAt: Date.now() - 60 * 60_000 }),
      makeWorkflow({ id: "wf_now", name: "now" }),
    ]);

    const rendered = h.render().map(plain).join("\n");
    expect(rendered).toContain("now");
    expect(rendered).not.toContain("old");
  });

  it("freezes a finished run's clock the way an agent's is frozen", () => {
    const h = harness([]);
    // Inside FINISHED_LINGER_MS, or the row would be gone before it could be read.
    const completedAt = Date.now() - 1_000;
    h.setWorkflows([makeWorkflow({ status: "completed", startedAt: completedAt - 12_000, completedAt })]);

    expect(h.render().map(plain).join("\n")).toContain("12s");
  });
});
