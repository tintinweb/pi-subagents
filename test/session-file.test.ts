import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type RunOptions, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "lane-agent",
    description: "Lane agent",
    builtinToolNames: [],
    extensions: false,
    skills: false,
    systemPrompt: "Reply exactly as instructed.",
    promptMode: "replace",
    ...overrides,
  };
}

describe("explicit session_file persistence", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    registerAgents(new Map());
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the explicit session file parent even when session_dir points elsewhere", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagents-session-file-"));
    tmpDirs.push(cwd);
    const sessionFile = join(cwd, ".agents", "sessions", "KEY.dev.jsonl");
    const sessionDir = join(cwd, ".agents", "session-branches");

    registerAgents(new Map([
      ["lane-agent", makeAgentConfig({
        sessionDir: ".agents/session-branches",
        sessionFile: ".agents/sessions/KEY.dev.jsonl",
      })],
    ]));

    const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    try {
      faux.setResponses([fauxAssistantMessage([fauxText("LANE_OK")], { stopReason: "stop" })]);
      const model = faux.getModel();
      const modelRegistry = {
        find: () => model,
        getAll: () => [model],
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
      };
      const ctx = {
        cwd,
        model,
        modelRegistry,
        getSystemPrompt: () => "parent prompt",
        sessionManager: { getBranch: () => [] },
      } as unknown as Parameters<typeof runAgent>[0];

      const result = await runAgent(ctx, "lane-agent", "Say LANE_OK", { pi: {} as RunOptions["pi"] });

      expect(result.responseText).toBe("LANE_OK");
      expect(existsSync(sessionFile)).toBe(true);
      expect(existsSync(sessionDir)).toBe(true);
      expect(readFileSync(sessionFile, "utf-8")).toContain("LANE_OK");
      result.session.dispose?.();
    } finally {
      faux.unregister();
    }
  });
});
