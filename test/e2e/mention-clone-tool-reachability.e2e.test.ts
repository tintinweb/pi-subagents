/**
 * mention-clone-tool-reachability.e2e.test.ts — reachability guard for the one
 * tool the mention clone is built around.
 *
 * `runMentionClone` hands a session ONE tool and expects the model to call it.
 * Whether that tool ever reaches the model is decided entirely inside Pi, by
 * `createAgentSession`'s allowlist plumbing — and the unit tests cannot see it:
 * their `createAgentSession` is a mock that hands `customTools[0]` straight to
 * the model turn, so a session option that silently strips the tool passes
 * every one of them.
 *
 * That is not hypothetical. The clone shipped with `noTools: "all"` on the
 * reading its doc comment invites ("start with no tools enabled" — no
 * built-ins, keep mine). Pi turns that flag into an EMPTY allowlist, and an
 * empty array is truthy, so `AgentSession` builds an empty `Set` and
 * `isAllowedTool` rejects every name — custom tools are filtered by the same
 * predicate as built-ins. Every mention was prompted with no tools, answered in
 * prose, and fell back to a direct start with a warning. The unit suite stayed
 * green throughout.
 *
 * So this asserts against a REAL session, on the two things a mock cannot
 * establish:
 *   1. the clone's `Agent` tool is actually active on it, and
 *   2. nothing else is — the invisible turn cannot read, write or run anything.
 *
 * No network/LLM: a faux provider satisfies session construction, and the
 * assertion is on the constructed tool set rather than on a model turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real pi-mono session construction; a cold first run under full-suite CPU
// contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

// Hoisted so the (lifted) mock factory can reach it. Everything except the
// capture is the real module — the point is to construct a REAL session.
const { sessions } = vi.hoisted(() => ({ sessions: [] as any[] }));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession: async (opts: any) => {
      const created = await actual.createAgentSession(opts);
      sessions.push(created.session);
      return created;
    },
  };
});

import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

describe("mention clone tool reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    sessions.length = 0;
    cwd = mkdtempSync(join(tmpdir(), "subagents-mention-clone-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("the clone's Agent tool is live on the real session, and it is the only one", async () => {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT",
      // mention-clone reads the runtime off the registry facade, the same shim
      // agent-runner carries for Pi >= 0.80.8.
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: { getBranch: () => [] },
    };

    // Never called: the assertion is on what the session exposes, not on the
    // faux model deciding to use it.
    const agentTool = { name: "Agent", execute: vi.fn() } as any;

    // Never rejects by contract; a faux turn that cannot complete is fine,
    // because the tool set is fixed at construction.
    await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(sessions).toHaveLength(1);
    // The bug this file exists for: with an empty allowlist this is `[]`.
    expect(sessions[0].getActiveToolNames()).toEqual(["Agent"]);
  });

  it("the clone's request carries the parent's conversation and system prompt, and it spawns", async () => {
    // Pi 1.x keeps the prompt and the history in the session's transcript:
    // `AgentState.systemPrompt` is a read-only getter, and SessionManager is the
    // source of every request's context. A clone seeded by mutating agent state
    // throws on the prompt assignment and never reaches its turn.
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const parent = SessionManager.inMemory(cwd);
    // What a real parent transcript opens with: its prompt and its full tool set.
    parent.appendMessage({
      role: "system",
      content: "",
      sections: { preamble: "STALE-PARENT-PROMPT" },
      toolsAdded: [{ name: "read", description: "Read a file.", parameters: Type.Object({ path: Type.String() }) }],
      timestamp: 0,
    } as never);
    parent.appendMessage({ role: "user", content: "PARENT-HISTORY question", timestamp: 1 });
    parent.appendMessage(fauxAssistantMessage("PARENT-HISTORY answer"));
    const ctx: any = {
      cwd,
      model,
      getSystemPrompt: () => "PARENT-PROMPT",
      modelRegistry: { ...backend.modelRegistry, runtime: backend.modelRuntime },
      sessionManager: parent,
    };

    let seen: Context | undefined;
    faux.setResponses([
      (context: Context) => {
        seen = context;
        return fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "go" }));
      },
      fauxAssistantMessage("done"),
    ]);
    const agentTool = {
      name: "Agent",
      description: "Launch an agent.",
      parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
      execute: vi.fn(async () => ({ content: [{ type: "text", text: "Agent ID: a1" }], details: undefined })),
    } as any;

    const result = await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });

    expect(result).toEqual({ spawned: true });
    expect(seen).toBeDefined();
    const text = JSON.stringify(seen!.messages.filter((m) => m.role !== "system"));
    expect(text).toContain("PARENT-HISTORY question");
    expect(text).toContain("PARENT-HISTORY answer");
    expect(getCurrentSystemPrompt(seen!.messages)).toContain("PARENT-PROMPT");
    // Replayed, then patched over — not dropped on the way in.
    expect(JSON.stringify(seen!.messages)).toContain("STALE-PARENT-PROMPT");
    expect(getCurrentSystemPrompt(seen!.messages)).not.toContain("STALE-PARENT-PROMPT");
    // The parent's tools are withdrawn: the invisible turn can call Agent and nothing else.
    expect(getCurrentTools(seen!.messages).map((t) => t.name)).toEqual(["Agent"]);
  });
});
