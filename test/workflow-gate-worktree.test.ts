/**
 * workflow-gate-worktree.test.ts — a `gate` on an isolated child must verify
 * THAT child's tree.
 *
 * The other workflow tests stub either side of the seam; this one does not. It
 * drives the real `AgentManager` over a real git repo with the real
 * `src/worktree.ts`, and only the model itself is faked — because the whole bug
 * class lives in the timing between two real things: the manager commits the
 * child's worktree to a branch and deletes the copy *inside the child's own
 * settle*, so a gate that waits for `spawnAndWait` to resolve has nothing left
 * to verify and quietly runs against the main tree. A gate that passes on the
 * wrong directory marks unverified work as verified, which is worse than having
 * no gate at all.
 *
 * So the assertions are about the directory, not about plumbing: the gate ran in
 * the child's worktree path, that path existed at that moment, and it contained
 * what the child wrote.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

/** What the child leaves behind, and the thing a correct gate can see. */
const CHILD_FILE = "child-work.txt";

/** One `gate` command execution, sampled at the moment it ran. */
interface GateRun {
  command: string;
  cwd: string;
  /** Did the directory the gate was pointed at exist when it ran? */
  existed: boolean;
  /** Could it see the child's work — i.e. is this really the child's tree? */
  sawChildWork: boolean;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/**
 * A `pi` whose `exec` runs git for real and answers anything else — i.e. a gate
 * command — from `gate`, recording what the directory looked like at that
 * instant. Sampling inside the call is the point: afterwards the worktree is
 * gone, so a post-hoc `existsSync` would prove nothing either way.
 */
function makePi(gate: (command: string) => ExecResult | Promise<ExecResult> = () => execOk("3 passing")) {
  const gateRuns: GateRun[] = [];
  const exec = vi.fn(
    async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      if (command === "git") {
        try {
          const stdout = execFileSync(command, args, {
            cwd: options?.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout, stderr: "", code: 0, killed: false };
        } catch (err: any) {
          return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.status ?? 1, killed: false };
        }
      }
      const cwd = options?.cwd ?? "";
      gateRuns.push({
        command: args[args.length - 1],
        cwd,
        existed: existsSync(cwd),
        sawChildWork: existsSync(join(cwd, CHILD_FILE)),
      });
      return await gate(args[args.length - 1]);
    },
  );
  return { pi: { exec } as any, gateRuns, exec };
}

const execOk = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const execFail = (stderr: string): ExecResult => ({ stdout: "", stderr, code: 1, killed: false });

/** A git repo with one commit, so `git worktree add` has a HEAD to copy. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-gate-repo-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# gate");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "--no-gpg-sign", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/**
 * A model that writes a file where it was told to work, then reports success.
 * `fallback` is where a child with no worktree works — the manager leaves
 * `cwd` unset for those, meaning "the session's own directory".
 */
function childWrites(fallback: string) {
  vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
    writeFileSync(join(opts.cwd ?? fallback, CHILD_FILE), "the child wrote this");
    return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
  });
}

const spawnRequest = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "fix the failing test",
  label: "impl",
  agentType: "general-purpose",
  ...overrides,
});

const HEAD = 'export const meta = { name: "probe", description: "gate over a worktree" };\n';

const agentEntries = (progress: readonly WorkflowEntry[]): WorkflowAgentEntry[] =>
  progress.filter((entry): entry is WorkflowAgentEntry => entry.type === "workflow_agent");

