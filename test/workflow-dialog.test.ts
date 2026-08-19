import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SPINNER } from "../src/ui/agent-widget.js";
import { styleWorkflowCardLines, type WorkflowCardTask } from "../src/ui/workflow-card.js";
import {
  ASCII_DIALOG_GLYPHS,
  DEFAULT_PANE_BODY_ROWS,
  dialogRowGlyph,
  handleWorkflowDialogKey,
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  MIN_PANE_BODY_ROWS,
  PROMPT_COLLAPSED_LINES,
  plainWorkflowDialogLines,
  resolveWorkflowDialog,
  subStatusAnnotations,
  UNICODE_DIALOG_GLYPHS,
  WORKFLOW_DIALOG_COPY,
  WorkflowDialog,
  type WorkflowDialogInput,
  type WorkflowDialogState,
  workflowDialogContentWidth,
} from "../src/ui/workflow-dialog.js";
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

type DialogOverrides = Partial<Omit<WorkflowDialogInput, "state">> & {
  progress: readonly WorkflowEntry[];
  state?: Partial<WorkflowDialogState>;
};

function input(over: DialogOverrides): WorkflowDialogInput {
  const task: WorkflowCardTask = {
    status: "running",
    workflowName: "review-changes",
    startTime: START,
    ...over.task,
  };
  return {
    width: 86,
    now: START + 1000,
    ...over,
    task,
    state: { ...initialWorkflowDialogState(), ...over.state },
  };
}

const dialog = (over: DialogOverrides): string[] =>
  plainWorkflowDialogLines(layoutWorkflowDialog(input(over)));

const styled = (over: DialogOverrides): string[] =>
  styleWorkflowCardLines(layoutWorkflowDialog(input(over)), theme);

/** Strip the fake theme's markup, keeping the text exactly as it is laid out. */
const stripMarkup = (line: string) => line.replace(/<\/?[a-zA-Z]+>|\*/g, "");

/** Strip the markup and a heading's focus marker / padding. */
const bare = (line: string) => stripMarkup(line).replace(/^[\s▸>]+/, "");

/* --- reading the framed layout ---------------------------------------------
 *
 * Every body row is `│<left cell>│<right cell>│`, so a pane is read by taking
 * one side of every row. Trailing blank rows are dropped: the frame pads to a
 * fixed height, and a test asserting on "the rows" means the ones with content.
 */

/**
 * The frame's body rows, as (left, right) cell pairs.
 *
 * Split on the border rather than sliced by index, and the border is matched
 * with its optional theme markup, so the same helper reads a plain layout and a
 * styled one — the styled tests need the markup left intact inside the cells.
 */
const BORDER = /(?:<[a-zA-Z]+>)?[│|](?:<\/[a-zA-Z]+>)?/;

function cells(lines: string[]): { left: string; right: string }[] {
  const rows: { left: string; right: string }[] = [];
  for (const line of lines) {
    const parts = line.split(new RegExp(BORDER.source, "g"));
    if (parts.length === 4 && parts[0].trim() === "" && parts[3].trim() === "") {
      rows.push({ left: parts[1], right: parts[2] });
    }
  }
  return rows;
}

/** Drop the padding rows the frame adds below the content. */
const trimTrailing = (rows: string[]): string[] => {
  const out = [...rows];
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out;
};

const leftRows = (lines: string[]): string[] => trimTrailing(cells(lines).map(row => row.left));
const rightRows = (lines: string[]): string[] => trimTrailing(cells(lines).map(row => row.right));

/** The two pane titles from the frame's top edge. */
function paneTitles(lines: string[]): { left: string; right: string } {
  for (const line of lines) {
    const match = bare(line).match(/^[╭+](.*?)[┬+](.*)[╮+]$/);
    if (match) {
      const strip = (part: string) => part.replace(/[─-]+\s*$/, "").trim();
      return { left: strip(match[1]), right: strip(match[2]) };
    }
  }
  throw new Error(`no frame in:\n${lines.join("\n")}`);
}

/** Rows of a detail section, i.e. everything between its heading and the next blank. */
function section(lines: string[], heading: string): string[] {
  const rows = rightRows(lines).map(row => stripMarkup(row).trimEnd());
  const start = rows.findIndex(row => row.trim().startsWith(heading));
  if (start < 0) throw new Error(`no ${heading} section in:\n${lines.join("\n")}`);
  const rest = rows.slice(start + 1);
  const end = rest.findIndex(row => row.trim() === "");
  // Body rows are indented three columns under their heading; the recovered
  // copy carries its own two, so one is dropped to compare against it.
  return (end < 0 ? rest : rest.slice(0, end)).map(row => row.replace(/^ {3}/, "  "));
}

/** The dialog in its agent subview, which is where the detail sections live. */
const detail = (over: DialogOverrides): string[] =>
  dialog({ ...over, state: { ...over.state, level: "agent" } });


/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

