/**
 * run-supervisor.ts — the bounded per-attempt lifecycle primitive.
 *
 * AgentManager stays the owner of records, its AbortController, pool
 * accounting, and terminal settlement; RunSupervisor is the stop/settle/
 * cleanup state machine for ONE attempt, composed over the manager's own
 * signal rather than a second manager-facing AbortController.
 *
 * Public lifecycle: queued -> running -> stopping -> terminal. An explicit
 * stop records its first reason and grants child work a grace period; natural
 * settlement before the grace cancels forced disposal; grace expiry invokes
 * the force-dispose hook exactly once and settles forced. Begin/settle/
 * dispose/cleanup paths are idempotent and cleanup hooks are exactly-once
 * resource disposal hooks. Timing is a deadline timer — never a poll.
 */

import {
  type ActivitySnapshot,
  type AgentActivityEvent,
  createInitialActivity,
  reduceActivity,
} from "./agent-activity.js";
import type {
  AttemptTerminationReason,
  RunSupervisorOptions,
  SettleOutcome,
  StopMode,
  TimeoutReason,
} from "./types.js";

export class RunSupervisor {
  private readonly managerSignal: AbortSignal;
  private readonly stopGraceMs: number;
  private readonly stalledWarningMs: number;
  private readonly toolCallTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly now: () => number;
  private readonly onForceDispose: () => void;
  private readonly onTimeout?: (reason: TimeoutReason) => void;

  private readonly controller = new AbortController();
  private readonly cleanups = new Set<() => void>();
  private readonly activityListeners = new Set<(snapshot: ActivitySnapshot) => void>();
  private activitySnapshot: ActivitySnapshot;
  private stopReason: AttemptTerminationReason | undefined;
  private settlementMode: StopMode | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private stalledTimer: ReturnType<typeof setTimeout> | undefined;
  private toolTimer: ReturnType<typeof setTimeout> | undefined;
  private inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  private managerListenerAttached = false;
  private settledState = false;
  private resourcesClosed = false;

  private readonly onManagerAbort = () => {
    this.controller.abort(this.managerSignal.reason);
  };

