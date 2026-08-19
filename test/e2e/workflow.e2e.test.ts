/**
 * workflow.e2e.test.ts — the Workflow tool driven end to end, for real.
 *
 * Every other workflow suite stubs something. The runtime tests inject a fake
 * `WorkflowHost`; the tool tests drive a stub `AgentManager`. Both are the right
 * call for what they assert, but neither proves the parts fit together: a script
 * has to be parsed, compiled in a vm inside a worker thread, call back over the
 * RPC bridge, reach the real `AgentManager`, spawn real agent sessions against a
 * faux model, and carry results back across the JSON boundary.
 *
 * The evidence used here is what the *child* model calls actually saw. If a
 * subagent's context contains the prompt the script wrote, then every link in
 * that chain ran — nothing else could have put it there.
 *
 * No network and no keys: the faux backend answers every model call.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { encodeCwd } from "../../src/output-file.js";
import { readJournal } from "../../src/workflow/journal.js";
import { runPrintMode } from "../helpers/print-mode-runner.js";

/**
 * A project directory with workflows switched on.
 *
 * Workflows are opt-in, and the switch is read at extension load — so it has to
 * be on disk before the run boots, exactly as it would be for a real project
 * that turned the feature on once. Without this the tool is never registered
 * and the parent model has nothing to call.
 */
function workflowProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-wf-e2e-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: true }));
  return dir;
}

/** A `SubagentWorkflow` tool call, the way the parent model would emit one. */
const workflowCall = (script: string, id = "wf-call-1") =>
  fauxToolCall("SubagentWorkflow", { script }, { id });

/**
 * Every workflow journal written for `cwd`, across whatever session id the run
 * ended up with. The path is derived the same way `sessionTaskDir` derives it.
 */
function journalsFor(cwd: string): string[] {
  const root = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const session of readdirSync(root)) {
    const tasks = join(root, session, "tasks");
    if (!existsSync(tasks)) continue;
    for (const file of readdirSync(tasks)) {
      if (file.endsWith(".workflow.jsonl")) found.push(join(tasks, file));
    }
  }
  return found;
}

/** Everything the faux backend was ever asked, flattened for substring checks. */
const asText = (context: { messages?: unknown[] }) => JSON.stringify(context.messages ?? []);

