import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/workflow/runtime.js", () => ({ runWorkflow: vi.fn() }));

import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { runWorkflow } from "../src/workflow/runtime.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("flag-launched headless workflow startup", () => {
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
    subagentsExtension(booted.pi);
  });

  afterEach(async () => {
    await booted.lifecycle.get("session_shutdown")?.({}, context);
    hermetic.restore();
    vi.restoreAllMocks();
  });

  it.each(["print", "json"] as const)("awaits completion and delivery during %s startup", async mode => {
    context = ctx({ cwd: hermetic.dir, mode });
    let started = false;
    const startup = booted.lifecycle.get("session_start")({}, context).then(() => { started = true; });
    await flush();
    expect(started).toBe(false);
    expect(booted.pi.appendEntry).not.toHaveBeenCalled();
    finish();
    await startup;
    expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.objectContaining({ status: "completed" }));
    expect(booted.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "workflow-result", content: expect.stringContaining("<result>done</result>") }),
      { deliverAs: "nextTurn" },
    );
  });

  it.each(["tui", "rpc"] as const)("leaves %s startup detached", async mode => {
    context = ctx({ cwd: hermetic.dir, mode });
    await booted.lifecycle.get("session_start")({}, context);
    expect(booted.pi.appendEntry).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.objectContaining({ status: "completed" }));
  });
});
