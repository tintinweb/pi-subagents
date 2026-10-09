import type { AgentSession, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import { Input, ScrollView, type ScrollViewScrollbar, type Terminal, Text, type TUI, TuiAltScreen, type TuiMode, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer, getConversationOverlayOptions } from "../src/ui/conversation-viewer.js";

const supportsMouse = "handleMouse" in Input.prototype && "isScrollbarActive" in ScrollView.prototype;
type ViewerMouseEvent = Parameters<ConversationViewer["handleMouse"]>[0];

function setup(rows = 20, columns = 100, host?: TUI, scrollbar: ScrollViewScrollbar = "always", mode: TuiMode = "fullscreen") {
  const terminal = { rows, columns };
  const tui = host ?? { mode, terminal, requestRender: vi.fn(), handleMouse: () => undefined } as unknown as TUI;
  const messages = [{ role: "user", content: Array.from({ length: 100 }, (_, i) => `row-${i.toString().padStart(3, "0")}`).join("\n") }];
  const unsubscribe = vi.fn();
  let listener: AgentSessionEventListener = () => {};
  const session = { messages, subscribe: (onEvent: AgentSessionEventListener) => { listener = onEvent; return unsubscribe; } } as unknown as AgentSession;
  const record = { type: "Explore", description: "Observe only", status: "running", toolUses: 0, startedAt: Date.now() } as AgentRecord;
  const done = vi.fn();
  const stop = vi.fn();
  const steer = vi.fn();
  const viewer = new ConversationViewer(tui, session, record, undefined, {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  }, done, stop, undefined, steer, false, undefined, undefined, scrollbar);
  const render = () => viewer.render(terminal.columns);
  const mouse = (event: Partial<ViewerMouseEvent>) => viewer.handleMouse({
    type: "wheel", button: "none", x: 10, y: 8,
    width: terminal.columns, height: terminal.rows,
    ...event,
  });
  const click = (label: string) => {
    const lines = render();
    const y = lines.findIndex(line => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    return mouse({ type: "press", button: "left", x: lines[y].indexOf(label), y });
  };
  const emit: AgentSessionEventListener = event => listener(event);
  return { viewer, tui, terminal, messages, render, mouse, click, done, stop, steer, unsubscribe, emit };
}

function firstRow(lines: string[]): string | undefined {
  return lines.join("\n").match(/row-\d+/)?.[0];
}

describe("regular conversation viewer", () => {
  it("falls back to the floating viewer when fullscreen mouse APIs are absent", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Input.prototype, "handleMouse");
    Reflect.deleteProperty(Input.prototype, "handleMouse");
    const { viewer, tui, render } = setup(30, 90);
    try {
      expect(getConversationOverlayOptions(tui)).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
      expect(render()).toHaveLength(21);
      expect(render()[0]).toBe(`╭${"─".repeat(88)}╮`);
      viewer.handleInput("\x1b[H");
      expect(render().join("\n")).toContain("row-000");
    } finally {
      viewer.dispose();
      if (descriptor) Object.defineProperty(Input.prototype, "handleMouse", descriptor);
    }
  });

  it("keeps an older fullscreen host floating even with newer component libraries", () => {
    const host = { mode: "fullscreen", terminal: { rows: 30, columns: 90 }, requestRender: vi.fn() } as unknown as TUI;
    const { viewer, render } = setup(30, 90, host);
    try {
      expect(getConversationOverlayOptions(host)).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
      expect(render()).toHaveLength(21);
      expect(render()[0]).toBe(`╭${"─".repeat(88)}╮`);
    } finally {
      viewer.dispose();
    }
  });

  it("retains its floating frame, height cap, and keyboard-only navigation", () => {
    const { viewer, render, terminal, mouse, steer } = setup(30, 90, undefined, "always", "regular");
    try {
      const before = render();
      expect(before).toHaveLength(21);
      expect(before[0]).toBe(`╭${"─".repeat(88)}╮`);
      expect(before.at(-1)).toBe(`╰${"─".repeat(88)}╯`);
      expect(before.every(line => visibleWidth(line) === 90)).toBe(true);
      expect(before.slice(1, -1).every(line => line.startsWith("│ ") && line.endsWith(" │"))).toBe(true);
      expect(mouse({ wheelDelta: -10 })).toMatchObject({ handled: false });
      expect(render()).toEqual(before);
      viewer.handleInput("\x1b[H");
      expect(render().join("\n")).toContain("row-000");
      expect(render().join("\n")).not.toContain("Ctrl+End");
      viewer.handleInput("\x1b[F");
      expect(render().join("\n")).toContain("row-099");
      viewer.handleInput("\r");
      viewer.handleInput("draft");
      expect(render()).toHaveLength(21);
      viewer.handleInput("\r");
      expect(steer).toHaveBeenCalledExactlyOnceWith("draft");
      terminal.rows = 40;
      expect(render()).toHaveLength(28);
      expect(viewer.render(5)).toEqual([]);
    } finally {
      viewer.dispose();
    }
  });
});