  constructor(options: RunSupervisorOptions) {
    this.managerSignal = options.signal;
    this.stopGraceMs = options.stopGraceMs;
    this.stalledWarningMs = options.stalledWarningMs ?? 0;
    this.toolCallTimeoutMs = options.toolCallTimeoutMs ?? 0;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 0;
    this.onForceDispose = options.onForceDispose;
    this.onTimeout = options.onTimeout;
    this.now = options.now ?? Date.now;
    this.activitySnapshot =
      options.initialActivity ??
      createInitialActivity(this.now(), {
        model: options.model,
        provider: options.provider,
      });

    if (options.signal.aborted) {
      this.controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", this.onManagerAbort, {
        once: true,
      });
      this.managerListenerAttached = true;
    }

    this.rescheduleProgressClocks();
  }

  /** The derived signal child work watches: manager signal + explicit stop. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Latest execution activity snapshot. */
  get activity(): ActivitySnapshot {
    return this.activitySnapshot;
  }

  /**
   * Record a lifecycle or runtime event and update the activity snapshot.
   * Notifies subscribers and returns the updated snapshot.
   */
  recordActivity(event: AgentActivityEvent): ActivitySnapshot {
    if (this.settledState || this.resourcesClosed) {
      return this.activitySnapshot;
    }
    const prev = this.activitySnapshot;
    const next = reduceActivity(prev, event);
    if (next === prev) {
      return this.activitySnapshot;
    }
    this.activitySnapshot = next;

    if (event.type === "tool-start") {
      this.scheduleToolDeadline();
    } else if (event.type === "tool-update" && prev.activeTool?.callId === event.callId) {
      this.scheduleToolDeadline();
    } else if (event.type === "tool-end" && prev.activeTool?.callId === event.callId) {
      this.clearToolTimer();
    }

    if (event.type !== "stalled" && event.type !== "unstalled") {
      this.rescheduleProgressClocks();
    }

    for (const listener of this.activityListeners) {
      try {
        listener(next);
      } catch {}
    }
    return next;
  }

  /**
   * Subscribe to activity snapshot changes. Immediately fires with current state
   * if fireImmediately is true (default: true). Returns an unsubscribe callback.
   */
  subscribeActivity(
    listener: (snapshot: ActivitySnapshot) => void,
    fireImmediately = true,
  ): () => void {
    if (this.resourcesClosed) {
      return () => {};
    }
    this.activityListeners.add(listener);
    if (fireImmediately) {
      try {
        listener(this.activitySnapshot);
      } catch {}
    }
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  /** True once an explicit stop request has been recorded. */
  get stopping(): boolean {
    return this.stopReason !== undefined;
  }

  /** True once the attempt has settled, naturally or forced. */
  get settled(): boolean {
    return this.settledState;
  }

  /** The first recorded stop reason, if a stop was ever requested. */
  get terminationReason(): AttemptTerminationReason | undefined {
    return this.stopReason;
  }

  beginStopping(reason: AttemptTerminationReason): boolean {
    if (
      this.stopReason !== undefined ||
      this.settledState ||
      this.resourcesClosed
    ) {
      return false;
    }

    this.stopReason = reason;
    this.clearDeadlineTimers();

    const deadline = this.now() + this.stopGraceMs;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      // Claim forced BEFORE the hook (a reentrant graceful settle inside the
      // hook must lose), and invoke the hook only when this callback won the
      // claim — structurally guaranteeing one force disposal per attempt.
      if (this.settle("forced").first) {
        try {
          this.onForceDispose();
        } catch {}
      }
    }, deadline - this.now());
    this.controller.abort(reason);
    return true;
  }

  settle(mode?: StopMode): SettleOutcome {
    if (this.settledState) {
      return this.settlementMode === undefined
        ? { first: false }
        : { first: false, mode: this.settlementMode };
    }

    this.settledState = true;
    this.settlementMode = mode;
    this.closeResources();
    return mode === undefined ? { first: true } : { first: true, mode };
  }

  registerCleanup(cleanup: () => void): () => void {
    if (this.resourcesClosed) {
      try {
        cleanup();
      } catch {}
      return () => {};
    }

    this.cleanups.add(cleanup);
    return () => {
      this.cleanups.delete(cleanup);
    };
  }

  dispose(): void {
    this.closeResources();
  }

  private closeResources(): void {
    if (this.resourcesClosed) {
      return;
    }
    this.resourcesClosed = true;

    if (this.managerListenerAttached) {
      this.managerSignal.removeEventListener("abort", this.onManagerAbort);
      this.managerListenerAttached = false;
    }
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.clearDeadlineTimers();

    this.activityListeners.clear();
    const cleanups = [...this.cleanups];
    this.cleanups.clear();
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {}
    }
  }

  private clearToolTimer(): void {
    if (this.toolTimer !== undefined) {
      clearTimeout(this.toolTimer);
      this.toolTimer = undefined;
    }
  }

  private clearDeadlineTimers(): void {
    this.clearToolTimer();
    if (this.stalledTimer !== undefined) {
      clearTimeout(this.stalledTimer);
      this.stalledTimer = undefined;
    }
    if (this.inactivityTimer !== undefined) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }
  }

  private scheduleToolDeadline(): void {
    this.clearToolTimer();
    if (
      this.toolCallTimeoutMs <= 0 ||
      this.stopReason !== undefined ||
      this.settledState ||
      this.resourcesClosed
    ) {
      return;
    }
    this.toolTimer = setTimeout(() => {
      this.toolTimer = undefined;
      this.beginStopping("tool_timeout");
      try {
        this.onTimeout?.("tool_timeout");
      } catch {}
    }, this.toolCallTimeoutMs);
  }

  private rescheduleProgressClocks(): void {
    if (this.stalledTimer !== undefined) {
      clearTimeout(this.stalledTimer);
      this.stalledTimer = undefined;
    }
    if (this.inactivityTimer !== undefined) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = undefined;
    }

    if (
      this.stopReason !== undefined ||
      this.settledState ||
      this.resourcesClosed ||
      this.activitySnapshot.phase === "queued" ||
      this.activitySnapshot.phase === "idle"
    ) {
      return;
    }

    if (this.stalledWarningMs > 0) {
      this.stalledTimer = setTimeout(() => {
        this.stalledTimer = undefined;
        this.recordActivity({
          type: "stalled",
          at: this.now(),
          stalledSince: this.now(),
        });
      }, this.stalledWarningMs);
    }

    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => {
        this.inactivityTimer = undefined;
        this.beginStopping("inactivity_timeout");
        try {
          this.onTimeout?.("inactivity_timeout");
        } catch {}
      }, this.inactivityTimeoutMs);
    }
  }
}
