/**
 * nudge-queue.ts — Delivery timing for background agent completion notifications.
 *
 * Notifications are sent with `deliverAs: "followUp"`, which pi delivers only
 * once the agent has no more tool calls. Emitting one mid-run therefore parks it
 * in pi's follow-up queue until the run ends — and a parked message can no
 * longer be withdrawn, so an agent the orchestrator joins with
 * `get_subagent_result` in the meantime still produces a notification after the
 * final answer. With pi's default `followUpMode: "one-at-a-time"` a batch of
 * those drains one wasted turn each, and a large enough batch can force a
 * compaction.
 *
 * This queue keeps due notifications in-process instead. `schedule` holds each
 * one for a short window (so a same-tick join can cancel it), then either sends
 * it — parent idle, delivery is immediate and useful — or parks it here until
 * `flush` runs at `agent_settled`. Because every send closure re-checks
 * `resultConsumed` before emitting, deferring the call defers the check: an
 * agent joined in the meantime simply never notifies.
 *
 * The queue deliberately holds nothing across a session shutdown: results are
 * undeliverable once the session is gone, matching `abortAll()` on shutdown.
 */

/** Window that lets a same-tick `get_subagent_result` cancel a due notification. */
export const DEFAULT_HOLD_MS = 200;

export class NudgeQueue {
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private held = new Map<string, () => void>();

  /**
   * @param isBusy Whether the parent agent is mid-run. A due notification is
   *   parked while this is true. Read at delivery time rather than tracked as
   *   local state so an unbalanced lifecycle event cannot strand notifications.
   * @param holdMs Cancellation window applied before a notification comes due.
   */
  constructor(
    private readonly isBusy: () => boolean,
    private readonly holdMs: number = DEFAULT_HOLD_MS,
  ) {}

  /** Number of notifications parked waiting for the parent run to settle. */
  get heldCount(): number {
    return this.held.size;
  }

  /** Number of notifications inside their cancellation window. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Queue `send` under `key`, replacing any notification already queued for it. */
  schedule(key: string, send: () => void, delay: number = this.holdMs): void {
    this.cancel(key);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        if (this.isBusy()) {
          this.held.set(key, send);
          return;
        }
        this.deliver(send);
      }, delay),
    );
  }

  /** Drop `key` from both the cancellation window and the parked set. */
  cancel(key: string): void {
    const timer = this.pending.get(key);
    if (timer != null) {
      clearTimeout(timer);
      this.pending.delete(key);
    }
    this.held.delete(key);
  }

  /**
   * Deliver everything parked while the parent was running. Sends re-check
   * their own relevance, so this is safe to call whenever the agent settles —
   * including when nothing is parked.
   */
  flush(): void {
    if (this.held.size === 0) return;
    const sends = [...this.held.values()];
    this.held.clear();
    for (const send of sends) this.deliver(send);
  }

  /** Drop everything without delivering. */
  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.held.clear();
  }

  private deliver(send: () => void): void {
    try {
      send();
    } catch {
      /* ignore stale completion side-effect errors */
    }
  }
}
