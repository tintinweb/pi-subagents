import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  AGENT_VIEWS,
  buildInfoLines,
  formatWallClock,
  RunningAgentPicker,
  VIEW_LABELS,
  ViewPicker,
  viewFromKey,
} from "../src/ui/agent-views.js";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function mockTui() {
  return { terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() } as any;
}

describe("viewFromKey", () => {
  it("maps t/i/p/o and nothing else", () => {
    expect(viewFromKey("t")).toBe("transcript");
    expect(viewFromKey("i")).toBe("info");
    expect(viewFromKey("p")).toBe("prompt");
    expect(viewFromKey("o")).toBe("output");
    expect(viewFromKey("s")).toBeUndefined();
    expect(viewFromKey("m")).toBeUndefined();
    expect(viewFromKey("x")).toBeUndefined();
    expect(viewFromKey("\r")).toBeUndefined();
  });
});

describe("ViewPicker", () => {
  it("lists Transcript, Info, Prompt, Output in that order", () => {
    const picker = new ViewPicker(mockTui(), theme, undefined, vi.fn());
    const body = picker.render(40).join("\n");
    expect(AGENT_VIEWS.map(v => VIEW_LABELS[v]).every(label => body.includes(label))).toBe(true);
    const transcriptAt = body.indexOf("Transcript");
    const infoAt = body.indexOf("Info");
    const promptAt = body.indexOf("Prompt");
    const outputAt = body.indexOf("Output");
    expect(transcriptAt).toBeLessThan(infoAt);
    expect(infoAt).toBeLessThan(promptAt);
    expect(promptAt).toBeLessThan(outputAt);
  });

  it("Enter selects the highlighted view, t/i/p/o select immediately, Esc cancels", () => {
    const done = vi.fn();
    const picker = new ViewPicker(mockTui(), theme, undefined, done);
    picker.handleInput("\x1b[B"); // down → Info
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith("info");

    done.mockReset();
    const picker2 = new ViewPicker(mockTui(), theme, undefined, done);
    picker2.handleInput("p");
    expect(done).toHaveBeenCalledWith("prompt");

    done.mockReset();
    const picker3 = new ViewPicker(mockTui(), theme, undefined, done);
    picker3.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
  });
});

describe("RunningAgentPicker", () => {
  function agent(over: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: "a1",
      type: "general-purpose",
      description: "do the thing",
      status: "running",
      toolUses: 2,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      ...over,
    } as AgentRecord;
  }

  it("shows t/i/p/o in the footer", () => {
    const picker = new RunningAgentPicker(mockTui(), theme, undefined, [agent()], vi.fn());
    expect(picker.render(80).join("\n")).toContain("t/i/p/o");
  });

  it("Enter returns the highlighted agent without a view", () => {
    const done = vi.fn();
    const a = agent();
    const picker = new RunningAgentPicker(mockTui(), theme, undefined, [a], done);
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith({ record: a });
  });

  it("t/i/p/o return the highlighted agent and that view", () => {
    const done = vi.fn();
    const a = agent({ id: "live" });
    const picker = new RunningAgentPicker(mockTui(), theme, undefined, [a], done);
    picker.handleInput("p");
    expect(done).toHaveBeenCalledWith({ record: a, view: "prompt" });
  });

  it("arrows move the highlight before t/i/p/o", () => {
    const done = vi.fn();
    const a1 = agent({ id: "one", description: "first" });
    const a2 = agent({ id: "two", description: "second" });
    const picker = new RunningAgentPicker(mockTui(), theme, undefined, [a1, a2], done);
    picker.handleInput("\x1b[B");
    picker.handleInput("t");
    expect(done).toHaveBeenCalledWith({ record: a2, view: "transcript" });
  });
});

describe("buildInfoLines", () => {
  const started = Date.UTC(2026, 3, 4, 12, 0, 0);
  const record = {
    id: "a1",
    type: "general-purpose",
    description: "x",
    status: "completed",
    toolUses: 4,
    startedAt: started,
    completedAt: started + 5_000,
    lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
    compactionCount: 0,
    invocation: {
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      isolated: true,
    },
  } as AgentRecord;

  it("includes model, thinking, cost, tools, elapsed, wall clock, and flags", () => {
    const lines = buildInfoLines(record, true).join("\n");
    expect(lines).toContain("Status:    completed");
    expect(lines).toContain("Model:     anthropic/claude-sonnet-4-6");
    expect(lines).toContain("Thinking:  high");
    expect(lines).toContain("Cost:      ~$0.0042");
    expect(lines).toContain("Tools:     4");
    expect(lines).toContain("Elapsed:");
    expect(lines).toContain(`Started:   ${formatWallClock(started)}`);
    expect(lines).toContain(`Ended:     ${formatWallClock(started + 5_000)}`);
    expect(lines).toContain("isolated");
    expect(lines).not.toMatch(/Turns:/);
    expect(lines).not.toContain("↻");
  });

  it("omits cost when showCost is off, and says running when there is no end", () => {
    const lines = buildInfoLines({ ...record, completedAt: undefined, status: "running" }, false).join("\n");
    expect(lines).not.toContain("Cost:");
    expect(lines).toContain("Ended:     running");
  });
});
