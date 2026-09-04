import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  AGENT_VIEWS,
  buildInfoLines,
  formatWallClock,
  VIEW_LABELS,
  ViewPicker,
  viewFromKey,
} from "../src/ui/agent-views.js";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function mockTui() {
  return { terminal: { rows: 20, columns: 80 }, requestRender: vi.fn() } as any;
}

describe("viewFromKey", () => {
  it("maps s/p/i/o and nothing else", () => {
    expect(viewFromKey("s")).toBe("session");
    expect(viewFromKey("p")).toBe("prompt");
    expect(viewFromKey("i")).toBe("info");
    expect(viewFromKey("o")).toBe("output");
    expect(viewFromKey("m")).toBeUndefined();
    expect(viewFromKey("x")).toBeUndefined();
    expect(viewFromKey("\r")).toBeUndefined();
  });
});

describe("ViewPicker", () => {
  it("lists Session, Prompt, Info, Output in that order", () => {
    const picker = new ViewPicker(mockTui(), theme, undefined, vi.fn());
    const body = picker.render(40).join("\n");
    expect(AGENT_VIEWS.map(v => VIEW_LABELS[v]).every(label => body.includes(label))).toBe(true);
    const sessionAt = body.indexOf("Session");
    const promptAt = body.indexOf("Prompt");
    const infoAt = body.indexOf("Info");
    const outputAt = body.indexOf("Output");
    expect(sessionAt).toBeLessThan(promptAt);
    expect(promptAt).toBeLessThan(infoAt);
    expect(infoAt).toBeLessThan(outputAt);
  });

  it("Enter selects the highlighted view, s/p/i/o select immediately, Esc cancels", () => {
    const done = vi.fn();
    const picker = new ViewPicker(mockTui(), theme, undefined, done);
    picker.handleInput("\x1b[B"); // down → Prompt
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledWith("prompt");

    done.mockReset();
    const picker2 = new ViewPicker(mockTui(), theme, undefined, done);
    picker2.handleInput("i");
    expect(done).toHaveBeenCalledWith("info");

    done.mockReset();
    const picker3 = new ViewPicker(mockTui(), theme, undefined, done);
    picker3.handleInput("\x1b");
    expect(done).toHaveBeenCalledWith(undefined);
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
