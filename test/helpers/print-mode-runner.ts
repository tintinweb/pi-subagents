/**
 * print-mode-runner.ts — a headless ("print mode") host runner for driving the
 * pi-subagents extension through REAL end-to-end subagent runs.
 *
 * WHY THIS EXISTS
 * ---------------
 * The other e2e suites (agent-runner-e2e, ext-templates-e2e) assert on the
 * *gated tool set captured at construction* — they never drive a turn, so they
 * never actually spawn a subagent or exercise the background hold condition.
 * This runner closes that gap: it boots a real headless pi session with the
 * pi-subagents extension loaded, drives a real assistant turn that calls the
 * `Agent` tool, and lets the extension spawn a real child session through the
 * real `runAgent` path — then waits for it to finish exactly like a production
 * print-mode host does.
 *
 * It is the pi-subagents analogue of pi-chonky-step's `src/agent.ts` headless
 * runner: same shape (DefaultResourceLoader → createAgentSession → prompt loop),
 * and crucially it replicates pi-chonky-step's SUBAGENT HOLD CONDITION — the
 * `dequeueFollowUpMessages` monkey-patch that blocks the parent agent loop until
 * background subagents complete (via the `Symbol.for("pi-subagents:manager")`
 * global the extension publishes). Without that patch, `session.prompt()`
 * resolves and the parent finishes before background children report back.
 *
 * MODEL BACKEND (faux default, real opt-in)
 * -----------------------------------------
 *   - Faux (default): a scripted `registerFauxProvider` model drives both the
 *     parent and the spawned child deterministically — no network, CI-safe. You
 *     supply a `respond(context)` function (or raw `steps`) that emits the
 *     `Agent` tool call on the parent and a reply on the child. `routeBySession`
 *     does the parent/child branching for the common single-spawn case.
 *   - Live (opt-in): set `PI_E2E_LIVE=1` or pass `live: {provider, model}`. A real
 *     model drives the turn; `respond`/`steps` are ignored. Non-deterministic,
 *     needs creds. With no explicit model pin, it resolves the model from your
 *     local `pi` config (settings default → first authed model), so a logged-in
 *     `pi` is picked up automatically — no PI_PROVIDER/PI_MODEL needed.
 *
 * ONE PARAMETERIZED RUNNER
 * ------------------------
 * The same `runPrintMode()` covers built-in agent types, `.pi/agents/*.md`
 * frontmatter agents, and inline-instruction agents — the difference is purely
 * what you register in `beforeRun` and which `subagent_type` the `Agent` call
 * names. See `test/subagents-print-mode-e2e.test.ts` for usage.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type Context,
  type FauxContentBlock,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getModel,
  type Model,
  registerFauxProvider,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/** Path to the pi-subagents extension entrypoint (repo `src/index.ts`). */
const EXTENSION_PATH = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

/** The cross-package handle the extension publishes on a global Symbol. */
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface ManagerHandle {
  waitForAll(): Promise<void>;
  hasRunning(): boolean;
  getRecord(id: string): unknown;
}

/** A faux reply in any convenient shape; normalized to an AssistantMessage. */
export type FauxReply = string | FauxContentBlock | FauxContentBlock[] | AssistantMessage;

/**
 * A context-branching responder. Invoked once per model call (parent OR child)
 * with that call's own `Context`, so it can decide what to emit from the prompt
 * it sees — order-independent, unlike a flat FIFO `steps` list.
 */
export type FauxResponder = (
  context: Context,
  state: { callCount: number },
) => FauxReply | Promise<FauxReply>;

