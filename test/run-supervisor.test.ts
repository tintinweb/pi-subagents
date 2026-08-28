/**
 * run-supervisor.test.ts — the per-attempt lifecycle primitive (Milestone 1,
 * reliability initiative). AgentManager stays the owner of records, its
 * AbortController, pool accounting, and terminal settlement; RunSupervisor is
 * the bounded stop/settle/cleanup primitive that composes over the manager's
 * signal.
 *
 * Public lifecycle: queued -> running -> stopping -> terminal. An explicit
 * stop records its first reason and grants child work a grace period; natural
 * settlement before the grace cancels forced disposal; grace expiry forces
 * disposal once and settles forced. Begin/settle/dispose/cleanup paths are
 * idempotent, and cleanup hooks are exactly-once resource disposal hooks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunSupervisor } from "../src/run-supervisor.js";

describe("RunSupervisor construction and signal", () => {
  afterEach(() => vi.useRealTimers());

  it("exposes a live composed signal for a live manager signal", () => {
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    expect(supervisor.signal.aborted).toBe(false);
    expect(supervisor.stopping).toBe(false);
    expect(supervisor.settled).toBe(false);
    expect(supervisor.terminationReason).toBeUndefined();
  });

  it("composes an already-aborted manager signal with its reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("session is gone"));

    const supervisor = new RunSupervisor({
      signal: controller.signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    expect(supervisor.signal.aborted).toBe(true);
    expect(supervisor.signal.reason).toBe(controller.signal.reason);
  });

  it("aborts its composed signal when the manager signal aborts", () => {
    const controller = new AbortController();
    const supervisor = new RunSupervisor({
      signal: controller.signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    controller.abort(new Error("hard stop"));

    expect(supervisor.signal.aborted).toBe(true);
    expect(supervisor.signal.reason).toBe(controller.signal.reason);
  });

  it("accepts the configured stop grace", () => {
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 30_000,
      onForceDispose: vi.fn(),
    });

    expect(supervisor.stopping).toBe(false);
    expect(supervisor.settled).toBe(false);
  });

  it("repeated getter reads do not mutate state", () => {
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    const snapshot = [
      supervisor.signal,
      supervisor.stopping,
      supervisor.settled,
      supervisor.terminationReason,
    ];
    expect(supervisor.signal).toBe(snapshot[0]);
    expect(supervisor.stopping).toBe(snapshot[1]);
    expect(supervisor.settled).toBe(snapshot[2]);
    expect(supervisor.terminationReason).toBe(snapshot[3]);
  });
});

describe("RunSupervisor stopping, settlement, and cleanup", () => {
  afterEach(() => vi.useRealTimers());

  it("records only the first stop request and cancels child-facing work", () => {
    vi.useFakeTimers();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    expect(supervisor.beginStopping("user")).toBe(true);
    expect(supervisor.beginStopping("shutdown")).toBe(false);
    expect(supervisor.stopping).toBe(true);
    expect(supervisor.terminationReason).toBe("user");
    expect(supervisor.signal.aborted).toBe(true);
    expect(supervisor.signal.reason).toBe("user");

    supervisor.dispose();
  });

  it("does not leave a grace timer after a synchronous abort listener settles", () => {
    vi.useFakeTimers();
    const onForceDispose = vi.fn();
    let supervisor: RunSupervisor;
    const settleGracefully = vi.fn(() => supervisor.settle("graceful"));
    supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose,
    });
    supervisor.signal.addEventListener("abort", settleGracefully, {
      once: true,
    });

    expect(supervisor.beginStopping("user")).toBe(true);
    expect(settleGracefully).toHaveReturnedWith({
      first: true,
      mode: "graceful",
    });
    expect(supervisor.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(onForceDispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("claims forced settlement before invoking the force callback", () => {
    vi.useFakeTimers();
    let supervisor: RunSupervisor;
    const settleGracefully = vi.fn(() => supervisor.settle("graceful"));
    supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: settleGracefully,
    });

    supervisor.beginStopping("shutdown");
    vi.advanceTimersByTime(5_000);

    expect(settleGracefully).toHaveReturnedWith({
      first: false,
      mode: "forced",
    });
    expect(supervisor.settle("graceful")).toEqual({
      first: false,
      mode: "forced",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one deadline timer for the configured grace instead of an interval", () => {
    vi.useFakeTimers();
    const now = vi.fn(() => 1_000);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 30_000,
      now,
      onForceDispose: vi.fn(),
    });

    supervisor.beginStopping("owner");

    expect(now).toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(intervalSpy).not.toHaveBeenCalled();

    supervisor.dispose();
  });

  it("keeps the first settlement mode on late settlement attempts", () => {
    const cleanup = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });
    supervisor.registerCleanup(cleanup);

    expect(supervisor.settle("graceful")).toEqual({
      first: true,
      mode: "graceful",
    });
    expect(supervisor.settle("forced")).toEqual({
      first: false,
      mode: "graceful",
    });
    expect(supervisor.settle()).toEqual({ first: false, mode: "graceful" });
    expect(supervisor.settled).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves an omitted first settlement mode", () => {
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    expect(supervisor.settle()).toEqual({ first: true });
    expect(supervisor.settle("forced")).toEqual({ first: false });
  });

  it("prevents force disposal when natural settlement wins the grace race", () => {
    vi.useFakeTimers();
    const onForceDispose = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose,
    });

    supervisor.beginStopping("user");
    expect(vi.getTimerCount()).toBe(1);
    expect(supervisor.settle("graceful")).toEqual({
      first: true,
      mode: "graceful",
    });
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(onForceDispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("force-disposes exactly once and settles forced when grace expires", () => {
    vi.useFakeTimers();
    const onForceDispose = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose,
    });

    supervisor.beginStopping("shutdown");
    vi.advanceTimersByTime(5_000);

    expect(onForceDispose).toHaveBeenCalledTimes(1);
    expect(supervisor.settled).toBe(true);
    expect(supervisor.settle("graceful")).toEqual({
      first: false,
      mode: "forced",
    });
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    supervisor.dispose();
    expect(onForceDispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("attempts every cleanup when an earlier cleanup throws", () => {
    const firstCleanup = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const secondCleanup = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });
    supervisor.registerCleanup(firstCleanup);
    supervisor.registerCleanup(secondCleanup);

    expect(() => supervisor.settle()).not.toThrow();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
    expect(() => supervisor.dispose()).not.toThrow();
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it("contains force callback exceptions and completes forced cleanup", () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const onForceDispose = vi.fn(() => {
      throw new Error("force disposal failed");
    });
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose,
    });
    supervisor.registerCleanup(cleanup);
    supervisor.beginStopping("shutdown");

    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    expect(onForceDispose).toHaveBeenCalledTimes(1);
    expect(supervisor.settled).toBe(true);
    expect(supervisor.settle("graceful")).toEqual({
      first: false,
      mode: "forced",
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs cleanup hooks once when settlement wins", () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });
    supervisor.registerCleanup(firstCleanup);
    supervisor.registerCleanup(secondCleanup);

    supervisor.settle();
    supervisor.dispose();
    supervisor.settle("forced");

    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup hooks once when disposal wins", () => {
    const cleanup = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });
    supervisor.registerCleanup(cleanup);

    supervisor.dispose();
    supervisor.dispose();
    supervisor.settle();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not invoke a cleanup hook unregistered before cleanup", () => {
    const cleanup = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });
    const unregister = supervisor.registerCleanup(cleanup);

    unregister();
    unregister();
    supervisor.settle();

    expect(cleanup).not.toHaveBeenCalled();
  });

  it("disposes its manager listener, grace timer, and cleanup references once", () => {
    vi.useFakeTimers();
    const managerController = new AbortController();
    const removeListener = vi.spyOn(
      managerController.signal,
      "removeEventListener",
    );
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const cleanup = vi.fn();
    const supervisor = new RunSupervisor({
      signal: managerController.signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });
    supervisor.registerCleanup(cleanup);
    supervisor.beginStopping("owner");

    supervisor.settle("graceful");
    supervisor.dispose();
    supervisor.settle("forced");

    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops observing the manager signal after disposal", () => {
    const managerController = new AbortController();
    const supervisor = new RunSupervisor({
      signal: managerController.signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    supervisor.dispose();
    managerController.abort(new Error("too late"));

    expect(supervisor.signal.aborted).toBe(false);
  });

  it("manages activity state and notifies subscribers", () => {
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
      model: "sonnet-4-6",
      provider: "anthropic",
    });

    expect(supervisor.activity.phase).toBe("queued");
    expect(supervisor.activity.effectiveModel).toBe("sonnet-4-6");
    expect(supervisor.activity.effectiveProvider).toBe("anthropic");

    const snapshots: string[] = [];
    const unsubscribe = supervisor.subscribeActivity((s) => {
      snapshots.push(s.phase);
    });

    supervisor.recordActivity({
      type: "initializing",
      stage: "loader",
      at: 2_000,
    });
    supervisor.recordActivity({ type: "model-inference", at: 3_000 });

    expect(snapshots).toEqual(["queued", "initializing", "model-inference"]);

    unsubscribe();
    supervisor.recordActivity({ type: "idle", at: 4_000 });
    expect(snapshots).toEqual(["queued", "initializing", "model-inference"]);
    expect(supervisor.activity.phase).toBe("idle");
  });

  it("does not publish activity updates after settlement", () => {
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      onForceDispose: vi.fn(),
    });

    const listener = vi.fn();
    supervisor.subscribeActivity(listener, false);

    supervisor.settle();
    supervisor.recordActivity({ type: "model-inference", at: 2_000 });

    expect(listener).not.toHaveBeenCalled();
    expect(supervisor.activity.phase).toBe("queued");
  });

  it("marks activity as stalled when stalled warning deadline expires", () => {
    vi.useFakeTimers();
    let now = 10_000;
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      stalledWarningMs: 300_000,
      onForceDispose: vi.fn(),
      now: () => now,
    });

    supervisor.recordActivity({ type: "model-inference", at: now });
    expect(supervisor.activity.stalledSince).toBeUndefined();

    now += 300_000;
    vi.advanceTimersByTime(300_000);

    expect(supervisor.activity.stalledSince).toBe(310_000);
    expect(supervisor.stopping).toBe(false);

    // Progress clears stalled
    now += 10_000;
    supervisor.recordActivity({ type: "model-progress", at: now });
    expect(supervisor.activity.stalledSince).toBeUndefined();
  });

  it("triggers tool timeout when tool execution exceeds limit", () => {
    vi.useFakeTimers();
    let now = 10_000;
    const onTimeout = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      toolCallTimeoutMs: 60_000,
      onForceDispose: vi.fn(),
      onTimeout,
      now: () => now,
    });

    supervisor.recordActivity({
      type: "tool-start",
      tool: { callId: "c1", name: "bash", startedAt: now, lastUpdateAt: now },
      at: now,
    });

    now += 60_000;
    vi.advanceTimersByTime(60_000);

    expect(supervisor.stopping).toBe(true);
    expect(supervisor.terminationReason).toBe("tool_timeout");
    expect(onTimeout).toHaveBeenCalledWith("tool_timeout");
  });

  it("triggers inactivity timeout when no progress happens within limit", () => {
    vi.useFakeTimers();
    let now = 10_000;
    const onTimeout = vi.fn();
    const supervisor = new RunSupervisor({
      signal: new AbortController().signal,
      stopGraceMs: 5_000,
      inactivityTimeoutMs: 120_000,
      onForceDispose: vi.fn(),
      onTimeout,
      now: () => now,
    });

    supervisor.recordActivity({ type: "model-inference", at: now });

    now += 120_000;
    vi.advanceTimersByTime(120_000);

    expect(supervisor.stopping).toBe(true);
    expect(supervisor.terminationReason).toBe("inactivity_timeout");
    expect(onTimeout).toHaveBeenCalledWith("inactivity_timeout");
  });
});
