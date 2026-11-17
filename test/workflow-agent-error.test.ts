/**
 * workflow-agent-error.test.ts — why an `agent()` call failed.
 *
 * A failed call still resolves to `null`. The reason goes three places: the
 * journal entry's `error`, the read-only `agentError(label)` global, and the
 * run's `failures` list that the completion notification reports. Cases
 * adapted from #444 (thanks @Swarneil1905).
 */

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
  return {
    async spawnAgent() {
      return result;
    },
    abortAgent() {},
  };
}

describe("agentError(label)", () => {
  it.each([
    { name: "provider failure", reply: { ok: false, error: "429 rate_limit_error" }, error: "429 rate_limit_error" },
    { name: "missing reason", reply: { ok: false }, error: "Agent failed." },
    { name: "empty reason", reply: { ok: false, error: "" }, error: "" },
    { name: "stopped child", reply: { ok: false, skipped: true, error: "Stopped." }, error: "Stopped." },
  ])("keeps agent() null and journals the $name", async ({ reply, error }) => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(
      `const value = await agent("review", { label: "reviewer" });
       return { value, error: agentError("reviewer") };`,
      { host: hostReturning(reply), journal: { append: entry => entries.push(entry) } },
    );
    expect(result).toMatchObject({ status: "completed", value: { value: null, error } });
    expect(entries).toEqual([{ index: 0, key: journalKey({ prompt: "review", label: "reviewer" }), ok: false, error }]);
  });

  it.each([499, 500, 501])("caps a %i-character reason at 500 in the journal and the sandbox", async length => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run('await agent("review"); return agentError("review");', {
      host: hostReturning({ ok: false, error: "x".repeat(length) }),
      journal: { append: entry => entries.push(entry) },
    });
    expect(result.value).toBe("x".repeat(Math.min(length, 500)));
    expect(entries[0].error).toBe("x".repeat(Math.min(length, 500)));
  });

  it("reports a thrown host error under the derived label", async () => {
    const result = await run('await agent("  review\\nsecond line"); return agentError("review");', {
      host: {
        abortAgent() {},
        async spawnAgent() {
          throw new Error("provider unavailable");
        },
      },
    });
    expect(result.value).toBe("provider unavailable");
  });

  it("reports schema and gate failures", async () => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(
      `await agent("schema", { label: "schema", schema: { type: "object" } });
       await agent("gate", { label: "gate", gate: "npm test" });
       return [agentError("schema"), agentError("gate")];`,
      {
        host: {
          ...hostReturning({ ok: true, text: "not JSON" }),
          async runGate() {
            return { ok: false, output: "1 failing test" };
          },
        },
        journal: { append: entry => entries.push(entry) },
      },
    );
    const errors = ["The agent did not return structured output: its answer was not JSON.", "1 failing test"];
    expect(result.value).toEqual(errors);
    expect(entries.map(entry => entry.error)).toEqual(errors);
  });

  it("describes the most recent call with that label: a success clears it", async () => {
    const result = await run(
      `const unknown = agentError("toString") === undefined;
       await agent("first", { label: "__proto__" });
       const afterFailure = agentError("__proto__");
       await agent("second", { label: "other" });
       await agent("success", { label: "__proto__" });
       const afterSuccess = agentError("__proto__");
       return { unknown, afterFailure, afterSuccess, other: agentError("other") };`,
      {
        host: {
          abortAgent() {},
          async spawnAgent(request) {
            return request.prompt === "success" ? { ok: true, text: "done" } : { ok: false, error: request.prompt };
          },
        },
      },
    );
    expect(result.value).toEqual({ unknown: true, afterFailure: "first", afterSuccess: undefined, other: "second" });
  });

  it("reads undefined after a retry loop that ends in success", async () => {
    let attempts = 0;
    const result = await run(
      `let answer = null;
       for (let i = 0; i < 3 && answer === null; i++) answer = await agent("fix it", { label: "fix" });
       return { answer, error: agentError("fix") };`,
      {
        host: {
          abortAgent() {},
          async spawnAgent() {
            attempts++;
            return attempts < 3 ? { ok: false, error: `attempt ${attempts} failed` } : { ok: true, text: "fixed" };
          },
        },
      },
    );
    expect(result.value).toEqual({ answer: "fixed", error: undefined });
  });

  it("follows settlement order when concurrent calls share a label", async () => {
    let finishSlow: ((result: WorkflowSpawnResult) => void) | undefined;
    const result = await run(
      `const slow = agent("slow", { label: "shared" });
       await agent("fast", { label: "shared" });
       const first = agentError("shared");
       await agent("release");
       await slow;
       return [first, agentError("shared")];`,
      {
        host: {
          abortAgent() {},
          async spawnAgent(request) {
            if (request.prompt === "slow") {
              return new Promise<WorkflowSpawnResult>(resolve => {
                finishSlow = resolve;
              });
            }
            if (request.prompt === "release") {
              finishSlow?.({ ok: false, error: "slow failed" });
              return { ok: true, text: "released" };
            }
            return { ok: false, error: "fast failed" };
          },
        },
        concurrency: 2,
      },
    );
    expect(result.value).toEqual(["fast failed", "slow failed"]);
  });

  it("reports a failed resume under the original label and marks its journal entry", async () => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(
      `await agent("start", { label: "reviewer" });
       const value = await agent("continue", { resume: "reviewer" });
       return { value, error: agentError("reviewer") };`,
      {
        host: {
          ...hostReturning({ ok: true, text: "done" }),
          async resumeAgent() {
            return { ok: false, error: "session missing" };
          },
        },
        journal: { append: entry => entries.push(entry) },
      },
    );
    expect(result.value).toEqual({ value: null, error: "session missing" });
    expect(entries[1]).toMatchObject({ ok: false, error: "session missing", resumed: true });
  });

  it("records a user skip before the child starts", async () => {
    let control: WorkflowControl | undefined;
    let queued: () => void = () => {};
    const ready = new Promise<void>(resolve => {
      queued = resolve;
    });
    const entries: WorkflowJournalEntry[] = [];
    const done = run('const value = await agent("review"); return { value, error: agentError("review") };', {
      host: hostReturning({ ok: true, text: "should not run" }),
      onControl(c) {
        control = c;
        c.pause();
      },
      onProgress(batch) {
        if (batch.some(entry => entry.type === "workflow_agent")) queued();
      },
      journal: { append: entry => entries.push(entry) },
    });
    await ready;
    control?.skip(0);
    expect((await done).value).toEqual({ value: null, error: "Skipped by user." });
    expect(entries[0]).toMatchObject({ ok: false, error: "Skipped by user." });
  });

  it("is shared with nested workflows, and a new run starts empty", async () => {
    const host: WorkflowHost = {
      ...hostReturning({ ok: false, error: "child failure" }),
      loadWorkflow() {
        return { ok: true, script: `${HEAD}await agent("child", { label: "nested" }); return agentError("nested");` };
      },
    };
    const result = await run('const child = await workflow("child"); return [child, agentError("nested")];', { host });
    expect(result.value).toEqual(["child failure", "child failure"]);
    expect((await run('return agentError("nested") === undefined;', { host })).value).toBe(true);
  });

  it("does not restore journaled reasons on replay or retry", async () => {
    const result = await run(
      `const first = await agent("cached");
       const second = await agent("retry");
       return [first, second, agentError("cached") === undefined, agentError("retry") === undefined];`,
      {
        host: hostReturning({ ok: true, text: "fresh" }),
        journal: {
          entries: [
            { index: 0, key: journalKey({ prompt: "cached" }), ok: true, text: "cached text", error: "old diagnostic" },
            { index: 1, key: journalKey({ prompt: "retry" }), ok: false, error: "old failure" },
          ],
        },
      },
    );
    expect(result).toMatchObject({ replayedCount: 1, value: ["cached text", "fresh", true, true] });
  });

  it("is a read-only global: writing throws in strict mode, and deleting leaves it in place", async () => {
    // The vm's contextified global answers a delete itself rather than
    // throwing, so only the outcome is pinned for that half.
    const result = await run(
      `const original = agentError;
       let writeError;
       try { globalThis.agentError = () => "replaced"; } catch (e) { writeError = e.name; }
       try { delete globalThis.agentError; } catch {}
       await agent("success");
       return [writeError, agentError === original, agentError("success") === undefined];`,
      { host: hostReturning({ ok: true, text: "done" }) },
    );
    expect(result.value).toEqual(["TypeError", true, true]);
  });

  it.each(["null", "42", '""'])("rejects the label %s", async label => {
    const result = await run(`return agentError(${label});`, { host: hostReturning({ ok: true }) });
    expect(result).toMatchObject({ status: "failed", error: "agentError(label) requires a non-empty string." });
  });
});

