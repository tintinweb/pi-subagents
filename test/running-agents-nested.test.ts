/**
 * running-agents-nested.test.ts — `/agents → Running agents` lists nested
 * subagents under their parent, through the REAL extension.
 *
 * FleetView drops a finished row after its linger; this list keeps agents
 * until eviction, so it is where a finished nested child stays reachable.
 * Workflow agents stay out: the workflow inspector covers them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[MANAGER_KEY];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;

/**
 * Boots the extension with runs that never settle. The run for `parent` spawns
 * a nested child and a workflow-owned agent through the manager it is handed,
 * the way the nested Agent tool and a workflow would.
 */
function boot() {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, schedulingEnabled: false, defaultJoinMode: "async" },
  });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any, opts: any) =>
    new Promise<any>(() => {
      opts.onSessionCreated?.({
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        messages: [],
        getActiveToolNames: vi.fn(() => []),
      });
      if (prompt !== "parent") return;
      const manager = opts.nestedRuntime.manager;
      manager.spawn(b.pi, ctx(), "Explore", "child", {
        description: "nested job", parentAgentId: opts.agentId, depth: 2, isBackground: true,
      });
      manager.spawn(b.pi, ctx(), "general-purpose", "workflow", {
        description: "workflow job", workflowId: "wf-1", isBackground: true,
      });
    }) as any,
  );
  return b;
}

describe("/agents → Running agents with nested subagents", () => {
  it("counts nested children, lists them under their parent, and opens the picked child", async () => {
    const { tools, commands } = boot();
    await tools.get("Agent").execute(
      "call-1",
      { prompt: "parent", description: "parent job", subagent_type: "general-purpose", run_in_background: true },
      new AbortController().signal,
      undefined,
      ctx(),
    );
    await flush();

    let menu: string[] = [];
    let list: string[] = [];
    let viewer: { handleInput(data: string): void } | undefined;
    let closeViewer: (() => void) | undefined;
    const picks = [
      (o: string[]) => { menu = o; return o.find(x => x.startsWith("Running agents (")); },
      (o: string[]) => { list = o; return o.find(x => x.includes("nested job")); },
    ];
    const ui = {
      setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn(),
      select: vi.fn(async (_title: string, options: string[]) => picks.shift()?.(options)),
      custom: vi.fn((factory: any) => new Promise<undefined>(resolve => {
        closeViewer = () => resolve(undefined);
        viewer = factory({ mode: "regular", requestRender() {}, terminal: { columns: 120, rows: 40 } }, theme, undefined, closeViewer);
      })),
    };
    const run = commands.get("agents").handler("", ctx({ hasUI: true, ui }));
    await vi.waitFor(() => expect(viewer).toBeDefined());

    expect(menu.find(x => x.startsWith("Running agents ("))).toBe("Running agents (2) — 2 running, 0 done");
    expect(list).toHaveLength(2);
    expect(list[0]).toMatch(/^1\. Agent \(parent job\)/);
    expect(list[1]).toMatch(/^2\. └ Explore \(nested job\)/);
    expect(list.some(x => x.includes("workflow job"))).toBe(false);

    // The viewer is the child's: stopping from it names the child.
    viewer!.handleInput("x");
    viewer!.handleInput("x");
    expect(ui.notify).toHaveBeenCalledWith('Stopped "nested job".', "info");

    closeViewer!();
    await run;
  });
});
