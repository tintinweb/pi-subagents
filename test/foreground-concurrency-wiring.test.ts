/**
 * foreground-concurrency-wiring.test.ts — `maxConcurrentForeground` (#253)
 * through the REAL extension, at the layer the setting exists to serve.
 *
 * pi's agent loop runs a message's tool calls through `Promise.all`, so two
 * blocking `Agent` calls in one message start within microseconds of each
 * other. These tests dispatch them the same way — two `execute()` calls without
 * awaiting the first — because that is the only shape in which the queue is
 * reachable, and it is the shape that constrains everything else here:
 *
 *   a tool `execute` that REJECTS rejects that whole Promise.all, killing
 *   unrelated tool calls in the same batch.
 *
 * So the Esc case below asserts `.resolves`, deliberately, not `.rejects`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  // The manager registry is a globalThis symbol released only on shutdown; a
  // test that threw first would leave the next one reading a dead manager.
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Boot the real extension with foreground concurrency pinned to one slot. */
function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, maxConcurrentForeground: 1, ...settings },
  });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** Runs that settle only when their resolver is called, keyed by prompt. */
function controllableRuns() {
  const resolvers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation(
    (_c: any, _t: any, prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        opts.onSessionCreated?.({
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          messages: [],
          getActiveToolNames: vi.fn(() => []),
        });
        resolvers.set(prompt as string, () => resolve({
          responseText: `${prompt}-RESULT`,
          session: { dispose: vi.fn() },
          aborted: false,
          steered: false,
        }));
      }) as any,
  );
  return resolvers;
}

/** Dispatch a blocking Agent call the way pi does — without awaiting it. */
function callForeground(tools: Map<string, any>, prompt: string, opts: {
  signal?: AbortSignal;
  onUpdate?: (u: any) => void;
} = {}) {
  return tools.get("Agent").execute(
    `tc-${prompt}`,
    { prompt, description: prompt, subagent_type: "general-purpose", run_in_background: false },
    opts.signal,
    opts.onUpdate,
    ctx(),
  );
}

describe("maxConcurrentForeground, through the Agent tool", () => {
  it("runs blocking calls one at a time and returns each its own result", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const first = callForeground(tools, "alpha");
    const second = callForeground(tools, "beta");
    await flush();

    // Only one started; "beta" is parked on the pool.
    expect(runAgent).toHaveBeenCalledTimes(1);

    resolvers.get("alpha")!();
    expect(textOf(await first)).toContain("alpha-RESULT");

    await flush();
    expect(runAgent).toHaveBeenCalledTimes(2);
    resolvers.get("beta")!();
    expect(textOf(await second)).toContain("beta-RESULT");
  });

  // The Promise.all constraint. A queued agent aborted by Esc must come back as
  // an ordinary stopped result, not as a throw that would take the batch down.
  it("resolves a queued call as STOPPED when the turn is interrupted", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const controller = new AbortController();
    const first = callForeground(tools, "alpha");
    const second = callForeground(tools, "beta", { signal: controller.signal });
    await flush();

    controller.abort();

    const result = await second; // resolves — never rejects
    expect(textOf(result)).toContain("STOPPED BY THE USER");
    expect(result.isError).toBeFalsy();

    // Freeing the slot must not start the agent the user just stopped.
    resolvers.get("alpha")!();
    await first;
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  // "thinking…" would be a lie for an agent that has not started and may not
  // for minutes. The row keeps its spinner either way — a status the renderer
  // does not know falls through to raw text and reads as hung.
  it("says it is queued in the live tool result, then stops saying it", async () => {
    const { tools } = boot();
    const resolvers = controllableRuns();

    const firstUpdates: any[] = [];
    const secondUpdates: any[] = [];
    const first = callForeground(tools, "alpha", { onUpdate: u => firstUpdates.push(u) });
    const second = callForeground(tools, "beta", { onUpdate: u => secondUpdates.push(u) });
    await flush();

    const queuedActivity = secondUpdates.map(u => u.details?.activity);
    expect(queuedActivity.some((a: string) => a?.includes("waiting for a foreground slot"))).toBe(true);
    expect(secondUpdates.at(-1)?.details?.status).toBe("running");
    // The agent that actually started never claims to be queued.
    expect(firstUpdates.every((u: any) => !u.details?.activity?.includes("queued"))).toBe(true);

    resolvers.get("alpha")!();
    await first;
    await flush();

    const afterStart = secondUpdates.at(-1)?.details?.activity;
    expect(afterStart).not.toContain("waiting for a foreground slot");

    resolvers.get("beta")!();
    await second;
  });

  it("leaves blocking calls unbounded when the setting is unset", async () => {
    const { tools } = boot({ maxConcurrentForeground: 0 });
    const resolvers = controllableRuns();

    const calls = ["a", "b", "c"].map(p => callForeground(tools, p));
    await flush();
    expect(runAgent).toHaveBeenCalledTimes(3);
    for (const p of ["a", "b", "c"]) resolvers.get(p)!();
    await Promise.all(calls);
  });
});
