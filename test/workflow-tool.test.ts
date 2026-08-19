/**
 * workflow-tool.test.ts — the seams that bind the workflow engine to the rest of
 * the extension.
 *
 * The engine itself is covered by workflow-runtime/-progress/-meta/-render; what
 * is untested until here is everything *around* it: the adapter that turns a
 * `WorkflowSpawnRequest` into a real `AgentManager` spawn, the `SubagentWorkflow` tool's
 * input contract, and the CLI flag's ordering — read from `session_start`, never
 * at activation, because the host applies flag values only after every extension
 * has already loaded.
 *
 * The host tests drive a stub manager rather than the real one. That is not to
 * avoid work: `spawnAndWait` needs a model, a session and a repo, and none of
 * those are what these assertions are about — the mapping is.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import type { AgentRecord } from "../src/types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

/** A settled record, in the shape `toSpawnResult` reads. */
function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "a child",
    status: "completed",
    result: "the answer",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

interface StubManager {
  manager: AgentManager;
  spawnAndWait: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

/** A manager that spawns nothing; `settle` decides what each spawn produces. */
function stubManager(
  settle: (type: string, prompt: string, options: any) => Promise<AgentRecord> | AgentRecord = () => record(),
): StubManager {
  const abort = vi.fn();
  const resume = vi.fn(async () => record({ id: "agent-1", result: "resumed" }));
  const spawnAndWait = vi.fn(
    async (_pi: any, _ctx: any, type: string, prompt: string, options: any, onSpawned?: (id: string) => void) => {
      const settled = await settle(type, prompt, options);
      onSpawned?.(settled.id);
      return { id: settled.id, record: settled };
    },
  );
  return { manager: { spawnAndWait, abort, resume } as unknown as AgentManager, spawnAndWait, abort, resume };
}

const request = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "do the thing",
  label: "step",
  agentType: "general-purpose",
  ...overrides,
});

const execResult = (overrides: Partial<{ stdout: string; stderr: string; code: number; killed: boolean }> = {}) => ({
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
  ...overrides,
});

/* ------------------------------------------------------------------------- *
 * The host adapter
 * ------------------------------------------------------------------------- */

