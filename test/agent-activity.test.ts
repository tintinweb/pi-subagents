import { describe, expect, it } from "vitest";
import {
  type ActivitySnapshot,
  createInitialActivity,
  describeActivity,
  formatActivityDuration,
  reduceActivity,
} from "../src/agent-activity.js";

describe("formatActivityDuration", () => {
  it("formats seconds, minutes, and hours compactly", () => {
    expect(formatActivityDuration(0)).toBe("0s");
    expect(formatActivityDuration(18_000)).toBe("18s");
    expect(formatActivityDuration(43_000)).toBe("43s");
    expect(formatActivityDuration(192_000)).toBe("3m12s");
    expect(formatActivityDuration(65_000)).toBe("1m05s");
    expect(formatActivityDuration(3_665_000)).toBe("1h01m05s");
  });
});

describe("agent-activity reducer", () => {
  it("creates initial queued snapshot with metadata", () => {
    const initial = createInitialActivity(1_000, {
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    expect(initial).toEqual({
      phase: "queued",
      phaseStartedAt: 1_000,
      lastProgressAt: 1_000,
      turnCount: 0,
      effectiveModel: "claude-sonnet-4-6",
      effectiveProvider: "anthropic",
    });
  });

  it("handles initializing stages and updates progress", () => {
    const s0 = createInitialActivity(1_000);
    const s1 = reduceActivity(s0, {
      type: "initializing",
      stage: "extensions",
      at: 2_000,
    });

    expect(s1.phase).toBe("initializing");
    expect(s1.detail).toBe("extensions");
    expect(s1.phaseStartedAt).toBe(2_000);
    expect(s1.lastProgressAt).toBe(2_000);
  });

  it("transitions to model-inference and updates on progress", () => {
    const s0 = createInitialActivity(1_000);
    const s1 = reduceActivity(s0, { type: "model-inference", at: 3_000 });
    expect(s1.phase).toBe("model-inference");
    expect(s1.phaseStartedAt).toBe(3_000);
    expect(s1.lastProgressAt).toBe(3_000);

    const s2 = reduceActivity(s1, { type: "model-progress", at: 4_500 });
    expect(s2.phase).toBe("model-inference");
    expect(s2.phaseStartedAt).toBe(3_000);
    expect(s2.lastProgressAt).toBe(4_500);
  });

  it("tracks tool lifecycle and rejects stale tool updates", () => {
    const s0 = reduceActivity(createInitialActivity(1_000), {
      type: "model-inference",
      at: 2_000,
    });

    const s1 = reduceActivity(s0, {
      type: "tool-start",
      at: 3_000,
      tool: {
        callId: "call_1",
        name: "bash",
        startedAt: 3_000,
        lastUpdateAt: 3_000,
      },
    });
    expect(s1.phase).toBe("tool-execution");
    expect(s1.activeTool).toEqual({
      callId: "call_1",
      name: "bash",
      startedAt: 3_000,
      lastUpdateAt: 3_000,
    });
    expect(s1.phaseStartedAt).toBe(3_000);
    expect(s1.lastProgressAt).toBe(3_000);

    // Stale update with mismatched callId is ignored
    const s2 = reduceActivity(s1, {
      type: "tool-update",
      callId: "call_unknown",
      at: 4_000,
    });
    expect(s2).toBe(s1);

    // Matching update advances progress
    const s3 = reduceActivity(s1, {
      type: "tool-update",
      callId: "call_1",
      at: 5_000,
    });
    expect(s3.activeTool?.lastUpdateAt).toBe(5_000);
    expect(s3.lastProgressAt).toBe(5_000);

    // Stale end with mismatched callId is ignored
    const s4 = reduceActivity(s3, {
      type: "tool-end",
      callId: "call_unknown",
      at: 6_000,
    });
    expect(s4).toBe(s3);

    // Matching end transitions back to model-inference
    const s5 = reduceActivity(s3, {
      type: "tool-end",
      callId: "call_1",
      at: 7_000,
    });
    expect(s5.phase).toBe("model-inference");
    expect(s5.activeTool).toBeUndefined();
    expect(s5.phaseStartedAt).toBe(7_000);
    expect(s5.lastProgressAt).toBe(7_000);
  });

  it("tracks retry start and end", () => {
    const s0 = reduceActivity(createInitialActivity(1_000), {
      type: "model-inference",
      at: 2_000,
    });

    const s1 = reduceActivity(s0, {
      type: "retry-start",
      at: 3_000,
      retry: {
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4_000,
        reason: "rate limit",
      },
    });
    expect(s1.phase).toBe("retrying");
    expect(s1.retry).toEqual({
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4_000,
      reason: "rate limit",
    });

    const s2 = reduceActivity(s1, { type: "retry-end", at: 7_000 });
    expect(s2.phase).toBe("model-inference");
    expect(s2.retry).toBeUndefined();
  });

  it("tracks compaction start and end", () => {
    const s0 = reduceActivity(createInitialActivity(1_000), {
      type: "model-inference",
      at: 2_000,
    });

    const s1 = reduceActivity(s0, {
      type: "compaction-start",
      at: 3_000,
      compaction: { startedAt: 3_000, reason: "threshold" },
    });
    expect(s1.phase).toBe("compacting");
    expect(s1.compaction).toEqual({ startedAt: 3_000, reason: "threshold" });

    const s2 = reduceActivity(s1, { type: "compaction-end", at: 5_000 });
    expect(s2.phase).toBe("model-inference");
    expect(s2.compaction).toBeUndefined();
  });

  it("tracks waiting-for-child and idle phases", () => {
    const s0 = reduceActivity(createInitialActivity(1_000), {
      type: "waiting-for-child",
      child: "explore",
      at: 2_000,
    });
    expect(s0.phase).toBe("waiting-for-child");
    expect(s0.detail).toBe("explore");

    const s1 = reduceActivity(s0, { type: "idle", at: 5_000 });
    expect(s1.phase).toBe("idle");
    expect(s1.detail).toBeUndefined();
  });

  it("tracks turn-end with turn count and context percent", () => {
    const s0 = createInitialActivity(1_000);
    const s1 = reduceActivity(s0, {
      type: "turn-end",
      at: 3_000,
      turnCount: 4,
      contextPercent: 62,
    });
    expect(s1.turnCount).toBe(4);
    expect(s1.contextPercent).toBe(62);
    expect(s1.lastProgressAt).toBe(3_000);
  });
});

describe("describeActivity", () => {
  it("describes initializing phase", () => {
    const snapshot: ActivitySnapshot = {
      phase: "initializing",
      detail: "extensions",
      phaseStartedAt: 10_000,
      lastProgressAt: 10_000,
      turnCount: 0,
    };
    expect(describeActivity(snapshot, 28_000)).toBe("initializing extensions · 18s");
  });

  it("describes model inference with model info", () => {
    const snapshot: ActivitySnapshot = {
      phase: "model-inference",
      effectiveProvider: "openrouter",
      effectiveModel: "anthropic/claude-opus-4.8",
      phaseStartedAt: 10_000,
      lastProgressAt: 10_000,
      turnCount: 1,
    };
    expect(describeActivity(snapshot, 53_000)).toBe(
      "model inference · openrouter/anthropic/claude-opus-4.8 · 43s",
    );
  });

  it("describes retry phase with attempt, delay and reason", () => {
    const snapshot: ActivitySnapshot = {
      phase: "retrying",
      phaseStartedAt: 10_000,
      lastProgressAt: 10_000,
      retry: { attempt: 2, maxAttempts: 3, delayMs: 4_000 },
      turnCount: 1,
    };
    expect(describeActivity(snapshot, 12_000)).toBe(
      "retrying · attempt 2/3 · next attempt in 4s",
    );
  });

  it("describes compaction phase", () => {
    const snapshot: ActivitySnapshot = {
      phase: "compacting",
      compaction: { startedAt: 10_000 },
      phaseStartedAt: 10_000,
      lastProgressAt: 10_000,
      turnCount: 1,
    };
    expect(describeActivity(snapshot, 22_000)).toBe("compacting context · 12s");
  });

  it("describes tool execution and stalled duration", () => {
    const snapshot: ActivitySnapshot = {
      phase: "tool-execution",
      activeTool: {
        callId: "c1",
        name: "bash",
        startedAt: 10_000,
        lastUpdateAt: 10_000,
      },
      phaseStartedAt: 10_000,
      lastProgressAt: 10_000,
      turnCount: 1,
    };
    expect(describeActivity(snapshot, 202_000)).toBe("tool bash · 3m12s");

    const stalled: ActivitySnapshot = {
      ...snapshot,
      stalledSince: 310_000,
    };
    expect(describeActivity(stalled, 442_000)).toBe(
      "tool bash · 7m12s · stalled for 2m12s",
    );
  });

  it("describes waiting for child", () => {
    const snapshot: ActivitySnapshot = {
      phase: "waiting-for-child",
      detail: "explore",
      phaseStartedAt: 10_000,
      lastProgressAt: 10_000,
      turnCount: 1,
    };
    expect(describeActivity(snapshot, 75_000)).toBe(
      "waiting for child explore · 1m05s",
    );
  });
});