export interface RunPrintModeOptions {
  /** The user prompt that kicks off the parent turn. */
  prompt: string;
  /**
   * Working directory for the run. Defaults to a fresh temp dir that `dispose()`
   * removes. Pass a fixtures dir to make `.pi/agents/*.md` discoverable.
   */
  cwd?: string;
  /** Parent host system prompt. Default: a minimal orchestrator prompt. */
  systemPrompt?: string;
  /**
   * Faux mode: context-branching responder (padded to `maxModelCalls` calls).
   * Ignored in live mode. Mutually exclusive with `steps` (steps wins).
   */
  respond?: FauxResponder;
  /** Faux mode: explicit FIFO response steps. Overrides `respond`. */
  steps?: FauxResponseStep[];
  /** Faux mode: how many model calls to pad the queue for. Default 16. */
  maxModelCalls?: number;
  /**
   * Honor the subagent hold condition — block the parent agent loop until
   * background subagents finish (the pi-chonky-step monkey-patch). Default true.
   */
  hold?: boolean;
  /**
   * Run before the parent turn, after globals are isolated — e.g.
   * `registerAgents(loadCustomAgents(cwd))` to install frontmatter agents.
   */
  beforeRun?: () => void | Promise<void>;
  /**
   * Isolate global discovery (PI_CODING_AGENT_DIR + HOME → temp) so the dev's
   * real agents/extensions can't bleed into the run. Default true in faux mode,
   * false in live mode (so real auth/config resolve). Restored on `dispose()`.
   */
  isolateGlobals?: boolean;
  /** Wall-clock guard for the whole run. Default 30_000ms. */
  timeoutMs?: number;
  /** Abort the parent (and forwarded children) externally. */
  signal?: AbortSignal;
  /**
   * Force live mode against a specific provider/model (overrides PI_E2E_LIVE).
   * When omitted, live mode is on iff `PI_E2E_LIVE` is truthy. In live mode, if
   * neither this nor `PI_PROVIDER`+`PI_MODEL` is set, the model is left for pi to
   * resolve from your local config (settings default → first authed model) — i.e.
   * it picks up whatever your `pi` install is logged into, no env required.
   */
  live?: { provider: string; model: string };
}

export interface PrintModeRun {
  /** Last assistant text the parent produced (the "printed" answer). */
  responseText: string;
  /** The live parent session (history, tool calls, etc.). */
  parentSession: AgentSession;
  /** The extension's manager handle (undefined if the extension didn't load). */
  manager: ManagerHandle | undefined;
  /** Snapshot of all subagent records the manager knew about at the end. */
  subagents: Array<Record<string, unknown>>;
  /** Faux model call count (0 in live mode). */
  modelCalls: number;
  /**
   * Tear down: emit session_shutdown (so extensions clear timers), dispose the
   * session, unregister faux, restore cwd/env, rm temp dir. Async — await it.
   */
  dispose: () => Promise<void>;
}

// --------------------------------------------------------------------------
// Faux scripting helpers
// --------------------------------------------------------------------------

/**
 * Build an `Agent` tool call for a faux assistant turn. `subagent_type` defaults
 * to "general-purpose"; everything else is passed straight through as tool args.
 */
export function agentCall(
  args: {
    prompt: string;
    description: string;
    subagent_type?: string;
    run_in_background?: boolean;
    [k: string]: unknown;
  },
  opts?: { id?: string },
): ToolCall {
  return fauxToolCall("Agent", { subagent_type: "general-purpose", ...args }, opts);
}

function resolveReply(
  reply: FauxReply | ((ctx: Context) => FauxReply),
  ctx: Context,
): FauxReply {
  return typeof reply === "function" ? (reply as (c: Context) => FauxReply)(ctx) : reply;
}

/**
 * The common single-spawn flow as a responder. Routes by inspecting the calling
 * session's own context:
 *   - PARENT  (its tool set includes `Agent`):
 *       · `parentInitial` until an `Agent` tool result is in history (the spawn),
 *       · then `parentFinal` (the answer after the child reports back).
 *   - SUBAGENT (no `Agent` tool): `subagent`.
 * Each route may be a value or a `(ctx) => value` function.
 */