describe("createWorkflowHost — spawn mapping", () => {
  beforeEach(() => {
    // The host resolves agent types through the process-wide registry, the same
    // one the Agent tool uses. Seed it with the shipped defaults.
    registerAgents(new Map());
  });

  it("spawns through the manager and maps a completed record onto the script's result", async () => {
    const stub = stubManager(() =>
      record({ result: "the answer", toolUses: 3, lifetimeUsage: { input: 100, output: 20, cacheWrite: 5 } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ label: "review:bugs" }));

    expect(result).toMatchObject({ ok: true, text: "the answer", tokens: 125, toolCalls: 3 });
    // `tokens` is the lifetime total (100 + 20 + 5); `outputTokens` feeds the
    // script's `budget.spent()` and must be output alone, as Claude Code's
    // budget is. Billing a fan-out's re-sent input would swamp it.
    expect(result.outputTokens).toBe(20);
    const [, , type, prompt, options] = stub.spawnAndWait.mock.calls[0];
    expect(type).toBe("general-purpose");
    expect(prompt).toBe("do the thing");
    // The label is the child's display description, so the fleet list and the
    // workflow tree name the same agent the same way.
    expect(options.description).toBe("review:bugs");
  });

  it("passes isolation and the run's abort signal down to the spawn", async () => {
    const stub = stubManager();
    const controller = new AbortController();
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx(),
      manager: stub.manager,
      signal: controller.signal,
      rootSessionId: "root-1",
    });

    await host.spawnAgent(request({ isolation: "worktree" }));

    const options = stub.spawnAndWait.mock.calls[0][4];
    expect(options.isolation).toBe("worktree");
    expect(options.signal).toBe(controller.signal);
    expect(options.rootSessionId).toBe("root-1");
  });

  it("routes an unknown agent type through the same dispatch the Agent tool uses", async () => {
    // Not a second resolution path: `resolveSpawnType` owns the fallback policy,
    // so an unknown type falls back here exactly as it does for a tool call…
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const fellBack = await host.spawnAgent(request({ agentType: "no-such-agent" }));
    expect(fellBack.ok).toBe(true);
    expect(stub.spawnAndWait.mock.calls[0][2]).toBe("general-purpose");

    // …and fails closed here too when the project configured strict dispatch.
    setFallbackSubagent(NO_FALLBACK);
    try {
      const strict = stubManager();
      const strictHost = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: strict.manager });
      const rejected = await strictHost.spawnAgent(request({ agentType: "no-such-agent" }));
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatch(/no-such-agent/);
      expect(strict.spawnAndWait).not.toHaveBeenCalled();
    } finally {
      setFallbackSubagent(undefined);
    }
  });

  it("rejects a model the script named and cannot be resolved", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ model: "not-a-model" }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Model not found/);
    expect(stub.spawnAndWait).not.toHaveBeenCalled();
  });

  it("resolves a model the script named through the session's registry", async () => {
    const stub = stubManager();
    const model = { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic" };
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx({
        modelRegistry: {
          find: vi.fn(() => model),
          getAvailable: vi.fn(() => [model]),
        },
      }),
      manager: stub.manager,
    });

    await host.spawnAgent(request({ model: "haiku" }));

    expect(stub.spawnAndWait.mock.calls[0][4].model).toBe(model);
  });

  it("stamps its children with the run id and keeps them out of the pool", async () => {
    // Ownership, not decoration: the stamp is what removes a workflow's agents
    // from the fleet list, the widget and the `/agents` menus, and what keeps
    // one fan-out from filling the session's concurrency pool.
    const stub = stubManager();
    const host = createWorkflowHost({
      pi: {} as any,
      ctx: ctx(),
      manager: stub.manager,
      workflowId: "wf_run1",
    });

    await host.spawnAgent(request({}));

    // The stamp alone: `AgentManager` reads it to keep the child out of the
    // pool (covered in agent-manager.test.ts), so no second opt-out is passed.
    const options = stub.spawnAndWait.mock.calls[0][4];
    expect(options.workflowId).toBe("wf_run1");
    expect(options.bypassQueue).toBeUndefined();
  });

  it("forwards a compiled schema and prefers the structured payload", async () => {
    // `result` is prose and picks up the worktree branch note on the way out;
    // the caller asked for a schema and must get the payload, not the prose.
    const compilation = compileJsonSchema({ type: "object", properties: { a: { type: "string" } } });
    if (!compilation.ok) throw new Error(compilation.message);
    const stub = stubManager(() =>
      record({ result: "here you go", structuredJson: '{"a":"x"}' }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ schema: compilation.compiled }));

    expect(stub.spawnAndWait.mock.calls[0][4].structuredOutput).toBe(compilation.compiled);
    expect(result).toMatchObject({ ok: true, text: '{"a":"x"}' });
  });

  it("falls back to the prose when no schema was asked for", async () => {
    const stub = stubManager(() => record({ result: "here you go" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({}));

    expect(stub.spawnAndWait.mock.calls[0][4].structuredOutput).toBeUndefined();
    expect(result).toMatchObject({ ok: true, text: "here you go" });
  });

  it("leaves the stamp off when no run id was injected", async () => {
    // The runtime tests drive the host without one; an undefined stamp must not
    // become the string "undefined" and quietly group unrelated agents.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({}));

    expect(stub.spawnAndWait.mock.calls[0][4].workflowId).toBeUndefined();
  });

  it("maps opts.effort onto the spawn's thinking level", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ effort: "high" }));

    expect(stub.spawnAndWait.mock.calls[0][4].thinkingLevel).toBe("high");
  });

  it("leaves thinkingLevel unset when no effort was asked for", async () => {
    // The agent definition's `thinking` resolves it downstream; sending
    // `undefined` explicitly would be the same, but sending a default would not.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({}));

    expect(stub.spawnAndWait.mock.calls[0][4].thinkingLevel).toBeUndefined();
  });

  it("surfaces a strict worktree-isolation failure as a failed agent, not a rejection", async () => {
    const stub = stubManager(() => {
      throw new Error('Cannot run with isolation: "worktree" — not a git repo');
    });
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    // `await` rather than `rejects`: a startup failure must land in the script
    // as a null, so the rest of a fan-out keeps going.
    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/isolation: "worktree"/);
  });

  it("maps an errored record onto an error, and a stopped one onto skipped", async () => {
    const failing = stubManager(() => record({ status: "error", error: "boom" }));
    const stopped = stubManager(() => record({ status: "stopped" }));

    const failed = await createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: failing.manager })
      .spawnAgent(request());
    const skipped = await createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stopped.manager })
      .spawnAgent(request());

    expect(failed).toMatchObject({ ok: false, error: "boom" });
    expect(failed.skipped).toBeUndefined();
    expect(skipped).toMatchObject({ ok: false, skipped: true });
  });
});

