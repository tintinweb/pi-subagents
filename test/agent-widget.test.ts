import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { type AgentActivity, AgentWidget, formatSessionTokens, type Theme, type UICtx } from "../src/ui/agent-widget.js";

const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("formatSessionTokens", () => {
  const plainTheme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70-85 warning, >=85 error)", () => {
    expect(formatSessionTokens(1234, null, plainTheme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, plainTheme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, plainTheme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, plainTheme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, plainTheme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, plainTheme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    expect(formatSessionTokens(1234, null, plainTheme, 1)).toBe("1.2k token (<dim>↻1</dim>)");
    expect(formatSessionTokens(1234, null, plainTheme, 3)).toBe("1.2k token (<dim>↻3</dim>)");
    expect(formatSessionTokens(1234, 45, plainTheme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>↻2</dim>)");
    expect(formatSessionTokens(1234, 88, plainTheme, 4)).toBe("1.2k token (<error>88%</error> · <dim>↻4</dim>)");
    expect(formatSessionTokens(1234, 45, plainTheme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});

describe("AgentWidget", () => {
  it("shows running model and thinking level in status text and widget line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:05Z"));

    const agent: AgentRecord = {
      id: "agent-1",
      type: "general-purpose",
      description: "Investigate bug",
      status: "running",
      modelName: "haiku",
      thinkingLevel: "high",
      toolUses: 1,
      startedAt: Date.parse("2026-04-13T12:00:00Z"),
    };

    const activity = new Map<string, AgentActivity>([
      ["agent-1", {
        activeTools: new Map(),
        toolUses: 1,
        responseText: "Tracing the root cause",
        turnCount: 2,
        maxTurns: 10,
      }],
    ]);

    let statusText: string | undefined;
    let widgetFactory: ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void }) | undefined;

    const uiCtx: UICtx = {
      setStatus: (_key: string, text: string | undefined) => {
        statusText = text;
      },
      setWidget: (_key: string, content: any) => {
        widgetFactory = content;
      },
    };

    const manager = {
      listAgents: () => [agent],
    } as any;

    const widget = new AgentWidget(manager, activity);
    widget.setUICtx(uiCtx);
    widget.setDisplayMode("tree");
    widget.update();

    expect(statusText).toBe("1 running agent · haiku:high");

    expect(widgetFactory).toBeDefined();
    const rendered = widgetFactory!({ terminal: { columns: 200 } }, theme).render(200);
    // In tree mode, the running agent line contains model:thinking in the stats
    const runningLine = rendered.find((l: string) => l.includes("Investigate bug"));
    expect(runningLine).toContain("haiku:high");

    vi.useRealTimers();
  });
});