describe("gate on an isolated child", () => {
  let repo: string;
  let manager: AgentManager;

  beforeEach(() => {
    registerAgents(new Map());
    repo = initRepo();
    manager = new AgentManager();
    childWrites(repo);
  });

  afterEach(() => {
    manager.dispose();
    // Any surviving worktree would be inside the repo's admin dir; removing the
    // repo drops both.
    rmSync(repo, { recursive: true, force: true });
    vi.mocked(runAgent).mockReset();
  });

  it("runs the gate inside the child's worktree, while it still exists", async () => {
    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.spawnAgent(
      spawnRequest({ isolation: "worktree", gate: "npm test" }),
    );

    const worktreePath = manager.listAgents()[0].worktree?.path;
    expect(worktreePath).toBeDefined();
    expect(gateRuns).toHaveLength(1);
    // The exact path, not merely "something was set": the whole failure mode is
    // a gate that ran somewhere plausible and wrong.
    expect(gateRuns[0].cwd).toBe(worktreePath);
    expect(gateRuns[0].cwd).not.toBe(repo);
    expect(gateRuns[0].existed).toBe(true);
    expect(gateRuns[0].sawChildWork).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.gate).toEqual({ ok: true, output: "3 passing" });

    // …and the copy is still torn down afterwards: verifying it must not keep it.
    expect(existsSync(worktreePath!)).toBe(false);
  });

  it("fails the agent with the gate's output, and still cleans the worktree up", async () => {
    const { pi, gateRuns } = makePi(() => execFail("FAIL src/auth.test.ts\n1 failing"));
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await runWorkflow({
      script: `${HEAD}return await agent("fix it", { gate: "npm test", isolation: "worktree" });`,
      host,
    });

    expect(result.status).toBe("completed");
    // The documented shape: a failed gate is a failed agent, the command output
    // is the error, and the script sees null.
    expect(result.value).toBeNull();
    const entry = agentEntries(result.progress).at(-1);
    expect(entry?.state).toBe("error");
    expect(entry?.error).toBe("FAIL src/auth.test.ts\n1 failing");

    // Exactly one execution: the host ran it in the worktree, so the runtime
    // must not run it again against the session's tree.
    expect(gateRuns).toHaveLength(1);
    expect(gateRuns[0].cwd).toBe(manager.listAgents()[0].worktree?.path);
    expect(gateRuns[0].sawChildWork).toBe(true);
    expect(existsSync(gateRuns[0].cwd)).toBe(false);
  });

  it("names the command when a failing gate in a worktree says nothing", async () => {
    const { pi } = makePi(() => ({ stdout: "  ", stderr: "", code: 1, killed: false }));
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await runWorkflow({
      script: `${HEAD}return await agent("x", { gate: "npm run lint", isolation: "worktree" });`,
      host,
    });

    expect(agentEntries(result.progress).at(-1)?.error).toBe("Gate command failed: npm run lint");
  });

  it("counts a killed gate as failed even though pi.exec reports exit code 0", async () => {
    const { pi } = makePi(() => ({ stdout: "", stderr: "", code: 0, killed: true }));
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.spawnAgent(spawnRequest({ isolation: "worktree", gate: "sleep 999" }));

    expect(result.gate?.ok).toBe(false);
    expect(result.gate?.output).toMatch(/timed out/);
  });

  it("treats a gate that could not run at all as a failed gate, not an un-run one", async () => {
    // If this leaked as an exception the manager would swallow it, the spawn
    // result would carry no verdict, and the runtime would helpfully re-run the
    // command — in the session's tree, which is the bug.
    const { pi, gateRuns } = makePi(() => {
      throw new Error("spawn sh ENOENT");
    });
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await runWorkflow({
      script: `${HEAD}return await agent("x", { gate: "npm test", isolation: "worktree" });`,
      host,
    });

    expect(result.value).toBeNull();
    expect(agentEntries(result.progress).at(-1)?.error).toBe("spawn sh ENOENT");
    expect(gateRuns).toHaveLength(1);
    expect(existsSync(manager.listAgents()[0].worktree!.path)).toBe(false);
  });

  it("gates a steered child too — a steer is a finished child, not a failed one", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
      writeFileSync(join(opts.cwd, CHILD_FILE), "steered work");
      return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: true };
    });
    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.spawnAgent(spawnRequest({ isolation: "worktree", gate: "npm test" }));

    expect(manager.listAgents()[0].status).toBe("steered");
    expect(result.ok).toBe(true);
    expect(gateRuns).toHaveLength(1);
    expect(gateRuns[0].cwd).toBe(manager.listAgents()[0].worktree?.path);
    expect(gateRuns[0].sawChildWork).toBe(true);
  });

  it("skips the gate for a child that failed, and reports the child's own failure", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
      failure: "provider exploded",
    } as any);
    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.spawnAgent(spawnRequest({ isolation: "worktree", gate: "npm test" }));

    expect(result).toMatchObject({ ok: false, error: "provider exploded" });
    expect(result.gate).toBeUndefined();
    expect(gateRuns).toEqual([]);
    expect(existsSync(manager.listAgents()[0].worktree!.path)).toBe(false);
  });
});

describe("gate on a child with no worktree of its own", () => {
  let repo: string;
  let manager: AgentManager;

  beforeEach(() => {
    registerAgents(new Map());
    repo = initRepo();
    manager = new AgentManager();
    childWrites(repo);
  });

  afterEach(() => {
    manager.dispose();
    rmSync(repo, { recursive: true, force: true });
    vi.mocked(runAgent).mockReset();
  });

  it("runs the gate once, in the session's own tree", async () => {
    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await runWorkflow({
      script: `${HEAD}return await agent("x", { gate: "npm test" });`,
      host,
    });

    expect(result.value).toBe("done");
    expect(gateRuns).toHaveLength(1);
    // No worktree to verify, so the session's tree is the tree the child edited.
    expect(gateRuns[0].cwd).toBe(repo);
    expect(manager.listAgents()[0].worktree).toBeUndefined();
  });
});

describe("an isolated child with no gate", () => {
  let repo: string;
  let manager: AgentManager;

  beforeEach(() => {
    registerAgents(new Map());
    repo = initRepo();
    manager = new AgentManager();
    childWrites(repo);
  });

  afterEach(() => {
    manager.dispose();
    rmSync(repo, { recursive: true, force: true });
    vi.mocked(runAgent).mockReset();
  });

  it("is untouched: nothing runs, and the work still lands on a branch", async () => {
    const { pi, gateRuns } = makePi();
    const host = createWorkflowHost({ pi, ctx: ctx({ cwd: repo }), manager });

    const result = await host.spawnAgent(spawnRequest({ isolation: "worktree" }));

    expect(gateRuns).toEqual([]);
    expect(result.ok).toBe(true);
    const record = manager.listAgents()[0];
    expect(record.worktreeResult?.hasChanges).toBe(true);
    // The child's file survives the copy's removal, on the branch.
    const branch = record.worktreeResult!.branch!;
    const files = execFileSync("git", ["show", "--name-only", "--format=", branch], {
      cwd: repo,
      encoding: "utf-8",
    });
    expect(files).toContain(CHILD_FILE);
    expect(existsSync(record.worktree!.path)).toBe(false);
  });
});