/** Poll until `predicate` holds or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

describe("Workflow end to end", () => {
  it("runs a real script whose agents reach real sessions with the script's prompts", async () => {
    const script = [
      'export const meta = { name: "e2e-fanout", description: "spawn two agents", phases: [{ title: "Work" }] };',
      'phase("Work");',
      "const results = await parallel([",
      '  () => agent("FIRST-TASK-MARKER", { label: "one" }),',
      '  () => agent("SECOND-TASK-MARKER", { label: "two" }),',
      "]);",
      'log("collected " + results.length);',
      "return results;",
    ].join("\n");

    /** Prompts the faux backend saw on non-parent (i.e. subagent) calls. */
    const childPrompts: string[] = [];

    const cwd = workflowProject();
    const run = await runPrintMode({
      prompt: "run the workflow",
      cwd,
      maxModelCalls: 32,
      respond: context => {
        const isParent = (context.tools ?? []).some(t => t.name === "SubagentWorkflow");
        if (!isParent) {
          childPrompts.push(asText(context));
          return fauxText("SUBAGENT-DONE");
        }
        return asText(context).includes("Task ID")
          ? fauxText("workflow launched")
          : workflowCall(script);
      },
    });

    try {
      // The tool reported a background task rather than an error.
      expect(asText(run.parentSession as unknown as { messages?: unknown[] })).toContain("Task ID");

      // The detached run is still going when the parent turn ends — that is the
      // point of background dispatch — so wait for the children to actually run.
      const sawBoth = await waitFor(
        () =>
          childPrompts.some(p => p.includes("FIRST-TASK-MARKER")) &&
          childPrompts.some(p => p.includes("SECOND-TASK-MARKER")),
      );

      expect(sawBoth, `child prompts seen: ${childPrompts.length}`).toBe(true);
      await run.manager?.waitForAll();

      // The journal is what makes `resumeFromRunId` cheap, and it is only real
      // if a real run writes it — both agents, keyed and answered, on disk.
      const journals = journalsFor(cwd);
      expect(journals, "a real run must leave a journal beside its script").toHaveLength(1);
      const recorded = readJournal(journals[0]);
      expect(recorded).toHaveLength(2);
      expect(recorded.every(entry => entry.ok && entry.key.length > 0)).toBe(true);
      expect(recorded.map(entry => entry.index)).toEqual([0, 1]);
    } finally {
      await run.dispose?.();
    }
  }, 90_000);

  it("runs a saved workflow by name, with schema and a nested child, end to end", async () => {
    // The point of the compatibility work, exercised the way a real script
    // does it: a saved workflow invoked by `name`, calling another saved
    // workflow inline, whose agent answers through StructuredOutput. Every
    // link — resolution, nesting, the injected tool, validation, the realm
    // parse — has to hold or this fails.
    const cwd = workflowProject();
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "workflows", "child.js"),
      [
        'export const meta = { name: "child", description: "the nested one" };',
        'const found = await agent("NESTED-TASK-MARKER", {',
        '  label: "scan",',
        '  schema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] },',
        "});",
        "return found.files.length;",
      ].join("\n"),
    );
    writeFileSync(
      join(cwd, ".pi", "workflows", "parent.js"),
      [
        'export const meta = { name: "parent", description: "the outer one" };',
        'const count = await workflow("child", { depth: 1 });',
        'return "child found " + count;',
      ].join("\n"),
    );

    const childPrompts: string[] = [];
    const run = await runPrintMode({
      prompt: "run the saved workflow",
      cwd,
      maxModelCalls: 32,
      respond: context => {
        const isParent = (context.tools ?? []).some(t => t.name === "SubagentWorkflow");
        if (!isParent) {
          const seen = asText(context);
          childPrompts.push(seen);
          // Answer through the injected tool exactly once, then stop — a model
          // that kept calling it every turn would just spin.
          const alreadyAnswered = (context.tools ?? []).length > 0 && /Recorded\./.test(seen);
          return alreadyAnswered
            ? fauxText("done")
            : fauxToolCall("StructuredOutput", { files: ["a.ts", "b.ts"] }, { id: "so-1" });
        }
        return asText(context).includes("Task ID")
          ? fauxText("workflow launched")
          : fauxToolCall("SubagentWorkflow", { name: "parent" }, { id: "wf-call-named" });
      },
    });

    try {
      expect(asText(run.parentSession as unknown as { messages?: unknown[] })).toContain("Task ID");
      const sawNested = await waitFor(() =>
        childPrompts.some(prompt => prompt.includes("NESTED-TASK-MARKER")),
      );
      expect(sawNested, `child prompts seen: ${childPrompts.length}`).toBe(true);
      await run.manager?.waitForAll();

      // The nested child's agent is journaled as this run's own — one run, one
      // counter — which is the whole claim of same-worker nesting.
      const journals = journalsFor(cwd);
      expect(journals).toHaveLength(1);
      const recorded = readJournal(journals[0]);
      expect(recorded).toHaveLength(1);
      expect(recorded[0].index).toBe(0);
      // And the recorded answer is the validated payload, not prose.
      expect(JSON.parse(String(recorded[0].text))).toEqual({ files: ["a.ts", "b.ts"] });
    } finally {
      await run.dispose?.();
    }
  }, 90_000);

  it("surfaces a script that fails to parse instead of launching it", async () => {
    const childPrompts: string[] = [];

    const run = await runPrintMode({
      prompt: "run the broken workflow",
      cwd: workflowProject(),
      maxModelCalls: 12,
      respond: context => {
        const isParent = (context.tools ?? []).some(t => t.name === "SubagentWorkflow");
        if (!isParent) {
          childPrompts.push(asText(context));
          return fauxText("SUBAGENT-DONE");
        }
        return asText(context).includes("PURE LITERAL")
          ? fauxText("reported")
          : workflowCall(
              'export const meta = { name: computeName(), description: "x" };\n',
              "wf-call-2",
            );
      },
    });

    try {
      // The author-facing rejection reaches the model, not a stack trace.
      expect(asText(run.parentSession as unknown as { messages?: unknown[] })).toContain("PURE LITERAL");
      // And nothing was spawned for a script that never compiled.
      expect(childPrompts).toHaveLength(0);
    } finally {
      await run.dispose?.();
    }
  }, 60_000);
});