describe.skipIf(!supportsMouse)("fullscreen conversation observer", () => {
  it("covers every cell without a frame, including after resize and while composing", () => {
    const { render, terminal, viewer } = setup();
    for (const [rows, columns] of [[20, 100], [35, 70], [4, 12], [1, 1]]) {
      terminal.rows = rows;
      terminal.columns = columns;
      const lines = render();
      expect(lines).toHaveLength(rows);
      expect(lines.every(line => visibleWidth(line) === columns)).toBe(true);
      expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/);
    }
    terminal.rows = 20;
    terminal.columns = 100;
    viewer.handleInput("\r");
    expect(render()).toHaveLength(20);
    expect(render().join("\n")).toContain("Enter send");
  });

  it("keeps the bottom divider pinned around the jump control while scrolled up", () => {
    const { render, terminal, viewer, mouse } = setup();
    try {
      expect(render()[terminal.rows - 2].trim()).toMatch(/^─+$/);
      mouse({ wheelDelta: -30 });
      expect(render()[terminal.rows - 2].trim()).toMatch(/^─+\[ ↓ Jump to latest message · Ctrl\+End \]─+$/);
      viewer.handleInput("\r");
      expect(render()[terminal.rows - 3].trim()).toMatch(/^─+\[ ↓ Jump to latest message · Ctrl\+End \]─+$/);
      terminal.rows = 30;
      terminal.columns = 80;
      expect(render()[terminal.rows - 3].trim()).toMatch(/^─+\[ ↓ Jump to latest message · Ctrl\+End \]─+$/);
      viewer.handleInput("\x1b[1;5F");
      expect(render()[terminal.rows - 3].trim()).toMatch(/^─+$/);
    } finally {
      viewer.dispose();
    }
  });

  it("wheel scrolling pauses follow until the observer reaches the bottom again", () => {
    const { render, mouse, messages } = setup();
    const bottom = firstRow(render());
    expect(mouse({ wheelDelta: -5 })).toMatchObject({ handled: true });
    const paused = firstRow(render());
    expect(paused).not.toBe(bottom);
    messages[0].content += "\nrow-100";
    expect(firstRow(render())).toBe(paused);
    mouse({ wheelDelta: 1000 });
    expect(render().join("\n")).toContain("row-100");
    messages[0].content += "\nrow-101";
    expect(render().join("\n")).toContain("row-101");
    mouse({ wheelDelta: -1000 });
    expect(render().join("\n")).toContain("row-000");
  });

  it("captures scrollbar drags and reaches both ends", () => {
    const { render, mouse } = setup();
    const lines = render();
    const thumbRow = lines.findIndex(line => line.endsWith("┃"));
    expect(thumbRow).toBeGreaterThan(0);
    expect(mouse({ type: "press", button: "left", x: 99, y: thumbRow })).toMatchObject({ handled: true, capture: true });
    mouse({ type: "drag", button: "left", x: 99, y: -100 });
    expect(render().join("\n")).toContain("row-000");
    mouse({ type: "drag", button: "left", x: 99, y: 1000 });
    expect(render().join("\n")).toContain("row-099");
    expect(mouse({ type: "release", button: "left", x: 99, y: 1000 })).toMatchObject({ handled: true });
  });

  it("uses Pi's single-column track and thumb glyphs", () => {
    const { render, mouse } = setup();
    const lines = render();
    expect(lines.filter(line => line.endsWith("┃"))).toHaveLength(3);
    expect(lines.some(line => line.endsWith("│"))).toBe(true);
    expect(lines.some(line => /[░█]/.test(line))).toBe(false);
    expect(lines.every(line => !/[│┃]{2}$/.test(line))).toBe(true);
    const thumb = lines.findIndex(line => line.endsWith("┃"));
    mouse({ type: "press", button: "left", x: 99, y: thumb });
    expect(render().some(line => line.endsWith("█"))).toBe(true);
    mouse({ type: "release", button: "left", x: 99, y: thumb });
    expect(render().some(line => line.endsWith("█"))).toBe(true); // still hovering
    mouse({ type: "move", x: 20, y: thumb });
    expect(render().some(line => line.endsWith("█"))).toBe(false);
  });

  it("hides the rail and its hit target under Pi's hidden setting", () => {
    const { render, mouse, viewer } = setup(20, 100, undefined, "hidden");
    try {
      const before = firstRow(render());
      expect(render().some(line => /[│┃█]$/.test(line))).toBe(false);
      expect(mouse({ type: "press", button: "left", x: 99, y: 8 })).not.toHaveProperty("capture");
      expect(firstRow(render())).toBe(before);
      mouse({ type: "wheel", wheelDelta: -5 });
      expect(firstRow(render())).not.toBe(before);
      expect(render().some(line => /[│┃█]$/.test(line))).toBe(false);
    } finally {
      viewer.dispose();
    }
  });

  it("always shows a full-height thumb when the conversation fits", () => {
    const { render, messages, viewer } = setup(20, 100, undefined, "always");
    try {
      messages[0].content = "short";
      expect(render().filter(line => line.endsWith("┃"))).toHaveLength(16);
    } finally {
      viewer.dispose();
    }
  });

  it.each(["auto", "hidden"] as const)("does not reserve a content column in %s mode", (mode) => {
    const { render, messages, viewer } = setup(20, 100, undefined, mode);
    try {
      messages[0].content = "x".repeat(99);
      expect(render()).toContain(` ${"x".repeat(99)}`);
    } finally {
      viewer.dispose();
    }
  });

  it("auto reveals on scroll or hover, hides after idle, and cancels its timer on close", () => {
    vi.useFakeTimers();
    const { render, mouse, viewer } = setup(20, 100, undefined, "auto");
    const hasRail = () => render().some(line => /[│┃█]$/.test(line));
    try {
      expect(hasRail()).toBe(false);
      mouse({ wheelDelta: -5 });
      expect(hasRail()).toBe(true);
      vi.advanceTimersByTime(999);
      expect(hasRail()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(hasRail()).toBe(false);
      mouse({ type: "move", x: 99, y: 8 });
      expect(hasRail()).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(hasRail()).toBe(true);
      mouse({ type: "move", x: 20, y: 8 });
      vi.advanceTimersByTime(1000);
      expect(hasRail()).toBe(false);
      mouse({ wheelDelta: -5 });
      expect(hasRail()).toBe(true);
      viewer.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      viewer.dispose();
      vi.useRealTimers();
    }
  });

  it("counts new messages while scrolled away and resumes following with Ctrl+End", () => {
    const { render, mouse, messages, emit, viewer } = setup();
    expect(render().join("\n")).not.toContain("Ctrl+End");
    mouse({ wheelDelta: -10 });
    const paused = firstRow(render());
    expect(render().join("\n")).toContain("[ ↓ Jump to latest message · Ctrl+End ]");
    for (let i = 0; i < 6; i++) {
      const message = { role: "user" as const, content: `new message ${i}`, timestamp: i };
      messages.push(message);
      emit({ type: "message_start", message });
      emit({ type: "message_end", message }); // completion must not count twice
    }
    emit({ type: "message_start", message: { role: "system", content: "hidden context", timestamp: 0 } });
    expect(firstRow(render())).toBe(paused);
    expect(render().join("\n")).toContain("[ ↓ 6 new messages · Ctrl+End ]");
    viewer.handleInput("\x1b[1;5F");
    expect(render().join("\n")).toContain("new message 5");
    expect(render().join("\n")).not.toContain("Ctrl+End");
    messages.push({ role: "user", content: "following again" });
    expect(render().join("\n")).toContain("following again");
    mouse({ wheelDelta: -10 });
    expect(render().join("\n")).toContain("[ ↓ Jump to latest message · Ctrl+End ]");
  });

  it("lets the indicator return to latest without sending or losing a steering draft", () => {
    const { viewer, mouse, render, click, emit, messages, steer } = setup();
    render();
    mouse({ wheelDelta: -10 });
    const message = { role: "user" as const, content: "fresh", timestamp: 1 };
    messages.push(message);
    emit({ type: "message_start", message });
    viewer.handleInput("\r");
    viewer.handleInput("draft");
    click("[ ↓ 1 new message · Ctrl+End ]");
    expect(render().join("\n")).not.toContain("Ctrl+End");
    expect(render().join("\n")).toContain("fresh");
    expect(render().join("\n")).toContain("draft");
    mouse({ wheelDelta: -10 });
    viewer.handleInput("\x1b[1;5F");
    expect(render().join("\n")).not.toContain("Ctrl+End");
    expect(render().join("\n")).toContain("draft");
    expect(steer).not.toHaveBeenCalled();
  });

  it("pages on a track press and lets the same held press become a drag", () => {
    const { render, mouse } = setup();
    const bottom = firstRow(render());
    expect(mouse({ type: "press", button: "left", x: 99, y: 8 })).toMatchObject({ handled: true, capture: true });
    expect(firstRow(render())).not.toBe(bottom);
    mouse({ type: "drag", button: "left", x: 80, y: 2 });
    expect(render().join("\n")).toContain("row-000");
    mouse({ type: "release", button: "left", x: 80, y: 2 });
    mouse({ type: "drag", button: "left", x: 80, y: 19 });
    expect(render().join("\n")).toContain("row-000");
  });

  it("clicks steer, sends only to the child, and closes without stopping it", () => {
    const { click, mouse, viewer, render, steer, stop, done, unsubscribe } = setup();
    click("Enter steer");
    viewer.handleInput("hello child");
    expect(render().join("\n")).toContain("hello child");
    mouse({ type: "press", button: "left", x: 3, y: 18 }); // before the first character
    viewer.handleInput("!");
    click("Enter send");
    expect(steer).toHaveBeenCalledExactlyOnceWith("!hello child");
    click("Esc close");
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(stop).not.toHaveBeenCalled();
    viewer.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps two-step stop confirmation and disarms it on wheel input", () => {
    const { click, mouse, stop } = setup();
    click("x stop");
    expect(stop).not.toHaveBeenCalled();
    mouse({ wheelDelta: -1 });
    click("x stop");
    expect(stop).not.toHaveBeenCalled();
    click("x again to STOP");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("consumes unused mouse events rather than allowing main-view selection or clicks", () => {
    const { render, mouse, done, stop, steer } = setup();
    const before = render();
    for (const type of ["press", "drag", "release", "click", "move"] as const) {
      expect(mouse({ type, button: "left", x: 10, y: 10 })).toMatchObject({ handled: true });
    }
    expect(mouse({ type: "press", button: "right" })).toMatchObject({ handled: true });
    expect(render()).toEqual(before);
    expect(done).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });
});

describe.skipIf(!supportsMouse)("observer input isolation in Pi's fullscreen renderer", () => {
  it("keeps real wheel, drag, click, and keyboard input off the main view, then restores focus", () => {
    let input: (data: string) => void = () => {};
    const terminal: Terminal = {
      rows: 20, columns: 100, kittyProtocolActive: false,
      start: (onInput) => { input = onInput; },
      stop: vi.fn(), drainInput: async () => {}, write: vi.fn(),
      moveBy: vi.fn(), hideCursor: vi.fn(), showCursor: vi.fn(), clearLine: vi.fn(),
      clearFromCursor: vi.fn(), clearScreen: vi.fn(), setTitle: vi.fn(), setProgress: vi.fn(),
    };
    const openUrl = vi.fn();
    const copySelection = vi.fn(async () => true);
    const tui = new TuiAltScreen(terminal, false, undefined, { openUrl, copySelection });
    const main = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `main-${i}`).join("\n"), 0, 0), { primary: true });
    const editor = new Input();
    editor.setValue("main draft");
    editor.handleInput("\x1b[F"); // park the main cursor at the end
    editor.onSubmit = vi.fn();
    editor.onEscape = vi.fn();
    tui.setLayoutRoot(new VStack([main, editor]));
    tui.setFocus(editor);
    const { viewer, done, stop, steer, render, unsubscribe } = setup(20, 100, tui);
    done.mockImplementation(() => { tui.hideOverlay(); viewer.dispose(); });
    try {
      tui.start();
      tui.renderNow();
      main.scrollTo(25, { disableFollow: true });
      tui.renderNow();
      const position = main.scrollTop;
      const overlay = tui.showOverlay(viewer, getConversationOverlayOptions(tui));
      tui.renderNow();
      expect(overlay.getBounds()).toEqual({ row: 0, col: 0, width: 100, height: 20 });
      const before = firstRow(render());
      input("\x1b[<64;11;9M"); // wheel up
      tui.renderNow();
      expect(firstRow(render())).not.toBe(before);
      const thumbRow = render().findIndex(line => line.endsWith("┃"));
      input(`\x1b[<0;100;${thumbRow + 1}M`);
      input("\x1b[<32;90;3M"); // keep dragging after leaving the rail horizontally
      tui.renderNow();
      expect(render().join("\n")).toContain("row-000");
      input("\x1b[<0;90;3m");
      input("\x1b[<0;100;9M"); // grab the track below the thumb
      input("\x1b[<32;90;18M");
      tui.renderNow();
      expect(render().join("\n")).toContain("row-099");
      input("\x1b[<0;90;18m");
      input("\x1b[<64;11;9M");
      tui.renderNow();
      expect(render().join("\n")).toContain("Ctrl+End");
      input("\x1b[1;5F");
      tui.renderNow();
      expect(render().join("\n")).not.toContain("Ctrl+End");
      expect(render().join("\n")).toContain("row-099");
      input("\x1b[<0;11;9M"); // transcript press, drag, release
      input("\x1b[<32;21;10M");
      input("\x1b[<0;21;10m");
      input("ignored typing");
      input("\r"); // child composer
      input("child instruction");
      input("\r");
      expect(steer).toHaveBeenCalledExactlyOnceWith("child instruction");
      expect(main.scrollTop).toBe(position);
      expect(editor.getValue()).toBe("main draft");
      expect(editor.onSubmit).not.toHaveBeenCalled();
      expect(editor.onEscape).not.toHaveBeenCalled();
      expect(copySelection).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
      input("\x1b"); // close, don't abort either agent
      tui.renderNow();
      expect(done).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(tui.hasOverlay()).toBe(false);
      expect(tui.getFocusedComponent()).toBe(editor);
      expect(main.scrollTop).toBe(position);
      input("!");
      expect(editor.getValue()).toBe("main draft!");
    } finally {
      viewer.dispose();
      tui.stop();
    }
  });
});
