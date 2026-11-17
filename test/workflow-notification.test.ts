/**
 * workflow-notification.test.ts — the `<failures>` element of a workflow's
 * completion notification.
 *
 * Compatible with Claude Code's: the run's failure lines, one per line, after
 * `<result>`, capped at 40,000 characters, and absent when nothing failed.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowRunResult } from "../src/workflow/runtime.js";
import { completeWorkflowTask, createWorkflowTask, formatWorkflowNotification } from "../src/workflow/task.js";

function notified(failures: string[]): string {
  const task = createWorkflowTask({ id: "wf_test", script: "", startTime: 0 });
  const result: WorkflowRunResult = {
    status: "completed",
    meta: { name: "review", description: "review files" },
    value: "done",
    progress: [],
    agentCount: 2,
    replayedCount: 0,
    failures,
  };
  completeWorkflowTask(task, result);
  return formatWorkflowNotification(task, 1000);
}

describe("formatWorkflowNotification <failures>", () => {
  it("is left out when nothing failed", () => {
    expect(notified([])).not.toContain("<failures>");
  });

  it("lists each failure line after the result", () => {
    const text = notified(["[scan:a] failed: 429 rate_limit_error", "pipeline[1] failed: bad stage"]);
    expect(text).toContain("<failures>[scan:a] failed: 429 rate_limit_error\npipeline[1] failed: bad stage</failures>");
    expect(text.indexOf("<failures>")).toBeGreaterThan(text.indexOf("</result>"));
  });

  it("escapes provider text", () => {
    expect(notified(["[a] failed: <html> & co"])).toContain("<failures>[a] failed: &lt;html&gt; &amp; co</failures>");
  });

  it("caps the element at 40,000 characters", () => {
    const body = notified(["x".repeat(50_000)]).match(/<failures>([\s\S]*?)<\/failures>/)?.[1];
    expect(body?.length).toBe(40_000);
  });
});
