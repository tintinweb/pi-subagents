/**
 * mention-clone-prompt.e2e.test.ts — the clone's system prompt against a REAL
 * parent session (#459).
 *
 * The clone gets the parent's rendered prompt as its preamble, and pi then
 * renders the clone's own `cwd` section after it. `runMentionClone` removes the
 * parent's copy by matching pi's rendering of that section. Nothing here writes
 * that rendering by hand: the parent is a real session (context file, inline
 * extension), and every assertion compares against the system-message sections
 * pi itself sends to the model. If pi changes how it renders `cwd`, the match
 * stops working and these go red.
 *
 * `getSystemPrompt()` has three shapes, and a mention can see each one, because
 * pi runs `input` handlers for a steer/follow-up typed while a turn streams:
 *   - idle: the base options, ending at `cwd`;
 *   - mid-turn, with an extension section added in `before_agent_start`: the
 *     run options, with that section after `cwd`;
 *   - mid-turn, with the prompt forced by `before_agent_start`: opaque text.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Context,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemMessage,
  getCurrentTools,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMentionClone } from "../../src/mention-clone.js";
import { fauxModelBackend } from "../helpers/faux-model-backend.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

vi.setConfig({ testTimeout: 30_000 });

type Shape = "idle" | "extension-section" | "forced";

const EXT_SECTION = "EXTENSION-SECTION-TEXT";
const FORCED = "FORCED-PROMPT-TEXT";
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe("mention clone system prompt against a real parent session", () => {
  let root: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "subagents-clone-prompt-"));
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs a mention clone from a real parent in the given shape. Returns the
   * system message of the parent's request (mid-turn shapes), of the clone's
   * request, and the parent's `getSystemPrompt()` at the moment of the mention.
   */
  async function run(shape: Shape, cwdName = "project") {
    const cwd = join(root, cwdName);
    mkdirSync(cwd);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(cwd, "AGENTS.md"), "PROJECT-RULES-TEXT");

    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const modelRegistry = { ...backend.modelRegistry, runtime: backend.modelRuntime };
    const agentTool = {
      name: "Agent",
      description: "Launch an agent.",
      parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String() }),
      execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "Agent ID: a1" }], details: undefined })),
    } as any;

    let parentRequest: SystemMessage | undefined;
    let cloneRequest: SystemMessage | undefined;
    let parentPromptAtMention = "";
    const mention = async (ctx: ExtensionContext) => {
      parentPromptAtMention = ctx.getSystemPrompt();
      const result = await runMentionClone({ ctx, type: "Explore", message: "go", agentTool });
      expect(result).toEqual({ spawned: true });
    };

    let idleCtx: ExtensionContext | undefined;
    const extension = (pi: ExtensionAPI) => {
      pi.on("session_start", (_event, ctx) => {
        idleCtx = ctx;
      });
      pi.on("before_agent_start", (event) => {
        if (shape === "extension-section") event.systemPromptOptions.sections.probe_ext = EXT_SECTION;
        if (shape === "forced") return { systemPrompt: FORCED };
        return undefined;
      });
      // Runs inside the parent's turn: the mid-turn shapes.
      pi.registerTool({
        name: "probe",
        label: "probe",
        description: "Type a mention mid-turn.",
        parameters: Type.Object({}),
        execute: async (_id, _params, _signal, _onUpdate, ctx) => {
          await mention(ctx);
          return { content: [{ type: "text", text: "probed" }], details: undefined };
        },
      });
    };

    // One FIFO shared by parent and clone; each request is told apart by its tools.
    const respond = (context: Context) => {
      const tools = getCurrentTools(context.messages).map((t) => t.name);
      const answered = context.messages.some((m) => m.role === "toolResult");
      if (tools.includes("probe")) {
        parentRequest ??= getCurrentSystemMessage(context.messages);
        return answered ? fauxAssistantMessage("done") : fauxAssistantMessage(fauxToolCall("probe", {}));
      }
      cloneRequest = getCurrentSystemMessage(context.messages);
      return answered
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage(fauxToolCall("Agent", { subagent_type: "Explore", prompt: "go" }));
    };
    faux.setResponses(Array.from({ length: 8 }, () => respond));

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [extension],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      modelRegistry: modelRegistry as any,
      modelRuntime: backend.modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    try {
      await session.bindExtensions({});
      if (shape === "idle") await mention(idleCtx!);
      else await session.prompt("start");
    } finally {
      session.dispose();
    }
    expect(cloneRequest?.sections).toBeDefined();
    return { parent: parentRequest, clone: cloneRequest!, parentPromptAtMention };
  }

  const rendered = (message: SystemMessage) => Object.values(message.sections ?? {}).join("\n\n");

  it("an idle parent's prompt reaches the clone byte-identical", async () => {
    const { clone, parentPromptAtMention } = await run("idle");
    expect(parentPromptAtMention).toContain("PROJECT-RULES-TEXT");
    expect(rendered(clone)).toBe(parentPromptAtMention);
  });

  it("matches a cwd with backslashes as pi renders it", async () => {
    // A legal filename on POSIX; pi renders it with forward slashes, as for a Windows path.
    const { clone, parentPromptAtMention } = await run("idle", "back\\slash");
    expect(clone.sections?.cwd).toContain("back/slash");
    expect(rendered(clone)).toBe(parentPromptAtMention);
  });

  it("mid-turn, the clone keeps every parent section once, beside one cwd section", async () => {
    const { parent, clone } = await run("extension-section");
    const parentSections = parent?.sections ?? {};
    expect(Object.keys(parentSections)).toEqual(expect.arrayContaining(["preamble", "project_context", "cwd", "probe_ext"]));
    const clonePrompt = rendered(clone);
    expect(clone.sections?.cwd).toBe(parentSections.cwd);
    for (const text of Object.values(parentSections)) expect(count(clonePrompt, text)).toBe(1);
  });

  it("mid-turn with a forced prompt, the clone gets that prompt whole plus its own cwd", async () => {
    const { parent, clone } = await run("forced");
    expect(parent?.content).toBe(FORCED);
    expect(Object.keys(clone.sections ?? {})).toEqual(["preamble", "cwd"]);
    expect(clone.sections?.preamble).toBe(FORCED);
  });
});
