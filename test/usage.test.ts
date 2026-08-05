import { describe, expect, it } from "vitest";
import { getLifetimeTotal, getSessionContextPercent, getSessionTokens, takeUnreportedUsage } from "../src/usage.js";

// Regression for issue #38 — token semantics + context indicator
describe("usage", () => {
  describe("getSessionTokens", () => {
    it("uses billed-token semantics (input + output + cacheWrite), not inflated total", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 } as any,
          contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionTokens(session)).toBe(350);
    });

    it("returns 0 when session is undefined or stats throw", () => {
      expect(getSessionTokens(undefined)).toBe(0);
      const broken = { getSessionStats: () => { throw new Error("nope"); } } as any;
      expect(getSessionTokens(broken)).toBe(0);
    });
  });

  describe("getSessionContextPercent", () => {
    it("returns null when contextUsage is unavailable", () => {
      const session = {
        getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns null when percent is null (post-compaction)", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
        }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns the upstream percent when available", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });
  });

  describe("getLifetimeTotal", () => {
    it("sums components and handles undefined", () => {
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
    });

    // getSessionTokens reads upstream session stats (resets at compaction);
    // getLifetimeTotal reads our independent accumulator (survives compaction).
    // They agree pre-compaction, diverge after — both legitimate signals.
    it("agrees with getSessionTokens pre-compaction, diverges after", () => {
      let sessionStatsTokens = { input: 100, output: 200, cacheWrite: 50 };
      const session = {
        getSessionStats: () => ({ tokens: sessionStatsTokens }),
      };
      const lifetime = { input: 100, output: 200, cacheWrite: 50 };

      expect(getSessionTokens(session)).toBe(350);
      expect(getLifetimeTotal(lifetime)).toBe(350);

      // Compaction: upstream replaces session.state.messages, so stats reset.
      // Our accumulator is independent — it keeps growing.
      sessionStatsTokens = { input: 0, output: 0, cacheWrite: 0 };

      expect(getSessionTokens(session)).toBe(0);            // reset
      expect(getLifetimeTotal(lifetime)).toBe(350);          // preserved

      // Subsequent message_end events feed both: session re-fills, accumulator continues
      sessionStatsTokens = { input: 80, output: 150, cacheWrite: 30 };
      lifetime.input += 80; lifetime.output += 150; lifetime.cacheWrite += 30;

      expect(getSessionTokens(session)).toBe(260);           // post-compaction window
      expect(getLifetimeTotal(lifetime)).toBe(610);          // 350 + 260, monotone
    });

    // The accumulator survives compaction because it lives on AgentActivity /
    // AgentRecord, not on session.state.messages (which compaction replaces).
    it("stays monotone across simulated compaction when fed via addUsage-style accumulation", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      const onUsage = (u: { input: number; output: number; cacheWrite: number }) => {
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheWrite += u.cacheWrite;
      };

      // 5 normal turns
      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      // Compaction would replace session.state.messages, dropping any sum
      // re-derived from it. Our accumulator is independent — no reset.
      const beforeCompaction = getLifetimeTotal(usage);

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });

  // Tool-result usage reporting — the canonical ToolResultMessage.usage channel
  // that lets pi core and statusline extensions count subagent spend in the
  // parent session's cost.
  describe("takeUnreportedUsage", () => {
    const lifetime = (input: number, output: number, cacheWrite: number, cacheRead: number, cost: number) =>
      ({ input, output, cacheWrite, cacheRead, cost });

    it("returns full lifetime usage as pi-ai Usage on first call", () => {
      const record = { lifetimeUsage: lifetime(100, 50, 10, 1000, 0.05) };
      expect(takeUnreportedUsage(record)).toEqual({
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 10,
        totalTokens: 1160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 },
      });
    });

    it("returns undefined when there is nothing to report", () => {
      expect(takeUnreportedUsage({ lifetimeUsage: lifetime(0, 0, 0, 0, 0) })).toBeUndefined();
    });

    it("reports only the delta on subsequent calls (no double counting)", () => {
      const record: { lifetimeUsage: ReturnType<typeof lifetime>; reportedUsage?: ReturnType<typeof lifetime> } = {
        lifetimeUsage: lifetime(100, 50, 10, 1000, 0.05),
      };
      takeUnreportedUsage(record);

      // Nothing new — a second get_subagent_result on the same terminal agent
      expect(takeUnreportedUsage(record)).toBeUndefined();

      // Resume adds spend — only the new slice is reported
      record.lifetimeUsage = lifetime(150, 80, 15, 1500, 0.08);
      expect(takeUnreportedUsage(record)).toEqual({
        input: 50,
        output: 30,
        cacheRead: 500,
        cacheWrite: 5,
        totalTokens: 585,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      });
      expect(takeUnreportedUsage(record)).toBeUndefined();
    });

    it("clamps negative deltas to zero", () => {
      const record = {
        lifetimeUsage: lifetime(50, 20, 5, 100, 0.01),
        reportedUsage: lifetime(100, 50, 10, 1000, 0.05),
      };
      // All components below the reported watermark — nothing to report
      expect(takeUnreportedUsage(record)).toBeUndefined();
    });
  });
});
