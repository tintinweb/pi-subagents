/**
 * workflow-info.test.ts — pins the public workflow-run shape the bus exposes:
 * `WorkflowInfo` (the lifecycle events and `workflow_list`) and `WorkflowDetail`
 * (`workflow_get`). A change to a key set here is a change to the contract other
 * extensions read (docs/rpc.md), and must be deliberate. Mirrors
 * subagent-info.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowEntry } from "../src/workflow/progress.js";
import { createWorkflowTask, type WorkflowTask } from "../src/workflow/task.js";
import { toWorkflowDetail, toWorkflowInfo } from "../src/workflow-info.js";

function task(over: Partial<WorkflowTask> = {}): WorkflowTask {
  return Object.assign(
    createWorkflowTask({ id: "wf_1", script: "export const meta = {}", startTime: 1000 }),
    over,
  );
}

const progress: WorkflowEntry[] = [
  { type: "workflow_phase", index: 0, title: "Scan" },
  { type: "workflow_log", message: "hello" },
  {
    type: "workflow_agent", index: 0, label: "a0", state: "done",
    phaseIndex: 0, phaseTitle: "Scan", agentType: "general-purpose",
    model: "haiku 4.5", thinking: "high", tokens: 5, toolCalls: 2,
    durationMs: 100, resultPreview: "ok", recordId: "rec0", agentId: "wf-agent-0",
    // Churn-only internals that must NOT reach a listener:
    lastProgressAt: 123, promptPreview: "secret prompt", attempt: 1, modelId: "anthropic/x",
  },
  { type: "workflow_agent", index: 1, label: "a1", state: "error", error: "nope" },
];

describe("toWorkflowInfo", () => {
  it("exposes exactly the documented fields of a finished run", () => {
    const info = toWorkflowInfo(task({
      status: "completed",
      meta: { name: "demo", description: "d" },
      workflowName: "demo",
      toolCallId: "tc-1",
      endTime: 4000,
      agentCount: 2,
      doneCount: 1,
      totalTokens: 10,
      totalToolCalls: 3,
      phaseLabel: "Scan (1/2)",
      error: "boom",
      failures: ["a1 failed"],
      workflowProgress: progress,
    }), 9999);

    expect(Object.keys(info).sort()).toEqual([
      "agentCount", "completedAt", "description", "doneCount", "durationMs", "error", "failedCount",
      "failures", "id", "name", "phaseLabel", "startedAt", "status", "toolCallId", "totalTokens",
      "totalToolCalls",
    ]);
    expect(info).toMatchObject({
      id: "wf_1", name: "demo", status: "completed", startedAt: 1000,
      completedAt: 4000, durationMs: 3000, agentCount: 2, doneCount: 1,
      failedCount: 1, phaseLabel: "Scan (1/2)", description: "d", toolCallId: "tc-1",
      error: "boom", failures: ["a1 failed"],
    });
  });

  it("omits every unknown value rather than carrying it as undefined", () => {
    // No meta/toolCallId/endTime/error — name falls back to the run id.
    const info = toWorkflowInfo(task({ workflowName: undefined, meta: undefined }), 1500);

    expect(Object.keys(info).sort()).toEqual([
      "agentCount", "doneCount", "durationMs", "failedCount", "id", "name",
      "phaseLabel", "startedAt", "status", "totalTokens", "totalToolCalls",
    ]);
    expect(info.name).toBe("wf_1");
    expect(info.status).toBe("running");
    expect(info.durationMs).toBe(500);
    expect(info.phaseLabel).toBe("");
  });
});

describe("toWorkflowDetail", () => {
  it("adds version and a whitelisted per-agent snapshot", () => {
    const detail = toWorkflowDetail(task({
      progressVersion: 7,
      agentCount: 2,
      workflowProgress: progress,
    }));

    expect(detail.version).toBe(7);
    expect(detail.agents).toHaveLength(2);
    // Collapsed, sorted by index; churn-only fields dropped.
    expect(Object.keys(detail.agents[0]).sort()).toEqual([
      "agentType", "durationMs", "index", "label", "model",
      "phaseIndex", "phaseTitle", "recordId", "resultPreview", "state", "thinking", "tokens", "toolCalls",
    ]);
    expect(detail.agents[0]).not.toHaveProperty("lastProgressAt");
    expect(detail.agents[0]).not.toHaveProperty("promptPreview");
    expect(detail.agents[0]).not.toHaveProperty("attempt");
    expect(detail.agents[0]).not.toHaveProperty("modelId");
    // The runtime's internal wf-agent-N handle is not part of the public shape.
    expect(detail.agents[0]).not.toHaveProperty("agentId");
    expect(detail.agents[1]).toMatchObject({ index: 1, label: "a1", state: "error", error: "nope" });
    // No return value yet and no args: omitted, not carried as undefined.
    expect(detail).not.toHaveProperty("result");
    expect(detail).not.toHaveProperty("args");
    // The script's log() lines, in order.
    expect(detail.logs).toEqual(["hello"]);
  });

  it("returns the logs as a fresh array, and [] when the script logged nothing", () => {
    // `logs` mirrors what updateWorkflowProgressBatch stores, so only the copy differs.
    const t = task({ workflowProgress: progress, logs: ["hello"] });
    toWorkflowDetail(t).logs.push("injected");
    expect(t.logs).toEqual(["hello"]);
    expect(toWorkflowDetail(t).logs).toEqual(["hello"]);
    expect(toWorkflowDetail(task()).logs).toEqual([]);
  });

  it("carries the run's args as a fresh copy", () => {
    const args = { pr: 123, files: ["a.ts"] };
    const t = task({ args });
    const detail = toWorkflowDetail(t);

    expect(detail.args).toEqual(args);
    (detail.args as typeof args).files.push("b.ts");
    expect(args.files).toEqual(["a.ts"]);
  });

  it("carries the script's return value as a fresh copy", () => {
    const value = { findings: [{ file: "a.ts", severity: "high" }] };
    const t = task({ status: "completed", value });
    const detail = toWorkflowDetail(t);

    expect(detail.result).toEqual(value);
    expect(detail.result).not.toBe(value);
    (detail.result as typeof value).findings[0].severity = "low";
    expect(value.findings[0].severity).toBe("high");
    expect(toWorkflowDetail(t).result).toEqual({ findings: [{ file: "a.ts", severity: "high" }] });
  });

  it("passes a returned primitive through as that primitive", () => {
    expect(toWorkflowDetail(task({ value: "done" })).result).toBe("done");
    expect(toWorkflowDetail(task({ value: null })).result).toBeNull();
  });

  it("keeps the result, args and logs off the summary that workflow_list returns", () => {
    const info = toWorkflowInfo(task({ status: "completed", value: { big: true }, args: { pr: 1 }, workflowProgress: progress }));
    expect(info).not.toHaveProperty("result");
    expect(info).not.toHaveProperty("args");
    expect(info).not.toHaveProperty("logs");
  });
});
