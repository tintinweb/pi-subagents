import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";

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

function ctx(executionCwd = cwd) {
  return {
    cwd: executionCwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  } as any;
}

function tools(allowedSubagents?: string[], depth = 1, maxSubagentDepth = 2) {
  return createNestedSubagentTools({
    manager,
    pi: {} as any,
    parentAgentId: "parent-1",
    depth,
    maxSubagentDepth,
    allowedSubagents,
    configCwd: cwd,
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
    getRecord: (id: string) => records.get(id),
    resume: vi.fn(),
  } as any;
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("child-safe nested Agent tools", () => {
  it("allows any enabled agent when allowed_subagents is omitted", async () => {
    const [agent] = tools(undefined);
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
    );
  });

  it("keeps agent discovery rooted in inherited config, not the working directory", async () => {
    const workCwd = mkdtempSync(join(tmpdir(), "nested-tools-work-"));
    const workAgentDir = join(workCwd, ".pi", "agents");
    mkdirSync(workAgentDir, { recursive: true });
    writeFileSync(join(workAgentDir, "intruder.md"), "---\ndescription: intruder\n---\nintruder\n");

    try {
      const [agent] = tools(undefined);
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

  it("enforces a narrow allowlist and treats an empty list as allow none", async () => {
    const [limited] = tools(["scout"]);
    const denied = await execute(limited, {
      subagent_type: "reviewer",
      description: "review evidence",
      prompt: "Review it",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("not allowed");
    expect(spawnAndWait).not.toHaveBeenCalled();

    const [empty] = tools([]);
    const none = await execute(empty, {
      subagent_type: "scout",
      description: "find files",
      prompt: "Find them",
    });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("Allowed: none");
  });

  it("blocks delegation at the inherited depth cap", async () => {
    const [agent] = tools(undefined, 2, 2);
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
    const [agent] = tools(undefined);

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

  it("propagates a target agent's tighter depth cap", async () => {
    writeAgent("tight", "max_subagent_depth: 1\n");
    registerAgents(loadCustomAgents(cwd));
    const [agent] = tools(undefined, 1, 3);
    const result = await execute(agent, {
      subagent_type: "tight",
      description: "tight child",
      prompt: "Do work",
    });

    expect(result.isError).toBe(false);
    expect(spawnAndWait).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), "tight", "Do work",
      expect.objectContaining({ depth: 2, maxSubagentDepth: 1 }),
    );
  });
});
