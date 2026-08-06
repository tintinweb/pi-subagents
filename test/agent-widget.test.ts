import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import {
  type AgentActivity,
  AgentWidget,
  fgPreservingNestedStyles,
  formatGitSummary,
  formatSessionTokens,
} from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

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

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
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

  function makeRecord(id: string, opts: {
    isBackground?: boolean;
    parentAgentId?: string;
    status?: "running" | "queued" | "completed";
    cwd?: string;
    completedAt?: number;
  } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: opts.status ?? "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground,
      parentAgentId: opts.parentAgentId,
      cwd: opts.cwd,
      completedAt: opts.completedAt,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("hides nested children in every coordinator widget mode", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "parent" })],
    };
    expect(renderLines(manager, "nested", () => "all")).toBe("");
    expect(renderLines(manager, "nested", () => "background")).toBe("");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });

  it("renders a debounced Git summary in the running card", async () => {
    vi.useFakeTimers();
    try {
      const record = makeRecord("live", { cwd: "/repo" });
      const exec = vi.fn()
        .mockResolvedValueOnce({ code: 0, stdout: "82\t16\tsrc/file.ts\n" })
        .mockResolvedValueOnce({ code: 0, stdout: "" });
      const manager = {
        listAgents: () => [record],
        getRecord: (id: string) => id === record.id ? record : undefined,
      };
      const widget = new AgentWidget(
        manager as any,
        new Map([[record.id, makeActivity()]]),
        () => "all",
        { exec } as unknown as Pick<ExtensionAPI, "exec">,
      );
      let factory: any;
      widget.setUICtx({
        setStatus: () => {},
        setWidget: (_key, content) => { factory = content; },
      });
      widget.update();
      await vi.runAllTimersAsync();

      const lines = factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
        .render()
        .join("\n");
      expect(lines).toContain("1 file · +82 −16");
      expect(exec).toHaveBeenNthCalledWith(
        1,
        "git",
        ["diff", "--numstat", "HEAD", "--"],
        expect.objectContaining({ cwd: "/repo" }),
      );
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits a cached Git summary after the current refresh fails", async () => {
    vi.useFakeTimers();
    try {
      const record = makeRecord("live", { cwd: "/repo" });
      const exec = vi.fn()
        .mockResolvedValueOnce({ code: 0, stdout: "82\t16\tsrc/file.ts\n" })
        .mockResolvedValueOnce({ code: 0, stdout: "" })
        .mockResolvedValueOnce({ code: 128, stdout: "" });
      const manager = {
        listAgents: () => [record],
        getRecord: (id: string) => id === record.id ? record : undefined,
      };
      const widget = new AgentWidget(
        manager as any,
        new Map([[record.id, makeActivity()]]),
        () => "all",
        { exec } as unknown as Pick<ExtensionAPI, "exec">,
      );
      let factory: any;
      widget.setUICtx({
        setStatus: () => {},
        setWidget: (_key, content) => { factory = content; },
      });
      widget.update();
      await vi.runAllTimersAsync();
      widget.onActivity(record.id);
      await vi.runAllTimersAsync();

      const lines = factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
        .render()
        .join("\n");
      expect(lines).not.toContain("1 file · +82 −16");
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels untracked files instead of including them in line totals", () => {
    expect(formatGitSummary({ trackedFiles: 2, additions: 82, deletions: 16, untrackedFiles: 1 }))
      .toBe("2 files · +82 −16 · 1 untracked");
  });

  it("does not query queued, completed, or no-cwd records", async () => {
    vi.useFakeTimers();
    try {
      const records = [
        makeRecord("queued", { status: "queued", cwd: "/repo" }),
        makeRecord("completed", { status: "completed", cwd: "/repo", completedAt: Date.now() }),
        makeRecord("no-cwd"),
      ];
      const exec = vi.fn();
      const manager = {
        listAgents: () => records,
        getRecord: (id: string) => records.find(record => record.id === id),
      };
      const widget = new AgentWidget(
        manager as any,
        new Map(records.map(record => [record.id, makeActivity()])),
        () => "all",
        { exec } as unknown as Pick<ExtensionAPI, "exec">,
      );
      widget.setUICtx({
        setStatus: () => {},
        setWidget: (_key, content) => {
          if (content) content({ terminal: { columns: 120 }, requestRender: () => {} }, theme);
        },
      });
      widget.update();
      await vi.runAllTimersAsync();
      expect(exec).not.toHaveBeenCalled();
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
