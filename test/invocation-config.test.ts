import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params for locked fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
        isolation: "worktree",
        sessionFile: ".agents/sessions/config.jsonl",
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        max_turns: 1,
        inherit_context: true,
        run_in_background: true,
        isolated: true,
        isolation: "worktree",
        session_file: ".agents/sessions/params.jsonl",
      },
    );

    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.thinking).toBe("high");
    expect(resolved.maxTurns).toBe(42);
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
    expect(resolved.isolation).toBe("worktree");
    expect(resolved.sessionFile).toBe(".agents/sessions/config.jsonl");
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      inherit_context: true,
      run_in_background: true,
      isolated: true,
      isolation: "worktree",
      session_file: ".agents/sessions/params.jsonl",
    });

    expect(resolved.modelInput).toBe("provider/param-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("minimal");
    expect(resolved.maxTurns).toBe(3);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
    expect(resolved.isolation).toBe("worktree");
    expect(resolved.sessionFile).toBe(".agents/sessions/params.jsonl");
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {
        inherit_context: true,
        run_in_background: true,
        isolated: true,
      },
    );

    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
  });

  // "off" exists so a model that cannot bring itself to omit an optional field
  // has a legal way to say no (#231). It is an input spelling only — the
  // resolver collapses it to undefined so no consumer downstream grows a branch.
  it('collapses a param isolation of "off" to undefined', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "off" });
    expect(resolved.isolation).toBeUndefined();
  });

  // Agent config outranks tool-call params, so "off" in frontmatter is the only
  // way to veto a caller's worktree — before #231 no value could do this.
  it('lets a config isolation of "off" veto a param "worktree"', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "off" }), { isolation: "worktree" });
    expect(resolved.isolation).toBeUndefined();
  });

  it('still honours a param "worktree" when the config leaves isolation unset', () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: undefined }), { isolation: "worktree" });
    expect(resolved.isolation).toBe("worktree");
  });

  it("drops worktree isolation when the project disallows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), { isolation: "worktree" }, { worktreeAllowed: false });
    expect(resolved.isolation).toBeUndefined();
  });

  it("keeps worktree isolation when the project allows it", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig({ isolation: "worktree" }), {}, { worktreeAllowed: true });
    expect(resolved.isolation).toBe("worktree");
  });
});

describe("resolveJoinMode", () => {
  it("returns the global default for background agents", () => {
    expect(resolveJoinMode("smart", true)).toBe("smart");
    expect(resolveJoinMode("async", true)).toBe("async");
  });

  it("ignores join mode for foreground agents", () => {
    expect(resolveJoinMode("smart", false)).toBeUndefined();
    expect(resolveJoinMode("group", false)).toBeUndefined();
  });
});

describe("resolveAgentInvocationConfig — overridden params (#182)", () => {
  it("records the caller's values when the agent file outranks them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model", thinking: "low" }),
      { model: "provider/param-model", thinking: "max" },
    );

    expect(resolved.overridden).toEqual({ thinking: "max", model: "provider/param-model" });
  });

  it("records nothing when the caller got what they asked for", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ model: "provider/same", thinking: "high" }),
      { model: "provider/same", thinking: "high" },
    );

    expect(resolved.overridden).toBeUndefined();
  });

  it("records nothing when only one side named a value", () => {
    // Config-only is the agent's own default, not an override; param-only won
    // outright. Neither is a request that went unhonored.
    expect(resolveAgentInvocationConfig(
      makeConfig({ model: "provider/config-model", thinking: "low" }),
      {},
    ).overridden).toBeUndefined();

    expect(resolveAgentInvocationConfig(
      makeConfig(),
      { model: "provider/param-model", thinking: "max" },
    ).overridden).toBeUndefined();
  });

  it("records each field independently", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ thinking: "low" }),
      { model: "provider/param-model", thinking: "max" },
    );

    expect(resolved.overridden).toEqual({ thinking: "max", model: undefined });
  });
});
