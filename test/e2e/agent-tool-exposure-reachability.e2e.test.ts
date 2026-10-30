/**
 * agent-tool-exposure-reachability.e2e.test.ts — reachability guard for
 * `SubagentsSettings.toolExposure` against the REAL pi-mono runtime.
 *
 * `test/agent-tool-exposure.test.ts` boots the extension against a hand-written
 * `registerTool` mock and asserts on the registered tool's `.exposure` field.
 * That proves this extension PASSES the right value to `pi.registerTool()`; it
 * cannot prove the thing the setting exists for — that real Pi actually keeps a
 * `deferred` tool off the model's declared tool set, while still registering it
 * so `tool_search`/codemode can find it. A future Pi that stopped honoring
 * `exposure`, or a typo that silently fell back to `"direct"`, would leave the
 * unit test green with the real behavior gone.
 *
 * So this drives a REAL `DefaultResourceLoader` + `createAgentSession` with this
 * extension's actual `src/index.ts` loaded via `additionalExtensionPaths`, and
 * reads the real session's `getActiveToolNames()` (the declared set) and
 * `getAllTools()` (every registered tool, active or not) at construction time —
 * before any prompt, since exposure is fixed at registration.
 *
 * No network/LLM: a faux Model/modelRuntime satisfies `createAgentSession`, and
 * the assertion is on the constructed tool set, not on a model turn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createToolSearchExtension, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi-mono session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const EXTENSION = resolve(fileURLToPath(new URL("../../src/index.ts", import.meta.url)));

describe("Agent tool exposure against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-exposure-e2e-"));
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Writes `settings` to `.pi/subagents.json` (settings are read from
   * `process.cwd()` at extension load, so this chdirs for the duration), loads
   * the real extension into a real session, and returns its declared and
   * registered tool names at construction time.
   */
  async function toolsFor(
    settings: Record<string, unknown>,
    options: { withToolSearch?: boolean } = {},
  ): Promise<{ active: string[]; registered: string[] }> {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false, ...settings }));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: cwd,
        additionalExtensionPaths: [EXTENSION],
        extensionFactories: options.withToolSearch ? [createToolSearchExtension()] : undefined,
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const model = faux.getModel();
      const backend = fauxModelBackend(model);
      const { session } = await createAgentSession({
        cwd,
        agentDir: cwd,
        model: model as any,
        modelRuntime: backend.modelRuntime,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        // session_start does not fire unless requested -- needed for the
        // tool_search warning tests below, which assert on it.
        sessionStartEvent: { type: "session_start", reason: "startup" } as any,
      } as any);
      // Extensions are registered during construction above, but event handlers
      // (such as the tool_search warning's session_start listener) only fire
      // once bound -- needed for the tool_search warning tests below.
      await session.bindExtensions({});
      return { active: session.getActiveToolNames(), registered: session.getAllTools().map((t: any) => t.name) };
    } finally {
      process.chdir(previousCwd);
    }
  }

  it("Agent is declared to the model by default (unchanged behavior)", async () => {
    const { active, registered } = await toolsFor({});
    expect(active).toContain("Agent");
    expect(registered).toContain("Agent");
  });

  it('"deferred" keeps Agent registered but off the model\'s declared tool set', async () => {
    const { active, registered } = await toolsFor({ toolExposure: "deferred" });
    expect(registered).toContain("Agent");
    expect(active).not.toContain("Agent");
  });

  it("an invalid toolExposure value falls back to direct (Agent stays declared)", async () => {
    const { active } = await toolsFor({ toolExposure: "nonsense" });
    expect(active).toContain("Agent");
  });

  // Unlike pi-web-access's web_enable, this extension has no fallback activation path
  // of its own: tool_search is the ONLY way to reach a deferred Agent. These two close
  // the loop the unit-test mock (test/agent-tool-exposure.test.ts) can't -- they prove
  // the warning condition against the real built-in tool_search extension, registered
  // (or not) the same way a real pi session would load it.
  it("warns when deferred and the real tool_search extension is not loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await toolsFor({ toolExposure: "deferred" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('toolExposure is "deferred" but tool_search is not active'));
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when deferred and the real tool_search extension is loaded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await toolsFor({ toolExposure: "deferred" }, { withToolSearch: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
