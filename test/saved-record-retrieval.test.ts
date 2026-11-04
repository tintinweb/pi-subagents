/**
 * saved-record-retrieval.test.ts — get_subagent_result after the live record is gone.
 *
 * A completion notification carries only a preview and points at
 * get_subagent_result for the full text, but the live record is evicted ten
 * minutes after the agent finishes, read or not, and a reload drops it at once.
 * The final record is also appended to the session as a `subagents:record`
 * entry; get_subagent_result falls back to it.
 *
 * A second activation over the same session branch is the reload case, and the
 * same lookup as an evicted record: the manager has no record for the id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { type RunResult, resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;

beforeEach(() => {
  hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  // Release the globalThis manager registry even when a test throws before its own shutdown.
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Boot the extension with `appendEntry` landing on `branch`, as pi's session does. */
function boot(branch: any[]) {
  const { pi, tools, lifecycle } = makePi();
  pi.appendEntry = vi.fn((customType: string, data: unknown) => branch.push({ type: "custom", customType, data }));
  subagentsExtension(pi);
  booted = lifecycle;
  return { tools, lifecycle };
}

/**
 * Run an agent to completion in a first activation, optionally resume it in the
 * foreground, shut it down, and return the agent's id.
 */
async function finishedAgent(
  branch: any[],
  run: Partial<RunResult> = {},
  resumed?: Awaited<ReturnType<typeof resumeAgent>>,
  spawn: Record<string, unknown> = {},
): Promise<string> {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "THE-FULL-RESULT",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
    ...run,
  });
  const { tools, lifecycle } = boot(branch);
  const context = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
  const res = await tools
    .get("Agent")
    .execute(
      "tc-spawn",
      { prompt: "Review the change.", description: "Review the change", subagent_type: "Explore", run_in_background: false, ...spawn },
      undefined,
      undefined,
      context,
    );
  const id = (res as any).details.agentId;
  if (resumed) {
    vi.mocked(resumeAgent).mockResolvedValue(resumed);
    await tools
      .get("Agent")
      .execute("tc-resume", { prompt: "Continue.", description: "Continue", subagent_type: "Explore", resume: id, run_in_background: false }, undefined, undefined, context);
  }
  await lifecycle.get("session_shutdown")?.();
  booted = undefined;
  return id;
}

/** get_subagent_result in a fresh activation over the same branch. */
async function readAfterReload(branch: any[], agentId: string): Promise<string> {
  const { tools } = boot(branch);
  const read = await tools
    .get("get_subagent_result")
    .execute("tc-read", { agent_id: agentId }, undefined, undefined, ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } }));
  return textOf(read);
}

