/**
 * subagent-info.test.ts — pins the public agent shape every `subagents:*`
 * lifecycle event carries. A change to the key set here is a change to the
 * contract other extensions read (docs/rpc.md), and must be deliberate.
 */
import { describe, expect, it } from "vitest";
import { toSubagentInfo } from "../src/subagent-info.js";
import type { AgentRecord } from "../src/types.js";

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "Explore",
    description: "audit the RPC path",
    status: "running",
    toolUses: 0,
    startedAt: 1000,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    ownUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

describe("toSubagentInfo", () => {
  it("exposes exactly the documented fields of a finished, owned record", () => {
    const info = toSubagentInfo(record({
      status: "completed",
      depth: 2,
      parentAgentId: "p1",
      workflowId: "w1",
      completedAt: 4000,
      toolUses: 3,
      result: "done",
      error: "late warning",
      structuredJson: '{"verdict":"FAIL"}',
      sessionFile: "/sessions/a1.jsonl",
      lifetimeUsage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.01 },
      // Internal fields that must never reach a listener.
      outputFile: "/tmp/a1.output",
      resultConsumed: true,
      toolCallId: "tc-1",
    }));

    expect(Object.keys(info).sort()).toEqual([
      "completedAt", "depth", "description", "durationMs", "error", "id", "parentAgentId",
      "result", "sessionFile", "startedAt", "status", "structuredJson", "tokens", "toolUses",
      "type", "usage", "workflowId",
    ]);
    expect(info).toMatchObject({
      depth: 2,
      parentAgentId: "p1",
      workflowId: "w1",
      durationMs: 3000,
      structuredJson: '{"verdict":"FAIL"}',
      sessionFile: "/sessions/a1.jsonl",
      tokens: { input: 100, output: 50, total: 160 },
    });
    expect(info.usage?.totalTokens).toBe(1060);
  });

  it("omits every unknown value rather than carrying it as undefined", () => {
    // A listener tests `"sessionFile" in payload` as readily as `!== undefined`.
    const info = toSubagentInfo(record(), 1500);

    expect(Object.keys(info).sort()).toEqual([
      "depth", "description", "durationMs", "id", "startedAt", "status", "toolUses", "type",
    ]);
    expect(info.depth).toBe(1);
    expect(info.durationMs).toBe(500);
  });
});
