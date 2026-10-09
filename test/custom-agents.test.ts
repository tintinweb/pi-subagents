import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeAgentFile } from "../src/agent-file-toggle.js";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { MAX_PACKAGE_RESOURCE_BYTES } from "../src/package-resources.js";
import type { AgentConfig } from "../src/types.js";

describe("loadCustomAgents", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-"));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgentIn(projectDir: ".agents" | ".pi", name: string, content: string) {
    const dir = join(tmpDir, projectDir, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  function writeAgent(name: string, content: string) {
    writeAgentIn(".pi", name, content);
  }

  function writeWorkspaceAgent(name: string, content: string) {
    writeAgentIn(".agents", name, content);
  }

  it("returns empty map when custom agent dirs do not exist", () => {
    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(0);
  });

  it("loads a workspace project agent from .agents/agents", () => {
    writeWorkspaceAgent("reviewer", `---
description: Workspace Reviewer
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("reviewer")?.description).toBe("Workspace Reviewer");
    expect(result.get("reviewer")?.systemPrompt).toBe("Workspace prompt.");
    expect(result.get("reviewer")?.source).toBe("project");
  });

  it(".pi/agents overrides .agents/agents on a name clash", () => {
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);
    writeAgent("dupe", `---
description: Pi Project
---

Pi prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Pi Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Pi prompt.");
  });

  it("workspace project agents override global agents", () => {
    const globalAgentDir = join(tmpDir, "global-agent-dir");
    process.env.PI_CODING_AGENT_DIR = globalAgentDir;
    const globalAgents = join(globalAgentDir, "agents");
    mkdirSync(globalAgents, { recursive: true });
    writeFileSync(join(globalAgents, "dupe.md"), `---
description: Global
---

Global prompt.`);
    writeWorkspaceAgent("dupe", `---
description: Workspace Project
---

Workspace prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get("dupe")?.description).toBe("Workspace Project");
    expect(result.get("dupe")?.systemPrompt).toBe("Workspace prompt.");
  });

  it("loads a basic agent with all frontmatter fields", () => {
    writeAgent("auditor", `---
description: Security Auditor
tools: read, grep, find
model: anthropic/claude-opus-4-6
thinking: high
max_turns: 30
persist_session: true
output_transcript: false
session_dir: .seams/pi-sessions/seam-plan-reviewer
allowed_subagents: scout, reviewer
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
    expect(agent.persistSession).toBe(true);
    expect(agent.outputTranscript).toBe(false);
    expect(agent.sessionDir).toBe(".seams/pi-sessions/seam-plan-reviewer");
    expect(agent.allowedSubagents).toEqual(["scout", "reviewer"]);
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
    expect(agent.displayName).toBeUndefined();
    expect(agent.color).toBeUndefined();
    expect(agent.description).toBe("minimal"); // defaults to filename
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES); // all tools
    expect(agent.extensions).toBe(true); // inherit all
    expect(agent.skills).toBe(true); // inherit all
    expect(agent.model).toBeUndefined();
    expect(agent.thinking).toBeUndefined();
    expect(agent.maxTurns).toBeUndefined();
    expect(agent.persistSession).toBeUndefined();
    expect(agent.outputTranscript).toBeUndefined();
    expect(agent.sessionDir).toBeUndefined();
    expect(agent.allowedSubagents).toBeUndefined();
    expect(agent.promptMode).toBe("replace");
    expect(agent.inheritContext).toBeUndefined();
    expect(agent.runInBackground).toBeUndefined();
    expect(agent.isolated).toBeUndefined();
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

  it("parses allowed_subagents: off by default, `all` wildcard, csv restriction", () => {
    writeAgent("omitted", `---
---
Off.`);
    writeAgent("unrestricted", `---
allowed_subagents: all
---
Unrestricted.`);
    writeAgent("wildcard", `---
allowed_subagents: "*"
---
Unrestricted.`);
    writeAgent("mixed-case", `---
allowed_subagents: scout, ALL
---
Unrestricted.`);
    writeAgent("none", `---
allowed_subagents: none
---
Off.`);
    writeAgent("blank", `---
allowed_subagents:
---
Off.`);
    writeAgent("restricted", `---
allowed_subagents: scout, reviewer
---
Restricted.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("omitted")!.allowedSubagents).toBeUndefined();
    expect(result.get("unrestricted")!.allowedSubagents).toBe("all");
    expect(result.get("wildcard")!.allowedSubagents).toBe("all");
    expect(result.get("mixed-case")!.allowedSubagents).toBe("all");
    expect(result.get("none")!.allowedSubagents).toBeUndefined();
    expect(result.get("blank")!.allowedSubagents).toBeUndefined();
    expect(result.get("restricted")!.allowedSubagents).toEqual(["scout", "reviewer"]);
  });

  it("accepts booleans like extensions:/skills: do, instead of a type named \"true\"", () => {
    writeAgent("bool-on", `---
allowed_subagents: true
---
On.`);
    writeAgent("bool-off", `---
allowed_subagents: false
---
Off.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("bool-on")!.allowedSubagents).toBe("all");
    expect(result.get("bool-off")!.allowedSubagents).toBeUndefined();
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

  it("parses exclude_extensions CSV", () => {
    writeAgent("no-notify", `---
extensions: true
exclude_extensions: pi-notify, telemetry
---

No notifications.`);

    const result = loadCustomAgents(tmpDir);
    const agent = result.get("no-notify")!;
    expect(agent.extensions).toBe(true);
    expect(agent.excludeExtensions).toEqual(["pi-notify", "telemetry"]);
  });

  it("parses exclude_extensions YAML list", () => {
    writeAgent("no-notify-yaml", `---
exclude_extensions:
  - pi-notify
---

No notifications.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-notify-yaml")!.excludeExtensions).toEqual(["pi-notify"]);
  });

  it("exclude_extensions omitted or none → undefined", () => {
    writeAgent("plain", `---
description: plain
---

Plain.`);
    writeAgent("explicit-none", `---
exclude_extensions: none
---

None.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("plain")!.excludeExtensions).toBeUndefined();
    expect(result.get("explicit-none")!.excludeExtensions).toBeUndefined();
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

  it("partitions tools: ext: entries out of builtinToolNames into extSelectors", () => {
    writeAgent("ext-agent", `---
tools: read, ext:foo, ext:bar/x
---

Extension selectors.`);

    const agent = loadCustomAgents(tmpDir).get("ext-agent")!;
    expect(agent.builtinToolNames).toEqual(["read"]);
    expect(agent.extSelectors).toEqual(["ext:foo", "ext:bar/x"]);
  });

  it("tools: with only ext: entries yields zero built-ins", () => {
    writeAgent("ext-only", `---
tools: ext:foo/bar
---

Ext only.`);

    const agent = loadCustomAgents(tmpDir).get("ext-only")!;
    expect(agent.builtinToolNames).toEqual([]);
    expect(agent.extSelectors).toEqual(["ext:foo/bar"]);
  });

  it("tools: '*' expands to all built-ins and composes with ext: selectors", () => {
    writeAgent("wild", `---
tools: "*, ext:foo"
---

Wildcard plus ext.`);

    const agent = loadCustomAgents(tmpDir).get("wild")!;
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.extSelectors).toEqual(["ext:foo"]);
  });

  it("tools: 'all' is a case-insensitive alias for '*' (closes #75)", () => {
    // `tools: all` previously parsed "all" as a single tool name → allowlist
    // containing the non-existent tool "all" → silent zero-tool agent.
    for (const [name, value] of [["all-lower", "all"], ["all-upper", "ALL"], ["all-mixed", "All"]]) {
      writeAgent(name, `---\ntools: ${value}\n---\n\nAlias.`);
      const agent = loadCustomAgents(tmpDir).get(name)!;
      expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
      expect(agent.extSelectors).toBeUndefined();
    }
  });

  it("tools: 'all' composes with ext: selectors like '*'", () => {
    writeAgent("all-plus-ext", `---
tools: "all, ext:foo"
---

All plus ext.`);

    const agent = loadCustomAgents(tmpDir).get("all-plus-ext")!;
    expect(agent.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    expect(agent.extSelectors).toEqual(["ext:foo"]);
  });

  it("leaves extSelectors undefined when tools: has no ext: entries", () => {
    writeAgent("plain", `---
tools: read, bash
---

Plain tools.`);

    const agent = loadCustomAgents(tmpDir).get("plain")!;
    expect(agent.builtinToolNames).toEqual(["read", "bash"]);
    expect(agent.extSelectors).toBeUndefined();
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

  it("loads thinking: max (pi 0.80's top level) unchanged (#147)", () => {
    writeAgent("deepthink", `---
thinking: max
---

Think hard.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("deepthink")!.thinking).toBe("max");
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

  it("takes the agent type from frontmatter name, not the filename", () => {
    // Claude Code's rule: "the filename doesn't have to match". The same file
    // dropped into either tool must dispatch under the same type.
    writeAgent("blubb", `---
name: code-review
description: Reviews code
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("code-review")!.name).toBe("code-review");
    expect(result.get("blubb")).toBeUndefined();
  });

  it("records the file it was read from, not the one its type would name", () => {
    // `/agents` edits `sourcePath`: probing for `<type>.md` finds nothing here,
    // and its no-file branch writes a stub that loses to this file on load.
    writeAgent("blubb", `---
name: code-review
description: Reviews code
---

Agent prompt.`);

    expect(loadCustomAgents(tmpDir).get("code-review")!.sourcePath)
      .toBe(join(tmpDir, ".pi", "agents", "blubb.md"));
  });

  it("falls back to the filename for an empty or blank declared name", () => {
    // A quoted empty `name:` would otherwise register the agent under the empty
    // type — unspawnable, and it takes the filename-derived one down with it.
    writeAgent("myagent", "---\nname: \"\"\ndescription: My Agent\n---\n\nPrompt.");
    writeAgent("other", "---\nname: \"   \"\ndescription: Other\n---\n\nPrompt.");

    const result = loadCustomAgents(tmpDir);
    expect(result.get("myagent")!.name).toBe("myagent");
    expect(result.get("other")!.name).toBe("other");
    expect(result.has("")).toBe(false);
  });

  it("trims a declared name so it matches what the user meant to type", () => {
    writeAgent("blubb", "---\nname: \" code-review \"\ndescription: Reviews code\n---\n\nPrompt.");

    expect(loadCustomAgents(tmpDir).get("code-review")!.name).toBe("code-review");
  });

  it("falls back to the filename when no name is declared", () => {
    // Claude Code requires `name`; most existing files here predate it and
    // must keep loading under the identity they already dispatch by.
    writeAgent("myagent", `---
description: My Agent
---

Agent prompt.`);

    expect(loadCustomAgents(tmpDir).get("myagent")!.name).toBe("myagent");
  });

  it("keeps display_name as a label only, independent of the type", () => {
    writeAgent("blubb", `---
name: code-review
description: My Agent
display_name: MyAgent
---

Agent prompt.`);

    const agent = loadCustomAgents(tmpDir).get("code-review")!;
    expect(agent.name).toBe("code-review");
    expect(agent.displayName).toBe("MyAgent");
  });

  it("leaves displayName unset so the badge falls back to the type", () => {
    // A Claude Code file has no display_name; `getConfig` resolves the label
    // to the type, so it still badges as "code-reviewer" as it did before.
    writeAgent("whatever", `---
name: code-reviewer
description: Reviews code
color: "#8B5CF6"
---

Agent prompt.`);

    const agent = loadCustomAgents(tmpDir).get("code-reviewer")!;
    expect(agent.name).toBe("code-reviewer");
    expect(agent.displayName).toBeUndefined();
    expect(agent.color).toBe("#8B5CF6");
  });

  it("accepts a name Claude Code accepts, however unlike a type it looks", () => {
    // Its docs describe names as "lowercase letters and hyphens", but the only
    // load failure they state is the colon — so this must still load.
    writeAgent("reviewer", `---
name: Code Reviewer
description: Reviews code
---

Agent prompt.`);

    expect(loadCustomAgents(tmpDir).get("Code Reviewer")!.name).toBe("Code Reviewer");
  });

  it("refuses a name containing the plugin-scope separator", () => {
    // Claude Code doesn't load these. Skipping beats loading it under the
    // filename, which would dispatch an agent whose declared identity nothing
    // honoured.
    writeAgent("scoped", `---
name: my-plugin:reviewer
description: Reviews code
---

Agent prompt.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("my-plugin:reviewer")).toBeUndefined();
    expect(result.get("scoped")).toBeUndefined();
  });

  it("does not claim the rejected file was overriding its filename's agent", () => {
    // It would have registered under its *declared* name, which a colon keeps
    // out of the registry entirely — so it shadowed nothing. Reporting a
    // substitution of the same-named file from another directory describes a
    // swap that never happened, and points at an agent that is unchanged.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeWorkspaceAgent("scoped", "---\ndescription: An unrelated agent\n---\n\nBody.");
      writeAgent("scoped", "---\nname: my-plugin:reviewer\ndescription: Reviews code\n---\n\nBody.");

      const result = loadCustomAgents(tmpDir);

      expect(result.get("scoped")?.description).toBe("An unrelated agent");
      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain("reserved for plugin-scoped identifiers");
      expect(message).not.toContain("now loads from");
    } finally {
      warn.mockRestore();
    }
  });

  it("lets a later file win a declared-name clash, as a filename clash always did", () => {
    // Filenames were unique per directory by construction; declared names are
    // not, so two files in one directory can now claim the same type.
    writeAgent("a-first", `---
name: shared
description: first
---

First.`);
    writeAgent("b-second", `---
name: shared
description: second
---

Second.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("shared")!.description).toBe("second");
    expect([...result.keys()].filter(k => k === "shared")).toHaveLength(1);
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

  // `isolation: off` is a veto, not a synonym for omitting the field: agent
  // config outranks tool-call params, so it turns a caller's "worktree" back
  // off. That is why it must survive parsing as "off" rather than undefined.
  it("parses isolation: off", () => {
    writeAgent("no-wt", `---
description: Never worktree
isolation: off
---

No worktree.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get("no-wt")!.isolation).toBe("off");
  });

  // pi's frontmatter parser is not YAML 1.1, so bare `off`/`no` stay strings
  // and only `false` becomes a boolean — accept the spellings an author is
  // likely to reach for rather than silently dropping them.
  it.each([
    ["false", "isolation: false"],
    ["none", "isolation: none"],
    ["no", "isolation: no"],
  ])("accepts %s as a spelling of off", (name, line) => {
    writeAgent(`off-${name}`, `---
${line}
---

Off.`);

    const result = loadCustomAgents(tmpDir);
    expect(result.get(`off-${name}`)!.isolation).toBe("off");
  });

  // A YAML error in one file used to escape loadFromDir and abort the whole
  // extension load — pi exited 1 before the TUI. Regression for #212.
  it("skips a file with malformed frontmatter and still loads the others", () => {
    // Unquoted `description` containing ": " — the shape Claude Code tolerates.
    writeAgent("broken", `---
name: broken
description: Use this: that
---

Broken body.`);
    writeAgent("good", `---
description: Still loads
---

Good body.`);

    const result = loadCustomAgents(tmpDir);

    expect(result.has("broken")).toBe(false);
    expect(result.get("good")?.description).toBe("Still loads");
  });

  it("names the offending file and the reason when skipping it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("broken", "---\nname: broken\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);

      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain(join(tmpDir, ".pi", "agents", "broken.md"));
      expect(message).toContain("Nested mappings are not allowed");
    } finally {
      warn.mockRestore();
    }
  });

  // Skipping an override is not the same as skipping an agent: the name still
  // resolves, to a different prompt, model and tool policy. Nothing downstream
  // can flag that, because the Agent call succeeds.
  it("warns when a skipped file was overriding an agent that stays resolvable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeWorkspaceAgent("dup", "---\ndescription: Earlier definition\n---\n\nEarlier body.");
      writeAgent("dup", "---\nname: dup\ndescription: Use this: that\n---\n\nBroken body.");

      const result = loadCustomAgents(tmpDir);

      expect(result.get("dup")?.description).toBe("Earlier definition");
      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain(`Agent "dup" now loads from ${join(tmpDir, ".agents", "agents", "dup.md")} instead`);
    } finally {
      warn.mockRestore();
    }
  });

  // A disabled agent does not dispatch (resolveEnabledTypeIn), so claiming the
  // name "still resolves" to it would send the user chasing the wrong file.
  it("does not claim a fallback when the shadowed definition is disabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeWorkspaceAgent("dup", "---\ndescription: Earlier definition\nenabled: false\n---\n\nEarlier body.");
      writeAgent("dup", "---\nname: dup\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);

      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain("Skipping agent file");
      expect(message).not.toContain("now loads from");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not claim a fallback when the skipped file overrode nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("lonely", "---\nname: lonely\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);

      const message = warn.mock.calls.map(args => String(args[0])).join("\n");
      expect(message).toContain("Skipping agent file");
      expect(message).not.toContain("now loads from");
    } finally {
      warn.mockRestore();
    }
  });

  // strictAgentFiles: opt in to failing closed rather than running a substitute.
  it("throws naming the file when strict, and skips it when not", () => {
    writeAgent("broken", "---\nname: broken\ndescription: Use this: that\n---\n\nBroken.");
    writeAgent("healthy", "---\ndescription: Fine\n---\n\nFine.");
    const brokenPath = join(tmpDir, ".pi", "agents", "broken.md");

    expect(() => loadCustomAgents(tmpDir, true)).toThrow(brokenPath);
    expect(() => loadCustomAgents(tmpDir, true)).toThrow("Nested mappings are not allowed");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = loadCustomAgents(tmpDir);
      expect(result.has("broken")).toBe(false);
      expect(result.has("healthy")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // The rule is "warn when it breaks, stay quiet while it stays broken".
  // Suppressing an unchanged problem must not suppress it forever.
  it("warns when a file breaks, not while it stays broken", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Two loads while broken: the second must be suppressed as unchanged.
      writeAgent("flip", "---\nname: flip\ndescription: Use this: that\n---\n\nBroken.");
      loadCustomAgents(tmpDir);
      loadCustomAgents(tmpDir);
      expect(warn).toHaveBeenCalledTimes(1);

      writeAgent("flip", "---\ndescription: Fixed\n---\n\nFixed.");
      expect(loadCustomAgents(tmpDir).get("flip")?.description).toBe("Fixed");

      // Same breakage again — a new problem, not the one already reported.
      writeAgent("flip", "---\nname: flip\ndescription: Use this: that\n---\n\nBroken.");
      loadCustomAgents(tmpDir);

      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  // Agents reload on every Agent call, so repeating would scribble a live TUI.
  it("warns once per message, not on every reload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeAgent("noisy", "---\nname: noisy\ndescription: Use this: that\n---\n\nBroken body.");

      loadCustomAgents(tmpDir);
      loadCustomAgents(tmpDir);
      loadCustomAgents(tmpDir);

      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("honors PI_CODING_AGENT_DIR for global custom agent discovery", () => {
    const altAgentDir = mkdtempSync(join(tmpdir(), "pi-alt-agent-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = altAgentDir;
    try {
      const globalAgentsDir = join(altAgentDir, "agents");
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(
        join(globalAgentsDir, "via-env.md"),
        "---\ndescription: Discovered via env var\n---\n\nTest body.",
      );

      const result = loadCustomAgents(tmpDir);

      // Agent is found at $PI_CODING_AGENT_DIR/agents, not at $HOME/.pi/agent/agents
      expect(result.has("via-env")).toBe(true);
      expect(result.get("via-env")!.description).toBe("Discovered via env var");
    } finally {
      if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalEnv;
      rmSync(altAgentDir, { recursive: true, force: true });
    }
  });

  // `/agents → Eject` writes an AgentConfig back out as frontmatter. That writer
  // and this loader are the two halves of one format, but nothing pinned them
  // together — so a field can serialize to something the loader reads back
  // differently, and the agent silently changes shape on eject.
  describe("eject round-trip", () => {
    function roundTrip(cfg: Partial<AgentConfig>) {
      const full: AgentConfig = {
        description: "Round trip agent",
        systemPrompt: "Body prompt.",
        promptMode: "append",
        ...cfg,
      } as AgentConfig;
      writeAgent("rt", serializeAgentFile(full));
      const loaded = loadCustomAgents(tmpDir).get("rt");
      expect(loaded).toBeDefined();
      return loaded!;
    }

    it("preserves an explicitly narrowed tool list", () => {
      expect(roundTrip({ builtinToolNames: ["read", "grep"] }).builtinToolNames).toEqual(["read", "grep"]);
    });

    it("preserves the full built-in set", () => {
      expect(roundTrip({ builtinToolNames: [...BUILTIN_TOOL_NAMES] }).builtinToolNames)
        .toEqual([...BUILTIN_TOOL_NAMES]);
    });

    it("preserves an empty tool list instead of widening it to every built-in", () => {
      // `tools: none` parses to [] on load, so ejecting an agent with zero
      // built-ins must not write `tools: all` — that hands it the whole toolbox.
      expect(roundTrip({ builtinToolNames: [] }).builtinToolNames).toEqual([]);
    });

    it("preserves the scalar and list fields it writes", () => {
      const loaded = roundTrip({
        displayName: "RT",
        model: "anthropic/claude-haiku-4-5",
        thinking: "low",
        maxTurns: 7,
        allowedSubagents: ["Explore"],
        excludeExtensions: ["ext-beta"],
        disallowedTools: ["write"],
        inheritContext: true,
        runInBackground: true,
        outputTranscript: false,
        isolated: true,
        memory: "project",
        isolation: "worktree",
      });
      expect(loaded.displayName).toBe("RT");
      expect(loaded.model).toBe("anthropic/claude-haiku-4-5");
      expect(loaded.thinking).toBe("low");
      expect(loaded.maxTurns).toBe(7);
      expect(loaded.allowedSubagents).toEqual(["Explore"]);
      expect(loaded.excludeExtensions).toEqual(["ext-beta"]);
      expect(loaded.disallowedTools).toEqual(["write"]);
      expect(loaded.inheritContext).toBe(true);
      expect(loaded.runInBackground).toBe(true);
      expect(loaded.outputTranscript).toBe(false);
      expect(loaded.isolated).toBe(true);
      expect(loaded.memory).toBe("project");
      expect(loaded.isolation).toBe("worktree");
    });

    // The writer used to emit `run_in_background` only when truthy, so an
    // explicit `false` was dropped. Harmless while foreground was the default
    // and omission meant the same thing — but with `backgroundByDefault` on,
    // dropping it flips the ejected agent to background.
    it("preserves an explicit run_in_background: false instead of dropping it", () => {
      expect(roundTrip({ runInBackground: false }).runInBackground).toBe(false);
    });

    it("leaves run_in_background unset when the config doesn't pin it", () => {
      // Absent must stay absent — writing a value would freeze the agent
      // against the setting rather than letting it follow the default.
      expect(roundTrip({}).runInBackground).toBeUndefined();
    });

    it("preserves the extension and skill list fields", () => {
      // These serialize as bare CSV and are re-parsed by parseExtensionsSpec /
      // the skills field. A generate/parse mismatch here is silent: the ejected
      // agent loads fine but with a different extension or skill scope than the
      // one that was ejected.
      const loaded = roundTrip({
        extensions: ["mcp", "pi-notify"],
        skills: ["planning", "review"],
        disallowedTools: ["write", "edit"],
      });
      expect(loaded.extensions).toEqual(["mcp", "pi-notify"]);
      expect(loaded.skills).toEqual(["planning", "review"]);
      expect(loaded.disallowedTools).toEqual(["write", "edit"]);
    });

    it("preserves the boolean forms of extensions and skills", () => {
      const off = roundTrip({ extensions: false, skills: false });
      expect(off.extensions).toBe(false);
      expect(off.skills).toBe(false);
    });

    it("preserves allowed_subagents in both its list and `all` forms", () => {
      expect(roundTrip({ allowedSubagents: "all" }).allowedSubagents).toBe("all");
      expect(roundTrip({ allowedSubagents: ["Explore", "Plan"] }).allowedSubagents)
        .toEqual(["Explore", "Plan"]);
    });

    // Eject only ever ran on built-in defaults before package agents became
    // ejectable, so these three fields had no way to reach the writer. A package
    // agent can carry all of them, and the ejected copy SHADOWS the package
    // file — so anything dropped here is silently lost from the running agent.
    it("preserves ext: selectors alongside the built-in tool list", () => {
      const loaded = roundTrip({ builtinToolNames: ["read", "grep"], extSelectors: ["ext:mcp/github"] });
      expect(loaded.builtinToolNames).toEqual(["read", "grep"]);
      expect(loaded.extSelectors).toEqual(["ext:mcp/github"]);
    });

    it("preserves ext: selectors when there are no built-ins", () => {
      // Not `none`: zero built-ins with selectors present means "extension tools
      // only", which is a wider grant than none and has to survive the trip.
      const loaded = roundTrip({ builtinToolNames: [], extSelectors: ["ext:mcp/github"] });
      expect(loaded.builtinToolNames).toEqual([]);
      expect(loaded.extSelectors).toEqual(["ext:mcp/github"]);
    });

    it("preserves persist_session in both directions, and session_dir", () => {
      expect(roundTrip({ persistSession: true, sessionDir: "/tmp/sessions" }))
        .toMatchObject({ persistSession: true, sessionDir: "/tmp/sessions" });
      expect(roundTrip({ persistSession: false }).persistSession).toBe(false);
    });

    it("preserves a tool-less agent as none, not as the whole toolbox", () => {
      expect(roundTrip({ builtinToolNames: [] }).builtinToolNames).toEqual([]);
    });

    it("preserves a description containing a colon", () => {
      // Serialized via JSON.stringify precisely so YAML doesn't split on the colon.
      expect(roundTrip({ description: "Scout: find things" }).description).toBe("Scout: find things");
    });
  });
});

describe("package-provided agents", () => {
  let tmpDir: string;
  let pkgDir: string;
  let originalHome: string | undefined;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-test-pkg-"));
    pkgDir = join(tmpDir, "package", "agents");
    mkdirSync(pkgDir, { recursive: true });
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = tmpDir;
    delete process.env.PI_CODING_AGENT_DIR;
  });

  afterEach(() => {
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write an agent into the fake package directory. */
  function writePackageAgent(name: string, content: string): string {
    const path = join(pkgDir, `${name}.md`);
    writeFileSync(path, content);
    return path;
  }

  /** Write an agent into one of the local roots. */
  function writeLocalAgent(where: ".pi" | ".agents", name: string, content: string) {
    const dir = join(tmpDir, where, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), content);
  }

  /** Load with the package tier pinned, bypassing pi's settings. */
  function load(strict = false) {
    return loadCustomAgents(tmpDir, strict, { packageDirs: [pkgDir] });
  }

  it("registers an agent from a package directory", () => {
    writePackageAgent("researcher", "---\nname: researcher\ndescription: From a package\n---\nBody.");
    const agent = load().get("researcher");
    expect(agent?.description).toBe("From a package");
    expect(agent?.source).toBe("package");
    expect(agent?.sourcePath).toBe(join(pkgDir, "researcher.md"));
  });

  it("registers an individually declared package file", () => {
    const path = writePackageAgent("solo", "---\nname: solo\ndescription: One file\n---\nBody.");
    const agents = loadCustomAgents(tmpDir, false, { packageDirs: [], packageFiles: [path] });
    expect(agents.get("solo")?.source).toBe("package");
  });

  it("loses the name to a global agent", () => {
    writePackageAgent("reviewer", "---\nname: reviewer\ndescription: package\n---\nP");
    const globalDir = join(tmpDir, ".pi", "agent", "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "reviewer.md"), "---\nname: reviewer\ndescription: global\n---\nG");

    const agent = load().get("reviewer");
    expect(agent?.description).toBe("global");
    expect(agent?.source).toBe("global");
  });

  it("loses the name to a project agent", () => {
    writePackageAgent("reviewer", "---\nname: reviewer\ndescription: package\n---\nP");
    writeLocalAgent(".pi", "reviewer", "---\nname: reviewer\ndescription: project\n---\nJ");

    const agent = load().get("reviewer");
    expect(agent?.description).toBe("project");
    expect(agent?.source).toBe("project");
  });

  it("loses the name to a workspace agent", () => {
    writePackageAgent("reviewer", "---\nname: reviewer\ndescription: package\n---\nP");
    writeLocalAgent(".agents", "reviewer", "---\nname: reviewer\ndescription: workspace\n---\nW");

    expect(load().get("reviewer")?.description).toBe("workspace");
  });

  it("is disabled by a local stub, which is how /agents turns one off", () => {
    writePackageAgent("reviewer", "---\nname: reviewer\ndescription: package\n---\nP");
    writeLocalAgent(".pi", "reviewer", "---\nenabled: false\n---\n");

    const agent = load().get("reviewer");
    expect(agent?.enabled).toBe(false);
    expect(agent?.source).toBe("project");
  });

  it("keeps a package agent the local roots do not claim", () => {
    writePackageAgent("pkg-only", "---\nname: pkg-only\ndescription: package\n---\nP");
    writeLocalAgent(".pi", "other", "---\nname: other\ndescription: project\n---\nJ");

    const agents = load();
    expect(agents.get("pkg-only")?.source).toBe("package");
    expect(agents.get("other")?.source).toBe("project");
  });

  it("skips a package agent file larger than the 1 MB ceiling", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = "x".repeat(MAX_PACKAGE_RESOURCE_BYTES + 1);
      writePackageAgent("huge", `---\nname: huge\ndescription: big\n---\n${body}`);
      expect(load().has("huge")).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipping package agent"));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not apply the size ceiling to the user's own agent files", () => {
    // The ceiling exists because package files are third-party content read on
    // every spawn. A local file is the user's own and stays unbounded.
    const dir = join(tmpDir, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    const body = "x".repeat(MAX_PACKAGE_RESOURCE_BYTES + 1);
    writeFileSync(join(dir, "huge.md"), `---\nname: huge\ndescription: big\n---\n${body}`);
    expect(load().get("huge")?.source).toBe("project");
  });

  it("loads later package directories over earlier ones on a name clash", () => {
    const second = join(tmpDir, "package-two", "agents");
    mkdirSync(second, { recursive: true });
    writePackageAgent("shared", "---\nname: shared\ndescription: first\n---\nA");
    writeFileSync(join(second, "shared.md"), "---\nname: shared\ndescription: second\n---\nB");

    const agents = loadCustomAgents(tmpDir, false, { packageDirs: [pkgDir, second] });
    expect(agents.get("shared")?.description).toBe("second");
  });

  it("does not let strictAgentFiles abort a load over a third-party package file", () => {
    // Strict mode exists so a checked-in `.pi/agents/` fails loudly rather than
    // falling through to a same-named agent elsewhere. A file inside an
    // installed package is not the user's to fix, and throwing here would stop
    // pi from starting at all over someone else's broken `.md`.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writePackageAgent("broken", "---\nname: [unclosed\n---\nBody.");
      writePackageAgent("fine", "---\nname: fine\ndescription: ok\n---\nBody.");
      expect(() => load(true)).not.toThrow();
      expect(load(true).has("fine")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("still lets strictAgentFiles abort over a local file", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeLocalAgent(".pi", "broken", "---\nname: [unclosed\n---\nBody.");
      expect(() => load(true)).toThrow(/broken\.md/);
    } finally {
      warn.mockRestore();
    }
  });

  it("skips a package file a ! manifest entry excluded", () => {
    const path = writePackageAgent("wip", "---\nname: wip\ndescription: unfinished\n---\nB");
    writePackageAgent("shipped", "---\nname: shipped\ndescription: ready\n---\nB");
    const excluded = new Set([realpathSync(path)]);
    const agents = loadCustomAgents(tmpDir, false, {
      packageDirs: [pkgDir],
      packageExcluded: p => excluded.has(realpathSync(p)),
    });
    expect(agents.has("shipped")).toBe(true);
    expect(agents.has("wip")).toBe(false);
  });

  it("skips an unparseable package file without taking the load down", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writePackageAgent("broken", "---\nname: [unclosed\n---\nBody.");
      writePackageAgent("fine", "---\nname: fine\ndescription: ok\n---\nBody.");
      expect(load().has("fine")).toBe(true);
      expect(load().has("broken")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
