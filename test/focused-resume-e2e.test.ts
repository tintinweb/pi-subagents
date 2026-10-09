/** Opt-in dependency integration: PI_FOCUS_EXTENSION=/path/to/pi-focus/extensions/index.ts.
 * Real runner, loader, session, adapter, context and tool guard; only the provider is
 * scripted. No network/auth credentials, copied adapter, or pi-focus source import.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";

const extension = process.env.PI_FOCUS_EXTENSION;

it.skipIf(!extension)("retains focus through real live resume, provider context and tool guard", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "focused-resume-"));
  const agentDir = join(cwd, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const sessions: AgentSession[] = [];
  try {
    const descriptor = join(cwd, ".agents/focus/foci/child/focus.md");
    mkdirSync(dirname(descriptor), { recursive: true });
    writeFileSync(descriptor, `---
kind: focus
parent_id: null
id: child
name: Captured child
created_at: "2026-09-18T00:00:00.000Z"
updated_at: "2026-09-18T00:00:00.000Z"
revision: 1
goals: Keep the original snapshot
activation:
  tools: [read]
---
`);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    });
    let child: AgentSession | undefined;
    const requests: { context: string; bound: boolean }[] = [];
    runtime.registerProvider("focus-test", {
      api: "openai-completions", apiKey: "unused-local-test", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "scripted", name: "scripted", contextWindow: 200_000, maxTokens: 1000 }],
      streamSimple(model, context) {
        requests.push({ context: JSON.stringify(context.messages), bound: Boolean(child?.sessionManager.getBranch().some(
          entry => entry.type === "custom" && entry.customType === "pi-focus:binding" && (entry.data as { active?: unknown }).active,
        )) });
        const toolTurn = requests.length % 2 === 1;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: toolTurn
            ? [{ type: "toolCall", id: `call-${requests.length}`, name: "bash", arguments: { command: "printf SHOULD_NOT_RUN" } }]
            : [{ type: "text", text: "done" }],
          stopReason: toolTurn ? "toolUse" : "stop", timestamp: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end(message);
        return stream;
      },
    });
    const bus = createEventBus();
    const loader = new DefaultResourceLoader({
      cwd, agentDir, eventBus: bus, additionalExtensionPaths: [extension!],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { session: parent } = await createAgentSession({
      cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
      modelRuntime: runtime, model: runtime.getModel("focus-test", "scripted"),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    sessions.push(parent);
    await parent.bindExtensions({});
    const parentBefore = JSON.stringify(parent.sessionManager.getBranch());
    registerAgents(new Map([["focused-live", {
      name: "focused-live", description: "test", builtinToolNames: ["read", "bash"],
      extensions: [extension!], skills: false, persistSession: false,
      systemPrompt: "Test", promptMode: "replace", inheritContext: false,
      runInBackground: false, isolated: false,
    }]]));
    const first = await runAgent(parent.extensionRunner.createContext(), "focused-live", "start", {
      pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI,
      focus: { focusId: "child" },
      onSessionCreated(session) { child = session; sessions.push(session); },
    });
    const bindingsBefore = first.session.sessionManager.getBranch().filter(
      entry => entry.type === "custom" && entry.customType === "pi-focus:binding",
    );
    const bindingBefore = JSON.stringify(bindingsBefore);
    writeFileSync(descriptor, readFileSync(descriptor, "utf8").replace("Captured child", "Retargeted catalog").replace("[read]", "[bash]"));
    const resumed = await resumeAgent(first.session, "continue");
    const bindingsAfter = first.session.sessionManager.getBranch().filter(
      entry => entry.type === "custom" && entry.customType === "pi-focus:binding",
    );
    const toolResults = first.session.messages.filter(message => message.role === "toolResult");
    expect({
      output: [first.responseText, resumed.text],
      requests,
      guards: toolResults.map(message => ({ error: message.isError, text: JSON.stringify(message.content) })),
      retained: JSON.stringify(bindingsAfter) === bindingBefore,
      frozen: bindingsAfter.filter(entry => entry.type === "custom" && (entry.data as { active?: unknown }).active)
        .every(entry => entry.type === "custom" && Object.isFrozen((entry.data as { active: unknown }).active)),
      parentUnchanged: JSON.stringify(parent.sessionManager.getBranch()) === parentBefore,
    }).toEqual({
      output: ["done", "done"],
      requests: Array.from({ length: 4 }, () => ({ context: expect.stringMatching(/Focus: Captured child/), bound: true })),
      guards: Array.from({ length: 2 }, () => ({ error: true, text: expect.stringMatching(/not declared/) })),
      retained: true, frozen: true, parentUnchanged: true,
    });
  } finally {
    for (const session of sessions) session.dispose();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
