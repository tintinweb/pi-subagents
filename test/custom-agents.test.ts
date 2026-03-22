import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgent(name: string, content: string) {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  it("returns empty map when .pi/agents/ does not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
prompt_mode: replace
inherit_context: true
run_in_background: true
isolated: true
---

You are a security auditor.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);

    const agent = result.get("auditor")!;
    expect(agent.name).toBe("auditor");
    expect(agent.description).toBe("Security Auditor");
    expect(agent.builtinToolNames).toEqual(["read", "grep", "find"]);
    expect(agent.model).toBe("anthropic/claude-opus-4-6");
    expect(agent.thinking).toBe("high");
    expect(agent.maxTurns).toBe(30);
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(true);
    expect(agent.runInBackground).toBe(true);
    expect(agent.isolated).toBe(true);
    expect(agent.systemPrompt).toBe("You are a security auditor.");
  });

  it("uses sensible defaults when frontmatter is empty", () => {
    writeAgent("minimal", `---
---

Just a prompt.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("minimal")!;

    expect(agent.name).toBe("minimal");
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.skills).toBe(true); // inherit all
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBe(false);
    expect(agent.runInBackground).toBe(false);
    expect(agent.isolated).toBe(false);
    expect(agent.systemPrompt).toBe("Just a prompt.");
  });

  it("uses sensible defaults when no frontmatter at all", () => {
    writeAgent("bare", "Just a system prompt, no frontmatter.");

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("bare")!;

    expect(agent.name).toBe("bare");
    expect(agent.description).toBe("bare");
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.systemPrompt).toBe("Just a system prompt, no frontmatter.");
  });

  it("handles tools: none → empty array", () => {
    writeAgent("notool", `---
tools: none
---

No tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("notool")!.builtinToolNames).toEqual([]);
  });

  it("handles extensions: false → no extensions", () => {
    writeAgent("noext", `---
extensions: false
skills: false
---

No extensions.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("noext")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("handles extension allowlist", () => {
    writeAgent("partial", `---
extensions: web-search, mcp-server
skills: planning, review
---

Partial access.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("partial")!;
    expect(agent.extensions).toEqual(["web-search", "mcp-server"]);
    expect(agent.skills).toEqual(["planning", "review"]);
  });

  it("passes through unknown tool names (not filtered)", () => {
    writeAgent("custom-tools", `---
tools: read, my_custom_tool, grep
---

Custom tools.`);

    const result = loadCustomAgents(tmpDir);
    // Unknown tool names are passed through — filtering happens at tool creation time
    expect(result.get("custom-tools")!.builtinToolNames).toEqual(["read", "my_custom_tool", "grep"]);
  });

  it("passes through thinking level as-is (no validation)", () => {
    writeAgent("anythink", `---
thinking: turbo
---

Any thinking.`);

    const result = loadCustomAgents(tmpDir);
    // Pi validates at session creation — we just pass through
    expect(result.get("anythink")!.thinking).toBe("turbo");
  });

  it("accepts max_turns: 0 as unlimited", () => {
    writeAgent("unlimited", `---
max_turns: 0
---

Unlimited turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unlimited")!.maxTurns).toBe(0);
  });

  it("rejects negative max_turns", () => {
    writeAgent("negturns", `---
max_turns: -5
---

Negative turns.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("negturns")!.maxTurns).toBeUndefined();
  });

  it("handles prompt_mode: append", () => {
    writeAgent("appender", `---
prompt_mode: append
---

Extra instructions.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("appender")!.promptMode).toBe("append");
  });

  it("defaults unknown prompt_mode to replace", () => {
    writeAgent("badmode", `---
prompt_mode: merge
---

Unknown mode.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("badmode")!.promptMode).toBe("replace");
  });

  it("loads multiple agents", () => {
    writeAgent("agent1", `---
description: First
---

First agent.`);
    writeAgent("agent2", `---
description: Second
---

Second agent.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(2);
    expect(result.has("agent1")).toBe(true);
    expect(result.has("agent2")).toBe(true);
  });

  it("skips non-.md files", () => {
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not an agent");
    writeFileSync(join(dir, "real.md"), `---
description: Real Agent
---

Real.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("real")).toBe(true);
  });

  it("allows agents with names matching defaults (overrides them)", () => {
    writeAgent("Explore", `---
description: Custom Explore
---

Custom explore agent.`);
    writeAgent("custom", `---
description: Custom Agent
---

Should be loaded.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.has("Explore")).toBe(true);
    expect(result.get("Explore")!.description).toBe("Custom Explore");
    expect(result.has("custom")).toBe(true);
  });

  it("handles empty body with frontmatter", () => {
    writeAgent("nobody", `---
description: No body
tools: read
---
`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("nobody")!.systemPrompt).toBe("");
  });

  it("supports inherit_extensions as alternative to extensions", () => {
    writeAgent("altkey", `---
inherit_extensions: false
inherit_skills: false
---

Alt keys.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("altkey")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: none → false", () => {
    writeAgent("extnone", `---
extensions: none
skills: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("extnone")!;
    expect(agent.extensions).toBe(false);
    expect(agent.skills).toBe(false);
  });

  it("extensions: true → true (inherit all)", () => {
    writeAgent("exttrue", `---
extensions: true
skills: true
---

All.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("exttrue")!;
    expect(agent.extensions).toBe(true);
    expect(agent.skills).toBe(true);
  });

  it("handles enabled: false frontmatter", () => {
    writeAgent("disabled", `---
enabled: false
---
`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("disabled")!;
    expect(agent.enabled).toBe(false);
  });

  it("parses display_name frontmatter", () => {
    writeAgent("myagent", `---
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.displayName).toBe("MyAgent");
  });

  it("parses disallowed_tools as csv list", () => {
    writeAgent("restricted", `---
description: Restricted Agent
disallowed_tools: bash, write
---

No bash or write.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("restricted")!;
    expect(agent.disallowedTools).toEqual(["bash", "write"]);
  });

  it("disallowed_tools defaults to undefined when omitted", () => {
    writeAgent("unrestricted", `---
description: Unrestricted
---

All tools.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("unrestricted")!.disallowedTools).toBeUndefined();
  });

  it("parses memory scope", () => {
    writeAgent("rememberer", `---
description: Agent with memory
memory: project
---

Remember things.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("rememberer")!.memory).toBe("project");
  });

  it("parses memory: user scope", () => {
    writeAgent("global-mem", `---
memory: user
---

User memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("global-mem")!.memory).toBe("user");
  });

  it("memory defaults to undefined when omitted", () => {
    writeAgent("no-mem", `---
description: No memory
---

Stateless.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-mem")!.memory).toBeUndefined();
  });

  it("rejects invalid memory scope", () => {
    writeAgent("bad-mem", `---
memory: invalid
---

Bad memory.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-mem")!.memory).toBeUndefined();
  });

  it("parses isolation: worktree", () => {
    writeAgent("isolated-wt", `---
description: Worktree agent
isolation: worktree
---

Isolated.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("isolated-wt")!.isolation).toBe("worktree");
  });

  it("isolation defaults to undefined when omitted", () => {
    writeAgent("no-isolation", `---
description: Normal
---

Normal.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-isolation")!.isolation).toBeUndefined();
  });

  it("rejects invalid isolation mode", () => {
    writeAgent("bad-isolation", `---
isolation: docker
---

Bad isolation.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bad-isolation")!.isolation).toBeUndefined();
  });
});
