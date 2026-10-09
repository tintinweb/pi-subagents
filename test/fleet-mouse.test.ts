import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetMouse } from "../src/ui/fleet-mouse.js";

const leases: FleetMouse[] = [];
afterEach(() => { for (const mouse of leases.splice(0)) mouse.dispose(); });

function harness(prefix = 7) {
  const open = vi.fn();
  const write = vi.fn();
  const rows = ["hint", "", "main", "workflow one", "workflow two"];
  const state = { previousLines: [...Array<string>(prefix).fill("transcript"), ...rows, "footer"], hardwareCursorRow: prefix - 1, previousWidth: 100 };
  const tui = { mode: "regular", terminal: { columns: 100, write }, captureRenderState: () => state, hasOverlay: () => false };
  const mouse = new FleetMouse(open); leases.push(mouse);
  mouse.attach(tui); mouse.rendered(rows, new Map([[3, "one"], [4, "two"]]));
  return { mouse, open, write, state, tui };
}

describe("FleetView mouse hit testing", () => {
  it.each([0, 7, 70])("uses a painted workflow row with %i preceding rows", prefix => {
    const h = harness(prefix);
    // Cursor is one row above the list, at screen row 10. Second workflow is 5 rows below it.
    h.mouse.handleInput("\x1b[<0;8;15M");
    expect(h.write).toHaveBeenLastCalledWith("\x1b[6n");
    h.mouse.handleInput("\x1b[10;1R");
    expect(h.open).toHaveBeenCalledExactlyOnceWith("two");
    h.mouse.handleInput("\x1b[<0;8;15m");
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("does not guess when the visible frame changed or the terminal resized", () => {
    const h = harness();
    h.state.previousWidth = 90;
    h.mouse.handleInput("\x1b[<0;8;15M");
    expect(h.write).not.toHaveBeenCalledWith("\x1b[6n");
    h.state.previousWidth = 100; h.state.previousLines = ["another view"];
    h.mouse.handleInput("\x1b[<0;8;15M");
    h.mouse.handleInput("\x1b[10;1R");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("ignores non-row clicks, modifiers, wheels, and overlays", () => {
    const h = harness();
    h.mouse.handleInput("\x1b[<0;8;10M"); h.mouse.handleInput("\x1b[10;1R");
    for (const button of [2, 4, 8, 16, 32, 64, 65]) h.mouse.handleInput(`\x1b[<${button};8;15M`);
    h.tui.hasOverlay = () => true;
    h.mouse.handleInput("\x1b[<0;8;15M"); h.mouse.handleInput("\x1b[10;1R");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("restores terminal mouse modes and forgets a pending click on dispose", () => {
    const h = harness();
    h.mouse.attach(h.tui);
    expect(h.write).toHaveBeenCalledTimes(1);
    h.mouse.handleInput("\x1b[<0;8;15M");
    h.mouse.dispose();
    expect(h.write).toHaveBeenLastCalledWith("\x1b[?1000;1006r");
    h.mouse.handleInput("\x1b[10;1R");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("leaves the fullscreen host's mouse ownership alone", () => {
    const h = harness(); h.mouse.dispose(); h.write.mockClear();
    h.mouse.attach({ ...h.tui, mode: "fullscreen" });
    h.mouse.handleInput("\x1b[<0;8;15M");
    expect(h.write).not.toHaveBeenCalled();
  });
});
