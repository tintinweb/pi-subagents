import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/workflow/runtime.js", () => ({ runWorkflow: vi.fn() }));

import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { FleetList } from "../src/ui/fleet-list.js";
import { runWorkflow } from "../src/workflow/runtime.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("flag-launched workflow lifecycle", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  let context: ExtensionContext;
  let finish: () => void;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true } });
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, 'export const meta = { name: "lifecycle", description: "test" }; return "done";');
    booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    context = ctx({ cwd: hermetic.dir });
    vi.mocked(runWorkflow).mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ status: "completed", meta: { name: "lifecycle", description: "test" }, value: "done", agentCount: 0, progress: [], replayedCount: 0 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    await booted.lifecycle.get("session_shutdown")?.({}, context);
    hermetic.restore();
    vi.restoreAllMocks();
  });

  it.each(["appendEntry", "sendMessage"] as const)("survives stale %s delivery after session replacement", async method => {
    await booted.lifecycle.get("session_start")({}, context);
    booted.pi[method].mockImplementation(() => { throw new Error("stale after session replacement"); });
    // Reporting through the captured UI would throw for exactly the same reason.
    vi.mocked(context.ui.notify).mockImplementation(() => { throw new Error("stale UI"); });
    finish();
    await flush();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("could not be delivered"));
    const data = booted.pi.appendEntry.mock.calls.find((call: unknown[]) => call[0] === WORKFLOW_ENTRY_TYPE)?.[1];
    expect(data).toMatchObject({ status: "completed" });
  });

  it.each([AgentWidget, FleetList])("survives a stale %s repaint without discarding the finished task", async component => {
    await booted.lifecycle.get("session_start")({}, context);
    vi.spyOn(component.prototype, "update").mockImplementationOnce(() => { throw new Error("stale UI"); });
    finish();
    await flush();
    const data = booted.pi.appendEntry.mock.calls.find((call: unknown[]) => call[0] === WORKFLOW_ENTRY_TYPE)?.[1];
    expect(data).toMatchObject({ status: "completed" });
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(booted.pi.sendMessage.mock.calls[0][0].content)?.[1];
    expect(taskId).toBeTruthy();
    const rendered = booted.tools.get("SubagentWorkflow").renderResult(
      { content: [], details: { taskId } }, { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text }, { isError: false },
    );
    expect(rendered.text).toContain("lifecycle");
  });
});
