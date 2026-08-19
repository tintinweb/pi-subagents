import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAvailableTypes, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { setScopeModelsEnabled } from "../src/model-scope.js";
import { createNestedSubagentTools, getMaxSubagentDepth, type NestedAgentManager, setMaxSubagentDepth } from "../src/nested-tools.js";
import { encodeCwd } from "../src/output-file.js";

let cwd: string;
let manager: NestedAgentManager;
let records: Map<string, any>;
let spawn: ReturnType<typeof vi.fn>;
let spawnAndWait: ReturnType<typeof vi.fn>;

function writeAgent(name: string, extra = "") {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n${extra}---\n${name}\n`);
}

const MODELS = [
  { id: "allowed", name: "Allowed", provider: "anthropic" },
  { id: "blocked", name: "Blocked", provider: "anthropic" },
];

function ctx(executionCwd = cwd) {
  return {
    cwd: executionCwd,
    model: undefined,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getAvailable: () => MODELS,
      getAll: () => MODELS,
    },
  } as any;
}

function tools(
  allowedSubagents: "all" | string[] = "all",
  depth = 1,
  maxSubagentDepth = 2,
  configCwd = cwd,
) {
  return createNestedSubagentTools({
    manager,
    pi: {} as any,
    parentAgentId: "parent-1",
    depth,
    maxSubagentDepth,
    allowedSubagents,
    configCwd,
  });
}

async function execute(tool: any, params: Record<string, unknown>, executionCwd = cwd) {
  return tool.execute("call-1", params, undefined, undefined, ctx(executionCwd));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nested-tools-test-"));
  writeAgent("scout");
  writeAgent("reviewer");
  registerAgents(loadCustomAgents(cwd));
  records = new Map();
  spawn = vi.fn((_pi, _ctx, type, _prompt, options) => {
    const id = `child-${records.size + 1}`;
    records.set(id, { id, type, status: "running", parentAgentId: options.parentAgentId });
    return id;
  });
  spawnAndWait = vi.fn(async (_pi, _ctx, type, _prompt, options) => {
    const id = `child-${records.size + 1}`;
    const record = { id, type, status: "completed", result: "done", parentAgentId: options.parentAgentId };
    records.set(id, record);
    return { id, record };
  });
  manager = {
    spawn,
    spawnAndWait,
    awaitStartup: vi.fn(async () => {}),
    getRecord: (id: string) => records.get(id),
    resume: vi.fn(),
  } as any;
});

afterEach(() => {
  setScopeModelsEnabled(false);
  rmSync(cwd, { recursive: true, force: true });
});

describe("child-safe nested Agent tools", () => {
  it("allows any enabled agent when allowed_subagents is omitted", async () => {
    const [agent] = tools();
    const result = await execute(agent, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "reviewer", "Review it",
      expect.objectContaining({
        depth: 2,
        parentAgentId: "parent-1",
        maxSubagentDepth: 2,
        configCwd: cwd,
      }),
      expect.any(Function), // onSpawned — attaches the child's transcript
    );
  });

  it("keeps agent discovery rooted in inherited config, not the working directory", async () => {
    const workCwd = mkdtempSync(join(tmpdir(), "nested-tools-work-"));
    const workAgentDir = join(workCwd, ".pi", "agents");
    mkdirSync(workAgentDir, { recursive: true });
    writeFileSync(join(workAgentDir, "intruder.md"), "---\ndescription: intruder\n---\nintruder\n");

    try {
      const [agent] = tools();
      const result = await execute(agent, {
        subagent_type: "intruder",
        description: "untrusted agent",
        prompt: "Do work",
      }, workCwd);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown or disabled");
      expect(spawnAndWait).not.toHaveBeenCalled();
    } finally {
      rmSync(workCwd, { recursive: true, force: true });
    }
  });

  it("enforces a narrow allowlist", async () => {
    const [limited] = tools(["scout"]);
    const denied = await execute(limited, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not allowed");
    expect(spawnAndWait).not.toHaveBeenCalled();

    const allowed = await execute(limited, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });
    expect(allowed.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledTimes(1);
  });

  it("resolves nested types without touching the process-global registry", async () => {
    // A worktree-isolated parent hands its own config root down. Resolving from
    // it must not swap the registry the main session and every other agent read.
    const otherCwd = mkdtempSync(join(tmpdir(), "nested-tools-config-"));
    const otherAgentDir = join(otherCwd, ".pi", "agents");
    mkdirSync(otherAgentDir, { recursive: true });
    writeFileSync(join(otherAgentDir, "branch-only.md"), "---\ndescription: branch-only\n---\nbranch-only\n");
    const before = getAvailableTypes();

    try {
      const [agent] = tools("all", 1, 2, otherCwd);
      const result = await execute(agent, {
        subagent_type: "branch-only",
        description: "branch agent",
        prompt: "Do work",
      });

      // Resolved from the inherited root...
      expect(result.isError).toBe(false);
      // ...without leaking it into the shared registry.
      expect(getAvailableTypes()).toEqual(before);
      expect(getAvailableTypes()).not.toContain("branch-only");
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("applies the scopeModels allowlist to a caller-supplied model", async () => {
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["anthropic/allowed"] }),
    );
    setScopeModelsEnabled(true);
    const [agent] = tools();

    const blocked = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      model: "anthropic/blocked",
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("Model not in scope");
    expect(spawnAndWait).not.toHaveBeenCalled();

    const inScope = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      model: "anthropic/allowed",
    });
    expect(inScope.isError).toBe(false);
  });

  it("queues a steer for an owned child whose session is not ready yet", async () => {
    const [, , steer] = tools();
    const record: Record<string, unknown> = {
      id: "child-1",
      status: "running",
      parentAgentId: "parent-1",
    };
    records.set("child-1", record);

    const result = await execute(steer, { agent_id: "child-1", message: "focus on tests" });

    expect(result.isError).toBe(false);
    expect(record.pendingSteers).toEqual(["focus on tests"]);
  });

  it("blocks delegation at the inherited depth cap", async () => {
    const [agent] = tools("all", 2, 2);
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("depth=2, max=2");
    expect(spawnAndWait).not.toHaveBeenCalled();
  });

  it("rejects unknown or disabled nested agent types instead of falling back", async () => {
    writeAgent("disabled", "enabled: false\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools();

    for (const subagentType of ["missing", "disabled"]) {
      const result = await execute(agent, {
        subagent_type: subagentType,
        description: "invalid agent",
        prompt: "Do work",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown or disabled");
    }
  });

  it("supports background launches and ownership-scopes result, resume, and steer", async () => {
    const [agent, getResult, steer] = tools(["scout"]);
    const launched = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      run_in_background: true,
    });
    expect(launched.content[0].text).toContain("child-1");
    expect(spawn).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "scout", "Find them",
      expect.objectContaining({ isBackground: true, depth: 2, parentAgentId: "parent-1" }),
    );

    const own = await execute(getResult, { agent_id: "child-1" });
    expect(own.isError).toBe(false);

    records.set("foreign", {
      id: "foreign",
      status: "running",
      result: "secret",
      parentAgentId: "other",
      session: { steer: vi.fn() },
    });
    expect((await execute(getResult, { agent_id: "foreign" })).isError).toBe(true);
    expect((await execute(steer, { agent_id: "foreign", message: "stop" })).isError).toBe(true);
    expect((await execute(agent, {
      resume: "foreign",
      subagent_type: "scout",
      description: "resume foreign",
      prompt: "Continue",
    })).isError).toBe(true);
    expect(manager.resume).not.toHaveBeenCalled();
  });

  it("reports a background child that fails to start as a tool error", async () => {
    // Under isolation: "worktree" the child is not running when spawn() returns
    // — the repo copy is awaited. The failure must reach the parent as an error
    // result, not as "Nested agent started in background".
    vi.mocked(manager.awaitStartup).mockRejectedValueOnce(
      new Error('Cannot run with isolation: "worktree"'),
    );
    const [agent] = tools(["scout"]);

    const result = await execute(agent, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
      run_in_background: true,
      isolation: "worktree",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('isolation: "worktree"');
  });

  it("waits for a queued owned child to start and settle", async () => {
    const [, getResult] = tools();
    const record = {
      id: "queued-child",
      status: "queued",
      parentAgentId: "parent-1",
      promise: undefined as Promise<unknown> | undefined,
      result: undefined as string | undefined,
    };
    records.set(record.id, record);
    setTimeout(() => {
      record.status = "running";
      record.promise = Promise.resolve().then(() => {
        record.status = "completed";
        record.result = "queued done";
      });
    }, 10);

    const result = await execute(getResult, { agent_id: record.id, wait: true });

    expect(result.content[0].text).toBe("queued done");
  });

  it("aborts a nested result wait without aborting the owned child", async () => {
    const [, getResult] = tools();
    let settleChild: (() => void) | undefined;
    const record = {
      id: "running-child",
      status: "running",
      parentAgentId: "parent-1",
      promise: new Promise<void>(resolve => { settleChild = resolve; }),
    };
    records.set(record.id, record);

    const controller = new AbortController();
    const outcome = getResult
      .execute("call-abort", { agent_id: record.id, wait: true }, controller.signal, undefined, ctx())
      .then(() => "resolved", (e: unknown) => (e instanceof Error ? e.name : String(e)));

    controller.abort();
    const settled = await Promise.race([
      outcome,
      new Promise(r => setTimeout(() => r("timed-out"), 100)),
    ]);

    expect(settled).toBe("AbortError");
    // The wait was cancelled but the child was never aborted or consumed.
    expect(record.status).toBe("running");
    settleChild?.();
  });

  it("still rejects unknown types when the project configures a fallback", async () => {
    // The contract nested delegation documents is "rejected rather than falling
    // back" — a top-level fallback must not hand a nested caller an agent its
    // allowlist never named.
    setFallbackSubagent("scout");
    try {
      const [agent] = tools(["scout"]);
      const result = await execute(agent, {
        subagent_type: "definitely-missing",
        description: "typo",
        prompt: "Do work",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown or disabled nested agent type");
      expect(spawnAndWait).not.toHaveBeenCalled();
    } finally {
      setFallbackSubagent(undefined);
    }
  });

  it("hands the branch cap down to the child it spawns", async () => {
    const [agent] = tools("all", 1, 3);
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "child",
      prompt: "Do work",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "scout", "Do work",
      expect.objectContaining({ depth: 2, maxSubagentDepth: 3 }),
      expect.any(Function),
    );
  });

  it("flags a truncated child run instead of passing partial output off as complete", async () => {
    spawnAndWait.mockImplementation(async () => ({
      id: "child-1",
      record: { id: "child-1", status: "steered", result: "half an answer", parentAgentId: "parent-1" },
    }));
    const [agent] = tools();
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "truncated",
      prompt: "Do work",
    });

    expect(result.isError).toBe(false);
    // Foreground: the whole output is inline and no id came back, so the note
    // must not invite a get_subagent_result call the parent cannot make (#174).
    expect(result.content[0].text).toContain("everything the agent produced is above");
    expect(result.content[0].text).not.toContain("output is partial");
    // The warning leads, so it can't read as part of the child's own answer.
    expect(result.content[0].text.indexOf("half an answer")).toBeGreaterThan(0);
  });

  it("uses the fetchable wording when the parent polls a background child by id", async () => {
    records.set("child-1", {
      id: "child-1", status: "aborted", result: "partial work", parentAgentId: "parent-1",
    });
    const [, getResult] = tools();
    const result = await execute(getResult, { agent_id: "child-1" });

    // Here the parent does hold a valid id, so the background wording applies.
    expect(result.content[0].text).toContain("output may be incomplete");
    expect(result.content[0].text).not.toContain("everything the agent produced is above");
  });

  it("keeps a failed child's partial output alongside the error", async () => {
    spawnAndWait.mockImplementation(async () => ({
      id: "child-1",
      record: {
        id: "child-1", status: "error", error: "provider exploded",
        result: "got this far", parentAgentId: "parent-1",
      },
    }));
    const [agent] = tools();
    const result = await execute(agent, {
      subagent_type: "scout",
      description: "failing",
      prompt: "Do work",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("provider exploded");
    expect(result.content[0].text).toContain("got this far");
  });

  it("attributes a nested child's token spend to the owning parent", async () => {
    const parent = { id: "parent-1", status: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
    records.set("parent-1", parent);
    spawn.mockImplementation((_pi, _ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.({ input: 100, output: 20, cacheWrite: 5 });
      return "child-1";
    });

    const [agent] = tools();
    await execute(agent, {
      subagent_type: "scout",
      description: "spender",
      prompt: "Do work",
      run_in_background: true,
    });

    expect(parent.lifetimeUsage).toEqual({ input: 100, output: 20, cacheWrite: 5 });
  });

  it("attributes spend up the whole ancestor chain, not just one level", async () => {
    // A spawn callback fires only for that child's own turns, so a deeper
    // descendant would otherwise never reach the one record anyone can see.
    const top = { id: "top", status: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
    const middle = {
      id: "parent-1", status: "running", parentAgentId: "top",
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    };
    records.set("top", top);
    records.set("parent-1", middle);
    spawn.mockImplementation((_pi, _ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.({ input: 7, output: 3, cacheWrite: 1 });
      return "child-1";
    });

    const [agent] = tools();
    await execute(agent, {
      subagent_type: "scout",
      description: "deep spender",
      prompt: "Do work",
      run_in_background: true,
    });

    expect(middle.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1 });
    expect(top.lifetimeUsage).toEqual({ input: 7, output: 3, cacheWrite: 1 });
  });

  it("files a nested transcript under the root session, honoring output_transcript", async () => {
    records.set("parent-1", { id: "parent-1", status: "running", rootSessionId: "root-session" });
    spawnAndWait.mockImplementation(async (_pi, _ctx, type, _prompt, options, onSpawned) => {
      const record = { id: "child-1", type, status: "completed", result: "done", parentAgentId: options.parentAgentId };
      records.set("child-1", record);
      onSpawned?.("child-1");
      return { id: "child-1", record };
    });

    // Real path construction (not mocked here), so clean up what it writes.
    const transcriptRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
    try {
      const [agent] = tools();
      await execute(agent, { subagent_type: "scout", description: "traced", prompt: "Do work" });
      expect(records.get("child-1").outputFile).toContain(join("root-session", "tasks", "child-1.output"));

      // The child's own frontmatter still wins.
      writeAgent("quiet", "output_transcript: false\n");
      registerAgents(loadCustomAgents(cwd));
      records.delete("child-1");
      await execute(agent, { subagent_type: "quiet", description: "untraced", prompt: "Do work" });
      expect(records.get("child-1").outputFile).toBeUndefined();
    } finally {
      rmSync(transcriptRoot, { recursive: true, force: true });
    }
  });

  it("forwards the execution context to the manager unmodified", async () => {
    // Each AgentSession builds its own ExtensionRunner, so the ctx handed to
    // execute is the CHILD's — capturing one at tool-build time instead would
    // silently misroute the grandchild's cwd, conversation, and model.
    const [agent] = tools();
    const executionCtx = ctx();
    await agent.execute("call-1", {
      subagent_type: "scout",
      description: "ctx check",
      prompt: "Do work",
    } as any, undefined, undefined, executionCtx);

    expect(spawnAndWait.mock.calls[0][1]).toBe(executionCtx);
  });
});

// setMaxSubagentDepth clamps its input, but test/settings.test.ts only asserts
// the applier SPY was called — the real Math.max(0, Math.floor(n)) never runs
// there. A hand-edited subagents.json reaches this unfiltered, and losing the
// clamp is silent in the worst direction: a negative depth makes the
// `depth >= maxSubagentDepth` check true everywhere, disabling nested
// delegation project-wide with no error.
describe("setMaxSubagentDepth clamping", () => {
  let previous: number;
  beforeEach(() => { previous = getMaxSubagentDepth(); });
  afterEach(() => { setMaxSubagentDepth(previous); });

  it("floors a negative depth at 0 rather than storing it", () => {
    setMaxSubagentDepth(-1);
    expect(getMaxSubagentDepth()).toBe(0);
  });

  it("truncates a fractional depth toward zero", () => {
    setMaxSubagentDepth(2.9);
    expect(getMaxSubagentDepth()).toBe(2);
  });

  it("stores a valid depth unchanged", () => {
    setMaxSubagentDepth(3);
    expect(getMaxSubagentDepth()).toBe(3);
  });
});
