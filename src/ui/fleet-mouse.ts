import { stripVTControlCharacters } from "node:util";

type RenderState = { previousLines: string[]; hardwareCursorRow: number; previousWidth: number };
export type FleetMouseTui = {
  mode?: string;
  terminal: { columns: number; write(data: string): void };
  captureRenderState?(): RenderState;
  hasOverlay?(): boolean;
};

/** Mouse hit testing against the main-screen renderer's last painted frame. */
export class FleetMouse {
  private tui?: FleetMouseTui;
  private lines: string[] = [];
  private targets = new Map<number, string>();
  private pending?: { y: number; cursor: number; start: number; targets: Map<number, string> };
  private timeout?: ReturnType<typeof setTimeout>;

  constructor(private open: (id: string) => void) {}

  attach(tui: FleetMouseTui): void {
    if (this.tui === tui) return;
    this.dispose();
    // Fullscreen owns mouse input before extension listeners run. Do not alter
    // its selection/scrolling modes; keyboard navigation remains available.
    if (!tui.captureRenderState || !tui.terminal?.write || tui.mode === "fullscreen") return;
    this.tui = tui;
    tui.terminal.write("\x1b[?1000;1006s\x1b[?1000;1006h");
  }

  rendered(lines: string[], targets: Map<number, string>): void {
    this.lines = lines.map(line => stripVTControlCharacters(line).trimEnd());
    this.targets = new Map(targets);
  }

  handleInput(data: string): { consume: true } | undefined {
    const position = /^\x1b\[(\d+);(\d+)R$/.exec(data);
    if (position && this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(this.timeout);
      // CPR gives the actual screen cursor row. The logical cursor is from
      // the same paint, so this also works when Pi started below a shell prompt
      // or content has scrolled above the viewport.
      const row = pending.y - Number(position[1]) + pending.cursor - pending.start;
      const id = pending.targets.get(row);
      if (id !== undefined && !this.tui?.hasOverlay?.()) this.open(id);
      return { consume: true };
    }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!mouse || !this.tui) return;
    if (this.tui.hasOverlay?.()) return;
    // Only an unmodified primary press opens a row. Never open on release,
    // motion, wheel, right click, or a modifier used for native selection.
    if (mouse[1] !== "0" || mouse[4] !== "M") return { consume: true };
    if (this.pending) return { consume: true };
    const state = this.tui.captureRenderState!();
    if (state.previousWidth !== this.tui.terminal.columns || this.lines.length === 0) return { consume: true };
    if (Number(mouse[2]) < 1 || Number(mouse[2]) > state.previousWidth) return { consume: true };
    const painted = state.previousLines.map(line => stripVTControlCharacters(line).trimEnd());
    let start = -1;
    for (let i = painted.length - this.lines.length; i >= 0; i--) {
      if (this.lines.every((line, offset) => painted[i + offset] === line)) { start = i; break; }
    }
    if (start < 0) return { consume: true }; // stale/unpainted frame: no guessed target
    this.pending = { y: Number(mouse[3]), cursor: state.hardwareCursorRow, start, targets: new Map(this.targets) };
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { this.pending = undefined; }, 500);
    this.timeout.unref();
    this.tui.terminal.write("\x1b[6n");
    return { consume: true };
  }

  dispose(): void {
    clearTimeout(this.timeout);
    this.pending = undefined;
    this.tui?.terminal.write("\x1b[?1000;1006r");
    this.tui = undefined;
    this.lines = [];
    this.targets.clear();
  }
}
