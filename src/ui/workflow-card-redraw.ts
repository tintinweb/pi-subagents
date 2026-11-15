/**
 * workflow-card-redraw.ts — when a background run's inline card redraws.
 *
 * pi re-runs a tool's `renderResult` only when told to, through
 * `renderContext.invalidate`. A `SubagentWorkflow` call settles at launch, so
 * without this the card keeps its first frame (#284).
 *
 * The redraw cost depends on pi's renderer. In fullscreen only the visible
 * rows are diffed, so redrawing a card that has scrolled off screen is free. In
 * regular mode a change above the viewport clears the screen and scrollback
 * and replays the session (#317). So a card follows its run live only when
 * `isLive()` says fullscreen, and redraws once when the run ends either way.
 */

import { WORKFLOW_TICK_MS } from "./workflow-card.js";

interface Card {
  invalidate: () => void;
  lastAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class WorkflowCardRedraws {
  /** Live runs' cards, by run id. */
  private cards = new Map<string, Card>();

  constructor(
    /** Read at every decision, because pi can switch renderers mid-run. */
    private isLive: () => boolean,
    private tickMs = WORKFLOW_TICK_MS,
  ) {}

  /**
   * The handle of the component currently drawing this run's card. The latest
   * one wins: pi rebuilds the chat on some navigations, which replaces the
   * component.
   */
  track(id: string, invalidate: () => void): void {
    const card = this.cards.get(id);
    if (card) card.invalidate = invalidate;
    else this.cards.set(id, { invalidate, lastAt: 0 });
  }

  /** The run changed: redraw now, or once when the current window closes. */
  request(id: string): void {
    const card = this.cards.get(id);
    if (!card || card.timer || !this.isLive()) return;
    const fire = () => {
      card.timer = undefined;
      card.lastAt = Date.now();
      card.invalidate();
    };
    const wait = card.lastAt + this.tickMs - Date.now();
    if (wait <= 0) {
      fire();
    } else {
      card.timer = setTimeout(fire, wait);
      card.timer.unref?.();
    }
  }

  /** The run ended: one last redraw, in either renderer, and release the card. */
  flush(id: string): void {
    const card = this.cards.get(id);
    if (!card) return;
    clearTimeout(card.timer);
    this.cards.delete(id);
    card.invalidate();
  }

  /**
   * The renderer changed: every live card redraws once. A card drawn in one
   * mode is wrong for the other: the full tree can't follow the run in regular
   * mode, and the launch line hides it in fullscreen.
   */
  redrawAll(): void {
    for (const card of this.cards.values()) card.invalidate();
  }
}
