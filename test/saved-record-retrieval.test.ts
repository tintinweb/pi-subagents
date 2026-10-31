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
      { prompt: "Review the change.", description: "Review the change", subagent_type: "Explore", run_in_background: false },
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
});
