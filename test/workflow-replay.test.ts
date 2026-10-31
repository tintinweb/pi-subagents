import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type WorkflowJournalEntry } from "../src/workflow/journal.js";
import { runWorkflow, type WorkflowHost, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "replay", description: "Replay regression" };\n';

function recorder() {
  const entries: WorkflowJournalEntry[] = [];
  return { entries, append: (entry: WorkflowJournalEntry) => entries.push(entry) };
}

function host(reply: WorkflowHost["spawnAgent"]): WorkflowHost {
  return { spawnAgent: reply, abortAgent() {} };
}

describe("structural replay", () => {
  it("replays every pipeline call when cached replies change the arrival order", async () => {
    let releaseA!: () => void;
    const waitingA = new Promise<void>(resolve => { releaseA = resolve; });
    const firstHost = host(async request => {
      if (request.prompt === "scan:a") await waitingA;
      if (request.prompt === "check:b") releaseA();
      return { ok: true, text: request.prompt };
    });
    const script = HEAD + 'return await pipeline(["a", "b"], item => agent("scan:" + item), (_, item) => agent("check:" + item));';
    const journal = recorder();
    const first = await runWorkflow({ script, host: firstHost, journal, concurrency: 2 });
    expect(first.status).toBe("completed");
    const live: string[] = [];
    const second = await runWorkflow({
      script,
      host: host(async request => { live.push(request.prompt); return { ok: true, text: "unexpected" }; }),
      journal: { entries: journal.entries },
    });
    expect(second.status).toBe("completed");
    expect(second.value).toEqual(first.value);
    expect(second.replayedCount).toBe(4);
    expect(live).toEqual([]);
  });

  it("does not replay sibling or parent work after the first changed call", async () => {
    const script = (prompt: string) => HEAD + `await agent("before"); await parallel([() => agent("${prompt}"), () => agent("sibling")]); return await agent("after");`;
    const journal = recorder();
    await runWorkflow({ script: script("original"), host: host(async r => ({ ok: true, text: r.prompt })), journal });
    const live: string[] = [];
    const result = await runWorkflow({
      script: script("edited"),
      host: host(async r => { live.push(r.prompt); return { ok: true, text: r.prompt }; }),
      journal: { entries: journal.entries },
    });
    expect(result.replayedCount).toBe(1);
    expect(live).toEqual(["edited", "sibling", "after"]);
  });

  it("does not reuse a parent audit after a changed child rewrites its input", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "workflow-replay-"));
    const artifact = join(cwd, "report.txt");
    const journal = recorder();
    const script = HEAD + 'await workflow("writer"); return await agent("audit report.txt");';
    function writer(version: string): WorkflowHost {
      return {
        ...host(async request => {
          if (request.prompt.startsWith("write:")) {
            writeFileSync(artifact, version);
            return { ok: true, text: "written" };
          }
          return { ok: true, text: readFileSync(artifact, "utf8") };
        }),
        loadWorkflow: () => ({ ok: true, script: HEAD + `return await agent("write:${version}");` }),
      };
    }
    try {
      const first = await runWorkflow({ script, host: writer("v1"), journal });
      expect(first.value).toBe("v1");
      const second = await runWorkflow({ script, host: writer("v2"), journal: { entries: journal.entries } });
      expect(second.status).toBe("completed");
      expect(readFileSync(artifact, "utf8")).toBe("v2");
      expect(second.value).toBe("v2");
      expect(second.replayedCount).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("identifies equal prompts in different branches independently", async () => {
    let releaseA!: () => void;
    const waitingA = new Promise<void>(resolve => { releaseA = resolve; });
    const firstHost = host(async request => {
      if (request.prompt === "scan:a") await waitingA;
      if (request.prompt === "same") releaseA();
      return { ok: true, text: `${request.prompt}:${request.index}` };
    });
    const script = HEAD + 'return await pipeline(["a", "b"], item => agent("scan:" + item), () => agent("same"));';
    const journal = recorder();
    const first = await runWorkflow({ script, host: firstHost, journal, concurrency: 2 });
    const live: WorkflowSpawnRequest[] = [];
    const second = await runWorkflow({
      script,
      host: host(async request => { live.push(request); return { ok: true, text: "wrong" }; }),
      journal: { entries: journal.entries },
    });
    expect(second.status).toBe("completed");
    expect(second.value).toEqual(first.value);
    expect(second.replayedCount).toBe(4);
    expect(live).toEqual([]);
  });
});