describe("createWorkflowHost — worktree cwd propagation", () => {
  let worktree: string;

  beforeEach(() => {
    registerAgents(new Map());
    worktree = mkdtempSync(join(tmpdir(), "wf-worktree-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("reports the directory the child ran in, so a gate verifies that tree", async () => {
    const stub = stubManager(() =>
      record({ worktree: { path: worktree, branch: "b", baseSha: "sha", workPath: worktree } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.cwd).toBe(worktree);
  });

  it("reports no cwd once the worktree has been torn down", async () => {
    // The manager commits the child's changes to a branch and REMOVES the copy
    // before spawnAndWait resolves. Handing that path to a gate would fail every
    // gated worktree agent with a spawn error instead of a test result.
    const gone = join(worktree, "already-removed");
    expect(existsSync(gone)).toBe(false);
    const stub = stubManager(() =>
      record({ worktree: { path: gone, branch: "b", baseSha: "sha", workPath: gone } }),
    );
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const result = await host.spawnAgent(request({ isolation: "worktree" }));

    expect(result.cwd).toBeUndefined();
  });

  it("reports no cwd for a child that never had a worktree", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    expect((await host.spawnAgent(request())).cwd).toBeUndefined();
  });
});

describe("createWorkflowHost — abort, resume and gate", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  it("aborts the manager record the runtime's agent id stands for", async () => {
    const stub = stubManager(() => record({ id: "manager-id-7" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-3" }));
    host.abortAgent("wf-agent-3");

    expect(stub.abort).toHaveBeenCalledWith("manager-id-7");
  });

  it("does not abort anything for an agent that never started", () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    host.abortAgent("wf-agent-0");

    expect(stub.abort).not.toHaveBeenCalled();
  });

  it("resumes the same manager record, long after that agent settled", async () => {
    const stub = stubManager(() => record({ id: "manager-id-7" }));
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ agentId: "wf-agent-0" }));
    const resumed = await host.resumeAgent?.("wf-agent-0", "and now this");

    expect(stub.resume).toHaveBeenCalledWith("manager-id-7", "and now this", undefined);
    expect(resumed).toMatchObject({ ok: true, text: "resumed" });
  });

  it("refuses to resume an agent the run never spawned", async () => {
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    const resumed = await host.resumeAgent?.("wf-agent-9", "continue");

    expect(resumed?.ok).toBe(false);
    expect(stub.resume).not.toHaveBeenCalled();
  });

  it("asks the manager for a pre-cleanup hook only when the agent is gated", async () => {
    // The hook is how a gate reaches the child's worktree before it is deleted
    // (see workflow-gate-worktree.test.ts). An ungated agent must not acquire
    // one: nothing would run in it, and the manager's settle path is shared
    // with every other spawn.
    const stub = stubManager();
    const host = createWorkflowHost({ pi: {} as any, ctx: ctx(), manager: stub.manager });

    await host.spawnAgent(request({ isolation: "worktree" }));
    expect(stub.spawnAndWait.mock.calls[0][4].onBeforeWorktreeCleanup).toBeUndefined();

    await host.spawnAgent(request({ isolation: "worktree", gate: "npm test" }));
    expect(stub.spawnAndWait.mock.calls[1][4].onBeforeWorktreeCleanup).toBeInstanceOf(Function);
  });

  it("runs a gate through pi.exec in the child's own tree", async () => {
    const exec = vi.fn(async () => execResult({ stdout: "3 passing" }));
    const host = createWorkflowHost({
      pi: { exec } as any,
      ctx: ctx({ cwd: "/session" }),
      manager: stubManager().manager,
    });

    const gate = await host.runGate?.("npm test", { agentId: "wf-agent-0", cwd: "/worktree" });

    expect(gate).toEqual({ ok: true, output: "3 passing" });
    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: "/worktree" });
  });

  it("falls back to the session's cwd when the child had no tree of its own", async () => {
    const exec = vi.fn(async () => execResult());
    const host = createWorkflowHost({
      pi: { exec } as any,
      ctx: ctx({ cwd: "/session" }),
      manager: stubManager().manager,
    });

    await host.runGate?.("npm test", { agentId: "wf-agent-0" });

    expect(exec.mock.calls[0][2]).toMatchObject({ cwd: "/session" });
  });

  it("fails a gate on a non-zero exit and surfaces its output", async () => {
    const exec = vi.fn(async () => execResult({ code: 1, stderr: "1 failing" }));
    const host = createWorkflowHost({ pi: { exec } as any, ctx: ctx(), manager: stubManager().manager });

    expect(await host.runGate?.("npm test", { agentId: "wf-agent-0" })).toEqual({ ok: false, output: "1 failing" });
  });

  it("fails a gate that was killed, which pi.exec reports with exit code 0", async () => {
    const exec = vi.fn(async () => execResult({ killed: true, code: 0 }));
    const host = createWorkflowHost({ pi: { exec } as any, ctx: ctx(), manager: stubManager().manager });

    const gate = await host.runGate?.("sleep 999", { agentId: "wf-agent-0" });

    expect(gate?.ok).toBe(false);
    expect(gate?.output).toMatch(/timed out/);
  });
});

/* ------------------------------------------------------------------------- *
 * Tool registration
 * ------------------------------------------------------------------------- */

describe("Workflow tool registration", () => {
  it("excludes itself from subagents, so a workflow cannot recurse into itself", () => {
    // The exclusion list is derived from this object; a Workflow tool missing
    // here is a Workflow tool every spawned child inherits.
    expect(Object.values(SUBAGENT_TOOL_NAMES)).toContain("SubagentWorkflow");
    expect(SUBAGENT_TOOL_NAMES.WORKFLOW).toBe("SubagentWorkflow");
  });
});

/* ------------------------------------------------------------------------- *
 * The tool's input contract
 * ------------------------------------------------------------------------- */

const inlineScript = 'export const meta = { name: "from-inline", description: "inline source" };\n';
const fileScript = 'export const meta = { name: "from-file", description: "file source" };\n';

