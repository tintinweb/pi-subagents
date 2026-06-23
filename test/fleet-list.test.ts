import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { getDisplayName } from "../src/ui/agent-widget.js";
import { FleetList, type FleetUICtx, formatFleetElapsed, formatFleetTokens } from "../src/ui/fleet-list.js";

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
  } as unknown as AgentManager;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
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
}

function harness(agents: AgentRecord[]): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
  let editorText = "";
  let opened = false;
  let closed = false;
  let overlayDone: ((r: undefined) => void) | undefined;
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
        // Construct the overlay component so the controller wires viewerClose.
        factory(fakeTui, theme, undefined, done);
      });
    }) as FleetUICtx["custom"],
  };

  const fleet = new FleetList(fakeManager(agents), new Map());
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    ui,
    press: (data) => inputHandler?.(data),
    render: (width = 120) => (widgetFactory ? widgetFactory(fakeTui, theme).render(width) : []),
    setEditorText: (t) => { editorText = t; },
    overlayOpened: () => opened,
    overlayClosed: () => closed,
    closeOverlay: async () => { overlayDone?.(undefined); await Promise.resolve(); },
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
    expect(h.render().find(l => l.includes("main"))).toContain("⏺");
    h.press(DOWN);          // a real second tap → first agent
    h.press(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("⏺");
    expect(h.render().find(l => l.includes("two"))).toContain("◯");
  });

  it("moves selection down/up and clamps at the ends", () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    h.press(DOWN); // activate → index 0 (main)
    h.press(DOWN); // → 1 (a1)
    expect(h.render().find(l => l.includes("one"))).toContain("⏺");
    h.press(DOWN); // → 2 (a2)
    h.press(DOWN); // clamp at 2
    expect(h.render().find(l => l.includes("two"))).toContain("⏺");
    expect(h.render().find(l => l.includes("one"))).toContain("◯");
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

describe("FleetList rendering", () => {
  it("renders main + agent rows with markers, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    const lines = h.render(120);
    // hint + blank + main + one agent
    expect(lines[0]).toContain("← for agents");
    expect(lines.find(l => l.includes("main"))).toContain("⏺"); // main selected by default
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("◯");
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
    expect(lines.find(l => l.includes("report 7"))).toContain("⏺");
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
    expect(h.render().find(l => l.includes("two"))).toContain("⏺");
    expect(h.render().find(l => l.includes("three"))).toContain("◯");
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
