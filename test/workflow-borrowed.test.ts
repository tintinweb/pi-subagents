/**
 * The three additions that are not in Claude Code's Workflow tool: `gate`,
 * `resume`, and unawaited-launch detection. All three are optional and additive,
 * so a Claude Code script runs here unchanged — these tests exist to keep it that
 * way as much as to check the features.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowGateResult,
  type WorkflowHost,
  type WorkflowRunResult,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "a test workflow" };\n';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface GateCall {
  command: string;
  agentId: string;
  cwd?: string;
}

interface ResumeCall {
  agentId: string;
  prompt: string;
}

interface Stub {
  host: WorkflowHost;
  calls: WorkflowSpawnRequest[];
  gateCalls: GateCall[];
  resumeCalls: ResumeCall[];
  aborted: string[];
}

/**
 * Like the stub in workflow-runtime.test.ts, plus the two optional host methods.
 * Both are recorded rather than simulated: the point of the seam is that the
 * runtime's behaviour is decided here, not inside an agent manager.
 */
function stubHost(options?: {
  reply?: (request: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult> | WorkflowSpawnResult;
  gate?: (command: string) => Promise<WorkflowGateResult> | WorkflowGateResult;
  resume?: (call: ResumeCall) => Promise<WorkflowSpawnResult> | WorkflowSpawnResult;
}): Stub {
  const calls: WorkflowSpawnRequest[] = [];
  const gateCalls: GateCall[] = [];
  const resumeCalls: ResumeCall[] = [];
  const aborted: string[] = [];
  return {
    calls,
    gateCalls,
    resumeCalls,
    aborted,
    host: {
      async spawnAgent(request) {
        calls.push(request);
        return options?.reply ? await options.reply(request) : { ok: true, text: `ok:${request.prompt}` };
      },
      abortAgent(agentId) {
        aborted.push(agentId);
      },
      async runGate(command, gateOptions) {
        gateCalls.push({ command, agentId: gateOptions.agentId, cwd: gateOptions.cwd });
        return options?.gate ? await options.gate(command) : { ok: true, output: "" };
      },
      async resumeAgent(agentId, prompt) {
        resumeCalls.push({ agentId, prompt });
        return options?.resume
          ? await options.resume({ agentId, prompt })
          : { ok: true, text: `resumed:${prompt}` };
      },
    },
  };
}

function run(body: string, options: Omit<RunWorkflowOptions, "script">): Promise<WorkflowRunResult> {
  return runWorkflow({ script: HEAD + body, ...options });
}

const agentEntries = (progress: readonly WorkflowEntry[]): WorkflowAgentEntry[] =>
  progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");

/** The last entry written for an index — the log is append-only, last write wins. */
const latest = (progress: readonly WorkflowEntry[], index: number): WorkflowAgentEntry | undefined =>
  agentEntries(progress).filter(entry => entry.index === index).at(-1);

describe("gate", () => {
  it("turns a failing gate into a failed agent, with the command output as the error", async () => {
    const { host, gateCalls } = stubHost({
      gate: () => ({ ok: false, output: "FAIL src/auth.test.ts\n1 failing" }),
    });

    const result = await run('return await agent("fix the auth test", { gate: "npm test" });', {
      host,
    });

    expect(result.status).toBe("completed");
    // Not a new state and not a new entry type: a gated agent whose command
    // fails is a failed agent, so every renderer already knows what to do.
    const entry = latest(result.progress, 0);
    expect(entry?.state).toBe("error");
    expect(entry?.error).toBe("FAIL src/auth.test.ts\n1 failing");
    expect(entry?.skipped).toBeUndefined();
    // ...and the script sees the same null a dead agent produces.
    expect(result.value).toBeNull();
    expect(gateCalls).toEqual([{ command: "npm test", agentId: "wf-agent-0", cwd: undefined }]);
  });

  it("leaves a passing gate's agent done, with its value intact", async () => {
    const { host, gateCalls } = stubHost({ gate: () => ({ ok: true, output: "42 passing" }) });

    const result = await run('return await agent("fix it", { gate: "npm test" });', { host });

    expect(result.status).toBe("completed");
    expect(result.value).toBe("ok:fix it");
    const entry = latest(result.progress, 0);
    expect(entry?.state).toBe("done");
    expect(entry?.error).toBeUndefined();
    expect(gateCalls).toHaveLength(1);
  });

  it("keeps the agent's own accounting when the gate rejects the work", async () => {
    const { host } = stubHost({
      reply: () => ({ ok: true, text: "done", tokens: 1234, toolCalls: 7 }),
      gate: () => ({ ok: false, output: "boom" }),
    });

    const result = await run('return await agent("x", { gate: "npm test" });', { host });
    const entry = latest(result.progress, 0);
    expect(entry?.tokens).toBe(1234);
    expect(entry?.toolCalls).toBe(7);
    expect(entry?.resultPreview).toBeUndefined();
  });

  it("names the command when a failing gate says nothing", async () => {
    const { host } = stubHost({ gate: () => ({ ok: false, output: "   " }) });
    const result = await run('return await agent("x", { gate: "npm run lint" });', { host });
    expect(latest(result.progress, 0)?.error).toBe("Gate command failed: npm run lint");
  });

  it("does not run for an agent that already failed", async () => {
    const { host, gateCalls } = stubHost({ reply: () => ({ ok: false, error: "child exploded" }) });

    const result = await run('return await agent("x", { gate: "npm test" });', { host });

    // Gating a dead agent verifies nothing and can only overwrite the real
    // reason it died with a stale test failure.
    expect(gateCalls).toEqual([]);
    expect(latest(result.progress, 0)?.error).toBe("child exploded");
    expect(result.value).toBeNull();
  });

  it("does not run for an agent the user skipped", async () => {
    const { host, gateCalls } = stubHost({
      reply: () => ({ ok: false, skipped: true, error: "Skipped by user." }),
    });

    const result = await run('return await agent("x", { gate: "npm test" });', { host });

    expect(gateCalls).toEqual([]);
    const entry = latest(result.progress, 0);
    expect(entry?.state).toBe("error");
    expect(entry?.skipped).toBe(true);
  });

  it("runs inside the child's worktree when it has one", async () => {
    const { host, gateCalls } = stubHost({
      reply: request =>
        request.isolation === "worktree"
          ? { ok: true, text: "done", cwd: "/tmp/wt-review" }
          : { ok: true, text: "done" },
    });

    await run(
      [
        'await agent("in a worktree", { gate: "npm test", isolation: "worktree" });',
        'await agent("in the main tree", { gate: "npm test" });',
        "return null;",
      ].join("\n"),
      { host, concurrency: 1 },
    );

    // Gating the main tree for a worktree child would verify code that child
    // never touched — the cwd round-trip is the whole point of carrying it back.
    expect(gateCalls).toEqual([
      { command: "npm test", agentId: "wf-agent-0", cwd: "/tmp/wt-review" },
      { command: "npm test", agentId: "wf-agent-1", cwd: undefined },
    ]);
  });

  it("offers the command to the host, and shapes the verdict a host that ran it reports", async () => {
    // A host that can reach inside the child's settle runs the gate there —
    // inside a worktree that no longer exists by the time the result gets here.
    // The pass/fail decision and the error shaping still happen in one place:
    // this one. What must NOT happen is a second execution.
    const { host, gateCalls, calls } = stubHost({
      reply: () => ({ ok: true, text: "done", gate: { ok: false, output: "1 failing" } }),
    });

    const result = await run(
      'return await agent("x", { gate: "npm test", isolation: "worktree" });',
      { host },
    );

    expect(calls[0].gate).toBe("npm test");
    expect(gateCalls).toEqual([]);
    expect(result.value).toBeNull();
    expect(latest(result.progress, 0)?.error).toBe("1 failing");
  });

  it("keeps an agent done when the host's own gate run passed", async () => {
    const { host, gateCalls } = stubHost({
      reply: () => ({ ok: true, text: "42", gate: { ok: true, output: "3 passing" } }),
    });

    const result = await run(
      'return await agent("x", { gate: "npm test", isolation: "worktree" });',
      { host },
    );

    expect(result.value).toBe("42");
    expect(latest(result.progress, 0)?.state).toBe("done");
    expect(gateCalls).toEqual([]);
  });

  it("names the command when a gate the host ran fails silently", async () => {
    const { host } = stubHost({
      reply: () => ({ ok: true, text: "done", gate: { ok: false, output: "  " } }),
    });

    const result = await run('return await agent("x", { gate: "npm test" });', { host });

    expect(latest(result.progress, 0)?.error).toBe("Gate command failed: npm test");
  });

  it("offers nothing to the host for an ungated agent", async () => {
    const { host, calls } = stubHost();
    await run('return await agent("x");', { host });
    expect(calls[0].gate).toBeUndefined();
  });

  it("rejects an empty gate command", async () => {
    const { host, calls } = stubHost();
    const result = await run('return await agent("x", { gate: "  " });', { host });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("agent() opts.gate requires a non-empty string.");
    expect(calls).toEqual([]);
  });

  it("fails the run rather than skipping the gate when the host cannot run one", async () => {
    // A gate that quietly does not run would mark unverified work as verified,
    // which is worse than not offering gates at all.
    const { host } = stubHost();
    const gateless: WorkflowHost = { spawnAgent: host.spawnAgent, abortAgent: host.abortAgent };
    const result = await run('return await agent("x", { gate: "npm test" });', { host: gateless });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("This workflow host cannot run gate commands.");
  });
});

describe("resume", () => {
  it("continues the child that ran under the label, and still reports progress", async () => {
    const { host, calls, resumeCalls } = stubHost();

    const result = await run(
      [
        'const first = await agent("write the parser", { label: "impl", agentType: "Explore", model: "haiku" });',
        'const second = await agent("now handle escapes", { resume: "impl" });',
        "return [first, second];",
      ].join("\n"),
      { host },
    );

    expect(result.status).toBe("completed");
    expect(result.value).toEqual(["ok:write the parser", "resumed:now handle escapes"]);
    // One spawn, one resume — the second call did not pay for a fresh context.
    expect(calls).toHaveLength(1);
    expect(resumeCalls).toEqual([{ agentId: "wf-agent-0", prompt: "now handle escapes" }]);

    const second = latest(result.progress, 1);
    expect(second?.state).toBe("done");
    // Same child, so the same agent id — which is also what makes abort reach it.
    expect(second?.agentId).toBe("wf-agent-0");
    // The revived child keeps the contract it was started with, and the row
    // says so rather than falling back to general-purpose.
    expect(second?.agentType).toBe("Explore");
    expect(second?.model).toBe("haiku");
    expect(second?.label).toBe("impl");
    expect(second?.promptPreview).toBe("now handle escapes");
    // It went through the same start → done lifecycle as any other agent.
    expect(agentEntries(result.progress).filter(entry => entry.index === 1)).toHaveLength(3);
  });

  it("holds a semaphore slot like any other agent", async () => {
    let active = 0;
    let peak = 0;
    const occupy = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(15);
      active--;
      return { ok: true, text: "done" } as WorkflowSpawnResult;
    };
    const { host } = stubHost({ reply: occupy, resume: occupy });

    const result = await run(
      [
        'await agent("seed", { label: "impl" });',
        "await parallel([",
        '  () => agent("more", { resume: "impl" }),',
        '  () => agent("fresh one"),',
        "]);",
        "return null;",
      ].join("\n"),
      { host, concurrency: 1 },
    );

    expect(result.status).toBe("completed");
    expect(peak).toBe(1);
  });

  it("resumes a child whose gate rejected its work", async () => {
    // The loop gate exists for: run it, the tests fail, hand the child the
    // failure instead of starting over.
    const { host, resumeCalls } = stubHost({ gate: () => ({ ok: false, output: "1 failing" }) });

    const result = await run(
      [
        'const first = await agent("fix it", { label: "impl", gate: "npm test" });',
        'const second = await agent("still failing, try again", { resume: "impl" });',
        "return [first, second];",
      ].join("\n"),
      { host },
    );

    expect(result.value).toEqual([null, "resumed:still failing, try again"]);
    expect(resumeCalls).toHaveLength(1);
  });

  it("names the label and lists the known ones when it does not exist", async () => {
    const { host } = stubHost();
    const result = await run(
      [
        'await agent("a", { label: "scan" });',
        'await agent("b", { label: "impl" });',
        'await agent("c", { resume: "implement" });',
        "return null;",
      ].join("\n"),
      { host },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain('the label "implement"');
    expect(result.error).toContain('Known labels: "scan", "impl".');
  });

  it("says so when nothing has completed yet", async () => {
    const { host } = stubHost();
    const result = await run('return await agent("c", { resume: "impl" });', { host });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("No agent has completed yet.");
  });

  it("does not offer a failed child as a resume target", async () => {
    const { host } = stubHost({ reply: () => ({ ok: false, error: "child exploded" }) });
    const result = await run(
      ['await agent("a", { label: "impl" });', 'await agent("b", { resume: "impl" });', "return null;"].join(
        "\n",
      ),
      { host },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("No agent has completed yet.");
  });

  it("fails the run rather than starting a fresh child when the host cannot resume", async () => {
    const { host } = stubHost();
    const resumeless: WorkflowHost = {
      spawnAgent: host.spawnAgent,
      abortAgent: host.abortAgent,
      runGate: host.runGate,
    };
    const result = await run(
      ['await agent("a", { label: "impl" });', 'await agent("b", { resume: "impl" });', "return null;"].join(
        "\n",
      ),
      { host: resumeless },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("This workflow host cannot resume agents.");
  });

  describe("guardrails", () => {
    const rejected: [string, string, string][] = [
      [
        "gate",
        'await agent("a", { label: "impl" });\nawait agent("b", { resume: "impl", gate: "npm test" });',
        "agent() opts.gate cannot be combined with opts.resume.",
      ],
      [
        "agentType",
        'await agent("b", { resume: "impl", agentType: "Explore" });',
        "agent() opts.resume and opts.agentType are mutually exclusive",
      ],
      [
        "model",
        'await agent("b", { resume: "impl", model: "haiku" });',
        "agent() opts.resume and opts.model are mutually exclusive",
      ],
      [
        "isolation",
        'await agent("b", { resume: "impl", isolation: "worktree" });',
        "agent() opts.resume and opts.isolation are mutually exclusive",
      ],
      [
        "effort",
        'await agent("b", { resume: "impl", effort: "high" });',
        "agent() opts.resume and opts.effort are mutually exclusive",
      ],
    ];

    for (const [name, body, expected] of rejected) {
      it(`rejects resume combined with ${name}`, async () => {
        const { host, resumeCalls } = stubHost();
        const result = await run(`${body}\nreturn null;`, { host });
        expect(result.status).toBe("failed");
        expect(result.error).toContain(expected);
        expect(resumeCalls).toEqual([]);
      });
    }

    it("rejects an empty resume label", async () => {
      const { host } = stubHost();
      const result = await run('return await agent("b", { resume: "" });', { host });
      expect(result.status).toBe("failed");
      expect(result.error).toContain("agent() opts.resume requires a non-empty string.");
    });

    it("rejects a resume with no follow-up task", async () => {
      // Enforced by agent()'s own prompt check rather than a resume-specific
      // one: a resume with nothing to do is just an agent call with no prompt.
      const { host, resumeCalls } = stubHost();
      const result = await run(
        ['await agent("a", { label: "impl" });', 'await agent("   ", { resume: "impl" });', "return null;"].join(
          "\n",
        ),
        { host },
      );
      expect(result.status).toBe("failed");
      expect(result.error).toContain("agent(prompt) requires a non-empty string.");
      expect(resumeCalls).toEqual([]);
    });
  });
});

describe("unawaited launches", () => {
  it("fails the run and aborts the child when a launch is dropped", async () => {
    const { host, aborted } = stubHost({ reply: () => new Promise<WorkflowSpawnResult>(() => {}) });

    const result = await run(
      ['agent("scan the repo", { label: "scan" });', 'return "done";'].join("\n"),
      { host },
    );

    // Nobody is waiting for that agent's answer, so finishing "successfully"
    // would hand back a result assembled from work that was thrown away.
    expect(result.status).toBe("failed");
    expect(result.error).toBe(
      "workflow script completed with unawaited agent launch(es): 'scan'. Await or return each launch.",
    );
    expect(result.value).toBeUndefined();
    // Failing fast rather than draining: a hung child that ignores the abort
    // cannot wedge the run's completion forever.
    expect(aborted).toEqual(["wf-agent-0"]);
  });

  it("lists every dropped launch, in call order", async () => {
    const { host } = stubHost({ reply: () => new Promise<WorkflowSpawnResult>(() => {}) });
    const result = await run(
      [
        'agent("a", { label: "label-a" });',
        'agent("b", { label: "label-b" });',
        "return null;",
      ].join("\n"),
      { host, concurrency: 4 },
    );
    expect(result.error).toBe(
      "workflow script completed with unawaited agent launch(es): 'label-a', 'label-b'. Await or return each launch.",
    );
  });

  it("does not fire for a script that awaits everything", async () => {
    const { host } = stubHost({
      reply: async request => {
        if (request.prompt === "slow") await sleep(40);
        return { ok: true, text: `ok:${request.prompt}` };
      },
    });

    const result = await run(
      [
        'const held = agent("slow");',
        'const values = await parallel([() => agent("p1"), () => agent("p2")]);',
        'const out = await pipeline(["x"], async (item) => await agent("s1:" + item));',
        "return [await held, values, out];",
      ].join("\n"),
      { host, concurrency: 4 },
    );

    expect(result.status).toBe("completed");
    expect(result.value).toEqual([
      "ok:slow",
      ["ok:p1", "ok:p2"],
      ["ok:s1:x"],
    ]);
  });

  it("does not fire for a launch that settled before the script returned", async () => {
    // The host cannot tell a discarded-but-finished launch from a fire-and-
    // forget log line, and guessing would fail honest scripts.
    const { host } = stubHost();
    const result = await run(
      ['agent("fire and forget");', 'await agent("awaited");', 'return "done";'].join("\n"),
      { host, concurrency: 4 },
    );
    expect(result.status).toBe("completed");
    expect(result.value).toBe("done");
  });

  it("does not report unawaited launches when the run was aborted", async () => {
    // A killed run has in-flight agents by definition; calling that a script
    // bug would blame the user for pressing stop.
    const controller = new AbortController();
    const { host } = stubHost({ reply: () => new Promise<WorkflowSpawnResult>(() => {}) });

    let started = () => {};
    const running = new Promise<void>(resolve => {
      started = resolve;
    });

    const promise = run(
      ['agent("dropped", { label: "drop" });', 'await agent("blocks forever");', "return null;"].join("\n"),
      {
        host,
        concurrency: 4,
        signal: controller.signal,
        onProgress(entries) {
          if (entries.some(entry => entry.type === "workflow_agent" && entry.startedAt != null)) started();
        },
      },
    );

    await running;
    controller.abort();
    const result = await promise;

    expect(result.status).toBe("killed");
    expect(result.error).toBe("Workflow aborted.");
    expect(result.error).not.toContain("unawaited");
  });
});