/** Plain theme, so a rendered component can be asserted as text. */
const plainTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe("SubagentWorkflow tool — script vs scriptPath vs name", () => {
  let hermetic: Hermetic;
  let booted: ReturnType<typeof makePi>;
  let tools: Map<string, any>;

  beforeEach(() => {
    // Hermetic dir first — settings and agent files are read at boot.
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true } });
    booted = makePi();
    subagentsExtension(booted.pi);
    tools = booted.tools;
  });

  afterEach(async () => {
    // Let any detached run settle before the temp dir disappears under it.
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const workflowCtx = () => ctx({ cwd: hermetic.dir });

  it("runs the inline script when only `script` is given, and persists it", async () => {
    const result = await tools.get("SubagentWorkflow").execute("tc-1", { script: inlineScript }, undefined, undefined, workflowCtx());

    const text = textOf(result);
    expect(text).toMatch(/Workflow "from-inline" started/);
    const scriptLine = text.split("\n").find((line: string) => line.startsWith("Script: "));
    expect(scriptLine, "the persisted script path is what makes iteration edit-then-rerun").toBeTruthy();
    expect(existsSync(scriptLine!.slice("Script: ".length))).toBe(true);
  });

  it("prefers scriptPath over script when both are given", async () => {
    const path = join(hermetic.dir, "wf.js");
    writeFileSync(path, fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-2",
      { script: inlineScript, scriptPath: path },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-file" started/);
    expect(textOf(result)).not.toMatch(/from-inline/);
  });

  it("resolves a relative scriptPath against the project directory", async () => {
    mkdirSync(join(hermetic.dir, "flows"), { recursive: true });
    writeFileSync(join(hermetic.dir, "flows", "wf.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-3",
      { scriptPath: join("flows", "wf.js") },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-file" started/);
  });

  it("reports a missing scriptPath instead of silently falling back to `script`", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-4",
      { script: inlineScript, scriptPath: join(hermetic.dir, "nope.js") },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Could not read workflow script/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("asks for one of the three when none is given", async () => {
    const result = await tools.get("SubagentWorkflow").execute("tc-5", {}, undefined, undefined, workflowCtx());

    expect(textOf(result)).toMatch(/Provide `script`.*`scriptPath`.*or `name`/s);
  });

  it("runs a saved workflow by name from .pi/workflows", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-1",
      { name: "nightly" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/Workflow "from-file" started/);
    // Reported as its own file, so editing and re-running works on a saved one.
    expect(text).toContain(join(".pi", "workflows", "nightly.js"));
  });

  it("lets script and scriptPath both outrank name", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const viaScript = await tools.get("SubagentWorkflow").execute(
      "tc-name-2",
      { script: inlineScript, name: "nightly" },
      undefined, undefined, workflowCtx(),
    );
    expect(textOf(viaScript)).toMatch(/Workflow "from-inline" started/);
  });

  it("names the saved workflows it does have when the name is unknown", async () => {
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-3",
      { name: "nightlyy" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/No saved workflow named "nightlyy"/);
    expect(text).toMatch(/Available: nightly\./);
    expect(text).not.toMatch(/started/);
  });

  it("falls back to the user's agent dir, and lets the project shadow it", async () => {
    const globalDir = join(process.env.PI_CODING_AGENT_DIR!, "workflows");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "shared.js"), fileScript);

    const fromGlobal = await tools.get("SubagentWorkflow").execute(
      "tc-name-6",
      { name: "shared" },
      undefined, undefined, workflowCtx(),
    );
    expect(textOf(fromGlobal)).toMatch(/Workflow "from-file" started/);

    // Same name in the project wins — .pi stays the project authority.
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "shared.js"), inlineScript);

    const fromProject = await tools.get("SubagentWorkflow").execute(
      "tc-name-7",
      { name: "shared" },
      undefined, undefined, workflowCtx(),
    );
    expect(textOf(fromProject)).toMatch(/Workflow "from-inline" started/);
  });

  it("refuses a file in the folder that is not a workflow", async () => {
    // These are ordinary directories — a build artifact or a scratch script can
    // sit next to the workflows, and naming one must not run it.
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "utils.js"), "module.exports = { helper: 1 };\n");

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shape-1",
      { name: "utils" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/is not a workflow script/);
    expect(text).toMatch(/Nothing was run/);
    expect(text).not.toMatch(/started/);
  });

  it("leaves non-workflow files out of the listing entirely", async () => {
    // Offering `utils.js` as a runnable workflow is what invites trying it.
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "utils.js"), "const x = 1;\n");
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "nightly.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shape-2",
      { name: "nope" },
      undefined, undefined, workflowCtx(),
    );

    const text = textOf(result);
    expect(text).toMatch(/Available: nightly\./);
    expect(text).not.toMatch(/utils/);
  });

  it("does not shadow a real workflow with a same-named non-workflow deeper down", async () => {
    // The project file wins the lookup, so the report is about the file that
    // was actually found — reaching past it to a lower root would run a
    // different script than the one the name resolves to.
    const globalDir = join(process.env.PI_CODING_AGENT_DIR!, "workflows");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "shared.js"), fileScript);
    mkdirSync(join(hermetic.dir, ".pi", "workflows"), { recursive: true });
    writeFileSync(join(hermetic.dir, ".pi", "workflows", "shared.js"), "// not a workflow\n");

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shape-3",
      { name: "shared" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/is not a workflow script/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("refuses to read a name out of its directories", async () => {
    writeFileSync(join(hermetic.dir, "escaped.js"), fileScript);

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-4",
      { name: "../escaped" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/is not a usable workflow name/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("refuses a run id this session never issued", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-resume-1",
      { script: inlineScript, resumeFromRunId: "wf_deadbeef1234" },
      undefined, undefined, workflowCtx(),
    );

    // An unknown id is an error, not a cold start: a caller that asked to
    // resume is expecting not to pay, and silently paying hides that.
    expect(textOf(result)).toMatch(/No workflow run "wf_deadbeef1234" in this session/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("refuses to resume a run that is still going", async () => {
    const started = await tools.get("SubagentWorkflow").execute(
      "tc-resume-2",
      { script: inlineScript },
      undefined, undefined, workflowCtx(),
    );
    const runId = (started.details as { taskId: string }).taskId;

    const result = await tools.get("SubagentWorkflow").execute(
      "tc-resume-3",
      { script: inlineScript, resumeFromRunId: runId },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/is still running/);
  });

  it("accepts a settled run and says plainly that there was nothing to replay", async () => {
    const started = await tools.get("SubagentWorkflow").execute(
      "tc-resume-4",
      { script: inlineScript },
      undefined, undefined, workflowCtx(),
    );
    const runId = (started.details as { taskId: string }).taskId;

    // The run is detached: it has to actually settle before it can be resumed,
    // and the worker thread takes a moment to start, compile and finish.
    let result: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      await flush();
      result = await tools.get("SubagentWorkflow").execute(
        `tc-resume-5-${attempt}`,
        { script: inlineScript, resumeFromRunId: runId },
        undefined, undefined, workflowCtx(),
      );
      if (!/is still running/.test(textOf(result))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    // That script spawns no agents, so its journal is empty. Saying so beats
    // reporting a resume that silently replayed nothing.
    expect(textOf(result)).toMatch(new RegExp(`Nothing to replay from ${runId}`));
    expect(textOf(result)).toMatch(/started in the background/);
  });

  it("ignores title and description rather than rejecting them", async () => {
    // Claude Code accepts both and ignores them; a schema rejection here would
    // cost a turn to re-emit a script that was already correct.
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-name-5",
      { script: inlineScript, title: "Nightly Audit", description: "does the thing" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/Workflow "from-inline" started/);
  });

  it("reports a bad `meta` up front rather than as a background run that failed", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-6",
      { script: "const x = 1;\n" },
      undefined, undefined, workflowCtx(),
    );

    expect(textOf(result)).toMatch(/must begin with .export const meta/);
    expect(textOf(result)).not.toMatch(/started/);
  });

  it("names the workflow on the call line", () => {
    const line = tools.get("SubagentWorkflow").renderCall({ script: inlineScript }, plainTheme, { isPartial: false }).text ?? "";
    expect(String(line)).toContain("SubagentWorkflow");
    expect(String(line)).toContain("from-inline");
  });

  it("actually runs the script in the background and notifies through the agent channel", async () => {
    const script = `${inlineScript}log("scanned 3 files");\nreturn "done here";\n`;
    const result = await tools.get("SubagentWorkflow").execute("tc-run", { script }, undefined, undefined, workflowCtx());
    const taskId = /Task ID: (\S+)/.exec(textOf(result))?.[1];
    expect(taskId).toBeTruthy();

    // The tool returned before the run finished — the completion has to arrive
    // on its own, through the same channel a background agent uses.
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId!)),
        ).toBe(true),
      { timeout: 10_000 },
    );

    const sent = booted.pi.sendMessage.mock.calls.find((c: any[]) => String(c[0]?.content).includes(taskId!))!;
    expect(sent[0].customType).toBe("subagent-notification");
    expect(sent[1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    expect(String(sent[0].content)).toContain("<result>done here</result>");

    // …and the inline card follows the background run rather than freezing at
    // whatever `execute` returned.
    const card = String(
      tools.get("SubagentWorkflow")
        .renderResult(result, { expanded: false, isPartial: false }, plainTheme, { isError: false })
        .text ?? "",
    );
    expect(card).toContain("from-inline");
    expect(card).toContain("scanned 3 files");
    expect(card).toContain("done");
  });

  /** Wait for the completion notification a background run sends for `taskId`. */
  async function awaitNotification(taskId: string) {
    await vi.waitFor(
      () =>
        expect(
          booted.pi.sendMessage.mock.calls.some((c: any[]) => String(c[0]?.content).includes(taskId)),
        ).toBe(true),
      { timeout: 10_000 },
    );
    return booted.pi.sendMessage.mock.calls.find((c: any[]) => String(c[0]?.content).includes(taskId))!;
  }

  const startedTaskId = (result: unknown) => /Task ID: (\S+)/.exec(textOf(result))![1];

  it("kills a still-running workflow (and its worker thread) on session shutdown", async () => {
    // A never-returning script: only the run's own abort signal can stop it, so
    // abortAll() over the agent records would leave the worker spinning.
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-shutdown",
      { script: `${inlineScript}await new Promise(() => {});\n` },
      undefined, undefined, workflowCtx(),
    );

    await booted.lifecycle.get("session_shutdown")?.({}, workflowCtx());

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("<status>Stopped</status>");
  });

  it("reports a script that threw, rather than a run that quietly ended", async () => {
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-throw",
      { script: `${inlineScript}throw new Error("script blew up");\n` },
      undefined, undefined, workflowCtx(),
    );

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("<status>Error:");
    expect(sent[0].details).toMatchObject({ status: "error" });
    // The reason has to be the *result* too, not only the status line — that is
    // what the collapsed notification row shows.
    expect(String(sent[0].details.resultPreview)).toContain("script blew up");
  });

  it("reports a run that could not start at all", async () => {
    // A control character is rejected before the worker is created, so this
    // never reaches the run's own error path.
    const result = await tools.get("SubagentWorkflow").execute(
      "tc-bad",
      { script: `${inlineScript}const x = "\u0007";\n` },
      undefined, undefined, workflowCtx(),
    );

    const sent = await awaitNotification(startedTaskId(result));
    expect(String(sent[0].content)).toContain("control characters");
    expect(sent[0].details).toMatchObject({ status: "error" });
  });
});

