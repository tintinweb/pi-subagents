import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnBudget, getGraceTurns, resumeAgent, setGraceTurns } from "../src/agent-runner.js";
import type { TurnBudgetController } from "../src/types.js";

function session() {
  return {
    steer: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  } as unknown as AgentSession;
}

function turn() {
  return { type: "turn_end" } as AgentSessionEvent;
}

describe("extendable turn budget", () => {
  let previousGrace: number;

  beforeEach(() => {
    previousGrace = getGraceTurns();
  });

  afterEach(() => {
    setGraceTurns(previousGrace);
  });

  it("adds to the existing ceiling without resetting spent turns", () => {
    const child = session();
    const budget = createTurnBudget(child, 5);
    budget.onEvent(turn());
    budget.onEvent(turn());

    expect(budget.controller.extend(3)).toEqual({
      extended: true,
      turnCount: 2,
      previousMaxTurns: 5,
      maxTurns: 8,
      resumedFromSoftLimit: false,
    });

    for (let i = 0; i < 5; i++) budget.onEvent(turn());
    expect(child.steer).not.toHaveBeenCalled();
    budget.onEvent(turn());
    expect(child.steer).toHaveBeenCalledOnce();
    expect(budget.controller.snapshot()).toEqual({
      turnCount: 8,
      maxTurns: 8,
      softLimitReached: true,
    });
  });

  it("clears an active wrap-up latch and moves the hard-abort boundary", () => {
    setGraceTurns(2);
    const child = session();
    const budget = createTurnBudget(child, 5);
    for (let i = 0; i < 5; i++) budget.onEvent(turn());
    expect(child.steer).toHaveBeenCalledOnce();

    expect(budget.controller.extend(5)).toEqual(expect.objectContaining({
      previousMaxTurns: 5,
      maxTurns: 10,
      turnCount: 5,
      resumedFromSoftLimit: true,
    }));
    for (let i = 0; i < 4; i++) budget.onEvent(turn());
    expect(child.abort).not.toHaveBeenCalled();
    expect(child.steer).toHaveBeenCalledOnce();

    budget.onEvent(turn());
    expect(child.steer).toHaveBeenCalledTimes(2);
    budget.onEvent(turn());
    expect(child.abort).not.toHaveBeenCalled();
    budget.onEvent(turn());
    expect(child.abort).toHaveBeenCalledOnce();
  });

  it("reports unlimited runs as a no-op", () => {
    const budget = createTurnBudget(session(), undefined);
    expect(budget.controller.extend(20)).toEqual({
      extended: false,
      reason: "unlimited",
      turnCount: 0,
    });
  });

  it("rejects invalid extension sizes", () => {
    const budget = createTurnBudget(session(), 5);
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => budget.controller.extend(value)).toThrow(/positive integer/);
    }
  });

  it("enforces and extends the ceiling on resumed runs too", async () => {
    const listeners: Array<(event: AgentSessionEvent) => void> = [];
    let controller: TurnBudgetController | undefined;
    const child = {
      messages: [] as any[],
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
        listeners.push(listener);
        return () => {};
      }),
      prompt: vi.fn(async () => {
        for (let i = 0; i < 3; i++) for (const listener of listeners) listener(turn());
        expect(controller?.extend(3)).toEqual(expect.objectContaining({
          previousMaxTurns: 3,
          maxTurns: 6,
          resumedFromSoftLimit: true,
        }));
        for (let i = 0; i < 3; i++) for (const listener of listeners) listener(turn());
        child.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        });
      }),
    } as unknown as AgentSession;

    const result = await resumeAgent(child, "continue", {
      maxTurns: 3,
      onTurnBudgetCreated: (created) => { controller = created; },
    });

    expect(child.steer).toHaveBeenCalledTimes(2);
    expect(child.abort).not.toHaveBeenCalled();
    expect(result).toMatchObject({ text: "done", aborted: false, steered: true });
  });
});