describe("get_subagent_result falls back to the saved record", () => {
  it("answers from the session's subagents:record entry once the live record is gone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch);
    expect(branch.some((entry) => entry.customType === "subagents:record" && entry.data.id === id)).toBe(true);

    const out = await readAfterReload(branch, id);
    expect(out).toContain(`Agent: ${id}`);
    expect(out).toContain("Status: completed");
    expect(out).toContain("THE-FULL-RESULT");
    expect(out).toContain("saved record");
  });

  it("answers with a foreground resume's outcome, not the earlier run's", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, {}, { text: "THE-RESUMED-RESULT", aborted: false, steered: false });

    const out = await readAfterReload(branch, id);
    expect(out).toContain("THE-RESUMED-RESULT");
    expect(out).not.toContain("THE-FULL-RESULT");
  });

  it("keeps a failed run's partial output, labelled as partial", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, { responseText: "THE-PARTIAL-OUTPUT", failure: "provider error" });

    const out = await readAfterReload(branch, id);
    expect(out).toContain("Status: error");
    expect(out).toContain("Error: provider error\n\nPartial output before the failure:\nTHE-PARTIAL-OUTPUT");
  });

  it("still reports an id with no saved record as not found", async () => {
    const branch: any[] = [];
    await finishedAgent(branch);

    expect(await readAfterReload(branch, "3f1320a7-74ec-422")).toContain("Agent not found");
  });

  it("answers by name and by type handle after reload, with no live record or tombstone", async () => {
    const branch: any[] = [];
    const id = await finishedAgent(branch, { responseText: "THE-NAMED-RESULT" }, undefined, { name: "auth-audit" });
    const saved = branch.find((entry) => entry.customType === "subagents:record" && entry.data.id === id);
    expect(saved.data).toMatchObject({ handle: "explore", alias: "auth-audit" });

    // A second activation has a new manager: no live record and no tombstone,
    // which is the reload case. The handle is stored lowercased; the call uses
    // the casing a person or the model might actually type.
    const { tools } = boot(branch);
    const context = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
    const read = (agentId: string) =>
      tools.get("get_subagent_result").execute("tc-read", { agent_id: agentId }, undefined, undefined, context).then(textOf);

    const byName = await read("Auth-Audit");
    expect(byName).toContain(`Agent: ${id}`);
    expect(byName).toContain("Status: completed");
    expect(byName).toContain("THE-NAMED-RESULT");
    expect(byName).toContain("saved record");

    const byType = await read("Explore");
    expect(byType).toContain(`Agent: ${id}`);
    expect(byType).toContain("THE-NAMED-RESULT");
    expect(byType).toContain("saved record");

    expect(await read("no-such-handle")).toContain("Agent not found");
  });

  it("returns the latest saved record when a later agent reuses the type handle", async () => {
    const branch: any[] = [];
    const first = await finishedAgent(branch, { responseText: "FIRST-RESULT" }, undefined, { name: "auth-audit" });
    // The first activation is gone, so nothing is holding "explore". The next
    // Explore is handed that handle again and appends a second record.
    const second = await finishedAgent(branch, { responseText: "SECOND-RESULT" });

    const { tools } = boot(branch);
    const context = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
    const read = (agentId: string) =>
      tools.get("get_subagent_result").execute("tc-read", { agent_id: agentId }, undefined, undefined, context).then(textOf);

    const byHandle = await read("explore");
    expect(byHandle).toContain(`Agent: ${second}`);
    expect(byHandle).toContain("SECOND-RESULT");
    expect(byHandle).not.toContain("FIRST-RESULT");

    const byName = await read("auth-audit");
    expect(byName).toContain(`Agent: ${first}`);
    expect(byName).toContain("FIRST-RESULT");
    expect(byName).not.toContain("SECOND-RESULT");

    // The earlier agent's id still returns that run, not the later one that reused the type handle.
    const byId = await read(first);
    expect(byId).toContain(`Agent: ${first}`);
    expect(byId).toContain("FIRST-RESULT");
    expect(byId).not.toContain("SECOND-RESULT");
  });

  it("finds a disambiguated type handle (explore-2) after reload", async () => {
    // Two Explores in one activation: the first keeps `explore`, so the second
    // is numbered `explore-2`. Both persist a record; after reload the suffixed
    // handle has to match the saved entry on its own.
    const branch: any[] = [];
    const { tools, lifecycle } = boot(branch);
    const context = ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } });
    const spawn = (responseText: string) => {
      vi.mocked(runAgent).mockResolvedValueOnce({ responseText, session: { dispose: vi.fn() } as any, aborted: false, steered: false });
      return tools
        .get("Agent")
        .execute("tc-spawn", { prompt: "Review.", description: "Review", subagent_type: "Explore", run_in_background: false }, undefined, undefined, context)
        .then((res) => (res as any).details.agentId as string);
    };
    await spawn("FIRST-RESULT");
    const second = await spawn("SECOND-RESULT");
    expect(branch.find((e) => e.customType === "subagents:record" && e.data.id === second)?.data.handle).toBe("explore-2");
    await lifecycle.get("session_shutdown")?.();
    booted = undefined;

    const { tools: tools2 } = boot(branch);
    const out = textOf(
      await tools2
        .get("get_subagent_result")
        .execute("tc-read", { agent_id: "Explore-2" }, undefined, undefined, ctx({ sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => branch) } })),
    );
    expect(out).toContain(`Agent: ${second}`);
    expect(out).toContain("SECOND-RESULT");
    expect(out).not.toContain("FIRST-RESULT");
  });
});