/* ------------------------------------------------------------------------- *
 * The CLI flag
 * ------------------------------------------------------------------------- */

describe("--subagents-workflow-file", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, workflowsEnabled: true } });
  });

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const uiCtx = (overrides: Record<string, unknown> = {}) =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
      ...overrides,
    });

  it("registers the fleet row as soon as a run starts, not when it settles", async () => {
    // The regression this guards: a run's agents are owned by it, so their
    // lifecycle callbacks no longer refresh the fleet — and nothing else did,
    // which left a running workflow invisible in FleetView.
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();
    await booted.lifecycle.get("session_start")?.({}, context);
    context.ui.setWidget.mockClear();

    await booted.tools.get("SubagentWorkflow").execute(
      "tc-fleet",
      { script: inlineScript },
      undefined, undefined, ctx({ cwd: hermetic.dir }),
    );

    const keys = context.ui.setWidget.mock.calls.map((call: any[]) => call[0]);
    expect(keys, "the run has to claim its row before its first agent starts").toContain("fleet");
  });

  it("captures the UI at session_start, before any tool has executed", () => {
    // A flag-launched workflow runs from session_start, so a UI captured only
    // from tool_execution_start would leave it with no widget and no fleet row.
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();

    booted.lifecycle.get("session_start")?.({}, context);

    expect(context.ui.onTerminalInput, "the fleet list only hooks input once it has a UI").toHaveBeenCalled();
  });

  it("registers the flag at activation but does not read it there", () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: "ignored-at-activation.js" });
    subagentsExtension(booted.pi);

    expect(booted.registeredFlags.get(WORKFLOW_FILE_FLAG)).toMatchObject({ type: "string" });
    // The host applies CLI values only AFTER every extension factory has run, so
    // reading here would see the registered default and never the real value.
    expect(booted.pi.getFlag).not.toHaveBeenCalled();
  });

  it("reads the flag from session_start", async () => {
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());

    expect(booted.pi.getFlag).toHaveBeenCalledWith(WORKFLOW_FILE_FLAG);
  });

  it("explains the `=` form when the flag arrives bare as boolean true", async () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: true });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => m.includes(`--${WORKFLOW_FILE_FLAG}=<path>`))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("does nothing at all when the flag was not passed", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await flush();

    expect(context.ui.notify).not.toHaveBeenCalled();
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("reports a script it cannot read without starting a run", async () => {
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: join(hermetic.dir, "absent.js") });
    subagentsExtension(booted.pi);
    const context = uiCtx();

    await booted.lifecycle.get("session_start")?.({}, context);
    await flush();

    expect(context.ui.notify.mock.calls.some((c: any[]) => /Could not read/.test(String(c[0])))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("renders the finished run as a session entry and hands it to the model as next-turn context", async () => {
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, `${fileScript}log("scanned");\nreturn "all clear";\n`);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);

    await booted.lifecycle.get("session_start")?.({}, uiCtx());
    await vi.waitFor(
      () => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything()),
      { timeout: 10_000 },
    );

    const [, data] = booted.pi.appendEntry.mock.calls.find((c: any[]) => c[0] === WORKFLOW_ENTRY_TYPE)!;
    expect(data).toMatchObject({ name: "from-file", status: "completed" });
    // The card is rebuilt from this log, so the entry has to carry it.
    expect(data.progress).toContainEqual({ type: "workflow_log", message: "scanned" });

    // nextTurn, not followUp: a flag-launched run puts its result in context
    // without forcing a turn the user never asked for.
    const sent = booted.pi.sendMessage.mock.calls.find((c: any[]) => c[0]?.customType === "workflow-result");
    expect(sent, "the run's outcome must reach the model").toBeTruthy();
    expect(sent![1]).toMatchObject({ deliverAs: "nextTurn" });
    expect(String(sent![0].content)).toContain("<result>all clear</result>");
  });

  it("renders the persisted entry through the shared workflow card layout", async () => {
    const booted = makePi();
    subagentsExtension(booted.pi);
    const renderer = booted.entryRenderers.get(WORKFLOW_ENTRY_TYPE);
    expect(renderer, "a custom entry with no renderer is silently dropped by the host").toBeTruthy();

    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const rendered = renderer(
      {
        data: {
          name: "from-file",
          status: "completed",
          startTime: 0,
          endTime: 1000,
          agentCount: 1,
          totalTokens: 0,
          progress: [
            { type: "workflow_agent", index: 0, label: "step", state: "done", agentType: "Explore" },
          ],
        },
      },
      { expanded: false },
      theme,
    );

    const text = String(rendered.text ?? "");
    expect(text).toContain("from-file");
    expect(text).toContain("step");
    expect(text).toContain("1/1 agent");
  });
});

