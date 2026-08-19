/**
 * workflow-claude-code-compat.test.ts — a Claude Code script, run unchanged.
 *
 * Every other suite tests one seam. This one tests the claim the README makes:
 * that a script written for Claude Code's `Workflow` tool runs here. It is the
 * canonical example from that tool's own description, copied verbatim —
 * `schema`, `pipeline`, `parallel`, `phase`, template-literal labels and
 * `.then` chaining inside a stage, all at once.
 *
 * If a future change breaks compatibility, this is the test that should say so
 * before anyone finds out from a ported script.
 */

import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowHost } from "../src/workflow/runtime.js";

/** Claude Code's canonical review-changes example, verbatim from its tool description. */
const CC_SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const FINDINGS_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, file: { type: 'string' } }, required: ['title'] } } }, required: ['findings'] }
const VERDICT_SCHEMA = { type: 'object', properties: { isReal: { type: 'boolean' } }, required: ['isReal'] }
const DIMENSIONS = [{key: 'bugs', prompt: 'find bugs'}, {key: 'perf', prompt: 'find perf issues'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed: confirmed.length, total: results.flat().length }
`;

describe("a Claude Code script, unchanged", () => {
  it("runs the canonical review-changes example", async () => {
    const host: WorkflowHost = {
      async spawnAgent(request) {
        const text = request.label?.startsWith("verify:")
          ? JSON.stringify({ isReal: request.label.includes("a.ts") })
          : JSON.stringify({ findings: [{ title: "t1", file: "a.ts" }, { title: "t2", file: "b.ts" }] });
        return { ok: true, text, outputTokens: 10 };
      },
      abortAgent() {},
    };

    const result = await runWorkflow({ script: CC_SCRIPT, host });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    // 2 dimensions x 2 findings verified, of which the a.ts ones are real.
    expect(result.value).toEqual({ confirmed: 2, total: 4 });
    expect(result.agentCount).toBe(6);
  });
});

describe("the other Claude Code globals", () => {
  const host: WorkflowHost = {
    async spawnAgent() { return { ok: true, text: "ok", outputTokens: 25 }; },
    abortAgent() {},
    loadWorkflow: () => ({
      ok: true,
      script: 'export const meta = { name: "sub", description: "d" };\nreturn args.n * 2;\n',
    }),
  };

  it("runs the loop-until-budget and static-scaling patterns as written", async () => {
    const script = [
      "export const meta = { name: 'b', description: 'd' };",
      "const found = [];",
      "while (budget.total && budget.remaining() > 50_000) { found.push(await agent('find')); }",
      "const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5;",
      "return JSON.stringify([found.length, FLEET, budget.spent()]);",
    ].join("\n");

    const result = await runWorkflow({ script, host });
    // No target, so the loop never runs and the fallback fleet size is used —
    // which is exactly what those guards were written to do.
    expect(JSON.parse(result.value as string)).toEqual([0, 5, 0]);
  });

  it("composes a saved workflow through workflow()", async () => {
    const script = [
      "export const meta = { name: 'c', description: 'd' };",
      "const doubled = await workflow('sub', { n: 21 });",
      "return doubled;",
    ].join("\n");

    expect((await runWorkflow({ script, host })).value).toBe(42);
  });
});
