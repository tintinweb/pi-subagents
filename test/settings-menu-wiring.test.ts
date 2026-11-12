/**
 * settings-menu-wiring.test.ts — `/agents` → Settings through the real
 * extension writes only the setting the user changed (#391).
 *
 * The unit tests in settings.test.ts pin `saveSettings`' merge. What they
 * cannot see is the baseline `index.ts` diffs against: it must be taken after
 * the persisted settings are applied, and move forward only when a write
 * lands. Get either wrong and a single change re-writes every effective value
 * — built-in defaults and the other layer's keys — into the target file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

let cwd: string;
let agentDir: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

const globalFile = () => join(agentDir, "subagents.json");
const projectFile = () => join(cwd, ".pi", "subagents.json");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}

/** Boot the extension and return the `/agents` command handler. */
function boot(): (ctx: any) => Promise<void> {
  const commands = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return (ctx) => commands.get("agents").handler("", ctx);
}

/**
 * One trip through `/agents` → Settings that types `value` into the numeric
 * field `id`: the menu opens Settings, Enter on the field closes the list with
 * its id, the input prompt takes the value, the re-shown list and then the
 * agents menu are dismissed.
 */
function typeSetting(id: string, value: string) {
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      notify,
      select: vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined),
      custom: vi.fn().mockResolvedValueOnce(id).mockResolvedValue(undefined),
      input: vi.fn().mockResolvedValueOnce(value),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
  return { ctx, notify };
}

describe("/agents → Settings writes only the changed setting", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "settings-menu-wiring-"));
    agentDir = join(cwd, "agent-dir");
    process.chdir(cwd);
    // Keep a developer's real ~/.pi/agent/subagents.json out of the test.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = cwd;
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("with no project file: writes the one key to the global file, no defaults, no .pi", async () => {
    const agents = boot();
    const { ctx, notify } = typeSetting("maxConcurrent", "4");

    await agents(ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 4 });
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(notify).toHaveBeenCalledWith("Max concurrency set to 4 (saved to global settings)", "info");
  });

  it("with a project file: writes the one key there and copies no global value into it", async () => {
    writeJson(globalFile(), { graceTurns: 7 });
    writeJson(projectFile(), {});
    const agents = boot();

    await agents(typeSetting("maxConcurrent", "4").ctx);

    // graceTurns 7 is loaded into memory before the baseline is taken, so it
    // is not a change — it stays in the global layer only.
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 4 });
    expect(readJson(globalFile())).toEqual({ graceTurns: 7 });
  });

  it("does not re-write an earlier change over what another session saved since", async () => {
    const agents = boot();
    await agents(typeSetting("maxConcurrent", "4").ctx);

    // Another pi session saves its own max concurrency to the shared file.
    writeJson(globalFile(), { maxConcurrent: 8 });
    await agents(typeSetting("graceTurns", "3").ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 8, graceTurns: 3 });
  });

  it("retries a change whose write failed on the next save", async () => {
    const agents = boot();
    // The agent dir sits under a regular file, so the global write fails.
    const blocker = join(cwd, "blocker");
    writeFileSync(blocker, "");
    process.env.PI_CODING_AGENT_DIR = join(blocker, "agent");
    const failed = typeSetting("maxConcurrent", "4");
    await agents(failed.ctx);
    expect(failed.notify).toHaveBeenCalledWith(
      "Max concurrency set to 4 (session only; failed to persist)",
      "warning",
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Grace turns is module state and survives between tests in this file, so
    // each test types a value no earlier test left behind.
    await agents(typeSetting("graceTurns", "6").ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 4, graceTurns: 6 });
  });
});