/* ------------------------------------------------------------------------- *
 * The master switch
 * ------------------------------------------------------------------------- */

describe("workflowsEnabled — the master switch", () => {
  let hermetic: Hermetic;

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  /** A context with the UI surface `session_start` touches on the way through. */
  const switchCtx = () =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
    });

  /** Boot the extension against a project whose settings say `settings`. */
  const boot = (settings: Record<string, unknown>, flags: Record<string, string | boolean> = {}) => {
    hermetic = hermeticDir({ settings });
    const booted = makePi(flags);
    subagentsExtension(booted.pi);
    return booted;
  };

  it("is on with no setting at all", () => {
    const booted = boot({});

    expect(booted.tools.has("SubagentWorkflow")).toBe(true);
    // Nothing else is affected.
    expect(booted.tools.has("Agent")).toBe(true);
  });

  it("stays off when the setting says so explicitly", () => {
    // Not registered at all: the model is never told the feature exists. The
    // switch buys zero tool-spec tokens, which a refusing tool would not.
    expect(boot({ workflowsEnabled: false }).tools.has("SubagentWorkflow")).toBe(false);
  });

  it("registers the tool once the setting turns it on", () => {
    expect(boot({ workflowsEnabled: true }).tools.has("SubagentWorkflow")).toBe(true);
  });

  it("refuses the startup flag while off, instead of running the script anyway", async () => {
    // The flag is the same machinery by another door, so the switch has to
    // close it too — and say why, rather than appearing to do nothing.
    const booted = boot({ workflowsEnabled: false });
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    booted.pi.getFlag.mockReturnValue(path);
    const context = switchCtx();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => /workflows are off/i.test(m))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

});

