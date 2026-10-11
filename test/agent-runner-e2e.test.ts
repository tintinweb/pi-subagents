/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Every other agent-runner test mocks `@earendil-works/pi-coding-agent`: it
 * asserts that `runAgent` hands the right `tools:` allowlist to a *simulated*
 * `createAgentSession`. That proves our allowlist math, but not the assumption
 * the math rests on — that real pi-mono actually gates a session to that
 * allowlist, admitting extension-registered tools (the #47 fix) and dropping
 * the rest.
 *
 * This test closes that loop with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` loads it via `additionalExtensionPaths`,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert what the LLM
 *     would actually be allowed to call.
 *
 * No network/LLM: a faux Model object satisfies `createAgentSession`'s `model`
 * param, and we never depend on a turn completing — the assertion is on the
 * gated tool set, which is fixed at construction. (Driving a live faux model
 * through `session.prompt()` is intentionally avoided: under Vite the faux
 * provider registers in a different `pi-ai` module instance than the one
 * pi-coding-agent streams through, which is brittle and orthogonal to gating.)
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
const EXPOSURE_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-exposure-ext.mjs", import.meta.url)));
const LAZY_MCP_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-lazy-mcp-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    // Only used as a valid Model object for createAgentSession; we never rely
    // on it actually streaming (we assert on the pre-prompt gated tool set).
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Register `cfg` as agent type "e2e", run it through the REAL runAgent, and
   * return the real session's active tool names captured at construction time.
   */
  /** Every tool the last session registered, active or not — set by `activeToolsFor`. */
  let registered: string[] = [];
  /** The last session `activeToolsFor` built — set alongside `registered`. */
  let lastSession: any;

  async function activeToolsFor(
    cfg: Partial<AgentConfig>,
    projectTrusted = true,
    runOpts: { cwd?: string; configCwd?: string } = {},
  ): Promise<string[]> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: BUILTINS,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", isProjectTrusted: () => projectTrusted, model, modelRegistry };

    let active: string[] = [];
    try {
      await runAgent(ctx, "e2e", "go", {
        ...runOpts,
        pi: makePi(),
        model,
        onSessionCreated: (s) => {
          active = s.getActiveToolNames();
          registered = s.getAllTools().map((t) => t.name);
          lastSession = s;
        },
      });
    } catch {
      // A no-op/erroring prompt turn is fine — the gated tool set is fixed at
      // construction, which `onSessionCreated` already captured.
    }
    return active;
  }

  it("real pi-mono admits an extension-registered tool when it's in the allowlist (#47)", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE] });
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when extensions are disabled (not loaded)", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("disallowedTools removes a real extension tool from the live session", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE], disallowedTools: [EXT_TOOL] });
    expect(active).not.toContain(EXT_TOOL); // loaded, then denied at construction
    expect(active).toContain("read");
  });

  it("the ext: allowlist flip mutes a loaded-but-unselected extension in real pi-mono", async () => {
    // Extension loads (extensions: [FIXTURE]), but a single ext: selector for a
    // *different* name flips extension tools to an allowlist — the unselected
    // fixture contributes nothing, even though it loaded and ran its handlers.
    const active = await activeToolsFor({ extensions: [FIXTURE], extSelectors: ["ext:not-the-fixture"] });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext: selector surfaces the loaded extension's tool through the flip", async () => {
    // Derive the canonical name the loader/selector matcher uses, so the test
    // tracks `extensionCanonicalName` rather than hard-coding a filename form.
    const canon = extensionCanonicalName(FIXTURE);
    const active = await activeToolsFor({
      extensions: [FIXTURE],
      builtinToolNames: ["read"],
      extSelectors: [`ext:${canon}`],
    });
    expect(active).toContain(EXT_TOOL); // selected → surfaces despite the flip
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // builtinToolNames: ["read"] only
  });

  it("activates only the tools pi would declare — codemode/deferred MCP tools stay off", async () => {
    // pi's built-in MCP registers server tools as `mcp__<server>__<tool>` with
    // `codemode` exposure: reachable from codemode scripts, never declared to the
    // model. Activating every in-scope tool declared them all to the subagent.
    const active = await activeToolsFor({ extensions: [EXPOSURE_FIXTURE] });
    expect(active).toContain("exposure_direct");
    expect(active).not.toContain("mcp__probe__codemode_only");
    expect(active).not.toContain("mcp__probe__deferred");
    expect(active).not.toContain("exposure_off_by_default");
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext:foo/bar narrowing activates a defaultActive: false tool, as --tools does", async () => {
    const canon = extensionCanonicalName(EXPOSURE_FIXTURE);
    const active = await activeToolsFor({
      extensions: [EXPOSURE_FIXTURE],
      extSelectors: [`ext:${canon}/exposure_off_by_default`],
    });
    expect(active).toContain("exposure_off_by_default");
    expect(active).not.toContain("exposure_direct"); // narrowed away
  });

  // pi's built-in MCP starts each stdio server in `.pi/mcp.json` when a session
  // starts, so a server whose command touches a marker file shows, on the real
  // runtime, whether a subagent ran a project's MCP config.
  describe.skipIf(process.platform === "win32")("pi built-ins and project trust", () => {
    /** Run `fn` against an empty pi agent dir, so no real global config takes part. */
    async function withEmptyAgentDir<T>(fn: () => Promise<T>): Promise<T> {
      const agentDir = mkdtempSync(join(tmpdir(), "subagents-e2e-agent-"));
      const prev = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        return await fn();
      } finally {
        if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prev;
        rmSync(agentDir, { recursive: true, force: true });
      }
    }

    /** Write `dir/.pi/mcp.json` with one stdio server; returns the marker it touches. */
    function writeMcpConfig(dir: string): string {
      const marker = join(dir, "mcp-server-started");
      mkdirSync(join(dir, ".pi"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "mcp.json"),
        JSON.stringify({ mcpServers: { probe: { command: "/bin/sh", args: ["-c", `touch '${marker}'`] } } }),
      );
      return marker;
    }

    /** Write a project-local extension in `dir/.pi/extensions` that registers `toolName`. */
    function writeProjectExtension(dir: string, toolName: string): void {
      mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "extensions", `${toolName}.js`),
        `export default (pi) => pi.registerTool({ name: "${toolName}", label: "${toolName}", description: "${toolName}", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } });`,
      );
    }

    /** Whether the server behind `marker` started; it starts in the background after session_start. */
    async function started(marker: string): Promise<boolean> {
      for (let i = 0; i < 30 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
      return existsSync(marker);
    }

    it("a trusted project's .pi/mcp.json server starts in the subagent", async () => {
      // Positive control: proves the marker shows a started server, so the
      // negative tests below can't pass just because nothing ever starts.
      const marker = writeMcpConfig(cwd);
      await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, true));
      expect(await started(marker)).toBe(true);
    });

    it("an untrusted project's .pi/mcp.json never runs in the subagent", async () => {
      // pi's SettingsManager defaults to trusted; the child must inherit the
      // parent's decision instead, or an untrusted repo runs its own commands.
      const marker = writeMcpConfig(cwd);
      await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, false));
      expect(await started(marker)).toBe(false);
    });

    it("a spawn sent into another directory never runs that directory's .pi/mcp.json", async () => {
      // The parent project (`cwd`) is trusted; the target is not part of it. Trust
      // covers the parent's project, so the target's config must not execute (#96).
      const target = mkdtempSync(join(tmpdir(), "subagents-e2e-target-"));
      try {
        const marker = writeMcpConfig(target);
        await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, true, { cwd: target, configCwd: cwd }));
        expect(await started(marker)).toBe(false);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });

    it("a trusted project's .pi/extensions load in the subagent", async () => {
      writeProjectExtension(cwd, "project_tool");
      const active = await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, true));
      expect(active).toContain("project_tool");
    });

    it("an untrusted project's .pi/extensions never load in the subagent", async () => {
      writeProjectExtension(cwd, "project_tool");
      const active = await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, false));
      expect(active).not.toContain("project_tool");
      expect(registered).not.toContain("project_tool"); // never loaded, not merely inactive
    });

    it("a spawn sent into another directory still loads the parent project's extensions", async () => {
      // Only the session's view of its cwd is untrusted; the loader keeps the
      // parent project's trust, so the parent's toolbox goes with the worker.
      writeProjectExtension(cwd, "project_tool");
      const target = mkdtempSync(join(tmpdir(), "subagents-e2e-target-"));
      try {
        const active = await withEmptyAgentDir(() =>
          activeToolsFor({ extensions: true }, true, { cwd: target, configCwd: cwd }),
        );
        expect(active).toContain("project_tool");
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });

    it("starting pi with --no-mcp keeps the built-in MCP out of the subagent", async () => {
      const marker = writeMcpConfig(cwd);
      process.argv.push("--no-mcp");
      try {
        await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, true));
      } finally {
        process.argv.pop();
      }
      expect(await started(marker)).toBe(false);
    });

    it("starting pi with -ne keeps every built-in out of the subagent", async () => {
      const marker = writeMcpConfig(cwd);
      process.argv.push("-ne");
      try {
        await withEmptyAgentDir(() => activeToolsFor({ extensions: true }, true));
      } finally {
        process.argv.pop();
      }
      expect(registered).not.toContain("codemode");
      expect(registered).not.toContain("tool_search");
      expect(await started(marker)).toBe(false);
    });

    it("exclude_extensions: builtin:mcp keeps the built-in MCP out of the subagent", async () => {
      const marker = writeMcpConfig(cwd);
      await withEmptyAgentDir(() => activeToolsFor({ extensions: true, excludeExtensions: ["builtin:mcp"] }, true));
      expect(await started(marker)).toBe(false);
      expect(registered).toContain("codemode"); // the other built-ins still load
    });

    it("extensions: [builtin:tool-search] loads only that built-in", async () => {
      const marker = writeMcpConfig(cwd);
      await withEmptyAgentDir(() => activeToolsFor({ extensions: ["builtin:tool-search"] }, true));
      expect(registered).toContain("tool_search");
      expect(registered).not.toContain("codemode");
      expect(await started(marker)).toBe(false);
    });

    it("ext:builtin:codemode beside a narrowed MCP tool keeps codemode active, as pi's --tools does", async () => {
      // pi's MCP activates codemode at session_start, before its server tools
      // register. Naming the bridge, as in `pi --tools read,codemode,'mcp__*'`,
      // keeps it in scope from the start, so the scope never takes it back.
      const canon = extensionCanonicalName(LAZY_MCP_FIXTURE);
      const active = await withEmptyAgentDir(() =>
        activeToolsFor({
          extensions: ["*", LAZY_MCP_FIXTURE],
          extSelectors: [`ext:${canon}/mcp__lazy__lookup`, "ext:builtin:codemode"],
        }),
      );
      expect(active).toContain("codemode");
      expect(registered).not.toContain("mcp__lazy__lookup"); // the server has not connected yet
      (globalThis as { __lazyMcpConnect?: () => void }).__lazyMcpConnect?.();
      expect(lastSession.getAllTools().map((t: { name: string }) => t.name)).toContain("mcp__lazy__lookup");
      expect(lastSession.getActiveToolNames()).toContain("codemode");
      expect(lastSession.getActiveToolNames()).not.toContain("tool_search");
    });

    it("an ext: allowlist that names no bridge keeps codemode out, as pi's --tools does", async () => {
      const canon = extensionCanonicalName(LAZY_MCP_FIXTURE);
      const active = await withEmptyAgentDir(() =>
        activeToolsFor({ extensions: ["*", LAZY_MCP_FIXTURE], extSelectors: [`ext:${canon}/mcp__lazy__lookup`] }),
      );
      expect(active).not.toContain("codemode");
    });
  });
});
