/**
 * workflow-journal-compat.test.ts — a journal written by an earlier release
 * still resumes under this one.
 *
 * Every journal below was recorded by running each script through the runtime
 * at bc85252 (before `disallowedTools`, the global `Date` shim, strict mode,
 * the copied return value and the `pipeline` null-stop) against a stub host.
 * The keys are pasted in as literal hex rather than recomputed, so anything
 * that re-keys an existing call — a new unconditional key slot, a changed
 * normalisation — goes red here instead of silently turning a user's resume
 * into a full, paid re-run.
 */

import { describe, expect, it } from "vitest";

import type { WorkflowJournalEntry } from "../src/workflow/journal.js";
import { runWorkflow, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "a probe" };\n';

/** Answers the way the recording host did, and counts what reaches it. */
function liveHost() {
  const calls: string[] = [];
  return {
    calls,
    host: {
      async spawnAgent(request: WorkflowSpawnRequest) {
        calls.push(request.prompt);
        if (request.schema !== undefined) return { ok: true, text: JSON.stringify({ ok: true }) };
        return { ok: true, text: `live:${request.prompt}` };
      },
      async runGate() {
        return { ok: true, output: "" };
      },
      abortAgent() {},
    },
  };
}

const resume = (body: string, entries: WorkflowJournalEntry[], host: ReturnType<typeof liveHost>["host"]) =>
  runWorkflow({ script: HEAD + body, host, journal: { entries } });

interface Recorded {
  body: string;
  /** What the run returned at bc85252. */
  value: unknown;
  entries: WorkflowJournalEntry[];
}

const RECORDED: Record<string, Recorded> = {
  "every agent() option that keys a call": {
    body: [
      'const a = await agent("plain");',
      'const b = await agent("labelled", { label: "lbl", phase: "P" });',
      'const c = await agent("tuned", { model: "haiku", effort: "high", agentType: "Explore" });',
      'const d = await agent("isolated", { isolation: "worktree", gate: "npm test" });',
      "return [a, b, c, d];",
    ].join("\n"),
    value: ["live:plain", "live:labelled", "live:tuned", "live:isolated"],
    entries: [
      { index: 0, key: "9878cbc1e3efe51d7fddc64dfd694148", ok: true, text: "live:plain" },
      { index: 1, key: "7c9259aa9da5d8bf77d5114ac5c63994", ok: true, text: "live:labelled" },
      { index: 2, key: "4198f80e12a54f67054ac70a63e7233e", ok: true, text: "live:tuned" },
      { index: 3, key: "9015b3ea47f996931d9e39ad7089ae1c", ok: true, text: "live:isolated" },
    ],
  },
  "a schema call, whose answer is re-parsed on replay": {
    body: [
      'const r = await agent("judge", { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } });',
      "return { verdict: r, ok: r.ok };",
    ].join("\n"),
    value: { verdict: { ok: true }, ok: true },
    entries: [{ index: 0, key: "859bc9d4898f411715743d8dd23ca4da", ok: true, text: '{"ok":true}' }],
  },
  "a pipeline and a parallel fan-out": {
    body: [
      'const p = await pipeline(["x", "y"], s => agent("one " + s), (r, s) => agent("two " + s));',
      'const q = await parallel([() => agent("pa"), () => agent("pb")]);',
      "return { p, q };",
    ].join("\n"),
    value: { p: ["live:two x", "live:two y"], q: ["live:pa", "live:pb"] },
    entries: [
      { index: 0, key: "4bb8a36d512c42f8c89162306c4e3ea3", ok: true, text: "live:one x" },
      { index: 1, key: "6d93c9b24bbe0410118870a956dbee3b", ok: true, text: "live:one y" },
      { index: 2, key: "66593de003c8673922fdd9775af7e7a1", ok: true, text: "live:two x" },
      { index: 3, key: "ab536d234fad87400ac660395665c62b", ok: true, text: "live:two y" },
      { index: 4, key: "6448f4f7f6a80ddf921a102e6fcd7569", ok: true, text: "live:pa" },
      { index: 5, key: "9ad8299b3470067573f032c7b540837e", ok: true, text: "live:pb" },
    ],
  },
  "a prompt built from fixed dates, through the Date shim": {
    body: [
      'const stamp = new Date("2026-01-01T00:00:00Z").toISOString();',
      'const ms = Date.UTC(2026, 0, 2) - Date.parse("2026-01-01T00:00:00Z");',
      'return await agent("at " + stamp + " +" + ms);',
    ].join("\n"),
    value: "live:at 2026-01-01T00:00:00.000Z +86400000",
    entries: [
      { index: 0, key: "685d89ad6483ae3f900cfc8d84e7500b", ok: true, text: "live:at 2026-01-01T00:00:00.000Z +86400000" },
    ],
  },
};

describe("resuming a journal recorded by bc85252", () => {
  for (const [name, recorded] of Object.entries(RECORDED)) {
    it(`replays ${name} without spawning anything`, async () => {
      const live = liveHost();
      const result = await resume(recorded.body, recorded.entries, live.host);

      expect(result.status).toBe("completed");
      expect(result.replayedCount).toBe(recorded.entries.length);
      expect(live.calls, "a full cache hit must not reach the host").toEqual([]);
      expect(result.value).toEqual(recorded.value);
    });
  }

  it("re-runs only the stages a pipeline null no longer reaches, reusing no answer for the wrong call", async () => {
    // The one recorded run whose shape changed. bc85252 fed the "drop" item's
    // null into stage two and paid an agent to verify nothing; that verify is
    // journal entry 2. Now the null ends that chain, so the call at index 2 is
    // "verify keep" — its key differs, the prefix ends there, and both verifies
    // run live rather than being handed the recorded "verify drop" answer.
    const body =
      'return await pipeline(["keep", "drop", "tail"], s => s === "drop" ? null : agent("find " + s), (r, s) => agent("verify " + s + " " + r));';
    const entries: WorkflowJournalEntry[] = [
      { index: 0, key: "dc5acde5f2f111a01be969d4a9acfe38", ok: true, text: "live:find keep" },
      { index: 1, key: "eb2a685f2e14388d9e2c9af1d12ea383", ok: true, text: "live:find tail" },
      { index: 2, key: "ee673b554c288ffda790db7345288674", ok: true, text: "live:verify drop null" },
      { index: 3, key: "b72cdd1c01abbf4227ffd58db164ce83", ok: true, text: "live:verify keep live:find keep" },
      { index: 4, key: "4a4935529163c1c70c5fdcb5d8eab4b5", ok: true, text: "live:verify tail live:find tail" },
    ];

    const live = liveHost();
    const result = await resume(body, entries, live.host);

    expect(result.status).toBe("completed");
    expect(result.replayedCount).toBe(2);
    expect([...live.calls].sort()).toEqual(["verify keep live:find keep", "verify tail live:find tail"]);
    expect(result.value).toEqual(["live:verify keep live:find keep", null, "live:verify tail live:find tail"]);
  });
});
