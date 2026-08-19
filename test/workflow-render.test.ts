import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ASCII_GLYPHS,
  agentStatSegments,
  layoutWorkflowCard,
  plainWorkflowCardLines,
  renderWorkflowCard,
  styleWorkflowCardLines,
  type WorkflowCardInput,
  type WorkflowCardTask,
} from "../src/ui/workflow-card.js";
import type { WorkflowMeta } from "../src/workflow/meta.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";

const START = 1_000_000;

/** A theme that makes every colour and bold span visible in the assertion. */
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
};

function agentEntry(partial: Partial<WorkflowAgentEntry> & { index: number }): WorkflowAgentEntry {
  return {
    type: "workflow_agent",
    label: `agent-${partial.index}`,
    phaseIndex: 0,
    state: "start",
    ...partial,
  };
}

function card(over: Partial<WorkflowCardInput> & { progress: readonly WorkflowEntry[] }): string[] {
  const task: WorkflowCardTask = {
    status: "running",
    workflowName: "review-changes",
    startTime: START,
    ...over.task,
  };
  return plainWorkflowCardLines(
    layoutWorkflowCard({ width: 120, now: START + 1000, ...over, task }),
  );
}

/** The tree rows only, with the leading indent removed so assertions read short. */
const treeRows = (lines: string[]) => lines.filter(l => /[╭╰├└,`|]/.test(l)).map(l => l.slice(2));

describe("inline glyph mapping", () => {
  const progress: WorkflowEntry[] = [
    agentEntry({ index: 0, label: "done", state: "done" }),
    agentEntry({ index: 1, label: "failed", state: "error" }),
    agentEntry({ index: 2, label: "started", state: "start" }),
    agentEntry({ index: 3, label: "progressing", state: "progress" }),
  ];

  it("keys off the raw entry state, not the display state", () => {
    const rows = treeRows(card({ progress })).slice(1);
    expect(rows[0]).toContain("✔ done");
    expect(rows[1]).toContain("✘ failed");
    expect(rows[2]).toContain("⟳ started");
    expect(rows[3]).toContain("⟳ progressing");
  });

  it("does not use the /workflows dialog's queued glyph for a queued agent", () => {
    const lines = card({
      progress: [agentEntry({ index: 0, label: "waiting", state: "start", queuedAt: START })],
    });
    expect(lines.join("\n")).not.toContain("◌");
    expect(treeRows(lines)[1]).toContain("⟳ waiting");
  });

  it("says a replayed agent came from the resume journal", () => {
    const lines = card({
      progress: [
        agentEntry({ index: 0, label: "audit", state: "done", cached: true, agentType: "general-purpose" }),
      ],
    });

    const row = treeRows(lines)[1];
    // Ahead of the stat tail, so the row reads "why" before "how much".
    expect(row).toContain("from resume journal");
    expect(row.indexOf("from resume journal")).toBeLessThan(row.indexOf("general-purpose"));
  });

  it("leaves an agent that actually ran unannotated", () => {
    const lines = card({
      progress: [agentEntry({ index: 0, label: "audit", state: "done", agentType: "general-purpose" })],
    });

    expect(treeRows(lines)[1]).not.toContain("resume journal");
  });

  it("renders a skipped and a blocked agent as a plain cross (the dialog splits them, this does not)", () => {
    const lines = card({
      progress: [
        agentEntry({ index: 0, label: "skipped", state: "error", skipped: true }),
        agentEntry({ index: 1, label: "blocked", state: "error", blocked: true }),
      ],
    });
    const rows = treeRows(lines).slice(1);
    expect(rows[0]).toContain("✘ skipped");
    expect(rows[1]).toContain("✘ blocked");
  });

  it("colours done success, error error, and leaves a running row at the terminal default", () => {
    const styled = styleWorkflowCardLines(
      layoutWorkflowCard({
        progress,
        task: { status: "running", workflowName: "wf", startTime: START },
        now: START,
      }),
      theme,
    );
    expect(styled.find(l => l.includes("done"))).toContain("<success>✔</success>");
    expect(styled.find(l => l.includes("failed"))).toContain("<error>✘</error>");
    const running = styled.find(l => l.includes("started")) ?? "";
    expect(running).toContain("⟳");
    expect(running).not.toContain(">⟳<");
  });
});

describe("tree branches", () => {
  const progress: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    { type: "workflow_phase", index: 1, title: "Verify" },
    agentEntry({ index: 0, label: "review:bugs", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 1, label: "review:perf", phaseIndex: 0 }),
    agentEntry({ index: 2, label: "verify:auth.ts", phaseIndex: 1 }),
  ];

  it("uses ├─ for every row but the last in a group, and └─ for the last", () => {
    const rows = treeRows(card({ progress }));
    expect(rows[1]).toMatch(/^│ ├─ /);
    expect(rows[2]).toMatch(/^│ └─ /);
    expect(rows[4]).toMatch(/^ {2}└─ /);
  });

  it("opens the first group with ╭─ and closes the last with ╰─", () => {
    const rows = treeRows(card({ progress }));
    expect(rows[0]).toBe("╭─ Review");
    expect(rows[3]).toBe("╰─ Verify");
  });

  it("branches the middle groups instead of re-opening the box", () => {
    // Three phases and no agents is what a run looks like the moment it starts,
    // and every non-final group used to draw ╭─ — so it read as a stack of
    // half-drawn boxes rather than one tree.
    const rows = treeRows(
      card({
        progress: [],
        meta: {
          name: "src-vuln-scan",
          description: "d",
          phases: [{ title: "Discover" }, { title: "Scan" }, { title: "Verify" }],
        },
      }),
    );
    expect(rows).toEqual(["╭─ Discover", "├─ Scan", "╰─ Verify"]);
  });

  it("still draws a lone group as a closed box", () => {
    const rows = treeRows(
      card({ progress: [], meta: { name: "n", description: "d", phases: [{ title: "Only" }] } }),
    );
    expect(rows).toEqual(["╰─ Only"]);
  });

  it("hangs rows off a │ rail under a non-final group and off blanks under the final one", () => {
    const rows = treeRows(card({ progress }));
    expect(rows[1].startsWith("│")).toBe(true);
    expect(rows[4].startsWith("│")).toBe(false);
  });

  it("collapses unphased agents into a single Agents group", () => {
    const rows = treeRows(
      card({
        progress: [
          { ...agentEntry({ index: 0, label: "solo" }), phaseIndex: undefined },
          { ...agentEntry({ index: 1, label: "solo2" }), phaseIndex: undefined },
        ],
      }),
    );
    expect(rows[0]).toBe("╰─ Agents");
    expect(rows[1]).toMatch(/^ {2}├─ ⟳ solo/);
    expect(rows[2]).toMatch(/^ {2}└─ ⟳ solo2/);
  });
});

describe("stat segments", () => {
  it("appends agentType, model, tokens, toolCalls, durationMs in that order", () => {
    expect(
      agentStatSegments(
        agentEntry({
          index: 0,
          agentType: "Explore",
          model: "haiku",
          tokens: 18_400,
          toolCalls: 12,
          durationMs: 42_000,
        }),
      ),
    ).toEqual(["Explore", "haiku", "18.4k", "12 tool calls", "42s"]);
  });

  it("omits every stat that is absent", () => {
    expect(agentStatSegments(agentEntry({ index: 0 }))).toEqual([]);
    expect(agentStatSegments(agentEntry({ index: 0, toolCalls: 1 }))).toEqual(["1 tool call"]);
  });

  it("merges the fallback model into the model segment", () => {
    expect(agentStatSegments(agentEntry({ index: 0, model: "haiku", fallbackModel: "sonnet" }))).toEqual([
      "haiku→sonnet",
    ]);
    expect(agentStatSegments(agentEntry({ index: 0, model: "haiku", fallbackModel: "haiku" }))).toEqual([
      "haiku",
    ]);
    expect(agentStatSegments(agentEntry({ index: 0, fallbackModel: "sonnet" }))).toEqual(["sonnet"]);
  });

  it("renders the segments · separated after the label", () => {
    const rows = treeRows(
      card({
        progress: [
          agentEntry({
            index: 0,
            label: "review:bugs",
            state: "done",
            agentType: "Explore",
            model: "haiku",
            tokens: 18_400,
            toolCalls: 12,
            durationMs: 42_000,
          }),
        ],
      }),
    );
    expect(rows[1].trimEnd()).toBe("  └─ ✔ review:bugs · Explore · haiku · 18.4k · 12 tool calls · 42s");
  });

  it("aligns stats into one column across groups", () => {
    const lines = card({
      progress: [
        { type: "workflow_phase", index: 0, title: "Review" },
        { type: "workflow_phase", index: 1, title: "Verify" },
        agentEntry({ index: 0, label: "short", phaseIndex: 0, toolCalls: 1 }),
        agentEntry({ index: 1, label: "a-much-longer-label", phaseIndex: 1, toolCalls: 2 }),
      ],
    });
    const columns = treeRows(lines)
      .filter(l => l.includes(" · "))
      .map(l => l.indexOf(" · "));
    expect(columns).toHaveLength(2);
    expect(columns[0]).toBe(columns[1]);
  });
});

describe("ASCII fallback tier", () => {
  it("swaps the tick and cross for √ and ×", () => {
    const lines = card({
      ascii: true,
      progress: [
        agentEntry({ index: 0, label: "done", state: "done" }),
        agentEntry({ index: 1, label: "failed", state: "error" }),
      ],
    });
    const joined = lines.join("\n");
    expect(joined).toContain("√ done");
    expect(joined).toContain("× failed");
    expect(joined).not.toContain("✔");
    expect(joined).not.toContain("✘");
  });

  it("swaps the box drawing too, keeping each glyph's column width", () => {
    const joined = card({
      ascii: true,
      progress: [agentEntry({ index: 0, label: "x" })],
    }).join("\n");
    expect(joined).not.toMatch(/[╭╰├└│⎿▸⟳]/);
    for (const key of ["groupTop", "groupBottom", "branch", "lastBranch", "running", "tick", "cross"] as const) {
      expect(visibleWidth(ASCII_GLYPHS[key])).toBeGreaterThan(0);
    }
  });
});

describe("header", () => {
  const sevenAgents: WorkflowEntry[] = Array.from({ length: 7 }, (_, i) =>
    agentEntry({ index: i, state: i < 3 ? "done" : "start" }),
  );

  it("reads N/M agents · elapsed, with no phase count", () => {
    const [header] = card({
      progress: [{ type: "workflow_phase", index: 0, title: "Review" }, ...sevenAgents],
      now: START + 72_000,
    });
    expect(header).toContain("3/7 agents · 1m12s");
    expect(header).not.toMatch(/phase/i);
    expect(header).not.toMatch(/1\/1|\d+ phases?/);
  });

  it("names the workflow, and the tool only when it stands alone", () => {
    // As a tool result there is a `▸ SubagentWorkflow …` call line directly
    // above, so repeating it here put two near-identical pointer lines back to
    // back. A session entry has no such line and asks for the prefix.
    const [asResult] = card({ progress: sevenAgents });
    expect(asResult).toMatch(/^ {2}review-changes/);
    expect(asResult).not.toContain("SubagentWorkflow");

    const [standalone] = card({ progress: sevenAgents, showToolTitle: true });
    expect(standalone).toMatch(/^▸ SubagentWorkflow {2}review-changes/);
  });

  it("appends the terminal suffix for each stopped status", () => {
    const suffixes: [WorkflowCardTask["status"], string][] = [
      ["running", ""],
      ["completed", " · done"],
      ["killed", " · stopped"],
      ["paused", " · paused"],
      ["failed", " · failed"],
    ];
    for (const [status, suffix] of suffixes) {
      const [header] = card({ progress: sevenAgents, task: { status, startTime: START } });
      expect(header, status).toContain(`3/7 agents · 1s${suffix}`);
    }
  });

  it("shows meta.description as the subtext line", () => {
    const meta: WorkflowMeta = {
      name: "review-changes",
      description: "Review changed files across dimensions, verify each finding",
    };
    const lines = card({ progress: sevenAgents, meta });
    expect(lines[1]).toBe("  Review changed files across dimensions, verify each finding");
  });

  it("right-aligns the stats to the card width", () => {
    const lines = card({ progress: sevenAgents, width: 60 });
    expect(visibleWidth(lines[0])).toBe(60);
    expect(lines[0].endsWith("3/7 agents · 1s")).toBe(true);
  });
});

describe("log lines", () => {
  it("renders below the tree with a ⎿ prefix", () => {
    const lines = card({
      progress: [
        agentEntry({ index: 0, label: "a" }),
        { type: "workflow_log", message: "scanned 41 changed files" },
      ],
    });
    expect(lines.at(-1)).toBe("  ⎿  scanned 41 changed files");
  });

  it("keeps every log in order and indents continuation lines under the first", () => {
    const lines = card({
      progress: [
        { type: "workflow_log", message: "first" },
        { type: "workflow_log", message: "second\nwrapped" },
      ],
    });
    expect(lines.slice(-3)).toEqual(["  ⎿  first", "  ⎿  second", "     wrapped"]);
  });
});

describe("width", () => {
  const wide: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "A phase title that runs on well past any sane terminal width" },
    agentEntry({
      index: 0,
      label: "an-extremely-long-agent-label-that-would-otherwise-wrap-the-whole-card",
      agentType: "general-purpose",
      model: "claude-opus-4-5-20260101",
      tokens: 1_240_000,
      toolCalls: 412,
      durationMs: 3_723_000,
    }),
    { type: "workflow_log", message: "a log line long enough to overflow a narrow terminal on its own" },
  ];

  for (const width of [20, 40, 80]) {
    it(`never exceeds ${width} columns`, () => {
      const lines = card({ progress: wide, width, task: { status: "running", startTime: START } });
      expect(lines.length).toBeGreaterThan(3);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    });
  }

  it("keeps the header stats when the name has to be cut", () => {
    const lines = card({
      progress: wide,
      width: 34,
      task: { status: "running", workflowName: "a-workflow-name-far-too-long-to-fit", startTime: START },
    });
    expect(lines[0]).toContain("0/1 agent · 1s");
    expect(lines[0]).toContain("…");
    expect(visibleWidth(lines[0])).toBe(34);
  });

  it("counts wide characters rather than code points", () => {
    const lines = card({
      progress: [agentEntry({ index: 0, label: "日本語のラベルがとても長い場合の折り返し確認", toolCalls: 3 })],
      width: 30,
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  });
});

describe("size warning", () => {
  it("appears once the scheduled agents pass the cap, with Claude Code's wording", () => {
    const lines = card({
      progress: [agentEntry({ index: 0, label: "a" })],
      agentCount: 40,
    });
    expect(lines.at(-1)).toBe("  ⚠ Large workflow · /agents → Workflows to stop");
  });

  it("stays away for a small run", () => {
    const lines = card({ progress: [agentEntry({ index: 0, label: "a" })] });
    expect(lines.join("\n")).not.toContain("Large workflow");
  });
});

describe("component rendering", () => {
  it("themes the card and hands back one Text of the same lines", () => {
    const input: WorkflowCardInput = {
      progress: [
        { type: "workflow_phase", index: 0, title: "Review" },
        agentEntry({ index: 0, label: "review:bugs", state: "done", durationMs: 42_000 }),
      ],
      task: { status: "completed", workflowName: "review-changes", startTime: START, endTime: START + 42_000 },
      now: START + 42_000,
      width: 80,
    };
    // Rendered wide: the fake theme's markup is visible width, unlike real ANSI,
    // so a realistic width would wrap lines the terminal never would.
    const rendered = renderWorkflowCard(input, theme).render(400);
    expect(rendered).toHaveLength(layoutWorkflowCard(input).length);
    expect(rendered[0]).toContain("<toolTitle>*review-changes*</toolTitle>");
    expect(rendered[0]).toContain("<dim>1/1 agent · 42s · done</dim>");
    expect(rendered.join("\n")).toContain("<success>✔</success>");
  });
});
