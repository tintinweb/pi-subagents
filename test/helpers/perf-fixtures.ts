/**
 * perf-fixtures.ts — the stubs the performance suite measures against.
 *
 * Three consumers share this: the benchmarks (`test/perf/*.bench.ts`), the
 * invariant guards (`test/perf/*.perf.test.ts`), and the A/B harness
 * (`test/perf/ab.mjs`), which copies this file into a worktree of an older
 * commit and runs the same benchmarks there. That last consumer is why the
 * builders here stay structural — plain object literals satisfying the shapes
 * `AgentWidget`, `FleetList` and `ConversationViewer` accept — rather than
 * importing anything from `src/`. A fixture that reached into production types
 * would stop compiling the moment it travelled to a tree where those types
 * differ, which is exactly the tree the comparison exists to measure.
 *
 * DETERMINISM RULES, all of them learned from a measurement that lied:
 *
 *  - `NOW` is captured once at import and every `startedAt` is derived from it,
 *    so the elapsed string keeps a stable character *width*. A hardcoded epoch
 *    rendered `87563024.1s` in one run and `87563018.2s` in the next — one digit
 *    wider, so a different truncation point, so a different amount of work. The
 *    diff looked like a regression and was a clock.
 *  - Nothing inside a measured closure calls `Date.now()` or allocates the
 *    fixture; build it once, outside, and measure only the call under test.
 *  - Surplus constructor arguments are passed unconditionally. JavaScript
 *    ignores extra arguments, which is what lets one benchmark file run against
 *    an older tree whose constructor took fewer. Do NOT feature-detect with
 *    `AgentWidget.length`: parameters that have defaults are not counted, so it
 *    reports the wrong arity and silently measures the wrong configuration.
 */

/** Identity theme: measure the render, not the ANSI. */
export const perfTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

/** Frozen "now". Every timestamp below hangs off this — see the header. */
export const NOW = Date.now();

/** A TUI stub. `columns` is read by widgets that size themselves. */
export function perfTui(columns = 120, rows = 40) {
  return { terminal: { columns, rows }, requestRender: () => {} } as any;
}

/**
 * A session stub reporting live stats.
 *
 * Both halves are load-bearing. `FleetList.agentRecords()` filters on
 * `a.session`, so a record without one is invisible to the fleet list and the
 * benchmark silently measures an empty bar. And `getSessionContextPercent()`
 * reads `getSessionStats().contextUsage`, which the widget calls once per
 * running agent per frame — returning stats rather than throwing is what keeps
 * that call on the path it takes in production instead of its catch branch.
 */
export function perfSession(messages: unknown[] = []) {
  return {
    messages,
    subscribe: () => () => {},
    dispose: () => {},
    getSessionStats: () => ({
      tokens: { input: 12_000, output: 3_000, cacheWrite: 500 },
      contextUsage: { percent: 42 },
    }),
  } as any;
}

export interface FleetOptions {
  running?: number;
  queued?: number;
  finished?: number;
}

/**
 * One agent record. `i` seeds every varying field so a fleet is heterogeneous
 * (two agent types, growing token counts) without being random — a benchmark
 * that changes shape between runs cannot be compared with itself.
 */
export function makeRecord(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `perf-agent-${i}`,
    type: i % 3 === 0 ? "Explore" : "general-purpose",
    description: `agent ${i} inspecting a subsystem for the benchmark fixture`,
    status: "running",
    toolUses: i % 7,
    // Recent and fixed: a ~1s elapsed renders as a stable-width "1.0s".
    startedAt: NOW - 1000 - (i % 5) * 100,
    completedAt: undefined as number | undefined,
    lifetimeUsage: { input: 1000 + i * 37, output: 200 + i * 11, cacheRead: 0, cacheWrite: 0 },
    compactionCount: i % 3,
    invocation: {
      modelName: "sonnet 4.6",
      modelId: "anthropic/claude-sonnet-4-6",
      thinking: "high",
      runInBackground: true,
    },
    isBackground: true,
    session: perfSession(),
    ...overrides,
  };
}

/** A fleet in the mix the widget actually renders: running, queued, finished. */
export function makeFleet(opts: FleetOptions = {}): ReturnType<typeof makeRecord>[] {
  const { running = 3, queued = 0, finished = 0 } = opts;
  const out: ReturnType<typeof makeRecord>[] = [];
  let i = 0;
  for (let n = 0; n < running; n++) out.push(makeRecord(i++));
  for (let n = 0; n < queued; n++) out.push(makeRecord(i++, { status: "queued" }));
  for (let n = 0; n < finished; n++) out.push(makeRecord(i++, { status: "completed", completedAt: NOW }));
  return out;
}

/** Live per-agent activity, keyed by id, as the widget and fleet list expect. */
export function makeActivity(records: { id: string; toolUses: number }[]): Map<string, any> {
  return new Map(
    records.map(r => [
      r.id,
      {
        activeTools: new Map(),
        toolUses: r.toolUses,
        responseText: "working on the fixture",
        turnCount: 2,
        session: perfSession(),
      },
    ]),
  );
}