describe("the run's failures list", () => {
  it("is empty when nothing failed", async () => {
    const result = await run('await agent("fine"); return "ok";', { host: hostReturning({ ok: true, text: "done" }) });
    expect(result.failures).toEqual([]);
  });

  it("names each failed agent with its reason", async () => {
    const result = await run(
      `await agent("one", { label: "scan:a" });
       await agent("two", { label: "scan:b" });
       return "ok";`,
      {
        host: {
          abortAgent() {},
          async spawnAgent(request) {
            return request.label === "scan:a" ? { ok: false, error: "429 rate_limit_error" } : { ok: true, text: "x" };
          },
        },
      },
    );
    expect(result.failures).toEqual(["[scan:a] failed: 429 rate_limit_error"]);
  });

  it("names a thrown pipeline stage and a thrown parallel thunk by position", async () => {
    const result = await run(
      `await pipeline([1, 2], v => { if (v === 2) throw new Error("bad stage"); return v; });
       await parallel([() => { throw new Error("bad thunk"); }, () => 1]);
       return "ok";`,
      { host: hostReturning({ ok: true, text: "x" }) },
    );
    expect(result.failures).toEqual(["pipeline[1] failed: bad stage", "parallel[0] failed: bad thunk"]);
  });

  it("leaves out skipped agents and replayed ones", async () => {
    const skipped = await run('await agent("stop me"); return "ok";', {
      host: hostReturning({ ok: false, skipped: true, error: "Stopped." }),
    });
    expect(skipped.failures).toEqual([]);

    const replayed = await run('await agent("cached"); return "ok";', {
      host: hostReturning({ ok: true, text: "fresh" }),
      journal: { entries: [{ index: 0, key: journalKey({ prompt: "cached" }), ok: true, text: "cached" }] },
    });
    expect(replayed.failures).toEqual([]);
  });
});
