/**
 * workflow-task.test.ts — the record one run lives in.
 *
 * Most of `task.ts` is covered through the tool and command suites, which drive
 * it the way the extension does. The pause bookkeeping is not: it is a small
 * state machine that spans the record and the run's control surface, and the
 * two ways it can go wrong — flipping the record without telling the runtime,
 * or letting a held run keep counting elapsed time — are both invisible from
 * the outside. So it gets driven directly, against a control stub.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkflowControl } from "../src/workflow/runtime.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  pauseWorkflowTask,
  resumeWorkflowTask,
  type WorkflowTask,
} from "../src/workflow/task.js";

function stubControl(): WorkflowControl & { pause: ReturnType<typeof vi.fn> } {
  return {
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn(() => false),
    skip: vi.fn(() => true),
    retry: vi.fn(() => true),
  } as unknown as WorkflowControl & { pause: ReturnType<typeof vi.fn> };
}

function runningTask(): { task: WorkflowTask; control: ReturnType<typeof stubControl> } {
  const task = createWorkflowTask({ id: "wf_abc123", script: "", startTime: 1_000 });
  const control = stubControl();
  task.control = control;
  return { task, control };
}

describe("pausing a run", () => {
  it("tells the run to hold, not just the record", () => {
    // Flipping the status alone would show a paused run in every surface while
    // it kept starting agents.
    const { task, control } = runningTask();

    expect(pauseWorkflowTask(task, 5_000)).toBe(true);
    expect(control.pause).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("paused");
    expect(task.pausedAt).toBe(5_000);
  });

  it("banks the held time on resume, so elapsed does not count it", () => {
    const { task, control } = runningTask();
    pauseWorkflowTask(task, 5_000);

    expect(resumeWorkflowTask(task, 9_000)).toBe(true);
    expect(control.resume).toHaveBeenCalledTimes(1);
    expect(task.status).toBe("running");
    expect(task.totalPausedMs).toBe(4_000);
    expect(task.pausedAt).toBeUndefined();
  });

  it("accumulates across several pauses", () => {
    const { task } = runningTask();
    pauseWorkflowTask(task, 2_000);
    resumeWorkflowTask(task, 3_000);
    pauseWorkflowTask(task, 4_000);
    resumeWorkflowTask(task, 10_000);

    expect(task.totalPausedMs).toBe(7_000);
  });

  it("refuses when there is no run behind the record", () => {
    // A task whose run has settled keeps its progress but loses its control;
    // pausing it would be a status the runtime never agreed to.
    const task = createWorkflowTask({ id: "wf_abc123", script: "" });
    expect(pauseWorkflowTask(task)).toBe(false);
    expect(task.status).toBe("running");
  });

  it("refuses to pause twice or resume something running", () => {
    const { task, control } = runningTask();
    expect(pauseWorkflowTask(task, 1_000)).toBe(true);
    expect(pauseWorkflowTask(task, 2_000)).toBe(false);
    expect(control.pause).toHaveBeenCalledTimes(1);
    // And the first pause's clock is untouched by the refused second one.
    expect(task.pausedAt).toBe(1_000);

    expect(resumeWorkflowTask(task, 3_000)).toBe(true);
    expect(resumeWorkflowTask(task, 4_000)).toBe(false);
    expect(control.resume).toHaveBeenCalledTimes(1);
  });
});

describe("settling a run", () => {
  const result = {
    status: "completed" as const,
    value: 1,
    meta: { name: "wf", description: "d" },
    progress: [],
    agentCount: 0,
    replayedCount: 0,
  };

  it("drops the control so a finished run cannot be paused", () => {
    const { task } = runningTask();
    completeWorkflowTask(task, result);

    expect(task.control).toBeUndefined();
    expect(pauseWorkflowTask(task)).toBe(false);
  });

  it("banks a pause that was still open when the run finished", () => {
    // A run held at a pause can still settle — its last agents finish and the
    // script returns. That time was spent held, and elapsed has to say so.
    const { task } = runningTask();
    pauseWorkflowTask(task, Date.now() - 3_000);
    completeWorkflowTask(task, result);

    expect(task.pausedAt).toBeUndefined();
    expect(task.totalPausedMs).toBeGreaterThanOrEqual(3_000);
    expect(task.status).toBe("completed");
  });

  it("drops the control when the run never started", () => {
    const { task } = runningTask();
    failWorkflowTask(task, "bad meta");

    expect(task.control).toBeUndefined();
    expect(task.status).toBe("failed");
  });
});
