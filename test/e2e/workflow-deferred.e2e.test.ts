/**
 * workflow-deferred.e2e.test.ts — `workflowToolExposure: "deferred"` against
 * pi's real `tool_search`.
 *
 * The unit tests pin what this extension hands pi (`exposure: "deferred"`, the
 * hidden re-registration). Only a real session proves pi does the rest: leaves
 * SubagentWorkflow out of the first request, lets `tool_search` find it, and
 * declares it for the next call, which can then run a script.
 *
 * Faux on purpose: the assertions rest on a scripted `tool_search` call and a
 * scripted workflow call. Whether a real model thinks to search is untested.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runPrintMode } from "../helpers/print-mode-runner.js";

function deferredProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-wf-deferred-e2e-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "subagents.json"),
    JSON.stringify({ workflowsEnabled: true, workflowToolExposure: "deferred" }),
  );
  return dir;
}

const asText = (context: { messages?: unknown[] }) => JSON.stringify(context.messages ?? []);
const launched = (context: { messages?: unknown[] }) => asText(context).includes("Task ID: wf_");

describe("SubagentWorkflow with deferred exposure", () => {
  it("is absent from the first request, loaded by tool_search, then runs a script", async () => {
    const script = 'export const meta = { name: "deferred-e2e", description: "literal" };\nreturn "DEFERRED-RESULT";';
    /** The tool names declared on each parent model call, in order. */
    const declared: string[][] = [];

    const run = await runPrintMode({
      prompt: "use a workflow",
      cwd: deferredProject(),
      extensionFactories: [createToolSearchExtension()],
      defaultTools: ["+tool_search"],
      maxModelCalls: 12,
      live: false, // scripted on purpose: the search and the workflow call are emitted by hand
      respond: context => {
        const names = getCurrentTools(context.messages).map(t => t.name);
        declared.push(names);
        if (launched(context)) return fauxText("workflow launched");
        if (names.includes("SubagentWorkflow")) {
          return fauxToolCall("SubagentWorkflow", { script }, { id: "wf-call-1" });
        }
        return fauxToolCall("tool_search", { query: "workflow orchestrate subagents script" }, { id: "search-1" });
      },
    });

    try {
      expect(declared[0]).toContain("tool_search");
      expect(declared[0]).toContain("Agent");
      expect(declared[0]).not.toContain("SubagentWorkflow");
      expect(declared[1]).toContain("SubagentWorkflow");
      expect(asText(run.parentSession as unknown as { messages?: unknown[] })).toContain("Task ID: wf_");
    } finally {
      await run.dispose?.();
    }
  }, 60_000);
});
