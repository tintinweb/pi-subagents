/**
 * session-cwd-wiring.test.ts — proves per-session config discovery (#206)
 * through the real extension, not just through the units.
 *
 * The bug: custom agents, `subagents.json`, and the Agent tool's advertised
 * type list were derived from `process.cwd()`. In the CLI that IS the session
 * cwd, but an embedding host (SDK) creates sessions whose workspace is not the
 * directory the process started in — and can run several such sessions
 * concurrently, where any process-wide registry is last-writer-wins.
 *
 * Three pins:
 *   1. `session_start` with a diverging `ctx.cwd` rebuilds settings, agents,
 *      and the Agent tool schema from the session's own tree.
 *   2. In the CLI shape (ctx.cwd === process.cwd()) nothing re-runs — no
 *      second tool registration, no second settings_loaded emit.
 *   3. Two activations with different session cwds resolve their own agents,
 *      concurrently, without one reload clobbering the other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
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

function writeAgent(root: string, name: string): void {
  const dir = join(root, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${name}\ntools: read\n---\n${name}.\n`);
}

const typeListOf = (tools: Map<string, any>): string =>
  tools.get("Agent").parameters.properties.subagent_type.description;

const settingsLoadedEmits = (pi: any): number =>
  pi.events.emit.mock.calls.filter(([event]: [string]) => event === "subagents:settings_loaded").length;

const agentRegistrations = (pi: any): number =>
  pi.registerTool.mock.calls.filter(([t]: [any]) => t.name === "Agent").length;

let dirA: string;
let dirB: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

describe("per-session config discovery through the real extension (#206)", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    dirA = mkdtempSync(join(tmpdir(), "session-cwd-a-"));
    dirB = mkdtempSync(join(tmpdir(), "session-cwd-b-"));
    writeAgent(dirA, "alpha");
    writeAgent(dirB, "beta");
    // dirB's own project settings — proves settings re-read from the session
    // cwd: strict dispatch there refuses what its tree doesn't define.
    mkdirSync(join(dirB, ".pi"), { recursive: true });
    writeFileSync(join(dirB, ".pi", "subagents.json"), JSON.stringify({ fallbackSubagent: "none" }));
    // Isolate global discovery so the dev's real agents/settings can't bleed in.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = join(dirA, "agent-dir");
    process.env.HOME = dirA;
    // The embedding-host shape: the process sits somewhere unrelated (dirA
    // stands in for "the host's own directory"), sessions live elsewhere.
    process.chdir(dirA);
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false,
    } as any);
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("adopts a diverging session cwd: settings, agents, and the Agent tool schema rebuild from it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    // Activation ran with the provisional process cwd — dirA's roster.
    expect(typeListOf(tools)).toContain("alpha");
    expect(typeListOf(tools)).not.toContain("beta");

    await lifecycle.get("session_start")({}, makeCtx(dirB));

    // The tool was re-registered with the session's own roster...
    expect(agentRegistrations(pi)).toBe(2);
    expect(typeListOf(tools)).toContain("beta");
    expect(typeListOf(tools)).not.toContain("alpha");

    // ...its agents dispatch...
    const ok = await tools.get("Agent").execute(
      "tc-1",
      { prompt: "go", description: "session agent", subagent_type: "beta" },
      undefined, undefined, makeCtx(dirB),
    );
    expect(ok.isError).not.toBe(true);
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "beta", "go", expect.anything());

    // ...and the OTHER tree's agent does not — refused, not fallen back,
    // because dirB's own subagents.json (fallbackSubagent: none) was applied.
    vi.mocked(runAgent).mockClear();
    const refused = await tools.get("Agent").execute(
      "tc-2",
      { prompt: "go", description: "foreign agent", subagent_type: "alpha" },
      undefined, undefined, makeCtx(dirB),
    );
    expect(refused.content[0].text).toContain('Unknown or disabled agent type: "alpha"');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("resets provisional-cwd policy at adoption: keys the session's tree omits return to defaults", async () => {
    // The host's own directory carries policy the session's tree never named —
    // both registry-shaping keys, since they are what this fix isolates.
    writeFileSync(
      join(dirA, ".pi", "subagents.json"),
      JSON.stringify({ disableDefaultAgents: true, fallbackSubagent: "none" }),
    );
    writeFileSync(join(dirB, ".pi", "subagents.json"), JSON.stringify({}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    // Activation applied the provisional policy: no built-ins advertised.
    expect(typeListOf(tools)).not.toContain("general-purpose");

    await lifecycle.get("session_start")({}, makeCtx(dirB));

    // Adoption reset the policy before re-applying: the built-ins are back...
    expect(typeListOf(tools)).toContain("general-purpose");
    // ...and dispatch falls back permissively (the historical default) instead
    // of keeping the provisional cwd's fail-closed fallbackSubagent.
    const fromUnknown = await tools.get("Agent").execute(
      "tc-1",
      { prompt: "go", description: "unknown type", subagent_type: "no-such-agent" },
      undefined, undefined, makeCtx(dirB),
    );
    expect(fromUnknown.isError).not.toBe(true);
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "general-purpose", "go", expect.anything());
  });

  it("surfaces a strict-load failure at adoption and still converges on the session's tree", async () => {
    // The session's tree opts into strictness and carries a broken agent file
    // (the unquoted second colon makes the frontmatter unparseable).
    writeFileSync(join(dirB, ".pi", "subagents.json"), JSON.stringify({ strictAgentFiles: true }));
    writeFileSync(join(dirB, ".pi", "agents", "broken.md"), "---\nname: broken\ndescription: Use this: that\n---\nBroken.\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    // The strict startup load fails loudly (pi surfaces the handler's throw
    // as an extension error)...
    await expect(lifecycle.get("session_start")({}, makeCtx(dirB))).rejects.toThrow(/broken\.md/);

    // ...but the adopted state stays self-consistent: every later reload is
    // non-strict from the session cwd, so the advertised schema must already
    // be the session's tree (minus the broken file), not the provisional
    // roster dispatch could never reach again.
    expect(typeListOf(tools)).toContain("beta");
    expect(typeListOf(tools)).not.toContain("alpha");
    warn.mockRestore();
  });

  it("is a no-op in the CLI shape: session_start with the process cwd re-registers nothing", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    const registrationsAtActivation = agentRegistrations(pi);
    const settingsEmitsAtActivation = settingsLoadedEmits(pi);
    expect(registrationsAtActivation).toBe(1);

    await lifecycle.get("session_start")({}, makeCtx(process.cwd()));

    expect(agentRegistrations(pi)).toBe(registrationsAtActivation);
    expect(settingsLoadedEmits(pi)).toBe(settingsEmitsAtActivation);
  });

  it("two concurrent sessions resolve their own agents — no last-writer-wins", async () => {
    // Two activations in one process, one per session, different projects.
    const a = makePi();
    subagentsExtension(a.pi);
    await a.lifecycle.get("session_start")({}, makeCtx(dirA));

    const b = makePi();
    subagentsExtension(b.pi);
    await b.lifecycle.get("session_start")({}, makeCtx(dirB));

    // Each session advertises its own roster...
    expect(typeListOf(a.tools)).toContain("alpha");
    expect(typeListOf(a.tools)).not.toContain("beta");
    expect(typeListOf(b.tools)).toContain("beta");
    expect(typeListOf(b.tools)).not.toContain("alpha");

    // ...and B's per-invocation reload does not clobber A's registry: A still
    // dispatches alpha AFTER B has reloaded and dispatched beta.
    await b.tools.get("Agent").execute(
      "tc-b", { prompt: "go", description: "b", subagent_type: "beta" },
      undefined, undefined, makeCtx(dirB),
    );
    vi.mocked(runAgent).mockClear();
    const fromA = await a.tools.get("Agent").execute(
      "tc-a", { prompt: "go", description: "a", subagent_type: "alpha" },
      undefined, undefined, makeCtx(dirA),
    );
    expect(fromA.isError).not.toBe(true);
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "alpha", "go", expect.anything());
  });
});