export function routeBySession(routes: {
  parentInitial: FauxReply | ((ctx: Context) => FauxReply);
  parentFinal?: FauxReply | ((ctx: Context) => FauxReply);
  subagent: FauxReply | ((ctx: Context) => FauxReply);
}): FauxResponder {
  return (context) => {
    const isParent = (context.tools ?? []).some((t) => t.name === "Agent");
    if (!isParent) return resolveReply(routes.subagent, context);
    const spawned = context.messages.some(
      (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
    );
    if (spawned) {
      return routes.parentFinal != null
        ? resolveReply(routes.parentFinal, context)
        : "Done.";
    }
    return resolveReply(routes.parentInitial, context);
  };
}

/** Normalize any FauxReply into a faux AssistantMessage (tool calls ⇒ stopReason "toolUse"). */
function toAssistantMessage(reply: FauxReply): AssistantMessage {
  if (reply && typeof reply === "object" && "role" in reply) {
    return reply as AssistantMessage;
  }
  const content: FauxContentBlock[] =
    typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
  const hasToolCall = content.some((b) => (b as { type?: string }).type === "toolCall");
  return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
}

// --------------------------------------------------------------------------
// The runner
// --------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
  "You are a headless orchestrator. Use the Agent tool to delegate, then report the result.";

function isLive(options: RunPrintModeOptions): boolean {
  return Boolean(options.live) || /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");
}

export async function runPrintMode(options: RunPrintModeOptions): Promise<PrintModeRun> {
  const live = isLive(options);
  const isolateGlobals = options.isolateGlobals ?? !live;
  const timeoutMs = options.timeoutMs ?? 30_000;

  // --- working dir (own it only if we created it) ---
  const ownsCwd = options.cwd == null;
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "subagents-print-"));

  // chdir into cwd: the extension discovers .pi/agents/*.md from process.cwd()
  // (not ctx.cwd), and re-reads it on every Agent invocation — so a custom agent
  // is only spawnable if process.cwd() points at the dir holding it. Restored on
  // dispose. (Vitest isolates test files per process, so this doesn't race.)
  const prevCwd = process.cwd();
  process.chdir(cwd);

  // --- isolate global discovery so the dev env can't bleed in ---
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;
  let hermeticDir: string | undefined;
  if (isolateGlobals) {
    hermeticDir = mkdtempSync(join(tmpdir(), "subagents-print-home-"));
    process.env.PI_CODING_AGENT_DIR = hermeticDir;
    process.env.HOME = hermeticDir;
  }

  // --- model backend ---
  let faux: ReturnType<typeof registerFauxProvider> | undefined;
  let model: Model<string> | undefined;
  let modelRegistry: unknown;
  if (live) {
    // Explicit pin wins (options.live or PI_PROVIDER + PI_MODEL). Otherwise leave
    // `model` undefined: createAgentSession then calls findInitialModel() against
    // the real, auth-backed registry + your local settings default — i.e. it
    // picks up whatever your `pi` install is logged into, no env needed.
    const provider = options.live?.provider ?? process.env.PI_PROVIDER;
    const modelId = options.live?.model ?? process.env.PI_MODEL;
    if (provider && modelId) {
      // getModel's overloads need the concrete provider literal; cast through.
      model = (getModel as (p: string, m: string) => Model<string>)(provider, modelId);
    }
    modelRegistry = undefined; // let createAgentSession build the real, auth-backed registry
  } else {
    if (!options.steps && !options.respond) {
      throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
    }
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    model = faux.getModel();
    // Structural faux registry (matches the existing e2e suites): the parent
    // session uses `model` directly; subagents inherit it via ctx.model since
    // resolveDefaultModel falls back to the parent model when no model is pinned.
    modelRegistry = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      // createAgentSession's injected streamFn checks `auth.ok` and throws
      // Error(auth.error) otherwise — so the `ok: true` flag is mandatory, not
      // cosmetic. Without it the turn dies before streaming (empty error message).
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };

    // Pad the response queue: one context-branching responder per expected model
    // call. The queue is a single FIFO shared by parent + child, but every entry
    // is the same responder that decides from its own context, so interleaving
    // order doesn't matter.
    if (options.steps) {
      faux.setResponses(options.steps);
    } else {
      const respond = options.respond;
      if (!respond) {
        throw new Error("runPrintMode (faux mode): provide `respond` or `steps`");
      }
      const max = options.maxModelCalls ?? 16;
      const factory: FauxResponseStep = async (context, _opts, state) =>
        toAssistantMessage(await respond(context, state));
      faux.setResponses(Array.from({ length: max }, () => factory));
    }
  }

  // --- build the parent host session with the extension loaded ---
  // Resolved after globals are isolated, so it honors the hermetic dir.
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [EXTENSION_PATH],
    systemPromptOverride: () => options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  // Run any test-supplied registration (e.g. loadCustomAgents) now that globals
  // are isolated but before the parent turn spawns anything.
  await options.beforeRun?.();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    // Structural faux registry in faux mode; undefined in live mode (defaults).
    modelRegistry: modelRegistry as any,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    // Live: real settings so an omitted model resolves to your local default
    // (settingsManager.getDefaultModel) and retries/compaction match your config.
    // Faux: in-memory, deterministic, no disk.
    settingsManager: live
      ? SettingsManager.create(cwd, agentDir)
      : SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  session.setSessionName("print-mode-host");

  // Binding fires session_start so the extension initializes and publishes its
  // manager on the global Symbol.
  await session.bindExtensions({});

  const manager = (globalThis as Record<symbol, unknown>)[MANAGER_KEY] as
    | ManagerHandle
    | undefined;

  // --- subagent hold condition (the pi-chonky-step monkey-patch) ---
  // Block the parent agent loop while background subagents are still running, so
  // their completion nudges land before the parent's final turn.
  const hold = options.hold ?? true;
  if (hold && manager) {
    // dequeueFollowUpMessages is internal — reach through with a cast.
    const agent = (session as any).agent;
    if (agent?.dequeueFollowUpMessages) {
      const original = agent.dequeueFollowUpMessages.bind(agent);
      agent.dequeueFollowUpMessages = function patched() {
        const messages = original();
        if (messages.length > 0) return messages;
        if (manager.hasRunning()) {
          // Returning a Promise is auto-unwrapped by the async loop config —
          // the loop blocks here until all subagents finish and queue nudges.
          return manager.waitForAll().then(() => original());
        }
        return messages;
      };
    }
  }

  // --- collect the parent's last assistant text ---
  let responseText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") responseText = "";
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      responseText += event.assistantMessageEvent.delta;
    }
  });

  // --- forward external abort ---
  const onAbort = () => session.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // --- drive the turn under a wall-clock guard ---
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`print-mode runner timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        await session.prompt(options.prompt);
        // Fallback for when the hold patch is unavailable: catch any subagents
        // still running after prompt() returns and process their results.
        if (hold) {
          while (manager?.hasRunning()) {
            await manager.waitForAll();
            await session.prompt("Background agents have completed. Process their results.");
          }
        }
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    unsubscribe();
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (!responseText.trim()) {
    responseText = lastAssistantText(session);
  }

  // Snapshot subagent records (manager exposes them via the extension session,
  // but the cross-package handle only exposes getRecord — read listAgents off
  // the underlying manager if reachable, else fall back to an empty list).
  const subagents = snapshotSubagents(manager);

  const dispose = async () => {
    // Emit session_shutdown FIRST so extensions tear down cleanly — in live mode
    // the real env loads global extensions (e.g. a status-bar) whose background
    // timers would otherwise fire after dispose() invalidates the ctx and surface
    // as unhandled "stale ctx" rejections. dispose() itself does the invalidation,
    // so shutdown has to happen before it.
    try {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    } catch {
      /* ignore */
    }
    try {
      session.dispose?.();
    } catch {
      /* ignore */
    }
    faux?.unregister();
    delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
    // Restore cwd before removing the temp dir (can't rm the dir you're in).
    try {
      process.chdir(prevCwd);
    } catch {
      /* ignore */
    }
    if (isolateGlobals) {
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (hermeticDir) rmSync(hermeticDir, { recursive: true, force: true });
    }
    if (ownsCwd) rmSync(cwd, { recursive: true, force: true });
  };

  return {
    responseText: responseText.trim(),
    parentSession: session,
    manager,
    subagents,
    modelCalls: faux?.state.callCount ?? 0,
    dispose,
  };
}

/**
 * Extract the text of every `Agent` tool result in a session's history. This is
 * the real end-to-end observable: for a foreground spawn it contains the child's
 * own output; for a background spawn it's the "started in background" envelope.
 */
export function agentToolResults(session: AgentSession): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "toolResult") continue;
    if ((msg as { toolName?: string }).toolName !== "Agent") continue;
    const text = (msg.content as Array<{ type?: string; text?: string }>)
      .map((b) => (b.type === "text" ? (b.text ?? "") : ""))
      .join("");
    out.push(text);
  }
  return out;
}

/**
 * All text across the whole conversation — assistant turns, user/nudge messages,
 * and every tool result. Use this to assert a child's output *materialized
 * somewhere* (a foreground tool result, a get_subagent_result result, a held
 * nudge), rather than only in the parent's final message which may summarize it.
 */
export function conversationText(session: AgentSession): string {
  const parts: string[] = [];
  for (const msg of session.messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Names of every tool the assistant actually invoked (in order). */
export function invokedToolNames(session: AgentSession): string[] {
  const out: string[] = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string }>) {
      if (block.type === "toolCall" && block.name) out.push(block.name);
    }
  }
  return out;
}

/**
 * The arguments of every `Agent` tool call the model actually made — lets a live
 * smoke assert which feature was exercised (e.g. `run_in_background`,
 * `subagent_type`) rather than just that *some* spawn happened.
 */
export function agentToolCalls(session: AgentSession): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
      if (block.type === "toolCall" && block.name === "Agent") {
        out.push((block.arguments ?? {}) as Record<string, unknown>);
      }
    }
  }
  return out;
}

/** Walk session history backward for the last non-empty assistant text. */
function lastAssistantText(session: AgentSession): string {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const text = msg.content
      .map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Best-effort snapshot of the manager's agent records for assertions. */
function snapshotSubagents(manager: ManagerHandle | undefined): Array<Record<string, unknown>> {
  if (!manager) return [];
  // The published handle is minimal; the real manager (with listAgents) is the
  // same object the extension constructed. Try listAgents if present.
  const m = manager as unknown as { listAgents?: () => Array<Record<string, unknown>> };
  try {
    return m.listAgents ? m.listAgents() : [];
  } catch {
    return [];
  }
}