/* ------------------------------------------------------------------------- *
 * Name collisions with other extensions
 * ------------------------------------------------------------------------- */

describe("collisions with another extension", () => {
  let hermetic: Hermetic;

  afterEach(async () => {
    await flush();
    hermetic.restore();
    vi.restoreAllMocks();
  });

  const boot = (settings: Record<string, unknown> = { workflowsEnabled: true }) => {
    hermetic = hermeticDir({ settings });
    const booted = makePi();
    subagentsExtension(booted.pi);
    return booted;
  };

  const uiContext = () =>
    ctx({
      hasUI: true,
      cwd: hermetic.dir,
      ui: {
        setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(),
        addAutocompleteProvider: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()),
      },
    });

  const warnings = (context: any) =>
    context.ui.notify.mock.calls.filter((c: any[]) => c[1] === "warning").map((c: any[]) => String(c[0]));

  it("warns when another extension already owns the tool name", async () => {
    // Pi keeps the FIRST registration per tool name, across extensions. Ours
    // never reaches the registry, and nothing in pi says so.
    const booted = boot();
    booted.pi.getAllTools.mockReturnValue([
      {
        name: "SubagentWorkflow",
        description: "some other extension's workflow tool",
        sourceInfo: { source: "other-ext", path: "/x/other.ts" },
      },
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).some(m => /already registers a "SubagentWorkflow" tool/.test(m))).toBe(true);
    expect(warnings(context).some(m => /other-ext/.test(m))).toBe(true);
  });

  it("stays quiet when the registered tool is our own", async () => {
    const booted = boot();
    const ours = booted.tools.get("SubagentWorkflow");
    booted.pi.getAllTools.mockReturnValue([
      { name: "SubagentWorkflow", description: ours.description, sourceInfo: { source: "pi-subagents" } },
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).filter(m => /SubagentWorkflow/.test(m))).toEqual([]);
  });

  it("does not check the tool name while workflows are off", async () => {
    // Nothing of ours is registered, so another extension owning the name is
    // simply not our business to complain about.
    const booted = boot({ workflowsEnabled: false });
    booted.pi.getAllTools.mockReturnValue([
      { name: "SubagentWorkflow", description: "someone else's", sourceInfo: { source: "other-ext" } },
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).filter(m => /SubagentWorkflow/.test(m))).toEqual([]);
  });

  it("survives a host where the listing methods are unavailable", async () => {
    // print mode and RPC mode do not bind them; a diagnostic must not be the
    // thing that takes the session down.
    const booted = boot();
    booted.pi.getAllTools.mockImplementation(() => {
      throw new Error("Extension runtime not initialized.");
    });
    const context = uiContext();

    await expect(booted.lifecycle.get("session_start")?.({}, context)).resolves.not.toThrow();
    expect(warnings(context)).toEqual([]);
  });

  /* ----------------------------------------------------------------------- *
   * Standing down for another extension's workflow tool
   *
   * The default is ON, so this extension can be the second orchestrator in a
   * session. Two workflow tools in one spec is worse than either alone, and
   * the one that was installed on purpose should be the one that survives.
   * ----------------------------------------------------------------------- */

  /** Boot with no `workflowsEnabled` at all — on by default, and unpinned. */
  const bootAuto = () => boot({});

  const foreign = (name: string, source = "other-ext") => ({
    name,
    description: "some other extension's workflow tool",
    sourceInfo: { source, path: `/x/${source}.ts` },
  });

  it("withdraws its tool when another extension provides a `Workflow` tool", async () => {
    const booted = bootAuto();
    // Registered, because the collision is only visible after every extension
    // has loaded — which is after ours registered.
    expect(booted.tools.has("SubagentWorkflow")).toBe(true);
    expect(booted.pi.getActiveTools()).toContain("SubagentWorkflow");
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    // Withdrawn for real: pi rebuilds the system prompt from the active set,
    // and session_start runs before any turn, so the model never sees it.
    expect(booted.pi.setActiveTools).toHaveBeenCalled();
    expect(booted.pi.getActiveTools()).not.toContain("SubagentWorkflow");
    // Everything else this extension registered stays.
    expect(booted.pi.getActiveTools()).toContain("Agent");
    expect(warnings(context).some(m => /already provides a "Workflow" tool/.test(m))).toBe(true);
    expect(warnings(context).some(m => /other-ext/.test(m))).toBe(true);
  });

  it("names the setting that keeps both", async () => {
    const booted = bootAuto();
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(warnings(context).some(m => /workflowsEnabled/.test(m))).toBe(true);
  });

  it("stands down without withdrawing when the foreign tool took our own name", async () => {
    // First registration wins, so ours never reached the registry. There is
    // nothing to withdraw — but the menu and the CLI flag would still be live,
    // driving a tool the model cannot call, so the feature comes down anyway.
    const booted = bootAuto();
    booted.pi.getAllTools.mockReturnValue([foreign("SubagentWorkflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(booted.pi.setActiveTools).not.toHaveBeenCalled();
    expect(warnings(context).some(m => /already provides a "SubagentWorkflow" tool/.test(m))).toBe(true);
  });

  it("refuses the startup flag once it has stood down", async () => {
    // The flag is the same machinery by another door. The collision check runs
    // first in session_start precisely so this door closes with the tool.
    hermetic = hermeticDir({ settings: {} });
    const path = join(hermetic.dir, "flow.js");
    writeFileSync(path, fileScript);
    const booted = makePi({ [WORKFLOW_FILE_FLAG]: path });
    subagentsExtension(booted.pi);
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    const notices = context.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
    expect(notices.some((m: string) => /workflows are off/i.test(m))).toBe(true);
    expect(booted.pi.appendEntry).not.toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.anything());
  });

  it("keeps ours when the setting pins workflows on", async () => {
    // A default yields to what else is loaded. A choice does not.
    const booted = boot({ workflowsEnabled: true });
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(booted.pi.setActiveTools).not.toHaveBeenCalled();
    expect(booted.pi.getActiveTools()).toContain("SubagentWorkflow");
    expect(warnings(context).filter(m => /disabled for this session/.test(m))).toEqual([]);
  });

  /**
   * Drive `/agents → Settings` far enough to write the settings file.
   *
   * Any change writes the WHOLE snapshot, so which row is toggled does not
   * matter — row 0 is `Max concurrency`, whose single-value list re-applies the
   * value it already had. What matters is that the file gets written at all.
   */
  async function changeAnUnrelatedSetting(booted: ReturnType<typeof boot>) {
    // The settings list asks for a real theme, which only the TUI normally sets up.
    initTheme(undefined, false);
    let built: any;
    // Take the Settings entry exactly once: the agents menu re-opens after a
    // submenu closes, so answering it every time never terminates.
    let taken = false;
    const context = ctx({
      cwd: hermetic.dir,
      ui: {
        notify: vi.fn(),
        select: vi.fn(async (title: string, options: string[]) => {
          if (title !== "Agents" || taken) return undefined;
          taken = true;
          return options.find(o => o === "Settings");
        }),
        custom: vi.fn(async (factory: any) => {
          built = factory({ requestRender: () => {} }, {}, {}, () => {});
          built.handleInput(" ");
          return undefined;
        }),
        input: vi.fn(async () => undefined),
      },
    });
    await booted.commands.get("agents").handler("", context);
    return context;
  }

  const savedSettings = () =>
    JSON.parse(readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf-8"));

  it("does not persist a stand-down as an explicit setting", async () => {
    // The stand-down is scoped to the session that detected it. Writing it to
    // the file would let an unrelated settings change three menus away freeze
    // it into an explicit `false` — which then outlives the extension it was
    // deferring to, leaving workflows mysteriously off after an uninstall.
    const booted = bootAuto();
    booted.pi.getAllTools.mockReturnValue([foreign("Workflow")]);
    await booted.lifecycle.get("session_start")?.({}, uiContext());

    await changeAnUnrelatedSetting(booted);

    expect(savedSettings()).not.toHaveProperty("workflowsEnabled");
  });

  it("still persists the setting when the user pinned it", async () => {
    const booted = boot({ workflowsEnabled: false });

    await changeAnUnrelatedSetting(booted);

    expect(savedSettings().workflowsEnabled).toBe(false);
  });

  it("ignores tool names that merely contain the word", async () => {
    // A substring test would turn any CI integration into a silent shutdown of
    // this feature — the kind of bug nobody can see from the outside.
    const booted = bootAuto();
    booted.pi.getAllTools.mockReturnValue([
      foreign("list_workflows"),
      foreign("github_workflow_run"),
      foreign("WorkflowTemplate"),
    ]);
    const context = uiContext();

    await booted.lifecycle.get("session_start")?.({}, context);

    expect(booted.pi.setActiveTools).not.toHaveBeenCalled();
    expect(booted.pi.getActiveTools()).toContain("SubagentWorkflow");
    expect(warnings(context)).toEqual([]);
  });
});
