/**
 * no-fs-on-render.perf.test.ts — a frame must not touch the disk.
 *
 * The widget and the conversation viewer redraw on every TUI frame, so a
 * synchronous read on either path blocks the event loop at up to 62 Hz. Nothing
 * on those paths reads today; this is the guard that keeps it that way, because
 * the mistake is easy to make and impossible to see in a functional test — the
 * output is identical either way, only the terminal stutters.
 *
 * `node:fs` is mocked wholesale rather than spied on: `src/` imports its
 * functions by name (`import { readFileSync } from "node:fs"`), and a named ESM
 * binding cannot be replaced after the importing module has been evaluated.
 *
 * Lives in its own file because that mock applies to the whole module graph;
 * the other guards must not inherit it.
 */
import { describe, expect, it, vi } from "vitest";

/** Every fs entry point a render path could plausibly reach. */
const FS_CALLS: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const watch = ["readFileSync", "readdirSync", "existsSync", "statSync", "lstatSync", "realpathSync"] as const;
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of watch) {
    const original = (actual as any)[name];
    wrapped[name] = (...args: unknown[]) => {
      FS_CALLS.push(`${name}(${String(args[0])})`);
      return original(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const { AgentWidget } = await import("../../src/ui/agent-widget.js");
const { ConversationViewer } = await import("../../src/ui/conversation-viewer.js");
const { makeFleet, makeSession, mountViewer, mountWidget } = await import("../helpers/perf-fixtures.js");

describe("a rendered frame touches no filesystem", () => {
  it("AgentWidget.render", () => {
    const w = mountWidget(AgentWidget, makeFleet({ running: 5, queued: 3, finished: 2 }));
    w.render(); // construction and priming may legitimately read; the frame may not
    FS_CALLS.length = 0;

    w.render();
    w.render();
    w.dispose();

    expect(FS_CALLS).toEqual([]);
  });

  it("ConversationViewer.render", () => {
    const viewer = mountViewer(ConversationViewer, makeSession(40));
    viewer.render(120);
    FS_CALLS.length = 0;

    viewer.render(120);
    viewer.render(120);

    expect(FS_CALLS).toEqual([]);
  });
});
