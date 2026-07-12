/**
 * output-file-compaction-e2e.test.ts — regression for issue #145: output-file
 * streaming must survive session compaction.
 *
 * Uses a REAL pi AgentSession (faux model backend, in-memory session manager)
 * and drives a REAL session.compact() — no mocked compaction semantics, so
 * this breaks if pi changes how compaction rebuilds session.messages.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamToOutputFile, writeInitialEntry } from "../src/output-file.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

const TURNS_BEFORE_COMPACT = 6;

describe("output-file streaming across a real compaction (#145)", () => {
  let tmp: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "issue-145-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmp; // hermetic: no dev-env extensions/themes
  });

  afterEach(() => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps writing post-compaction messages to the output file", async () => {
    const cwd = tmp;
    const faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
    const model = faux.getModel();
    // Context-branching responder: compaction issues a variable number of
    // model calls (summary, plus a turn-prefix summary when the cut point
    // splits a turn), so a fixed FIFO would desync. Decide from the request.
    const respond = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      const last = context.messages[context.messages.length - 1];
      const text = typeof last?.content === "string"
        ? last.content
        : JSON.stringify(last?.content ?? "");
      // Compaction requests first — their instruction embeds the transcript,
      // so the "question N" branch below would otherwise match inside it.
      // Markers are pi's own prompt texts (SUMMARIZATION_PROMPT and
      // TURN_PREFIX_SUMMARIZATION_PROMPT in core/compaction).
      if (text.includes("conversation to summarize") || text.includes("PREFIX of a turn")) {
        return fauxAssistantMessage([fauxText("summary of everything so far")]);
      }
      if (text.includes("final question")) {
        return fauxAssistantMessage([fauxText("POST-COMPACTION-ANSWER")]);
      }
      const q = text.match(/question (\d+)/);
      if (last?.role === "user" && q) {
        return fauxAssistantMessage([fauxText(`answer-${q[1]} ${"filler ".repeat(200)}`)]);
      }
      throw new Error(`unexpected faux request: ${text.slice(0, 120)}`);
    };
    faux.setResponses(Array.from({ length: 16 }, () => respond));

    const agentDir = getAgentDir();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      systemPromptOverride: () => "You are a test agent.",
      appendSystemPromptOverride: () => [],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRegistry: {
        find: () => model,
        getAll: () => [model],
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        isUsingOAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
        registerProvider: () => {},
        unregisterProvider: () => {},
      } as never,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        // Auto-compaction off (deterministic manual compact() below); a small
        // keep-window so the bulky early turns actually get summarized away.
        compaction: { enabled: false, keepRecentTokens: 500 },
        retry: { enabled: false },
      }),
    });

    const outPath = join(tmp, "agent.output");
    writeInitialEntry(outPath, "agent-145", "repro", cwd);
    const cleanup = streamToOutputFile(session as never, outPath, "agent-145", cwd);

    const readEntries = () =>
      readFileSync(outPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

    // Build up history, streaming as we go (turn_end fires per prompt).
    for (let i = 0; i < TURNS_BEFORE_COMPACT; i++) {
      await session.prompt(`question ${i}`);
    }
    const writtenBeforeCompact = readEntries().length;
    expect(writtenBeforeCompact).toBeGreaterThan(TURNS_BEFORE_COMPACT); // sanity: streaming worked pre-compaction

    const lenBefore = session.messages.length;
    const result = await session.compact();
    expect(result?.summary).toContain("summary"); // sanity: real compaction ran
    // Sanity: compaction actually shrank the array — the exact condition that
    // used to strand writtenCount past the end and halt streaming (#145).
    expect(session.messages.length).toBeLessThan(lenBefore);

    // The run continues after compaction...
    await session.prompt("final question");
    cleanup();

    // The post-compaction turn reaches the output file...
    const entries = readEntries();
    const all = JSON.stringify(entries);
    expect(all).toContain("final question");
    expect(all).toContain("POST-COMPACTION-ANSWER");
    // ...and re-anchoring didn't double-write the compaction-kept tail: every
    // pre-compaction answer still appears exactly once.
    for (let i = 0; i < TURNS_BEFORE_COMPACT; i++) {
      expect(all.split(`answer-${i} `).length - 1).toBe(1);
    }
    expect(entries.length).toBe(writtenBeforeCompact + 2); // + final question + its answer
  }, 30_000);
});
