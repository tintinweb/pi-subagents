import { describe, expect, it } from "vitest";
import { journalKey, type WorkflowJournalEntry } from "../src/workflow/journal.js";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowControl,
  type WorkflowHost,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "errors", description: "failure diagnostics" };\n';

function run(body: string, options: Omit<RunWorkflowOptions, "script">) {
  return runWorkflow({ script: HEAD + body, ...options });
}

function hostReturning(result: WorkflowSpawnResult): WorkflowHost {
  return { async spawnAgent() { return result; }, abortAgent() {} };
}

describe("agentError", () => {
  it.each([
    { name: "provider failure", reply: { ok: false, error: "429 rate_limit_error" }, error: "429 rate_limit_error" },
    { name: "missing reason", reply: { ok: false }, error: "Agent failed." },
    { name: "empty reason", reply: { ok: false, error: "" }, error: "" },
    { name: "stopped child", reply: { ok: false, skipped: true, error: "Stopped." }, error: "Stopped." },
  ])("preserves null and journals the $name", async ({ reply, error }) => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(`
      const value = await agent("review", { label: "reviewer" });
      return { value, error: agentError("reviewer") };
    `, { host: hostReturning(reply), journal: { append: entry => entries.push(entry) } });

    expect(result).toMatchObject({ status: "completed", value: { value: null, error } });
    expect(entries).toEqual([{
      index: 0, key: journalKey({ prompt: "review", label: "reviewer" }), ok: false, error,
    }]);
  });

  it.each([499, 500, 501])("bounds a %i-character diagnostic in both the journal and sandbox", async length => {
    const entries: WorkflowJournalEntry[] = [];
    const error = "x".repeat(length);
    const result = await run('await agent("review"); return agentError("review");', {
      host: hostReturning({ ok: false, error }),
      journal: { append: entry => entries.push(entry) },
    });
    expect(result.value).toBe("x".repeat(Math.min(length, 500)));
    expect(entries[0].error).toBe("x".repeat(Math.min(length, 500)));
  });

  it("exposes thrown host errors under the derived display label", async () => {
    const result = await run('await agent("  review\\nsecond line"); return agentError("review");', {
      host: { ...hostReturning({ ok: true }), async spawnAgent() { throw new Error("provider unavailable"); } },
    });
    expect(result.value).toBe("provider unavailable");
  });

  it("reports schema and gate failures", async () => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(`
      await agent("schema", { label: "schema", schema: { type: "object" } });
      await agent("gate", { label: "gate", gate: "npm test" });
      return [agentError("schema"), agentError("gate")];
    `, {
      host: {
        ...hostReturning({ ok: true, text: "not JSON" }),
        async runGate() { return { ok: false, output: "1 failing test" }; },
      },
      journal: { append: entry => entries.push(entry) },
    });
    const errors = ["The agent did not return structured output: its answer was not JSON.", "1 failing test"];
    expect(result.value).toEqual(errors);
    expect(entries.map(entry => entry.error)).toEqual(errors);
  });

  it("retains the last failure through success and keeps labels independent", async () => {
    const result = await run(`
      const unknown = agentError("toString") === undefined;
      await agent("first", { label: "__proto__" });
      await agent("second", { label: "other" });
      await agent("success", { label: "__proto__" });
      const afterSuccess = agentError("__proto__");
      await agent("last", { label: "__proto__" });
      return { unknown, afterSuccess, latest: agentError("__proto__"), other: agentError("other") };
    `, {
      host: {
        async spawnAgent(request) {
          return request.prompt === "success" ? { ok: true, text: "done" } : { ok: false, error: request.prompt };
        },
        abortAgent() {},
      },
    });
    expect(result.value).toEqual({ unknown: true, afterSuccess: "first", latest: "last", other: "second" });
  });

  it("uses settlement order when concurrent calls share a label", async () => {
    let finishSlow: ((result: WorkflowSpawnResult) => void) | undefined;
    const result = await run(`
      const slow = agent("slow", { label: "shared" });
      await agent("fast", { label: "shared" });
      const first = agentError("shared");
      await agent("release");
      await slow;
      return [first, agentError("shared")];
    `, {
      host: {
        async spawnAgent(request) {
          if (request.prompt === "slow") return new Promise<WorkflowSpawnResult>(resolve => { finishSlow = resolve; });
          if (request.prompt === "release") {
            finishSlow?.({ ok: false, error: "slow failed" });
            return { ok: true, text: "released" };
          }
          return { ok: false, error: "fast failed" };
        },
        abortAgent() {},
      },
      concurrency: 2,
    });
    expect(result.value).toEqual(["fast failed", "slow failed"]);
  });

  it("reports a failed resume under the original label and marks its journal entry", async () => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(`
      await agent("start", { label: "reviewer" });
      const value = await agent("continue", { resume: "reviewer" });
      return { value, error: agentError("reviewer") };
    `, {
      host: { ...hostReturning({ ok: true, text: "done" }), async resumeAgent() { return { ok: false, error: "session missing" }; } },
      journal: { append: entry => entries.push(entry) },
    });
    expect(result.value).toEqual({ value: null, error: "session missing" });
    expect(entries[1]).toMatchObject({ ok: false, error: "session missing", resumed: true });
  });

  it("records a user skip before spawn", async () => {
    let control: WorkflowControl | undefined;
    let queued: () => void = () => {};
    const ready = new Promise<void>(resolve => { queued = resolve; });
    const entries: WorkflowJournalEntry[] = [];
    const done = run('const value = await agent("review"); return { value, error: agentError("review") };', {
      host: hostReturning({ ok: true, text: "should not run" }),
      onControl(c) { control = c; c.pause(); },
      onProgress(entries) { if (entries.some(entry => entry.type === "workflow_agent")) queued(); },
      journal: { append: entry => entries.push(entry) },
    });
    await ready;
    control?.skip(0);
    expect((await done).value).toEqual({ value: null, error: "Skipped by user." });
    expect(entries[0]).toMatchObject({ ok: false, error: "Skipped by user." });
  });

  it("shares diagnostics with nested workflows but starts a new run empty", async () => {
    const host: WorkflowHost = {
      ...hostReturning({ ok: false, error: "child failure" }),
      loadWorkflow() { return { ok: true, script: HEAD + 'await agent("child", { label: "nested" }); return agentError("nested");' }; },
    };
    const result = await run('const child = await workflow("child"); return [child, agentError("nested")];', { host });
    expect(result.value).toEqual(["child failure", "child failure"]);
    expect((await run('return agentError("nested") === undefined;', { host })).value).toBe(true);
  });

  it("does not restore old errors when replaying successes or retrying a journaled failure", async () => {
    const result = await run(`
      const first = await agent("cached");
      const second = await agent("retry");
      return [first, second, agentError("cached") === undefined, agentError("retry") === undefined];
    `, {
      host: hostReturning({ ok: true, text: "fresh" }),
      journal: { entries: [
        { index: 0, key: journalKey({ prompt: "cached" }), ok: true, text: "cached text", error: "old diagnostic" },
        { index: 1, key: journalKey({ prompt: "retry" }), ok: false, error: "old failure" },
      ] },
    });
    expect(result).toMatchObject({ replayedCount: 1, value: ["cached text", "fresh", true, true] });
  });

  it("exposes a read-only global and no error for a successful call", async () => {
    const result = await run(`
      const original = agentError;
      globalThis.agentError = () => "replaced";
      const removed = delete globalThis.agentError;
      await agent("success");
      return [typeof agentError, agentError === original, removed, agentError("success") === undefined];
    `, { host: hostReturning({ ok: true, text: "done" }) });
    expect(result.value).toEqual(["function", true, false, true]);
  });

  it.each(["null", "42", '""'])("rejects an invalid lookup label %s", async label => {
    const result = await run(`return agentError(${label});`, { host: hostReturning({ ok: true }) });
    expect(result).toMatchObject({ status: "failed", error: "agentError(label) requires a non-empty string." });
  });
});
