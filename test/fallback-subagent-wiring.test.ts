/**
 * fallback-subagent-wiring.test.ts — proves `fallbackSubagent` actually gates
 * dispatch through the real registered tools (#183), not just that the resolver
 * returns the right verdict.
 *
 * The load-bearing assertion in the rejection tests is that `runAgent` was NEVER
 * called: the complaint in #183 is that a background call starts executing the
 * wrong agent before the caller learns anything, so a rejection that still
 * spawns would be no fix at all. The fallback tests assert the opposite — that
 * it ran, and which agent it ran.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import { getAllTypes, getAvailableTypes, NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

let cwd: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

/** Real agent files on disk. The Agent tool reloads the registry from
 *  `process.cwd()` on every call, so an in-memory registry would be wiped before
 *  dispatch is resolved — and a "disabled" fixture that never loads would make
 *  the disabled-type test pass merely because the name was unknown. */
function writeAgents(): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scout.md"), "---\ndescription: Scout\ntools: read\n---\nScout.\n");
  writeFileSync(join(dir, "retired.md"), "---\ndescription: Retired\ntools: read\nenabled: false\n---\nRetired.\n");
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("fallbackSubagent gates dispatch through the real Agent tool", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "fallback-wiring-"));
    writeAgents();
    process.chdir(cwd);
    // A developer's real ~/.pi/subagents.json would otherwise set this very
    // setting under the tests, and their global agents would pollute the roster.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
    process.env.HOME = cwd;
    vi.mocked(runAgent).mockReset();
  });

  afterEach(() => {
    setFallbackSubagent(undefined);
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    registerAgents(new Map());
    rmSync(cwd, { recursive: true, force: true });
  });

  function boot() {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    return { pi, tools, lifecycle };
  }

  it("accepts omitted type in the registered schema while keeping prompt and description required", () => {
    const { tools } = boot();
    const schema = tools.get("Agent").parameters;
    expect(Check(schema, { prompt: "go", description: "default agent" })).toBe(true);
    expect(Check(schema, { description: "missing prompt" })).toBe(false);
    expect(Check(schema, { prompt: "missing description" })).toBe(false);
  });

  it("renders an omitted type without throwing", () => {
    const { tools } = boot();
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = tools.get("Agent").renderCall({ prompt: "go", description: "default agent" }, theme, {});
    expect(rendered.render(80).join("\n")).toContain("default agent");
  });

  for (const background of [false, true]) {
    for (const fallback of [undefined, "scout", NO_FALLBACK]) {
      it(`routes omitted type with fallback=${fallback}, background=${background}`, async () => {
        const { tools } = boot();
        setFallbackSubagent(fallback);
        vi.mocked(runAgent).mockResolvedValue({
          responseText: "done", session: { dispose: vi.fn() } as never, aborted: false, steered: false,
        });
        const result = await tools.get("Agent").execute(
          "missing-type", { prompt: "go", description: "default", run_in_background: background },
          undefined, undefined, ctx(),
        );
        if (fallback === NO_FALLBACK) {
          expect(textOf(result)).toContain("No agent type given");
          expect(runAgent).not.toHaveBeenCalled();
        } else {
          expect(runAgent).toHaveBeenCalledWith(expect.anything(), fallback ?? "general-purpose", "go", expect.anything());
        }
      });
    }
  }

  for (const background of [false, true]) {
    it(`refuses an unknown type without spawning (run_in_background: ${background})`, async () => {
      const { tools } = boot();
      setFallbackSubagent(NO_FALLBACK);

      const result = await tools.get("Agent").execute(
        "tc-1",
        {
          prompt: "do it",
          description: "typo dispatch",
          subagent_type: "definitely-missing",
          run_in_background: background,
        },
        undefined, undefined, ctx(),
      );

      expect(textOf(result)).toContain('Unknown or disabled agent type: "definitely-missing"');
      expect(textOf(result)).toContain("scout");
      // The whole point: nothing ran.
      expect(runAgent).not.toHaveBeenCalled();
    });
  }

  it("still falls back — and says so — when the setting is unset", async () => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false,
    });

    const result = await tools.get("Agent").execute(
      "tc-2",
      { prompt: "do it", description: "typo dispatch", subagent_type: "definitely-missing" },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).toContain('Note: Unknown agent type "definitely-missing"');
    // Not merely "something ran" — a fallback that routed anywhere else would pass that.
    expect(runAgent).toHaveBeenCalledWith(
      expect.anything(), "general-purpose", "do it", expect.anything(),
    );
  });

  it("carries the fallback note on the background branch too", async () => {
    // Previously the note was computed after spawnAndWait returned, so only a
    // foreground caller ever saw it (#183).
    const { tools } = boot();
    vi.mocked(runAgent).mockReturnValue(new Promise(() => {}) as any);

    const result = await tools.get("Agent").execute(
      "tc-3",
      {
        prompt: "do it",
        description: "typo dispatch",
        subagent_type: "definitely-missing",
        run_in_background: true,
      },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).toContain('Note: Unknown agent type "definitely-missing"');
    expect(textOf(result)).toContain("started in background");
  });

  it("refuses a disabled type, which used to dispatch with a mixed identity", async () => {
    const { tools } = boot();
    setFallbackSubagent(NO_FALLBACK);
    // Pin the fixture: without this the test passes identically if retired.md
    // stopped loading, since "unknown" and "disabled" share one message.
    expect(getAllTypes()).toContain("retired");
    expect(getAvailableTypes()).not.toContain("retired");

    const result = await tools.get("Agent").execute(
      "tc-4",
      { prompt: "do it", description: "disabled dispatch", subagent_type: "retired" },
      undefined, undefined, ctx(),
    );

    expect(textOf(result)).toContain("Unknown or disabled agent type");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it.each([undefined, "   "])("never persists an unresolved type (%s) into a scheduled job", async (subagent_type) => {
    const { tools, lifecycle } = boot();
    await lifecycle.get("session_start")({}, ctx());

    const result = await tools.get("Agent").execute(
      "tc-5",
      { prompt: "later", description: "missing type", subagent_type, schedule: "+1h" },
      undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain("Scheduled");

    const storeDir = join(cwd, ".pi", "subagent-schedules");
    const jobs = readdirSync(storeDir).flatMap((f) =>
      JSON.parse(readFileSync(join(storeDir, f), "utf-8")).jobs ?? [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].subagent_type).toBe("general-purpose");
  });

  it.each([undefined, "deleted-since"])("never blocks resume with type %s", async (subagent_type) => {
    // Resume replays a stored session and needs no type, even in strict mode.
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({
      // `messages` is not optional on a real AgentSession, and a background
      // resume reads it to anchor transcript streaming.
      responseText: "first", session: { dispose: vi.fn(), messages: [] } as any, aborted: false, steered: false,
    });
    const spawned = await tools.get("Agent").execute(
      "tc-6",
      { prompt: "start", description: "live agent", subagent_type: "scout", run_in_background: false },
      undefined, undefined, ctx(),
    );
    const id = /Agent ID: (\S+)/.exec(textOf(spawned))?.[1]
      ?? (spawned as any).details?.agentId;
    expect(id).toBeTruthy();

    setFallbackSubagent(NO_FALLBACK);
    const resumed = await tools.get("Agent").execute(
      "tc-7",
      { resume: id, prompt: "keep going", description: "resume", subagent_type },
      undefined, undefined, ctx(),
    );

    expect(textOf(resumed)).not.toContain("Unknown or disabled agent type");
  });

  it.each([
    [true, undefined], [false, undefined], [true, "other"], [false, "other"],
  ])("resumes the stored type's mode (%s), ignoring requested type %s and fallback config", async (background, subagent_type) => {
    const { tools } = boot();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: { dispose: vi.fn(), messages: [] } as never, aborted: false, steered: false,
    });
    const spawned = await tools.get("Agent").execute(
      "resume-config-spawn",
      { prompt: "start", description: "scout", subagent_type: "scout", run_in_background: false },
      undefined, undefined, ctx(),
    );
    const id = spawned.details.agentId;
    expect(id).toBeTruthy();
    writeFileSync(join(cwd, ".pi", "agents", "scout.md"), `---\nrun_in_background: ${background}\noutput_transcript: false\n---\nScout.`);
    writeFileSync(join(cwd, ".pi", "agents", "other.md"), `---\nrun_in_background: ${!background}\nmax_turns: 9\noutput_transcript: true\n---\nOther.`);
    setFallbackSubagent("other");
    const resume = vi.spyOn(AgentManager.prototype, "resume").mockImplementation(async function (this: AgentManager, agentId) {
      return this.getRecord(agentId);
    });
    try {
      const result = await tools.get("Agent").execute(
        "resume-config", { resume: id, prompt: "continue", description: "resume", subagent_type },
        undefined, undefined, ctx(),
      );
      expect(resume).toHaveBeenCalledTimes(1);
      if (background) {
        expect(textOf(result)).toContain("resumed in background");
        expect(resume.mock.calls[0][3]).toMatchObject({ isBackground: true });
      } else {
        expect(textOf(result)).toBe("first");
        expect(resume.mock.calls[0][3]).toBeUndefined();
      }
    } finally { resume.mockRestore(); }
  });

  it("applies the same contract to cross-extension spawns", async () => {
    // The registry entry is what RPC callers reach; it must not be a way around
    // the setting. A throw here becomes an error envelope at the RPC boundary.
    boot();
    setFallbackSubagent(NO_FALLBACK);
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];

    expect(() => registry.spawn({}, ctx(), "definitely-missing", "do it", { description: "rpc" }))
      .toThrow(/Unknown or disabled agent type/);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
