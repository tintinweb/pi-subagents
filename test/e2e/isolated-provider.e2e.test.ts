/**
 * Isolated-provider regressions for PR #152 and issue #197.
 *
 * These tests load on the pinned pre-migration Pi and skip there. The
 * compat-latest-pi CI job installs current Pi, where ModelRuntime exists and
 * the private ModelRegistry.runtime bridge used by agent-runner is exercised.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@earendil-works/pi-ai";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../../src/agent-manager.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";

vi.setConfig({ testTimeout: 30_000 });

interface ModelRuntimeLike {
  registerProvider(id: string, config: Record<string, unknown>): void;
  getModel(provider: string, modelId: string): unknown;
}

const codingAgentNamespace = codingAgent as Record<string, unknown>;
const aiNamespace = ai as Record<string, unknown>;
const ModelRuntime = codingAgentNamespace.ModelRuntime as
  | { create(opts?: Record<string, unknown>): Promise<ModelRuntimeLike> }
  | undefined;
const ModelRegistry = codingAgentNamespace.ModelRegistry as
  | (new (runtime: ModelRuntimeLike) => { runtime?: unknown })
  | undefined;
const InMemoryCredentialStore = aiNamespace.InMemoryCredentialStore as
  | (new () => {
      read(providerId: string): Promise<unknown>;
      modify(providerId: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
    })
  | undefined;
const createAssistantMessageEventStream = aiNamespace.createAssistantMessageEventStream as
  | (() => { push(event: unknown): void; end(result?: unknown): void })
  | undefined;

const MIGRATED = typeof ModelRuntime?.create === "function" && typeof ModelRegistry === "function";

const RT = ModelRuntime as { create(opts?: Record<string, unknown>): Promise<ModelRuntimeLike> };
const Registry = ModelRegistry as new (runtime: ModelRuntimeLike) => { runtime?: unknown };
const CredentialStore = InMemoryCredentialStore as new () => {
  read(providerId: string): Promise<unknown>;
  modify(providerId: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
};
const createStream = createAssistantMessageEventStream as () => {
  push(event: unknown): void;
  end(result?: unknown): void;
};

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePi(): codingAgent.ExtensionAPI {
  return {
    exec: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
  } as unknown as codingAgent.ExtensionAPI;
}

type TextBlock = { type: "text"; text: string };
type MessageLike = { role?: unknown; content?: unknown };
type ModelLike = { api: string; provider: string; id: string };
type ContextLike = { messages: MessageLike[] };
type StreamOptionsLike = { apiKey?: string };
type OAuthLike = { type: "oauth"; access: string; refresh: string; expires: number };

function isTextBlock(block: unknown): block is TextBlock {
  return typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string";
}

function messageText(messages: MessageLike[], role: "user" | "assistant"): string[] {
  return messages
    .filter((message) => message.role === role)
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return Array.isArray(message.content)
        ? message.content.filter(isTextBlock).map((block) => block.text).join("\n")
        : "";
    });
}

function completedTextStream(model: ModelLike, text: string) {
  const stream = createStream();
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const base = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const started = { ...base, content: [] };
  const textStarted = { ...base, content: [{ type: "text", text: "" }] };
  const message = { ...base, content: [{ type: "text", text }] };
  stream.push({ type: "start", partial: started });
  stream.push({ type: "text_start", contentIndex: 0, partial: textStarted });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

describe.skipIf(!MIGRATED)("PR #152 reach: real ModelRegistry exposes .runtime (Pi >= 0.80.8)", () => {
  it("ctx.modelRegistry.runtime is reachable and IS the runtime it wraps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iso-prov-"));
    tmpDirs.push(dir);
    const runtime = await RT.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
      allowModelNetwork: false,
    });
    const facade = new Registry(runtime);
    expect(facade.runtime).toBe(runtime);
  });

  it("keeps parent OAuth ownership and the same real child session across resume", async () => {
    expect(InMemoryCredentialStore, "current Pi must export InMemoryCredentialStore").toBeTypeOf("function");
    expect(createAssistantMessageEventStream, "current Pi must export createAssistantMessageEventStream").toBeTypeOf("function");
    const provider = "issue-197-oauth";
    const modelId = "context-probe";
    const transcriptMarker = "issue-197-turn-one-marker";
    const credentials = new CredentialStore();
    const refreshInputs: OAuthLike[] = [];
    const authInputs: OAuthLike[] = [];
    const calls: Array<{ apiKey?: string; userTexts: string[]; assistantTexts: string[] }> = [];

    await credentials.modify(provider, async () => ({
      type: "oauth",
      access: "expired-parent-access",
      refresh: "parent-refresh-marker",
      expires: 0,
    }));

    const runtime = await RT.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerProvider(provider, {
      name: "Issue 197 OAuth",
      api: "issue-197-test-api",
      baseUrl: "https://issue-197.invalid",
      models: [{
        id: modelId,
        name: modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 1_000,
      }],
      oauth: {
        name: "Issue 197 OAuth",
        async login() {
          throw new Error("login must not run");
        },
        async refreshToken(current: OAuthLike) {
          refreshInputs.push(structuredClone(current));
          return {
            ...current,
            access: "rotated-parent-access",
            refresh: "rotated-parent-refresh",
            expires: Date.now() + 60 * 60_000,
          };
        },
        getApiKey(current: OAuthLike) {
          authInputs.push(structuredClone(current));
          return current.access;
        },
      },
      streamSimple(model: ModelLike, context: ContextLike, options?: StreamOptionsLike) {
        const userTexts = messageText(context.messages, "user");
        const assistantTexts = messageText(context.messages, "assistant");
        calls.push({ apiKey: options?.apiKey, userTexts, assistantTexts });
        const secondTurn = userTexts.some((text) => text.includes("SECOND_PROMPT"));
        const sawHistory = assistantTexts.some((text) => text.includes(transcriptMarker));
        const text = secondTurn
          ? `turn-two-${sawHistory ? "resumed" : "lost"}:${transcriptMarker}`
          : `turn-one:${transcriptMarker}`;
        return completedTextStream(model, text);
      },
    });

    const modelRegistry = new Registry(runtime);
    const model = runtime.getModel(provider, modelId) as ModelLike | undefined;
    expect(model).toBeDefined();
    const cwd = mkdtempSync(join(tmpdir(), "issue-197-session-"));
    tmpDirs.push(cwd);
    const ctx = {
      cwd,
      getSystemPrompt: () => "PARENT",
      model,
      modelRegistry,
    } as Parameters<AgentManager["spawnAndWait"]>[1];
    const manager = new AgentManager();
    try {
      registerAgents(new Map([
        [
          "issue-197",
          {
            name: "issue-197",
            description: "Issue 197 OAuth session probe",
            systemPrompt: "Return the requested marker.",
            promptMode: "replace",
            builtinToolNames: [],
            skills: false,
            isolated: true,
            inheritContext: false,
            runInBackground: false,
          } as AgentConfig,
        ],
      ]));
      const { id, record } = await manager.spawnAndWait(
        makePi(),
        ctx,
        "issue-197",
        "FIRST_PROMPT",
        {
          description: "issue 197",
          model,
          isolated: true,
          inheritContext: false,
        },
      );
      expect(record.status).toBe("completed");
      expect(record.result).toBe(`turn-one:${transcriptMarker}`);
      const originalSession = record.session;
      const originalSessionId = originalSession?.sessionId;
      const firstMessageCount = originalSession?.messages.length ?? 0;
      expect(originalSession).toBeDefined();
      expect(originalSessionId).toBeTruthy();

      const resumed = await manager.resume(id, "SECOND_PROMPT");
      expect(resumed).toBe(record);
      expect(resumed?.session).toBe(originalSession);
      expect(resumed?.session?.sessionId).toBe(originalSessionId);
      expect(resumed?.session?.messages.length).toBeGreaterThan(firstMessageCount);
      expect(resumed?.result).toBe(`turn-two-resumed:${transcriptMarker}`);
      expect(messageText(resumed?.session?.messages ?? [], "assistant")).toContain(`turn-one:${transcriptMarker}`);

      expect(refreshInputs).toHaveLength(1);
      expect(refreshInputs[0]).toMatchObject({
        type: "oauth",
        access: "expired-parent-access",
        refresh: "parent-refresh-marker",
      });
      expect(authInputs).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.apiKey)).toEqual([
        "rotated-parent-access",
        "rotated-parent-access",
      ]);
      expect(calls[1]?.assistantTexts).toContain(`turn-one:${transcriptMarker}`);
      expect(await credentials.read(provider)).toMatchObject({
        type: "oauth",
        access: "rotated-parent-access",
        refresh: "rotated-parent-refresh",
      });
    } finally {
      try {
        manager.dispose();
      } finally {
        registerAgents(new Map());
      }
    }
  });
});