/** A manager stub. `listAgents` is a plain function so a guard can count calls. */
export function makeManager(records: unknown[]) {
  return {
    listAgents: () => records,
    listTombstones: () => [],
    getRecord: (id: string) => records.find(r => (r as { id: string }).id === id),
    getMaxConcurrent: () => 4,
  } as any;
}

// ---- Conversation fixtures ----

/** Prose long enough to wrap several times at any realistic viewer width. */
const PARAGRAPH =
  "The subagent inspected the module and found that the render path rebuilds " +
  "its content on every frame, which is fine for a short transcript and not " +
  "fine for a long one. Here is what it looked like in practice, at width 120.";

/** Assistant text carries markdown, because since #259 that is what gets parsed. */
const ASSISTANT_MARKDOWN =
  `## Findings\n\n${PARAGRAPH}\n\n- the first observation, which wraps\n` +
  "- the second observation\n\n```ts\nconst x = compute(input);\n```\n";

/** A tool result: arbitrary bytes, rendered raw, capped by the viewer at 16 KB. */
const TOOL_RESULT = `${PARAGRAPH}\n${PARAGRAPH}\n`;

/**
 * A synthetic transcript of `n` messages, cycling user → assistant → toolResult.
 *
 * Message objects are stable across renders on purpose: the viewer's Markdown
 * cache is a `WeakMap` keyed by the message, so reusing one session across
 * iterations measures the warm path a real viewer sees on its second frame
 * onward. Build a fresh session to measure the cold one.
 */
export function makeSession(n: number) {
  const messages: any[] = [];
  for (let i = 0; i < n; i++) {
    const slot = i % 3;
    if (slot === 0) {
      messages.push({ role: "user", content: `Message ${i}: ${PARAGRAPH}` });
    } else if (slot === 1) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `${ASSISTANT_MARKDOWN}\n(message ${i})` },
          { type: "toolCall", name: "read" },
        ],
      });
    } else {
      messages.push({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: `${TOOL_RESULT}(result ${i})` }],
      });
    }
  }
  return {
    messages,
    subscribe: () => () => {},
    dispose: () => {},
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
  } as any;
}

// ---- Render harnesses ----

/**
 * Drive `AgentWidget` the way pi does: capture the component factory the widget
 * registers, then render it. Returns the factory so a caller can render
 * repeatedly without paying for construction — `renderWidget()` is the
 * per-frame path, `update()` is the 80 ms-timer path, and they are separate
 * measurements.
 */
export function mountWidget(
  Widget: any,
  records: unknown[],
  opts: { mode?: string; showCost?: boolean; showModel?: boolean } = {},
) {
  const widget = new Widget(
    makeManager(records),
    makeActivity(records as { id: string; toolUses: number }[]),
    () => opts.mode ?? "all",
    () => opts.showCost ?? false,
    () => opts.showModel ?? false,
  );
  let factory: any;
  widget.setUICtx({
    setStatus: () => {},
    setWidget: (_key: string, content: any) => { factory = content; },
  });
  widget.update();
  const tui = perfTui();
  // Prime: invoking the factory once is what hands the widget its TUI handle, so
  // `update()` afterwards takes the registered path (requestRender) it takes in
  // production rather than the colder first-registration branch.
  factory?.(tui, perfTheme).render();
  return {
    widget,
    /** One frame. Returns the produced lines so a caller can assert on them. */
    render: (): string[] => (factory ? factory(tui, perfTheme).render() : []),
    update: () => widget.update(),
    dispose: () => widget.dispose?.(),
  };
}

/** Drive `FleetList`: same idea, but its widget renders at an explicit width. */
export function mountFleet(FleetList: any, records: unknown[]) {
  const fleet = new FleetList(makeManager(records), makeActivity(records as { id: string; toolUses: number }[]));
  let factory: any;
  fleet.setUICtx({
    setWidget: (_key: string, content: any) => { factory = content; },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    notify: () => {},
    custom: () => new Promise(() => {}),
  });
  fleet.update();
  const tui = perfTui();
  factory?.(tui, perfTheme).render(120); // prime, as above
  return {
    fleet,
    render: (width = 120): string[] => (factory ? factory(tui, perfTheme).render(width) : []),
    update: () => fleet.update(),
    dispose: () => fleet.dispose?.(),
  };
}

/** Construct a `ConversationViewer` over a synthetic session. */
export function mountViewer(
  Viewer: any,
  session: any,
  record: unknown = makeRecord(0),
  markdownMode?: () => string,
) {
  const viewer = new Viewer(
    perfTui(120, 40),
    session,
    record,
    undefined,
    perfTheme,
    () => {},
    undefined,
    undefined,
    undefined,
    false,
    markdownMode,
  );
  return viewer;
}
