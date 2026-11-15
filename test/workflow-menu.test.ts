/**
 * workflow-menu.test.ts — the dialog's run controls, as the menu wires them.
 * The dialog's own keys and layout are covered in workflow-dialog.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { showWorkflowDialog, type WorkflowMenuDeps } from "../src/ui/workflow-menu.js";
import { createWorkflowTask } from "../src/workflow/task.js";

const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/** Open the dialog on `task` and hand back the actions it was given. */
async function openDialog(task: ReturnType<typeof createWorkflowTask>) {
  let actions: any;
  const ctx = {
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async (factory: any) => {
        const tui = { requestRender: vi.fn(), terminal: { columns: 100, rows: 40 } };
        const dialog = factory(tui, plainTheme, undefined, () => {});
        actions = dialog.actions;
        dialog.dispose();
      }),
    },
  };
  const onTaskChange = vi.fn();
  const deps: WorkflowMenuDeps = {
    tasks: new Map([[task.id, task]]),
    getRecord: () => undefined,
    viewAgentConversation: async () => {},
    getCtx: () => undefined,
    onTaskChange,
  };
  await showWorkflowDialog(ctx as any, task, deps);
  return { actions, onTaskChange };
}

describe("workflow dialog — pause and resume", () => {
  it("reports each status change, so the inline card redraws", async () => {
    const task = createWorkflowTask({ id: "wf_menu01", script: "" });
    task.control = { pause: vi.fn(), resume: vi.fn(), isPaused: () => false, skip: () => false, retry: () => false } as any;
    const { actions, onTaskChange } = await openDialog(task);

    actions.onPause();
    expect(task.status).toBe("paused");
    expect(onTaskChange).toHaveBeenCalledTimes(1);
    expect(onTaskChange).toHaveBeenLastCalledWith(task);

    actions.onResume();
    expect(task.status).toBe("running");
    expect(onTaskChange).toHaveBeenCalledTimes(2);
  });

  it("reports nothing when the run had nothing to pause", async () => {
    // A settled run has dropped its control handle: pause is a no-op.
    const task = createWorkflowTask({ id: "wf_menu02", script: "" });
    const { actions, onTaskChange } = await openDialog(task);

    actions.onPause();
    actions.onResume();
    expect(onTaskChange).not.toHaveBeenCalled();
  });
});
