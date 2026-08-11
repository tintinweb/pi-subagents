import { describe, expect, it } from "vitest";
import { addUsage, getCacheBreakdown, getLifetimeTotal, getSessionContextPercent, getSessionTokens, type LifetimeUsage } from "../src/usage.js";

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

  // Real cache-read/cache-write breakdown per dispatch, without
  // reintroducing the issue #38 double-counting (summing per-turn cacheRead,
  // which is already a cumulative snapshot, across N turns).
  describe("cacheRead breakdown", () => {
    it("addUsage sums cacheWrite but takes the LATEST value for cacheRead (no double-count)", () => {
      const lifetime: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

      // Turn 1: cacheRead already reflects the whole cached prefix re-read that turn.
      addUsage(lifetime, { input: 100, output: 50, cacheWrite: 20, cacheRead: 10_000 });
      expect(lifetime).toEqual({ input: 100, output: 50, cacheWrite: 20, cacheRead: 10_000 });

      // Turn 2: cacheWrite is incremental (sums); cacheRead is a fresh cumulative
      // snapshot for that turn and must overwrite, NOT add to, the previous value.
      addUsage(lifetime, { input: 80, output: 40, cacheWrite: 15, cacheRead: 25_000 });
      expect(lifetime).toEqual({ input: 180, output: 90, cacheWrite: 35, cacheRead: 25_000 });
      // If cacheRead were summed we'd see 35_000 here — that's the bug this guards against.
      expect(lifetime.cacheRead).not.toBe(35_000);
    });

    it("getLifetimeTotal is unchanged by cacheRead — still input + output + cacheWrite", () => {
      const u: LifetimeUsage = { input: 100, output: 200, cacheWrite: 50, cacheRead: 999_999 };
      expect(getLifetimeTotal(u)).toBe(350);
    });

    it("getCacheBreakdown exposes cacheRead/cacheWrite for telemetry consumers", () => {
      const u: LifetimeUsage = { input: 100, output: 200, cacheWrite: 50, cacheRead: 12_345 };
      expect(getCacheBreakdown(u)).toEqual({ cacheRead: 12_345, cacheWrite: 50 });
    });

    it("getCacheBreakdown returns zeros when usage is undefined", () => {
      expect(getCacheBreakdown(undefined)).toEqual({ cacheRead: 0, cacheWrite: 0 });
    });
  });

  describe("getLifetimeTotal", () => {
    it("sums components and handles undefined", () => {
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50, cacheRead: 0 })).toBe(350);
    });

    // getSessionTokens reads upstream session stats (resets at compaction);
    // getLifetimeTotal reads our independent accumulator (survives compaction).
    // They agree pre-compaction, diverge after — both legitimate signals.
    it("agrees with getSessionTokens pre-compaction, diverges after", () => {
      let sessionStatsTokens = { input: 100, output: 200, cacheWrite: 50 };
      const session = {
        getSessionStats: () => ({ tokens: sessionStatsTokens }),
      };
      const lifetime = { input: 100, output: 200, cacheWrite: 50, cacheRead: 0 };

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
      const usage: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
      const onUsage = (u: LifetimeUsage) => addUsage(usage, u);

      // 5 normal turns
      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50, cacheRead: 5_000 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      // Compaction would replace session.state.messages, dropping any sum
      // re-derived from it. Our accumulator is independent — no reset.
      const beforeCompaction = getLifetimeTotal(usage);

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30, cacheRead: 3_000 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });
});
