import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  vcs: "git",
  platform: "darwin",
};

const envNoGit: EnvInfo = {
  isGitRepo: false,
  branch: "",
  platform: "linux",
};

const envJj: EnvInfo = {
  isGitRepo: false,
  branch: "",
  vcs: "jj",
  change: "abc12345 agent work",
  platform: "linux",
};

// Initialize default agents
beforeEach(() => {
  registerAgents(new Map());
});

function getDefaultConfig(name: string): AgentConfig {
  return getAgentConfig(name)!;
}

describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles directories without version control", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("Not a version-controlled repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("includes jj working-copy information", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", envJj);
    expect(prompt).toContain("Jujutsu repository: yes");
    expect(prompt).toContain("Working copy: abc12345 agent work");
    expect(prompt).not.toContain("Not a version-controlled repository");
  });

  it("Explore prompt is read-only", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("file search specialist");
  });

  it("Plan prompt is read-only", () => {
    const config = getDefaultConfig("Plan");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("software architect");
  });

  it("general-purpose uses append mode (parent twin)", () => {
    const config = getDefaultConfig("general-purpose");
    const parentPrompt = "You are a parent coding agent with full powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent with full powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("READ-ONLY");
    // Empty systemPrompt means no <agent_instructions> section
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("general-purpose without parent prompt falls back to generic base", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).not.toContain("READ-ONLY");
  });

  it("append mode with parent prompt includes parent + custom instructions", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent with special powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("parent coding agent with special powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode without parent prompt falls back to generic base", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode with empty systemPrompt is a pure parent clone", () => {
    const config: AgentConfig = {
      name: "clone",
      description: "Clone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const parentPrompt = "You are a parent coding agent.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("replace mode uses config systemPrompt directly", () => {
    const config: AgentConfig = {
      name: "custom",
      description: "Custom",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a specialized agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("You are a pi coding agent sub-agent");
  });

  it("replace mode ignores parent prompt", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a standalone agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, "SECRET parent prompt content");
    expect(prompt).toContain("You are a standalone agent.");
    expect(prompt).not.toContain("SECRET parent prompt content");
    expect(prompt).not.toContain("<sub_agent_context>");
  });

  it("append mode bridge contains tool reminders", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("Use the edit tool instead of sed");
    expect(prompt).toContain("Use the grep tool instead of");
  });

  it("append mode without parent prompt still has bridge", () => {
    const config: AgentConfig = {
      name: "no-parent",
      description: "No parent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra stuff.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("<inherited_system_prompt>");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra stuff.");
  });

  it("injects memory block in replace mode", () => {
    const config: AgentConfig = {
      name: "mem-agent",
      description: "Memory Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a memory agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = { memoryBlock: "# Agent Memory\nYou have persistent memory at /tmp/mem/" };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("You are a memory agent.");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("persistent memory");
  });

  it("injects memory block in append mode", () => {
    const config: AgentConfig = {
      name: "mem-append",
      description: "Memory Append",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Custom instructions.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = { memoryBlock: "# Agent Memory\nPersistent memory here." };
    const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.", extras);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("Custom instructions.");
  });

  it("injects preloaded skill blocks", () => {
    const config: AgentConfig = {
      name: "skill-agent",
      description: "Skill Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a skill agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });

  it("injects both memory and skills", () => {
    const config: AgentConfig = {
      name: "full-agent",
      description: "Full Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Full agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      memoryBlock: "# Memory\nRemember this.",
      skillBlocks: [{ name: "skill1", content: "Skill content." }],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("Preloaded Skill: skill1");
  });

  it("no extras means no extra sections", () => {
    const config: AgentConfig = {
      name: "plain",
      description: "Plain",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Plain agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });

  describe("active_agent tag", () => {
    it("tag is present at start of prompt in replace mode", () => {
      const config: AgentConfig = {
        name: "my-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "You are a test agent.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toMatch(/^<active_agent name="my-agent"\/>/);
    });

    it("tag follows the cacheable inherited prefix in append mode", () => {
      const config: AgentConfig = {
        name: "my-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Custom instructions.",
        promptMode: "append",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env, "Parent prompt.");
      // Parent prompt must form the verbatim, cacheable byte prefix.
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      // The varying tag follows the static <sub_agent_context> bridge.
      const ctxIdx = prompt.indexOf("<sub_agent_context>");
      const tagIdx = prompt.indexOf('<active_agent name="my-agent"/>');
      expect(ctxIdx).toBeGreaterThan(-1);
      expect(tagIdx).toBeGreaterThan(ctxIdx);
    });

    it("tag uses agent name verbatim", () => {
      const config: AgentConfig = {
        name: "Some Agent With Spaces",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Test.",
        promptMode: "replace",
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
      const prompt = buildAgentPrompt(config, "/workspace", env);
      expect(prompt).toContain('<active_agent name="Some Agent With Spaces"/>');
    });

    it("tag appears before the env block in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const config: AgentConfig = {
          name: "test-agent",
          description: "Test",
          builtinToolNames: [],
          extensions: true,
          skills: true,
          systemPrompt: "Test.",
          promptMode,
          inheritContext: false,
          runInBackground: false,
          isolated: false,
        };
        const prompt = buildAgentPrompt(config, "/workspace", env, "Parent.");
        const tagIndex = prompt.indexOf('<active_agent name="test-agent"/>');
        const envIndex = prompt.indexOf("# Environment");
        expect(tagIndex).toBeLessThan(envIndex);
      }
    });
  });

  // #187: the inherited parent prompt names the main checkout as cwd, so a
  // worktree agent needs to be told which of the two paths is really its own.
  describe("worktree isolation block", () => {
    function worktreeConfig(promptMode: "append" | "replace"): AgentConfig {
      return {
        name: "test-agent",
        description: "Test",
        builtinToolNames: [],
        extensions: true,
        skills: true,
        systemPrompt: "Custom instructions.",
        promptMode,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      };
    }

    it("is absent without a worktree base", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(worktreeConfig(promptMode), "/wt/copy", env, "Parent.", {});
        expect(prompt).not.toContain("<worktree_isolation>");
      }
    });

    it("describes a Git worktree and follows the env block in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(worktreeConfig(promptMode), "/wt/copy", env, "Parent.", {
          worktreeBase: "/repo",
          worktreeBackend: "git",
        });
        expect(prompt).toContain("isolated Git worktree copy of /repo");
        expect(prompt).toContain("never in /repo, even if other instructions name that path");
        expect(prompt).not.toContain("Git commands do not work");
        expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("Working directory: /wt/copy"));
      }
    });

    it("describes a Jujutsu workspace and rejects Git commands in both modes", () => {
      for (const promptMode of ["replace", "append"] as const) {
        const prompt = buildAgentPrompt(worktreeConfig(promptMode), "/wt/copy", envJj, "Parent.", {
          worktreeBase: "/repo",
          worktreeBackend: "jj",
        });
        expect(prompt).toContain("isolated Jujutsu workspace created from /repo");
        expect(prompt).toContain("Use jj for version-control operations");
        expect(prompt).toContain("Git commands do not work inside this workspace");
        expect(prompt).toContain("shares its repository and operation log with the main checkout");
        expect(prompt).toContain("do not rewrite or abandon changes outside this workspace's own work");
      }
    });

    it("stays out of the cacheable inherited prefix", () => {
      const prompt = buildAgentPrompt(worktreeConfig("append"), "/wt/copy", env, "Parent prompt.", {
        worktreeBase: "/repo",
        worktreeBackend: "git",
      });
      expect(prompt.startsWith("Parent prompt.")).toBe(true);
      expect(prompt.indexOf("<worktree_isolation>")).toBeGreaterThan(prompt.indexOf("<sub_agent_context>"));
    });
  });
});
