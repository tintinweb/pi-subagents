/**
 * notification-coordinator.ts — Coordinates subagent completion notifications.
 *
 * Scoped to one parent session generation. Owns:
 * - Local consumption hold (default 200ms)
 * - `steer` vs `settled` delivery strategies
 * - Group joining via GroupJoinManager
 * - Clean disposal upon session switch or shutdown
 */

import { GroupJoinManager } from "./group-join.js";
import type { AgentRecord } from "./types.js";

export type NotificationDelivery = "steer" | "settled";

export interface NotificationCoordinatorOptions {
  sessionGeneration: number;
  delivery?: NotificationDelivery;
  holdMs?: number;
  send: (
    records: readonly AgentRecord[],
    options: { deliverAs: "steer"; triggerTurn: true } | { triggerTurn: true },
  ) => Promise<void> | void;
}

export class NotificationCoordinator {
  private readonly sessionGeneration: number;
  private readonly delivery: NotificationDelivery;
  private readonly holdMs: number;
  private readonly sendCb: (
    records: readonly AgentRecord[],
    options: { deliverAs: "steer"; triggerTurn: true } | { triggerTurn: true },
  ) => Promise<void> | void;

  private readonly groupJoin: GroupJoinManager;
  private readonly pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly settledQueue: AgentRecord[] = [];
  private parentIsActive = false;
  private disposed = false;

  constructor(options: NotificationCoordinatorOptions) {
    this.sessionGeneration = options.sessionGeneration;
    this.delivery = options.delivery ?? "steer";
    this.holdMs = options.holdMs ?? 200;
    this.sendCb = options.send;

    this.groupJoin = new GroupJoinManager((records, _partial) => {
      this.dispatchGroup(records);
    });
  }

  get joinManager(): GroupJoinManager {
    return this.groupJoin;
  }

  get generation(): number {
    return this.sessionGeneration;
  }

  /**
   * Called when an agent completes.
   */
  enqueue(record: AgentRecord): void {
    if (this.disposed || record.resultConsumed) return;

    const groupResult = this.groupJoin.onAgentComplete(record);
    if (groupResult === "pass") {
      this.scheduleSingleNudge(record);
    }
  }

  /**
   * Consume an agent result immediately, suppressing pending notifications.
   */
  consume(agentId: string): boolean {
    const timer = this.pendingNudges.get(agentId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingNudges.delete(agentId);
    }

    const idx = this.settledQueue.findIndex((r) => r.id === agentId);
    if (idx !== -1) {
      this.settledQueue.splice(idx, 1);
    }

    return timer !== undefined || idx !== -1;
  }

  parentStarted(): void {
    this.parentIsActive = true;
  }

  parentSettled(): void {
    this.parentIsActive = false;
    if (this.disposed || this.delivery !== "settled") return;

    if (this.settledQueue.length > 0) {
      const recordsToDeliver = this.settledQueue.filter((r) => !r.resultConsumed);
      this.settledQueue.length = 0;
      if (recordsToDeliver.length > 0) {
        this.deliverRecords(recordsToDeliver);
      }
    }
  }

  private scheduleSingleNudge(record: AgentRecord): void {
    this.cancelNudge(record.id);
    this.pendingNudges.set(
      record.id,
      setTimeout(() => {
        this.pendingNudges.delete(record.id);
        if (this.disposed || record.resultConsumed) return;
        this.handleReadyToDeliver([record]);
      }, this.holdMs),
    );
  }

  private dispatchGroup(records: AgentRecord[]): void {
    const groupKey = `group:${records.map((r) => r.id).join(",")}`;
    this.cancelNudge(groupKey);
    this.pendingNudges.set(
      groupKey,
      setTimeout(() => {
        this.pendingNudges.delete(groupKey);
        if (this.disposed) return;
        const unconsumed = records.filter((r) => !r.resultConsumed);
        if (unconsumed.length === 0) return;
        this.handleReadyToDeliver(unconsumed);
      }, this.holdMs),
    );
  }

  private cancelNudge(key: string): void {
    const timer = this.pendingNudges.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.pendingNudges.delete(key);
    }
  }

  private handleReadyToDeliver(records: AgentRecord[]): void {
    if (this.disposed) return;

    if (this.delivery === "settled" && this.parentIsActive) {
      this.settledQueue.push(...records);
      return;
    }

    this.deliverRecords(records);
  }

  private deliverRecords(records: AgentRecord[]): void {
    if (this.disposed) return;
    const unconsumed = records.filter((r) => !r.resultConsumed);
    if (unconsumed.length === 0) return;

    const options =
      this.delivery === "steer"
        ? ({ deliverAs: "steer", triggerTurn: true } as const)
        : ({ triggerTurn: true } as const);

    try {
      const p = this.sendCb(unconsumed, options);
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {});
      }
    } catch {}
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const timer of this.pendingNudges.values()) {
      clearTimeout(timer);
    }
    this.pendingNudges.clear();
    this.settledQueue.length = 0;
    this.groupJoin.dispose();
  }
}
