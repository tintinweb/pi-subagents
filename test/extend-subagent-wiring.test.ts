import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    sessionManager: { getSessionFile: vi.fn(() => undefined) },
  } as any;
}

async function spawnBackground(tools: Map<string, any>): Promise<string> {
  const result = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "extend wiring agent", subagent_type: "worker", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  const text = textOf(result);
  expect(text).toContain("Agent ID:");
  return /Agent ID: (\S+)/.exec(text)![1];
}

describe("extend_subagent", () => {
  it("changes the real controller, steers the child, and emits the new ceiling", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const extend = vi.fn(() => ({
      extended: true as const,
      turnCount: 20,
      previousMaxTurns: 30,
      maxTurns: 60,
      resumedFromSoftLimit: true,
    }));
    const session = fakeSession();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onTurnBudgetCreated?.({ snapshot: vi.fn(), extend });
      options.onSessionCreated?.(session);
      return new Promise(() => {});
    });

    const id = await spawnBackground(tools);
    await flush();
    const result = await tools.get("extend_subagent").execute(
      "tc-extend",
      { agent_id: id, additional_turns: 30, reason: "implementation is converging" },
      undefined,
      undefined,
      ctx(),
    );

    expect(extend).toHaveBeenCalledWith(30);
    expect(textOf(result)).toContain("30 → 60");
    expect(textOf(result)).toContain("previous wrap-up latch was cleared");
    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("Turn budget extended by 30 turns"));
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:turn_budget_extended", expect.objectContaining({
      id,
      additionalTurns: 30,
      previousMaxTurns: 30,
      maxTurns: 60,
      turnCount: 20,
      reason: "implementation is converging",
    }));

    await lifecycle.get("session_shutdown")?.();
  });

  it("reports an unlimited run without steering it", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const session = fakeSession();
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options) => {
      options.onTurnBudgetCreated?.({
        snapshot: vi.fn(),
        extend: vi.fn(() => ({ extended: false as const, reason: "unlimited" as const, turnCount: 4 })),
      });
      options.onSessionCreated?.(session);
      return new Promise(() => {});
    });

    const id = await spawnBackground(tools);
    await flush();
    const result = await tools.get("extend_subagent").execute(
      "tc-extend",
      { agent_id: id, additional_turns: 10 },
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(result)).toContain("already has an unlimited turn budget");
    expect(session.steer).not.toHaveBeenCalled();
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:turn_budget_extended", expect.anything());

    await lifecycle.get("session_shutdown")?.();
  });
});
