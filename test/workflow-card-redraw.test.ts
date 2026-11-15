/**
 * workflow-card-redraw.test.ts — when a background run's inline card redraws
 * (#284). The wiring to a real run is covered in workflow-tool.test.ts; this
 * covers the window logic, on fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowCardRedraws } from "../src/ui/workflow-card-redraw.js";

const TICK = 1000;

describe("WorkflowCardRedraws", () => {
  let live: boolean;
  let redraws: WorkflowCardRedraws;
  let invalidate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    live = true;
    redraws = new WorkflowCardRedraws(() => live, TICK);
    invalidate = vi.fn();
    redraws.track("wf", invalidate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("redraws the first change at once", () => {
    redraws.request("wf");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("folds changes inside the window into one trailing redraw", () => {
    redraws.request("wf");
    vi.advanceTimersByTime(100);
    redraws.request("wf");
    redraws.request("wf");
    expect(invalidate, "a change inside the window waits for it to close").toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TICK);
    expect(invalidate).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(TICK * 3);
    expect(invalidate, "no change, no redraw").toHaveBeenCalledTimes(2);
  });

  it("redraws a change after the window at once", () => {
    redraws.request("wf");
    vi.advanceTimersByTime(TICK);
    redraws.request("wf");
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("does not follow the run when the renderer is not live", () => {
    live = false;
    redraws.request("wf");
    vi.advanceTimersByTime(TICK * 2);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("flushes at settle in either renderer, cancels a pending redraw, and releases the card", () => {
    redraws.request("wf");
    redraws.request("wf");
    live = false;
    redraws.flush("wf");
    expect(invalidate, "settle does not wait for the window, or for a live renderer").toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(TICK * 2);
    expect(invalidate, "the pending redraw died with the run").toHaveBeenCalledTimes(2);
    live = true;
    redraws.request("wf");
    redraws.redrawAll();
    expect(invalidate, "a released card is never redrawn again").toHaveBeenCalledTimes(2);
  });

  it("redraws through the latest handle", () => {
    const replacement = vi.fn();
    redraws.track("wf", replacement);
    redraws.request("wf");
    expect(invalidate).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it("redraws every card on a renderer change, live or not", () => {
    const other = vi.fn();
    redraws.track("wf-2", other);
    live = false;
    redraws.redrawAll();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
