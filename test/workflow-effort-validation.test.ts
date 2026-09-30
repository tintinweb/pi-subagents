import { describe, expect, it, vi } from "vitest";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";

describe("workflow script effort validation", () => {
  it("dispatches explicit off from the worker script to the host unchanged", async () => {
    const host: WorkflowHost = {
      spawnAgent: vi.fn(async () => ({ ok: true, text: "checked" })),
      abortAgent: vi.fn(),
    };
    const result = await runWorkflow({
      script: `export const meta = { name: 'off-check', description: 'Check off effort' };
return await agent('check', { effort: 'off' });`,
      host,
    });
    expect(result.status).toBe("completed");
    expect(result.value).toBe("checked");
    expect(host.spawnAgent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: "check", effort: "off" }));
  });

  it.each(["invalid", "OFF"])("rejects invalid effort %s before host dispatch", async (effort) => {
    const host: WorkflowHost = {
      spawnAgent: vi.fn(async () => ({ ok: true, text: "must not dispatch" })),
      abortAgent: vi.fn(),
    };
    const result = await runWorkflow({
      script: `export const meta = { name: 'invalid-check', description: 'Check invalid effort' };
return await agent('check', { effort: ${JSON.stringify(effort)} });`,
      host,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("agent() opts.effort must be one of:");
    expect(host.spawnAgent).not.toHaveBeenCalled();
  });
});
