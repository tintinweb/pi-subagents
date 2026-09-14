/**
 * usage-reaches-session-stats.e2e.test.ts — the premise #193 rests on, checked
 * against the REAL pi runtime.
 *
 * Every unit test for usage reporting asserts that our tool results carry a
 * `usage` field. None of them can establish the thing that makes carrying it
 * worth doing: that pi picks it up. That happens entirely inside pi —
 * `createToolResultMessage` copies `AgentToolResult.usage` onto the persisted
 * message, and `getSessionStats()` folds `toolResult.usage` into the tokens and
 * cost the footer, the statusline and `/cost` read. Mock pi, and a release that
 * stopped doing either would leave the whole feature reporting into a void with
 * a green suite.
 *
 * So this drives a real `AgentSession` and reads its real `getSessionStats()`,
 * with the exact object `PendingUsagePool.drain()` produces — including the
 * `cacheRead` our own display total drops but this report must carry, and the
 * cost breakdown whose `total` pi reads with no guard at all.
 *
 * No network/LLM and no model turn: the message is appended through pi's own
 * `sessionManager.appendMessage`, because what is under test is the accounting,
 * not the streaming that would normally produce the message.
 *
 * This test is also what set the peer floor. Pi began folding `toolResult.usage`
 * into `getSessionStats()` in 0.81.0, when the computation moved to walking
 * session entries through `addUsageToTotals`; every 0.80.x sums assistant
 * messages alone and drops the field. Running unconditionally is the point —
 * against a Pi that does not aggregate, this fails rather than skipping, which
 * is how the range stays honest. `peerDependencies` moved to `>=0.81.0` for
 * exactly this reason, so the CI floor job runs it too. The floor has since moved
 * on past it (the Workflow tool needs 0.84.0), so this no longer pins the range's
 * lower edge — it still pins the behaviour that made 0.80.x unsupportable.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingUsagePool } from "../../src/usage.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

describe("subagent usage reaches the parent session's stats (real pi)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-usage-e2e-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /** A real session, in memory, on a faux model. */
  async function realSession() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      model: model as any,
      modelRegistry: backend.modelRegistry,
      modelRuntime: backend.modelRuntime,
      tools: [],
    } as any);
    return session;
  }

  /** The tool result our `Agent` tool returns, as pi would persist it. */
  function toolResultCarrying(usage: unknown) {
    return {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "Agent",
      content: [{ type: "text" as const, text: "Agent completed." }],
      isError: false,
      timestamp: 1,
      usage,
    };
  }

  it("pi adds our reported tokens and cost to getSessionStats()", async () => {
    const session = await realSession();
    try {
      const before = session.getSessionStats();

      const pool = new PendingUsagePool();
      pool.add({ input: 1000, output: 400, cacheWrite: 100, cacheRead: 9000, cost: 0.0123 });
      pool.add({ input: 2000, output: 600, cacheWrite: 200, cacheRead: 18_000, cost: 0.0077 });
      const usage = pool.drain();

      session.sessionManager.appendMessage(toolResultCarrying(usage) as any);
      const after = session.getSessionStats();

      // Exactly what we reported, on every component pi tracks — cacheRead
      // included, which is the one pi counts for its own messages and our own
      // display total leaves out.
      expect(after.tokens.input - before.tokens.input).toBe(3000);
      expect(after.tokens.output - before.tokens.output).toBe(1000);
      expect(after.tokens.cacheWrite - before.tokens.cacheWrite).toBe(300);
      expect(after.tokens.cacheRead - before.tokens.cacheRead).toBe(27_000);

      // The cost: the whole point of the feature for anyone watching a
      // statusline. `addUsageToTotals` reads `usage.cost.total` with no guard,
      // so an incomplete object would have thrown before reaching here.
      expect(after.cost - before.cost).toBeCloseTo(0.02, 10);
    } finally {
      session.dispose?.();
    }
  });

  it("leaves the context-window percentage alone", async () => {
    // pi derives context usage from assistant messages only. If that ever
    // changed, a delegating session would look like it was filling its context
    // with work that happened somewhere else entirely — and users would compact
    // for no reason.
    const session = await realSession();
    try {
      const before = session.getSessionStats().contextUsage?.percent ?? null;

      const pool = new PendingUsagePool();
      pool.add({ input: 150_000, output: 400, cacheWrite: 100, cost: 1.5 });
      session.sessionManager.appendMessage(toolResultCarrying(pool.drain()) as any);

      expect(session.getSessionStats().contextUsage?.percent ?? null).toBe(before);
    } finally {
      session.dispose?.();
    }
  });

  it("counts nothing for a tool result that carries no usage", async () => {
    // The `reportUsage: false` shape, and every other tool in the session.
    const session = await realSession();
    try {
      const before = session.getSessionStats();
      session.sessionManager.appendMessage(toolResultCarrying(undefined) as any);
      const after = session.getSessionStats();

      expect(after.tokens.input).toBe(before.tokens.input);
      expect(after.cost).toBe(before.cost);
    } finally {
      session.dispose?.();
    }
  });
});
