/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list, nested
 * subagents indented under their parent (`├`/`└`). Pressing ↓ (or ←) at an empty
 * prompt activates the list; ↑/↓ move the `❯` cursor, Enter opens the selected
 * agent's live conversation overlay, Esc returns to the prompt. `●` marks the view
 * in front (`main`, or the open overlay's agent). In pi's fullscreen mode the mouse
 * works too: hover moves the cursor, a click opens the row.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { isKeyRelease, Key, matchesKey, type ScrollViewScrollbar, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { agentTree } from "./agent-tree.js";
import { type AgentActivity, buildInvocationTags, formatCost, type Theme } from "./agent-widget.js";
import { ConversationViewer, getConversationOverlayOptions, type ViewerBackgroundAction } from "./conversation-viewer.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => {
      render(width: number): string[];
      invalidate(): void;
      dispose?(): void;
      handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
    }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
/** `prefix` is the tree glyphs before the dot: `""` at top level, `├ `/`└ ` (plus `│ ` continuations) below. */
type AgentEntry = { kind: "agent"; record: AgentRecord; prefix: string };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /**
   * Roster index under the mouse pointer (fullscreen mode only), shown as the
   * `❯` cursor while the keyboard is not navigating. The renderer sends no
   * leave event, so it clears on a move over a non-row line or on any key.
   */
  private hoverIndex: number | undefined;
  /** Roster index of each line the last render emitted; `undefined` for non-row lines. */
  private lineRoster: (number | undefined)[] = [];
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
    private scrollbarMode: () => ScrollViewScrollbar = () => "auto",
    /**
     * The viewer's `b` for this row's run, supplied by the extension: only it
     * knows which runs have a tool call waiting to be released, and it owns the
     * widget this list shares with. Omitted → no `b` affordance.
     */
    private backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction,
    /**
     * Read live at render time, like `showCost`. Whether each row names the
     * model driving the run and the thinking level it is running at. Defaults to
     * off — the extension supplies the user's `showModel` setting — because the
     * row is already dense and the same pair is shown unconditionally in the
     * conversation viewer and the `Agent` tool result.
     */
    private showModel: () => boolean = () => false,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers in the list — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;
    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.enabled && this.roster().length > 1;

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
          handleMouse: (event: TuiMouseEvent) => this.handleMouse(event),
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Agents shown in the list, as a tree: each top-level agent, then its nested
   * children depth-first under it, siblings earliest-launched first so the ones
   * started sooner sit at the top. Every row is openable (has a session), so Enter
   * never dead-ends. Included: running/queued, plus the agent currently being
   * viewed, plus recently-finished ones (they linger briefly before dropping out).
   * Pending agents with no session yet are hidden until they start.
   * (`listAgents()` is newest-first, so we re-sort.)
   *
   * Nested children get rows of their own here (`agentTree`), as in Claude
   * Code's FleetView, so each row shows its own usage rather than a rolled-up total.
   * A child shows only under a visible parent. A workflow's agents stay out —
   * the run's own row and inspector cover them.
   */
  private agentEntries(): AgentEntry[] {
    const now = Date.now();
    const all = this.manager.listAgents();
    // The viewed agent stays listed, and a nested one needs its ancestors to
    // hang from: they settle together (a parent stops its children), so the
    // parent would otherwise drop out first and take the viewed row with it.
    const pinned = new Set<string>();
    for (let id = this.viewingAgentId; id !== undefined && !pinned.has(id); ) {
      pinned.add(id);
      id = all.find(a => a.id === id)?.parentAgentId;
    }
    const visible = all
      .filter(a => a.workflowId === undefined && a.session && (
        a.status === "running" || a.status === "queued"
        || pinned.has(a.id)
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      ))
      .sort((a, b) => a.startedAt - b.startedAt);
    return agentTree(visible).map(({ record, prefix }) => ({ kind: "agent", record, prefix }));
  }

  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentEntries(),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
    if (this.hoverIndex !== undefined && this.hoverIndex > max) this.hoverIndex = undefined;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    // A key means the user went back to the keyboard. While navigating, it acts
    // on the row the `❯` is on, so take the hover over as the selection; either
    // way drop it, or it would sit wherever the pointer last crossed the list.
    if (this.active && this.hoverIndex !== undefined) this.selectedIndex = this.hoverIndex;
    this.hoverIndex = undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedIndex = 0;
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, Esc / Up-past-top exits.
    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) { this.deactivate(); return { consume: true }; }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * Hover and click on rows. Only reaches us in pi's fullscreen mode, where the
   * renderer captures the mouse and routes an event to the below-editor widget
   * under the pointer; `regular` mode sends none. Guarded like `handleKey`, so
   * a click never acts behind an overlay or a dialog.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.enabled || !this.ui) return undefined;
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    if (!this.editorHasFocus()) return undefined;
    const index = this.lineRoster[event.y];
    if (event.type === "move") {
      // Hover never moves `selectedIndex`: that re-windows a scrolled list,
      // which would shift the rows under the pointer. A key adopts the hover.
      if (index === this.hoverIndex) return undefined;
      this.hoverIndex = index;
      return { handled: true, render: true };
    }
    if (index === undefined || event.button !== "left") return undefined;
    // Claim the press: the renderer only sends `click` to the component that
    // handled it, and otherwise starts a text selection.
    if (event.type === "press") return { handled: true };
    if (event.type === "click") {
      this.hoverIndex = undefined;
      this.selectedIndex = index;
      this.openSelected();
      return { handled: true };
    }
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. The editor is pluggable
   * (ui.setEditorComponent) and need not extend `Editor` (#374), so match pi-tui's
   * `EditorComponent` contract instead: `getText` + `setText`, which pi calls on
   * every editor and none of pi's dialogs, selectors or overlays implement.
   * `focusedComponent` is TUI-private (no public accessor), hence the best-effort
   * peek: unknowable focus (no tui seen yet, nothing focused) counts as the
   * editor so activation keeps working.
   */
  editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    if (focused == null) return true;
    const c = focused as { getText?: unknown; setText?: unknown };
    return typeof c.getText === "function" && typeof c.setText === "function";
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      void Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
      return;
    }
    const record = entry.record;
    if (!this.ui) return;
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;
    let overlayOptions = getConversationOverlayOptions({ mode: "regular" });

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        overlayOptions = getConversationOverlayOptions(tui);
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
          this.scrollbarMode(),
          this.backgroundAction?.(record, message => this.ui?.notify(message, "info")),
        );
      },
      {
        overlay: true,
        overlayOptions: () => overlayOptions,
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "workflow" ? e.workflow.id === viewed
        : false,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as (WorkflowEntry | AgentEntry)[];
    if (rows.length === 0) { this.lineRoster = []; return []; }
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);
    // The `❯` row: the hover, else the keyboard's selection while it navigates.
    const cursor = this.hoverIndex ?? (this.active ? sel : undefined);

    const hint = this.active
      ? "↑↓ select · enter view · esc back"
      : "esc to interrupt · ← for agents · ↓ to manage";
    const lines: string[] = [];
    const lineRoster: (number | undefined)[] = [];
    const push = (line: string, rosterIndex?: number): void => {
      lines.push(line);
      lineRoster.push(rosterIndex);
    };
    push(truncateToWidth("  " + theme.fg("dim", hint), width));
    push("");
    const mainInFront = this.viewingAgentId === undefined && this.viewingWorkflowId === undefined;
    push(truncateToWidth(`${this.gutter(0, cursor, theme)}${this.dot(mainInFront, theme)} main`, width), 0);

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(a + 1, cursor, row.workflow, width, theme)
        : this.renderAgentRow(a + 1, cursor, row, width, theme),
        a + 1,
      );
    }
    if (hiddenBelow > 0) push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    // pi stacks below-editor widgets directly on its footer with no spacer (#351).
    push("");

    this.lineRoster = lineRoster;
    return lines;
  }

  /**
   * The two columns every row starts with: Claude Code's `❯` on the cursor row,
   * blank elsewhere — so moving the cursor never shifts a row's width.
   */
  private gutter(rosterIndex: number, cursor: number | undefined, theme: Theme): string {
    return rosterIndex === cursor ? `${theme.fg("accent", "❯")} ` : "  ";
  }

  /** `●` on the view in front — `main`, or the row whose overlay is open — `○` elsewhere. */
  private dot(inFront: boolean, theme: Theme): string {
    return inFront ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — gutter, dot, kind, name, stats flush
   * right — so the two read as one list, with the agent count where an agent
   * has its description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    cursor: number | undefined,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
  ): string {
    const selected = rosterIndex === cursor;
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const dot = this.dot(workflow.id === this.viewingWorkflowId, theme);
    const left = `${this.gutter(rosterIndex, cursor, theme)}${dot} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  private renderAgentRow(
    rosterIndex: number,
    cursor: number | undefined,
    entry: AgentEntry,
    width: number,
    theme: Theme,
  ): string {
    const { record, prefix } = entry;
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === cursor;
    const name = renderAgentName(record.type, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const description = selected ? theme.fg("text", record.description) : record.description;
    const tree = prefix ? theme.fg("dim", prefix) : "";
    const dot = this.dot(record.id === this.viewingAgentId, theme);
    let left = `${this.gutter(rosterIndex, cursor, theme)}${tree}${dot} ${name}  ${description}`;
    if (this.showModel()) {
      // After the description, not in the stats: rightAlign truncates only the
      // left side, so here the model is cut first and the name survives. Bare
      // level (`sonnet 4.6 · high`), matching the widget's running line.
      const { modelName, thinking } = buildInvocationTags(record.invocation);
      const model = [modelName, thinking].filter(Boolean).join(" · ");
      if (model) left += theme.fg(selected ? "text" : "dim", ` · ${model}`);
    }
    // The record, not the activity tracker: only the record outlives the agent.
    // Its OWN usage, not `lifetimeUsage` — that one folds in every descendant,
    // and the descendants have rows of their own here.
    const tokens = getLifetimeTotal(record.ownUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.ownUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
