import { describe, expect, it } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import { type AgentActivity, AgentWidget, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  function makeRecord(id: string, runInBackground?: boolean) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { runInBackground },
    };
  }

  it("does not render foreground agents in the persistent widget", () => {
    const manager = { listAgents: () => [makeRecord("foreground", false)] };
    const widget = new AgentWidget(manager as any, new Map([["foreground", makeActivity()]]));
    const calls: Array<{ key: string; content: unknown }> = [];

    widget.setUICtx({
      setStatus: () => {},
      setWidget: (key, content) => calls.push({ key, content }),
    });

    widget.update();

    expect(calls).toEqual([]);
  });

  it("renders background agents in the persistent widget", () => {
    const manager = { listAgents: () => [makeRecord("background", true)] };
    const widget = new AgentWidget(manager as any, new Map([["background", makeActivity()]]));
    let factory: any;

    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });

    widget.update();

    const component = factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme);
    const lines = component.render().join("\n");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });
});
