/**
 * formatters.bench.ts — the leaf functions the render paths call per agent, per
 * frame.
 *
 * These are individually tiny, which is the reason to isolate them: when a
 * widget or fleet-list benchmark moves, this file answers "was it the render or
 * something underneath it?" without bisecting. `buildInvocationTags` in
 * particular is called once per running row when `showModel` is on, and
 * `getSessionContextPercent` reaches into the live session on every row
 * regardless.
 *
 * Absolute numbers here are nanoseconds and will look irrelevant next to a
 * frame. They are — until one of them stops being O(1).
 */
import { bench, describe } from "vitest";
import {
  buildInvocationTags,
  describeActivity,
  formatCost,
  formatDuration,
  formatSessionTokens,
  formatTurns,
} from "../../src/ui/agent-widget.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../../src/usage.js";
import { NOW, perfSession, perfTheme } from "../helpers/perf-fixtures.js";

const INVOCATION = {
  modelName: "sonnet 4.6",
  modelId: "anthropic/claude-sonnet-4-6",
  thinking: "high",
  runInBackground: true,
  maxTurns: 60,
} as any;

/** The disclosure shape: both "(asked …)" annotations live, as #257 renders them. */
const INVOCATION_DISCLOSED = {
  ...INVOCATION,
  requestedModel: "google/gemini-3-pro",
  requestedThinking: "max",
} as any;

const USAGE = { input: 12_000, output: 3_000, cacheRead: 400, cacheWrite: 500 };
const SESSION = perfSession();

const ACTIVE_TOOLS = new Map([
  ["t1", "read"],
  ["t2", "bash"],
  ["t3", "grep"],
]);

describe("invocation tags", () => {
  bench("buildInvocationTags — nothing overridden", () => {
    buildInvocationTags(INVOCATION);
  });

  bench("buildInvocationTags — model and thinking disclosed", () => {
    buildInvocationTags(INVOCATION_DISCLOSED);
  });
});

describe("row formatters", () => {
  bench("formatSessionTokens", () => {
    formatSessionTokens(15_500, 42, perfTheme, 2);
  });

  bench("formatDuration", () => {
    formatDuration(NOW - 90_000, undefined);
  });

  bench("formatTurns", () => {
    formatTurns(4, 60);
  });

  bench("formatCost", () => {
    formatCost(0.0123);
  });

  bench("describeActivity — three tools active", () => {
    describeActivity(ACTIVE_TOOLS, "");
  });

  bench("describeActivity — streaming text", () => {
    describeActivity(new Map(), "a partial assistant response still streaming in");
  });
});

describe("usage leaves", () => {
  bench("getLifetimeTotal", () => {
    getLifetimeTotal(USAGE);
  });

  bench("getLifetimeCost", () => {
    getLifetimeCost(USAGE);
  });

  bench("getSessionContextPercent", () => {
    getSessionContextPercent(SESSION);
  });
});