describe("dialog glyph mapping", () => {
  const live: WorkflowEntry[] = [
    agentEntry({ index: 0, label: "done", state: "done" }),
    agentEntry({ index: 1, label: "failed", state: "error" }),
    agentEntry({ index: 2, label: "skipped", state: "error", skipped: true }),
    agentEntry({ index: 3, label: "blocked", state: "error", blocked: true }),
    agentEntry({ index: 4, label: "queued", state: "start", queuedAt: START }),
    agentEntry({ index: 5, label: "running", state: "progress", startedAt: START }),
  ];

  it("maps every one of the seven display states to its glyph and colour", () => {
    expect(dialogRowGlyph("done", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✔", color: "success" });
    expect(dialogRowGlyph("failed", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✘", color: "error" });
    expect(dialogRowGlyph("skipped", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✘", color: "dim" });
    expect(dialogRowGlyph("blocked", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "✘", color: "warning" });
    expect(dialogRowGlyph("queued", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "◌", color: "dim" });
    expect(dialogRowGlyph("interrupted", UNICODE_DIALOG_GLYPHS)).toEqual({ text: "◌", color: "dim" });
    expect(dialogRowGlyph("running", UNICODE_DIALOG_GLYPHS, 3)).toEqual({ text: SPINNER[3], color: "dim" });
  });

  it("keys off the derived display state, not the raw entry state", () => {
    const rows = rightRows(dialog({ progress: live }));
    expect(rows[0]).toContain("✔ done");
    expect(rows[1]).toContain("✘ failed");
    expect(rows[2]).toContain("✘ skipped");
    expect(rows[3]).toContain("✘ blocked");
    // All four above are `state: "done" | "error"` inline; only the dialog
    // splits the last three apart, and only it can draw ◌ for the queued row.
    expect(rows[4]).toContain("◌ queued");
    expect(rows[5]).toContain(`${SPINNER[0]} running`);
  });

  it("renders blocked distinctly from skipped despite sharing the cross", () => {
    const lines = styled({ progress: live });
    expect(lines.find(l => l.includes("skipped"))).toContain("<dim>✘</dim>");
    expect(lines.find(l => l.includes("blocked"))).toContain("<warning>✘</warning>");
    expect(lines.find(l => l.includes("failed"))).toContain("<error>✘</error>");
    expect(lines.find(l => l.includes(">done"))).toContain("<success>✔</success>");
  });

  it("does not use the card's ⟳ for a running row — it spins, and queues draw ◌", () => {
    const joined = dialog({ progress: live }).join("\n");
    expect(joined).not.toContain("⟳");
    expect(joined).toContain("◌");
    // And the spinner really advances, which a static glyph could not do.
    const later = dialog({ progress: live, spinnerFrame: 4 }).join("\n");
    expect(later).toContain(`${SPINNER[4]} running`);
    expect(later).not.toContain(`${SPINNER[0]} running`);
  });

  it("draws ◌ for an agent still live when the run stopped", () => {
    const rows = rightRows(
      dialog({
        progress: [agentEntry({ index: 0, label: "cutoff", state: "progress", startedAt: START })],
        task: { status: "killed", startTime: START },
      }),
    );
    expect(rows[0]).toContain("◌ cutoff");
  });

  it("keeps an ASCII tier one column wide for every glyph", () => {
    for (const key of ["tick", "cross", "queued", "pointer", "focus"] as const) {
      expect(visibleWidth(ASCII_DIALOG_GLYPHS[key]), key).toBe(1);
    }
    const joined = dialog({ progress: live, ascii: true }).join("\n");
    expect(joined).not.toMatch(/[✔✘◌❯▸]/);
    expect(joined).toContain("√ done");
    expect(joined).toContain("o queued");
  });
});

/* ------------------------------------------------------------------------- *
 * Phases pane
 * ------------------------------------------------------------------------- */

describe("phases pane", () => {
  const meta: WorkflowMeta = {
    name: "review-changes",
    description: "Review changed files",
    phases: [{ title: "Review" }, { title: "Verify" }, { title: "Report" }],
  };
  const progress: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    { type: "workflow_phase", index: 1, title: "Verify" },
    agentEntry({ index: 0, label: "a", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 1, label: "b", phaseIndex: 1, state: "start" }),
  ];

  it("shows a phase's number until it finishes, then its glyph", () => {
    const rows = leftRows(dialog({ progress, meta }));
    // Review is fully done → tick. Verify is still running → its NUMBER, not a
    // glyph. Report never started → its number too.
    expect(rows[0]).toContain("✔ Review");
    expect(rows[1]).toContain("2 Verify");
    expect(rows[2]).toContain("3 Report");
    expect(rows[1]).not.toContain("✔");
    expect(rows[1]).not.toContain("✘");
  });

  it("shows a cross once a phase has a failure", () => {
    const rows = leftRows(
      dialog({
        progress: [
          { type: "workflow_phase", index: 0, title: "Review" },
          agentEntry({ index: 0, label: "a", phaseIndex: 0, state: "error" }),
        ],
      }),
    );
    expect(rows[0]).toContain("✘ Review");
  });

  it("points at the selected phase and accents it, leaving the others alone", () => {
    const rows = leftRows(styled({ progress, meta, state: { selectedPhase: 1 } }));
    expect(rows[1]).toContain("<accent>❯</accent>");
    expect(rows[1]).toContain("<accent>Verify</accent>");
    expect(rows[0]).not.toContain("❯");
    expect(rows[0]).toContain("<success>");
    expect(rows[2]).toContain("<dim>");
  });

  it("leaves a declared-but-unseen phase without a count", () => {
    // The narrow pane has no room for "Not started yet"; an absent count says
    // the same thing, and the phase's number already marks it as pending.
    const rows = leftRows(dialog({ progress, meta }));
    expect(rows[2]).toContain("Report");
    expect(rows[2]).not.toMatch(/\d\/\d/);
    expect(rows[0]).toContain("1/1");
  });

  it("swaps the agent list when the phase selection moves", () => {
    expect(rightRows(dialog({ progress, meta }))[0]).toContain(" a");
    expect(rightRows(dialog({ progress, meta, state: { selectedPhase: 1 } }))[0]).toContain(" b");
  });

  it("names the selected phase and its agent count on the right pane", () => {
    expect(paneTitles(dialog({ progress, meta })).left).toBe("Phases");
    expect(paneTitles(dialog({ progress, meta })).right).toBe("Review · 1 agent");
    expect(paneTitles(dialog({ progress, meta, state: { selectedPhase: 1 } })).right).toBe("Verify · 1 agent");
  });
});

/* ------------------------------------------------------------------------- *
 * State filter
 * ------------------------------------------------------------------------- */

describe("state filter", () => {
  const progress: WorkflowEntry[] = [
    agentEntry({ index: 0, label: "one", state: "done" }),
    agentEntry({ index: 1, label: "two", state: "progress", startedAt: START }),
    agentEntry({ index: 2, label: "three", state: "progress", startedAt: START }),
  ];

  it("counts unfiltered agents with a plural that agrees", () => {
    // Exact, not `toContain`: "1 agent" is a substring of "1 agents".
    // "Phase 0" because the fixtures carry a phase index with no declared
    // title; what is being pinned is the count and its plural.
    expect(paneTitles(dialog({ progress })).right).toBe("Phase 0 · 3 agents");
    const one = dialog({ progress: [agentEntry({ index: 0, state: "done" })] });
    expect(paneTitles(one).right).toBe("Phase 0 · 1 agent");
  });

  it("narrows the visible set and names the filter in the pane title", () => {
    const lines = dialog({ progress, state: { filter: "running" } });
    // The count is of what survived, so the title has to say which filter or
    // "2 agents" would read as the whole phase.
    expect(paneTitles(lines).right).toBe("Phase 0 · 2 running");
    const rows = rightRows(lines);
    expect(rows).toHaveLength(2);
    expect(rows.join("\n")).not.toContain("one");
    expect(rows.join("\n")).toContain("two");
  });

  it("reports a filter that matches nothing, and says so in the list", () => {
    const lines = dialog({ progress, state: { filter: "blocked" } });
    expect(paneTitles(lines).right).toBe("Phase 0 · 0 blocked");
    expect(rightRows(lines).map(row => row.trim())).toEqual([WORKFLOW_DIALOG_COPY.noAgents]);
    expect(WORKFLOW_DIALOG_COPY.noAgents).toBe("No agents");
  });

  it("filters on the derived state, so a stopped run's live agents match interrupted", () => {
    const view = resolveWorkflowDialog(
      input({ progress, task: { status: "killed", startTime: START }, state: { filter: "interrupted" } }),
    );
    expect(view.visibleAgents.map(a => a.label)).toEqual(["two", "three"]);
  });
});

/* ------------------------------------------------------------------------- *
 * Sub-status annotations
 * ------------------------------------------------------------------------- */

describe("sub-status annotations", () => {
  it("renders the retry reason and attempt number from the entry", () => {
    expect(
      subStatusAnnotations(
        agentEntry({ index: 0, attempt: 3, lastAttemptReason: "throttled" }),
        "running",
        START,
      ),
    ).toEqual(["throttled", "attempt 3"]);
    expect(
      subStatusAnnotations(agentEntry({ index: 0, lastAttemptReason: "user-retry" }), "running", START),
    ).toEqual(["user retry"]);
    expect(
      subStatusAnnotations(agentEntry({ index: 0, lastAttemptReason: "stalled" }), "running", START),
    ).toEqual(["stalled"]);
  });

  it("does not annotate a first attempt", () => {
    expect(subStatusAnnotations(agentEntry({ index: 0, attempt: 1 }), "running", START)).toEqual([]);
  });

  it("marks a journal replay and an isolated child", () => {
    expect(
      subStatusAnnotations(agentEntry({ index: 0, cached: true, isolation: "worktree" }), "done", START),
    ).toEqual(["worktree", "from resume journal"]);
  });

  it("shows how long a queued agent has waited, and only while it is queued", () => {
    const entry = agentEntry({ index: 0, queuedAt: START });
    expect(subStatusAnnotations(entry, "queued", START + 8000)).toEqual(["waiting 8s"]);
    expect(subStatusAnnotations(entry, "running", START + 8000)).toEqual([]);
  });

  it("puts the annotations on the row ahead of the card's stat tail", () => {
    const rows = rightRows(
      dialog({
        progress: [
          agentEntry({
            index: 0,
            label: "retry-me",
            state: "start",
            queuedAt: START,
            attempt: 2,
            lastAttemptReason: "throttled",
            agentType: "Explore",
            toolCalls: 4,
          }),
        ],
        now: START + 8000,
      }),
    );
    // The agent type and the tool-call count are the detail pane's, not the
    // row's — the row carries why it looks the way it does, then the model and
    // the token count, and nothing that would push those off a narrow pane.
    expect(rows[0].trim()).toBe("❯ ◌ retry-me · throttled · attempt 2 · waiting 8s");
  });
});

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

describe("per-agent detail", () => {
  const long = Array.from({ length: 9 }, (_, i) => `prompt line ${i}`).join("\n");

  it("collapses a long prompt behind an `expand` affordance and counts its lines", () => {
    const collapsed = detail({
      progress: [agentEntry({ index: 0, state: "done", promptPreview: long })],
    });
    expect(rightRows(collapsed).map(bare).find(l => l.includes("Prompt"))).toContain("Prompt · 9 lines · ⏎ expand");
    // The shown lines plus the row that names how many are not shown, so a
    // collapsed prompt never looks like the whole prompt.
    expect(section(collapsed, "Prompt")).toHaveLength(PROMPT_COLLAPSED_LINES + 1);
    expect(section(collapsed, "Prompt").at(-1)).toContain("… 5 more lines");

    const expanded = detail({
      progress: [agentEntry({ index: 0, state: "done", promptPreview: long })],
      state: { promptExpanded: true },
    });
    expect(rightRows(expanded).map(bare).find(l => l.includes("Prompt"))).toContain("Prompt · 9 lines · ⏎ collapse");
    expect(section(expanded, "Prompt")).toHaveLength(9);
  });

  it("does not offer expand for a prompt that already fits, and counts one line as one", () => {
    const heading = (lines: string[]) =>
      rightRows(lines).map(row => bare(row).trim()).find(row => row.startsWith("Prompt"));
    const two = detail({
      progress: [agentEntry({ index: 0, state: "done", promptPreview: "one\ntwo" })],
    });
    expect(heading(two)).toBe("Prompt · 2 lines");
    const one = detail({ progress: [agentEntry({ index: 0, state: "done", promptPreview: "solo" })] });
    expect(heading(one)).toBe("Prompt · 1 line");
  });

  it("uses Claude Code's copy for a prompt and activity that do not exist yet", () => {
    const lines = detail({ progress: [agentEntry({ index: 0, state: "start", queuedAt: START })] });
    expect(section(lines, "Prompt")).toEqual([`  ${WORKFLOW_DIALOG_COPY.availableOnceStarted}`]);
    expect(section(lines, "Activity")).toEqual(["  Available once the agent starts."]);
    expect(section(lines, "Outcome")).toEqual(["  Waiting for an agent slot."]);
  });

  it("distinguishes no-tool-calls-yet from no-tool-calls-ever", () => {
    const running = detail({ progress: [agentEntry({ index: 0, state: "progress", startedAt: START })] });
    expect(section(running, "Activity")).toEqual(["  No tool calls yet."]);
    const finished = detail({ progress: [agentEntry({ index: 0, state: "done" })] });
    expect(section(finished, "Activity")).toEqual(["  No tool calls."]);
  });

  it("heads Activity with the tool-call count and admits it has no transcript", () => {
    const heading = (lines: string[]) =>
      rightRows(lines).map(row => bare(row).trim()).find(row => row.startsWith("Activity"));
    const lines = detail({ progress: [agentEntry({ index: 0, state: "done", toolCalls: 3 })] });
    expect(heading(lines)).toBe("Activity · 3 tool calls");
    expect(section(lines, "Activity")).toEqual(["  Transcript not available."]);
    const one = detail({ progress: [agentEntry({ index: 0, state: "done", toolCalls: 1 })] });
    expect(heading(one)).toBe("Activity · 1 tool call");
  });

  it("writes a different Outcome for every terminal state", () => {
    const outcome = (entry: Partial<WorkflowAgentEntry>, task?: WorkflowCardTask) =>
      section(detail({ progress: [agentEntry({ index: 0, ...entry })], task }), "Outcome");

    expect(outcome({ state: "error", skipped: true })).toEqual(["  Skipped by user."]);
    expect(outcome({ state: "error", error: "boom" })).toEqual(["  boom"]);
    expect(outcome({ state: "error", blocked: true })).toEqual([`  ${WORKFLOW_DIALOG_COPY.noTranscript}`]);
    expect(outcome({ state: "done", resultPreview: "shipped" })).toEqual(["  shipped"]);
    expect(outcome({ state: "progress", startedAt: START })).toEqual([
      "  Not available yet (agent still running).",
    ]);
    expect(outcome({ state: "progress", startedAt: START }, { status: "killed", startTime: START })).toEqual([
      "  The workflow stopped before this agent finished.",
    ]);
  });

  it("omits the detail sections entirely when nothing is selected", () => {
    const lines = detail({ progress: [] });
    expect(lines.join("\n")).not.toContain("Prompt");
    expect(lines.join("\n")).not.toContain("Outcome");
    expect(rightRows(lines).map(row => row.trim()).filter(Boolean)).toEqual([]);
    expect(leftRows(lines).map(row => row.trim())).toEqual([WORKFLOW_DIALOG_COPY.noAgents]);
  });
});

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

describe("keys", () => {
  const progress: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    { type: "workflow_phase", index: 1, title: "Verify" },
    agentEntry({ index: 0, label: "a", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 1, label: "b", phaseIndex: 0, state: "done" }),
    agentEntry({ index: 2, label: "c", phaseIndex: 1, state: "done" }),
  ];

  const press = (data: string, state?: Partial<WorkflowDialogState>) => {
    const full = input({ progress, state });
    return handleWorkflowDialogKey(data, full.state, resolveWorkflowDialog(full));
  };

  it("moves the phase selection with j/k and clamps at both ends", () => {
    expect(press("j")?.state.selectedPhase).toBe(1);
    expect(press("j", { selectedPhase: 1 })?.state.selectedPhase).toBe(1);
    expect(press("k", { selectedPhase: 1 })?.state.selectedPhase).toBe(0);
    expect(press("k", { selectedPhase: 0 })?.state.selectedPhase).toBe(0);
  });

  it("moves the agent selection with j/k and clamps at both ends", () => {
    const agents = { level: "agent" as const };
    expect(press("j", agents)?.state.selectedAgent).toBe(1);
    expect(press("j", { ...agents, selectedAgent: 1 })?.state.selectedAgent).toBe(1);
    expect(press("k", { ...agents, selectedAgent: 1 })?.state.selectedAgent).toBe(0);
    expect(press("k", { ...agents, selectedAgent: 0 })?.state.selectedAgent).toBe(0);
  });

  it("re-points the agent cursor at the top when the phase changes", () => {
    const moved = press("j", { selectedAgent: 1 });
    expect(moved?.state.selectedPhase).toBe(1);
    expect(moved?.state.selectedAgent).toBe(0);
  });

  it("never runs the cursor off an empty list", () => {
    const empty = input({ progress: [], state: { level: "agent" } });
    const view = resolveWorkflowDialog(empty);
    expect(handleWorkflowDialogKey("j", empty.state, view)?.state.selectedAgent).toBe(0);
    expect(view.selectedEntry).toBeUndefined();
  });

  it("opens the selected phase's agents, and escape comes back", () => {
    expect(press("\r")?.state.level).toBe("agent");
    expect(press("\x1b", { level: "agent" })?.state.level).toBe("phases");
    // Back one level, not out of the dialog — a wrong turn must not cost it.
    expect(press("\x1b", { level: "agent" })?.action).toBeUndefined();
  });

  it("refuses to open a phase with nothing in it", () => {
    // A subview with no rows and no detail is a dead end to back out of.
    const empty = input({ progress: [], state: {} });
    expect(handleWorkflowDialogKey("\r", empty.state, resolveWorkflowDialog(empty))?.state.level).toBe("phases");
  });

  it("swaps which pane holds which list when it opens", () => {
    const overview = dialog({ progress });
    expect(paneTitles(overview).left).toBe("Phases");
    expect(paneTitles(overview).right).toBe("Review · 2 agents");

    const opened = dialog({ progress, state: { level: "agent" } });
    // The agents move left and the selected one's detail takes the right. The
    // left title is truncated to the narrow pane, marker and all.
    expect(paneTitles(opened).left).toBe("Review · 2 agen…");
    expect(paneTitles(opened).right).toBe("a");
  });

  it("cycles the filter and resets the agent cursor with it", () => {
    expect(press("f")?.state.filter).toBe("running");
    expect(press("f", { filter: "running" })?.state.filter).toBe("queued");
    expect(press("f", { filter: "interrupted" })?.state.filter).toBe("all");
    expect(press("f", { selectedAgent: 1 })?.state.selectedAgent).toBe(0);
  });

  it("toggles the prompt expansion", () => {
    expect(press("e")?.state.promptExpanded).toBe(true);
    expect(press("e", { promptExpanded: true })?.state.promptExpanded).toBe(false);
    // Enter means "open" at the overview and "expand" once opened, which is the
    // only reading under which one key does the obvious thing at both levels.
    expect(press("\r", { level: "agent" })?.state.promptExpanded).toBe(true);
  });

  it("cancels on escape from the overview", () => {
    expect(press("\x1b")?.action).toEqual({ kind: "cancel" });
  });

  it("raises the run-level actions, and pause flips to resume once paused", () => {
    expect(press("x")?.action).toEqual({ kind: "kill" });
    expect(press("p")?.action).toEqual({ kind: "pause" });
    const paused = input({ progress, task: { status: "paused", startTime: START } });
    expect(handleWorkflowDialogKey("p", paused.state, resolveWorkflowDialog(paused))?.action).toEqual({
      kind: "resume",
    });
  });

  /** A run whose phase 0 holds one queued, one running and one finished agent. */
  const mixed: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    agentEntry({ index: 0, label: "queued", phaseIndex: 0, state: "start", queuedAt: START }),
    agentEntry({ index: 1, label: "running", phaseIndex: 0, state: "progress", queuedAt: START, startedAt: START }),
    agentEntry({ index: 2, label: "done", phaseIndex: 0, state: "done" }),
  ];
  const pressMixed = (data: string, selectedAgent: number) => {
    const full = input({ progress: mixed, state: { level: "agent", selectedAgent } });
    return handleWorkflowDialogKey(data, full.state, resolveWorkflowDialog(full));
  };

  it("raises skip and retry against the selected agent's stable index", () => {
    expect(pressMixed("s", 1)?.action).toEqual({ kind: "skip", index: 1 });
    expect(pressMixed("r", 1)?.action).toEqual({ kind: "retry", index: 1 });
  });

  it("uses the entry's index, not its row position", () => {
    // The distinction only shows across phases: phase 1's first row is index 3,
    // so a dialog reporting the row would skip the wrong agent entirely.
    const across: WorkflowEntry[] = [
      { type: "workflow_phase", index: 0, title: "Review" },
      { type: "workflow_phase", index: 1, title: "Verify" },
      agentEntry({ index: 0, label: "r0", phaseIndex: 0, state: "done" }),
      agentEntry({ index: 1, label: "r1", phaseIndex: 0, state: "done" }),
      agentEntry({ index: 2, label: "r2", phaseIndex: 0, state: "done" }),
      agentEntry({ index: 3, label: "v0", phaseIndex: 1, state: "progress", queuedAt: START, startedAt: START }),
    ];
    const full = input({ progress: across, state: { level: "agent", selectedPhase: 1, selectedAgent: 0 } });
    const view = resolveWorkflowDialog(full);

    expect(view.selectedEntry?.label).toBe("v0");
    expect(handleWorkflowDialogKey("s", full.state, view)?.action).toEqual({ kind: "skip", index: 3 });
    expect(handleWorkflowDialogKey("r", full.state, view)?.action).toEqual({ kind: "retry", index: 3 });
  });

  it("offers skip but not retry on an agent that has not started", () => {
    // Nothing has been spawned to stop and start over, but the call can still
    // be given up on.
    expect(pressMixed("s", 0)?.action).toEqual({ kind: "skip", index: 0 });
    expect(pressMixed("r", 0)).toBeUndefined();
  });

  it("refuses both on an agent that has already settled", () => {
    // Its `agent()` call has its value; there is nothing left to skip or redo.
    expect(pressMixed("s", 2)).toBeUndefined();
    expect(pressMixed("r", 2)).toBeUndefined();
  });

  it("refuses both once the run itself has stopped", () => {
    const settled = input({
      progress: mixed,
      task: { status: "killed", startTime: START, endTime: START + 10 },
      state: { level: "agent", selectedAgent: 1 },
    });
    const view = resolveWorkflowDialog(settled);
    expect(handleWorkflowDialogKey("s", settled.state, view)).toBeUndefined();
    expect(handleWorkflowDialogKey("r", settled.state, view)).toBeUndefined();
  });

  it("leaves an unbound key alone", () => {
    expect(press("z")).toBeUndefined();
  });

  it("refuses the run-level actions once the run has settled", () => {
    // The footer already hides `x stop` and `p pause` on a finished run, so the
    // keys have to agree: stopping something that already stopped reports a
    // success that did not happen.
    for (const status of ["completed", "failed", "killed"] as const) {
      const settled = input({ progress, task: { status, startTime: START, endTime: START + 10 } });
      const view = resolveWorkflowDialog(settled);
      expect(handleWorkflowDialogKey("x", settled.state, view)).toBeUndefined();
      expect(handleWorkflowDialogKey("p", settled.state, view)).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Frame height
 * ------------------------------------------------------------------------- */

describe("frame height", () => {
  /** Every row of the frame's body, padding included — the box's real height. */
  const bodyHeight = (over: DialogOverrides): number => cells(dialog(over)).length;

  const phased = (agents: number): WorkflowEntry[] => [
    { type: "workflow_phase", index: 0, title: "Review" },
    ...Array.from({ length: agents }, (_, i) =>
      agentEntry({ index: i, label: `a${i}`, phaseIndex: 0, state: "done" }),
    ),
  ];

  it("sizes the box to its content instead of a fixed height", () => {
    // A three-agent run in a twenty-two row box is twenty rows of nothing,
    // sitting in the conversation under everything else that happened.
    expect(bodyHeight({ progress: phased(3) })).toBeLessThan(DEFAULT_PANE_BODY_ROWS);
  });

  it("keeps a floor so a one-agent run still reads as a pane", () => {
    expect(bodyHeight({ progress: phased(1) })).toBe(MIN_PANE_BODY_ROWS);
  });

  it("grows with the content", () => {
    const small = bodyHeight({ progress: phased(3) });
    const large = bodyHeight({ progress: phased(12) });
    expect(large).toBeGreaterThan(small);
    expect(large).toBe(12);
  });

  it("stops growing at the cap, however large the run", () => {
    // A 200-agent fan-out must not paste 200 rows into the scrollback; the
    // window inside the pane is what scrolls instead.
    expect(bodyHeight({ progress: phased(200) })).toBe(DEFAULT_PANE_BODY_ROWS);
  });

  /**
   * The detail pane is the one thing in the dialog that is never windowed — an
   * expanded prompt is however many lines the prompt has — so it is where the
   * cap has to actually hold.
   */
  const longPrompt: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "Review" },
    agentEntry({
      index: 0,
      label: "a",
      phaseIndex: 0,
      state: "done",
      promptPreview: Array.from({ length: 60 }, (_, i) => `prompt line ${i}`).join("\n"),
    }),
  ];
  const expanded = { level: "agent" as const, promptExpanded: true };

  it("caps the detail pane when a long prompt is expanded", () => {
    expect(bodyHeight({ progress: longPrompt, state: expanded })).toBe(DEFAULT_PANE_BODY_ROWS);
  });

  it("honours an explicit cap from the caller", () => {
    expect(bodyHeight({ progress: longPrompt, state: expanded, bodyRows: 9 })).toBe(9);
    expect(bodyHeight({ progress: phased(200), bodyRows: 9 })).toBe(9);
  });
});

/* ------------------------------------------------------------------------- *
 * Width
 * ------------------------------------------------------------------------- */

describe("width", () => {
  const wide: WorkflowEntry[] = [
    { type: "workflow_phase", index: 0, title: "A phase title that runs on well past any sane terminal width" },
    agentEntry({
      index: 0,
      label: "an-extremely-long-agent-label-that-would-otherwise-wrap-the-whole-dialog",
      state: "done",
      agentType: "general-purpose",
      model: "claude-opus-4-5-20260101",
      tokens: 1_240_000,
      toolCalls: 412,
      durationMs: 3_723_000,
      promptPreview: "a prompt line long enough to overflow a narrow terminal all by itself",
      resultPreview: "an outcome line long enough to overflow a narrow terminal all by itself",
    }),
  ];

  it("reserves six columns of chrome from the terminal width", () => {
    expect(workflowDialogContentWidth(86)).toBe(80);
    expect(Math.max(...dialog({ progress: wide, width: 86 }).map(visibleWidth))).toBe(80);
  });

  it("floors the content width at 12 rather than going negative", () => {
    expect(workflowDialogContentWidth(4)).toBe(12);
    // Without the floor the layout would clamp every line to nothing at all.
    const lines = dialog({ progress: wide, width: 4 });
    expect(Math.max(...lines.map(visibleWidth))).toBe(12);
  });

  it("never exceeds the content width", () => {
    for (const width of [4, 12, 20, 40, 80]) {
      const lines = dialog({ progress: wide, width });
      const content = workflowDialogContentWidth(width);
      expect(lines.length).toBeGreaterThan(5);
      for (const line of lines) expect(visibleWidth(line), `w=${width}`).toBeLessThanOrEqual(content);
    }
  });

  it("counts wide characters rather than code points", () => {
    const lines = dialog({
      progress: [agentEntry({ index: 0, label: "日本語のラベルがとても長い場合の折り返し確認", toolCalls: 3 })],
      width: 30,
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  });
});

/* ------------------------------------------------------------------------- *
 * Header
 * ------------------------------------------------------------------------- */

describe("replayed rows", () => {
  it("annotates a replayed agent's row in the agents pane", () => {
    // The helper is unit-tested above; this pins that the row actually carries
    // it, which is the thing a person resuming a run looks at.
    const lines = dialog({
      progress: [
        agentEntry({ index: 0, label: "audit", state: "done", cached: true }),
        agentEntry({ index: 1, label: "verify", state: "done" }),
      ],
      now: START,
    });

    const audit = lines.find(line => line.includes("audit"))!;
    const verify = lines.find(line => line.includes("verify"))!;
    expect(audit).toContain("from resume journal");
    expect(verify).not.toContain("resume journal");
  });
});

describe("header", () => {
  it("carries the shared N/M agents · elapsed line and the run's subtext", () => {
    const lines = dialog({
      progress: [
        agentEntry({ index: 0, state: "done" }),
        agentEntry({ index: 1, state: "start", startedAt: START }),
      ],
      meta: { name: "review-changes", description: "Review changed files" },
      now: START + 72_000,
    });
    // The run's own name leads, with the description and the counters under
    // it — the tool's name is the card's job, not the dialog's.
    expect(lines[0]).toBe(" review-changes");
    expect(lines[1]).toContain("Review changed files");
    expect(lines[1]).toContain("1/2 agents · 1m12s");
  });
});

/* ------------------------------------------------------------------------- *
 * Component
 * ------------------------------------------------------------------------- */

describe("WorkflowDialog component", () => {
  const source = () => ({
    progress: [agentEntry({ index: 7, label: "only", state: "done" })],
    task: { status: "running" as const, workflowName: "wf", startTime: START },
  });

  /** The same run with its only agent still going, so the per-agent keys apply. */
  const liveSource = () => ({
    progress: [agentEntry({ index: 7, label: "only", state: "progress", queuedAt: START, startedAt: START })],
    task: { status: "running" as const, workflowName: "wf", startTime: START },
  });

  function harness(
    from: () => ReturnType<typeof source> = source,
  ): { dialog: WorkflowDialog; calls: string[]; closed: boolean[] } {
    const calls: string[] = [];
    const closed: boolean[] = [];
    const tui = { requestRender: () => calls.push("render") } as unknown as never;
    const instance = new WorkflowDialog(
      tui,
      from,
      theme,
      () => closed.push(true),
      {
        onKill: () => calls.push("kill"),
        onPause: () => calls.push("pause"),
        onSkipAgent: (index: number) => calls.push(`skip:${index}`),
        onRetryAgent: (index: number) => calls.push(`retry:${index}`),
      },
    );
    return { dialog: instance, calls, closed };
  }

  it("themes the layout and keeps its line count", () => {
    const { dialog: instance } = harness();
    const rendered = instance.render(86);
    expect(rendered).toHaveLength(
      layoutWorkflowDialog({ ...source(), state: initialWorkflowDialogState(), width: 86 }).length,
    );
    expect(rendered[0]).toContain("<toolTitle>*wf*</toolTitle>");
    expect(rendered.join("\n")).toContain("<success>✔</success>");
    instance.dispose();
  });

  it("dispatches the injected actions and closes on escape", () => {
    const { dialog: instance, calls, closed } = harness(liveSource);
    instance.handleInput("x");
    instance.handleInput("p");
    instance.handleInput("s");
    instance.handleInput("r");
    expect(calls.filter(c => c !== "render")).toEqual(["kill", "pause", "skip:7", "retry:7"]);
    expect(closed).toHaveLength(0);
    instance.handleInput("\x1b");
    expect(closed).toEqual([true]);
    instance.dispose();
  });

  it("keeps its state across keypresses", () => {
    const { dialog: instance } = harness();
    // Opening a phase is state the next render has to still be in.
    instance.handleInput("\r");
    expect(instance.render(86).some(l => l.includes("Prompt"))).toBe(true);
    instance.dispose();
  });
});

describe("key hints reflect the wired actions", () => {
  const live: WorkflowEntry[] = [
    { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "progress", startedAt: START },
  ];
  // Wide enough that the footer is never clipped — these assert which hints are
  // present, not how they truncate (that is covered by the width tests).
  // The footer is the last line, and the per-agent keys only exist in the
  // subview — so a test about skip/retry has to be looking at that level.
  const hintLine = (over: DialogOverrides) => dialog({ width: 200, ...over }).at(-1) ?? "";
  const agentHints = (over: DialogOverrides) =>
    hintLine({ ...over, state: { ...over.state, level: "agent" } });

  it("advertises the overview's own keys", () => {
    const hints = hintLine({ progress: live });
    for (const key of ["↑↓ select", "⏎ open", "f filter", "p pause", "x stop", "esc close"]) {
      expect(hints).toContain(key);
    }
    // Nothing that belongs to a single agent, because none is open.
    expect(hints).not.toContain("s skip");
  });

  it("advertises every per-agent key when availability is not declared", () => {
    const hints = agentHints({ progress: live });
    for (const key of ["↑↓ agent", "s skip", "r retry", "p pause", "x stop", "esc back"]) {
      expect(hints).toContain(key);
    }
  });

  it("hides the keys the caller did not wire", () => {
    // A caller that wires only onKill must not advertise skip/retry/pause —
    // a footer promising a key that silently does nothing is worse than no key.
    const hints = agentHints({
      progress: live,
      available: { onKill: true, onPause: false, onResume: false, onSkipAgent: false, onRetryAgent: false },
    });
    expect(hints).toContain("x stop");
    expect(hints).toContain("esc back");
    expect(hints).not.toContain("s skip");
    expect(hints).not.toContain("r retry");
    expect(hints).not.toContain("p pause");
  });

  it("offers skip but not retry on an agent that has not started", () => {
    const queued: WorkflowEntry[] = [
      { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "start", queuedAt: START },
    ];
    const hints = agentHints({ progress: queued });
    expect(hints).toContain("s skip");
    // There is no child to stop and start again yet.
    expect(hints).not.toContain("r retry");
  });

  it("offers neither once the agent has settled", () => {
    const settled: WorkflowEntry[] = [
      { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "done" },
    ];
    const hints = agentHints({ progress: settled });
    expect(hints).not.toContain("s skip");
    expect(hints).not.toContain("r retry");
  });

  it("hides stop when kill is not wired", () => {
    expect(hintLine({ progress: live, available: { onKill: false } })).not.toContain("x stop");
  });

  it("hides resume on a paused run when resume is not wired", () => {
    const hints = hintLine({
      progress: live,
      task: { status: "paused", startTime: START },
      available: { onResume: false },
    });
    expect(hints).not.toContain("p resume");
  });
});

describe("component availability", () => {
  const tui = { requestRender: () => {} } as unknown as never;
  const liveSource = () => ({
    progress: [
      { type: "workflow_agent", index: 0, label: "a", phaseIndex: 0, state: "progress", startedAt: START },
    ] as WorkflowEntry[],
    task: { status: "running", workflowName: "wf", startTime: START } as WorkflowCardTask,
  });
  /** The footer of the subview, where the per-agent keys are advertised. */
  const footer = (instance: WorkflowDialog) => {
    instance.handleInput("\r");
    return instance.render(200).at(-1) ?? "";
  };

  it("advertises only the actions it was given", () => {
    // Wiring just onKill must not promise skip/retry/pause.
    const instance = new WorkflowDialog(tui, liveSource, theme, () => {}, { onKill: () => {} });
    const hints = footer(instance);
    expect(hints).toContain("x stop");
    expect(hints).not.toContain("s skip");
    expect(hints).not.toContain("r retry");
    expect(hints).not.toContain("p pause");
    instance.dispose();
  });

  it("advertises the full set when every action is wired", () => {
    const instance = new WorkflowDialog(tui, liveSource, theme, () => {}, {
      onKill: () => {}, onPause: () => {}, onResume: () => {},
      onSkipAgent: () => {}, onRetryAgent: () => {},
    });
    const hints = footer(instance);
    for (const key of ["s skip", "r retry", "p pause", "x stop"]) expect(hints).toContain(key);
    instance.dispose();
  });

  it("advertises nothing actionable when no actions are wired", () => {
    const instance = new WorkflowDialog(tui, liveSource, theme, () => {});
    const hints = footer(instance);
    for (const key of ["s skip", "r retry", "p pause", "x stop"]) expect(hints).not.toContain(key);
    expect(hints).toContain("esc back");
    instance.dispose();
  });
});
