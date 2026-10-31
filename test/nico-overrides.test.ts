import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  buildAgentRegistry,
} from "../src/agent-types.js";
import { type ModelRegistry, resolveModel } from "../src/model-resolver.js";
import {
  applyNicoOverride,
  applyNicoOverridesToMap,
  readNicoAgentOverrides,
  resolveNicoTools,
} from "../src/nico-overrides.js";
import type { AgentConfig } from "../src/types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    displayName: "Explorer",
    color: "cyan",
    description: "Existing agent",
    builtinToolNames: ["read", "grep"],
    extSelectors: ["ext:search"],
    disallowedTools: ["write"],
    extensions: ["search-extension"],
    excludeExtensions: ["blocked-extension"],
    skills: ["research"],
    model: "anthropic/claude-haiku-4-5",
    thinking: "high",
    maxTurns: 12,
    persistSession: true,
    outputTranscript: false,
    sessionDir: "/tmp/sessions",
    allowedSubagents: ["helper"],
    systemPrompt: "existing prompt",
    promptMode: "append",
    inheritContext: true,
    runInBackground: true,
    isolated: false,
    memory: "project",
    isolation: "worktree",
    isDefault: true,
    enabled: true,
    source: "project",
    sourcePath: "/project/.pi/agents/Explore.md",
    ...overrides,
  };
}

let root: string;
let previousAgentDir: string | undefined;

describe("Nico-style agent overrides", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-nico-overrides-"));
    mkdirSync(join(root, ".pi"), { recursive: true });
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves every current AgentConfig field while overriding supported fields", () => {
    const agent = makeAgent();
    const updated = applyNicoOverride(agent, {
      model: "zai/glm-5.3-flash",
      thinking: "low",
      systemPrompt: "replacement prompt",
      disabled: true,
      tools: ["read", "ext:search/tool"],
    });

    expect(updated).toEqual({
      ...agent,
      model: "zai/glm-5.3-flash",
      thinking: "low",
      systemPrompt: "replacement prompt",
      enabled: false,
      builtinToolNames: ["read"],
      extSelectors: ["ext:search/tool"],
    });
  });

  it("keeps current built-in, extension, and wildcard tool semantics", () => {
    expect(resolveNicoTools(false)).toEqual({
      builtinToolNames: [],
      extSelectors: undefined,
    });
    expect(resolveNicoTools(["ext:search/tool"])).toEqual({
      builtinToolNames: [],
      extSelectors: ["ext:search/tool"],
    });
    expect(resolveNicoTools(["read", "ext:search", "grep"])).toEqual({
      builtinToolNames: ["read", "grep"],
      extSelectors: ["ext:search"],
    });
    expect(resolveNicoTools(["*", "read", "ext:search"])).toEqual({
      builtinToolNames: BUILTIN_TOOL_NAMES,
      extSelectors: ["ext:search"],
    });
    expect(resolveNicoTools(["all"])).toEqual({
      builtinToolNames: BUILTIN_TOOL_NAMES,
      extSelectors: undefined,
    });
  });

  it("requires exact override keys and auto-registers a typo as a separate agent", () => {
    const agents = new Map([["Explore", makeAgent()]]);

    applyNicoOverridesToMap(agents, {
      Explore: { model: "zai/glm-5.3-flash" },
      explore: { model: "openai/gpt-4o" },
    });

    expect(agents.get("Explore")?.model).toBe("zai/glm-5.3-flash");
    expect(agents.get("explore")?.model).toBe("openai/gpt-4o");
    expect(agents.get("explore")?.name).toBe("explore");
  });

  it("applies JSON overrides through buildAgentRegistry", () => {
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({
      subagents: {
        agentOverrides: {
          Explore: { model: "zai/glm-5.3-flash", thinking: "low" },
          typo: { model: "openai/gpt-4o" },
        },
      },
    }));

    const registry = buildAgentRegistry(new Map(), root);
    expect(registry.get("Explore")?.model).toBe("zai/glm-5.3-flash");
    expect(registry.get("Explore")?.thinking).toBe("low");
    expect(registry.get("typo")?.model).toBe("openai/gpt-4o");
  });

  it("lets project JSON override global JSON by exact key", () => {
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({
      subagents: {
        agentOverrides: {
          Explore: { model: "openrouter/claude-haiku-4-5" },
          GlobalOnly: { model: "zai/glm-5.3-flash" },
        },
      },
    }));
    writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({
      subagents: {
        agentOverrides: {
          Explore: { thinking: "low" },
        },
      },
    }));

    const loaded = readNicoAgentOverrides(root);
    expect(loaded.overrides.Explore).toEqual({
      model: "openrouter/claude-haiku-4-5",
      thinking: "low",
    });
    expect(loaded.overrides.GlobalOnly).toEqual({ model: "zai/glm-5.3-flash" });
  });

  it("resolves an explicit provider-qualified override under the current model resolver", () => {
    const zai = { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "zai" };
    const openrouter = { id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "openrouter" };
    const registry: ModelRegistry = {
      find(provider: string, modelId: string) {
        return [zai, openrouter].find(model => model.provider === provider && model.id === modelId);
      },
      getAll() {
        return [zai, openrouter];
      },
      getAvailable() {
        return [zai, openrouter];
      },
    };
    const agent = applyNicoOverride(makeAgent(), { model: "zai/glm-5.3-flash" });

    expect(resolveModel(agent.model ?? "", registry)).toBe(zai);
  });
});
