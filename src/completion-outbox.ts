/**
 * completion-outbox.ts — When background completions reach the parent.
 *
 * Claude Code queues each completion and, after every tool batch, hands the
 * model everything that queued up in one go: a busy parent sees what finished
 * during the batch before its next model call, and nothing waits for a sibling.
 * pi's steering queue would split those into one model call each under its
 * default `one-at-a-time` mode, so the outbox holds them and sends ONE message
 * at the boundary instead.
 *
 * - Parent busy: held until `turn_end`, which pi emits after the tool batch and
 *   before it reads the steering queue.
 * - Parent idle: sent after a short hold, so near-simultaneous completions
 *   share a turn and `get_subagent_result` still gets a moment to consume one.
 * - Parent turn aborted (Esc) or failed: held through it — pi clears its own
 *   queues on Esc — and sent once the run has ended, starting a turn. Claude
 *   Code keeps an agent's completion queued through Esc the same way and runs
 *   it as soon as the interrupted turn stops.
 */

import type { NotificationDetails } from "./types.js";

/** How long an idle parent's notification is held before it is sent. */
export const NOTIFICATION_HOLD_MS = 200;

export interface OutboxMessage<D = NotificationDetails> {
  content: string;
  details: D;
}

/**
 * A notification for one or more agents, built when they finished: a resume
 * before the send must not rewrite it. Reading an agent's result cancels its
 * id, and an item left with none is dropped; `build` gets the ids still pending.
 */
export interface OutboxItem<D = NotificationDetails> {
  ids: string[];
  build(ids: readonly string[]): OutboxMessage<D>;
}

/**
 * Also carries agents' `SendMessage`s to the main session, in an instance of
 * its own: the same boundary rules apply, and a burst of messages lands as one
 * turn, as Claude Code drains its whole queue at once.
 */
export class CompletionOutbox<D = NotificationDetails> {
  private items: OutboxItem<D>[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** Delivers one message as a steer that triggers a turn when the parent is idle. */
    private send: (message: OutboxMessage<D>) => void,
    /** Whether the parent has a run in flight, so a `turn_end` is coming. */
    private parentRunning: () => boolean,
    /** How several pending messages become the one that is sent. */
    private combineMessages: (messages: OutboxMessage<D>[]) => OutboxMessage<D>,
  ) {}

  /**
   * A newer completion of the same agent (a resume) replaces its pending one,
   * unless `replace` is false: a run woken by stranded messages follows the
   * previous run's completion rather than superseding it.
   */
  add(item: OutboxItem<D>, { replace = true }: { replace?: boolean } = {}): void {
    if (replace) for (const id of item.ids) this.cancel(id);
    this.items.push(item);
    if (!this.parentRunning()) this.arm();
  }

  /** The parent finished a turn: its tool batch is done, the next model call is not. */
  onTurnEnd(stopReason: string | undefined): void {
    // An aborted turn ends its run; a failed one may be retried. Either way
    // what is held waits for the next boundary or the run's end — sent now,
    // it would sit in a queue pi is about to clear.
    if (stopReason !== "aborted" && stopReason !== "error") this.flush();
  }

  /** The agent's result was read: it must not also be notified. */
  cancel(id: string): void {
    this.dropWhere(i => i === id);
  }

  /** Drop every pending id `drop` matches; an item left with none is dropped too. */
  dropWhere(drop: (id: string) => boolean): void {
    for (const item of this.items) item.ids = item.ids.filter(i => !drop(i));
    this.items = this.items.filter(item => item.ids.length > 0);
  }

  /**
   * Completions that landed after the run's last `turn_end` would otherwise wait for the next run.
   * Called at `agent_end` and again at `agent_settled`: one can land while the ending run is still open.
   */
  onAgentEnd(): void {
    if (this.items.length > 0) this.arm();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.items = [];
  }

  /** Not reset by later items: the first completion is never pushed back. */
  private arm(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, NOTIFICATION_HOLD_MS);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const items = this.items;
    this.items = [];
    const messages = items.map(item => item.build(item.ids));
    if (messages.length === 0) return;
    // A send from a timer can outlive the session it was meant for (pi -p
    // tearing down): pi throws on the stale context, and nothing is left to tell.
    try { this.send(messages.length === 1 ? messages[0] : this.combineMessages(messages)); } catch { /* stale context */ }
  }
}

/** Several completion notifications as one message, carrying every agent's details. */
export function combineNotifications(messages: OutboxMessage[]): OutboxMessage {
  const [first, ...rest] = messages.flatMap(({ details: { others, ...own } }) => [own, ...(others ?? [])]);
  return {
    content: `${messages.length} background tasks finished.\n\n${messages.map(m => m.content).join("\n\n")}`,
    details: { ...first, others: rest },
  };
}
