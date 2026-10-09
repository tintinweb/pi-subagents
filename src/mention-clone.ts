/**
 * mention-clone.ts — start a mentioned agent through a clone of this
 * conversation, without putting anything in the chat.
 *
 * Claude Code routes `@agent-<type>` through the main model: the mention
 * becomes a `<system-reminder>` appended to the prompt and the model makes the
 * tool call (see `agentMentionReminder`). That buys the spawned agent a prompt
 * written with conversation context, and costs a visible turn — the model's
 * reasoning and its tool block land in the transcript, for a decision the user
 * already made when they typed the handle.
 *
 * So the turn happens somewhere else. The conversation is cloned into a
 * throwaway in-memory session — same messages, same system prompt, same model —
 * and that copy takes the turn off-screen. A literal clone: the session's own
 * entries, not `inherit_context`'s text rendering of them.
 *
 * Pi builds every request from the session manager, so that is where the
 * clone's history goes: the parent's root-to-leaf entries, handed to
 * `SessionManager.inMemory`. The clone projects them itself, compaction and
 * branch summaries included, so a long conversation clones as what the main
 * model is actually working from. A conversation with nothing in it yet clones
 * to nothing in it yet, which is the correct answer rather than a failure.
 *
 * Cloned from memory rather than from the session file, which cannot be relied
 * on: `SessionManager._persist` withholds every write until the first assistant
 * message lands, so a fork taken before then reads an empty file and throws.
 *
 * The system prompt cannot ride along in those entries. Pi rebuilds it from the
 * session's own options on every request and patches the difference over the
 * transcript, so the parent's prompt would be replaced by the clone's. It goes
 * in through the resource loader's prompt override instead.
 *
 * Three details make the spawn belong to the real session rather than the
 * clone:
 *
 *   - the clone is handed the *registered* `Agent` tool, whose handler closes
 *     over the main activation, so it spawns top-level: widget, fleet row,
 *     handle, completion notification, all as if the main model had called it;
 *   - that tool is re-bound to the main `ExtensionContext`, because the handler
 *     reads `cwd`, `model` and `sessionManager.getSessionId()` off it to place
 *     the transcript and the `rootSessionId`. The clone's own context would
 *     file both under the throwaway fork;
 *   - it is called with no tool-call id. The clone's turn produces one, but the
 *     real session never issued it, and a `<tool-use-id>` pointing at nothing
 *     is exactly the bug the mention-resume path had to fix;
 *   - and it is forced into the background. A foreground agent returns its
 *     answer as the tool result and is marked `resultConsumed` so no completion
 *     notification is sent — correct when the caller is the real conversation,
 *     silent loss when the caller is a fork about to be discarded. Background
 *     delivery is the only route from a mention back to the main model.
 *
 * The clone gets one tool and one job. It cannot read, write or run anything —
 * an invisible turn with the full toolset could do invisible work.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  type ExtensionToolContext,
  getAgentDir,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runInChildSessionContext } from "./child-context.js";
import { agentMentionReminder } from "./mention.js";
import type { SubagentType } from "./types.js";

export interface MentionCloneOptions {
  /** The MAIN session's context — what the spawn is attributed to, and the
   * source of both the conversation and the live system prompt. */
  ctx: ExtensionContext;
  /** Agent type the handle resolved to. */
  type: SubagentType;
  /** What the user typed after the handle. */
  message: string;
  /** The registered `Agent` tool, reused so the spawn is an ordinary one. */
  agentTool: ToolDefinition;
}

export interface MentionCloneResult {
  /** True once the clone actually called `Agent`. */
  spawned: boolean;
  /** Why not, when it didn't. Absent on success. */
  error?: string;
}

/**
 * Fork the conversation, let the copy make the tool call, throw the copy away.
 * Never rejects: a clone that cannot run is reported so the caller can fall
 * back to starting the agent directly.
 */
export async function runMentionClone(opts: MentionCloneOptions): Promise<MentionCloneResult> {
  const { ctx, type, message, agentTool } = opts;

  let spawned = false;
  const cloneAgentTool: ToolDefinition = {
    ...agentTool,
    execute: (_cloneToolCallId, params, signal, onUpdate, _cloneCtx) => {
      // One spawn per mention. The clone has a single tool and every reason to
      // stop after using it, but a model that decides to "also" launch a second
      // agent would do it where nobody can see and nobody asked.
      if (spawned) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Already started an agent for this mention. Stop here." }],
          details: undefined,
          isError: true,
        });
      }
      spawned = true;
      // undefined tool-call id + the main ctx: see the header. Background is
      // forced rather than left to the clone: `run_in_background` defaults to
      // false, and a foreground agent answers through its TOOL RESULT — which
      // here is delivered into a session that is disposed moments later, so the
      // agent would run, appear in the widget and the fleet, and reach nobody.
      return agentTool.execute(
        undefined as never,
        { ...(params as Record<string, unknown>), run_in_background: true } as typeof params,
        signal,
        onUpdate,
        // A tool context adds `tools` and `executeTool`, for nested tool calls;
        // the Agent handler reads neither, only the main session's own fields.
        ctx as ExtensionToolContext,
      );
    },
  };

  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    // Pi 0.80.8 moved createAgentSession from modelRegistry to modelRuntime;
    // agent-runner.ts carries the same shim for the same reason — pass both so
    // the clone keeps the parent's providers across the supported range.
    const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
    // Absent when the session has no level of its own; the clone then takes the
    // settings level, which is what a session that never ran `/think` is on.
    const thinkingLevel = ctx.thinkingLevel;
    // The live system prompt, not the one the clone would build from cwd and
    // agentDir — extensions contribute to it per turn. Everything the loader
    // would add on top (AGENTS.md, skills, APPEND_SYSTEM.md) is already in the
    // rendered prompt, so it is suppressed, as agent-runner does.
    const systemPrompt = ctx.getSystemPrompt();
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: (base: string | undefined) => systemPrompt || base,
      appendSystemPromptOverride: () => [],
    });
    await runInChildSessionContext(() => loader.reload());
    const created = await runInChildSessionContext(() =>
      createAgentSession({
        cwd: ctx.cwd,
        // The parent's root-to-leaf path, which the clone projects itself:
        // compaction applied, branch summaries substituted. Not `getEntries()`,
        // whose last entry is not the leaf after `/tree` navigation. In memory,
        // so nothing about the copy is persisted and the real session stays
        // untouched.
        sessionManager: SessionManager.inMemory(ctx.cwd, undefined, ctx.sessionManager.getBranch()),
        resourceLoader: loader,
        model: ctx.model as Model<never> | undefined,
        ...(thinkingLevel && { thinkingLevel }),
        modelRegistry: ctx.modelRegistry,
        ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
        // An allowlist naming exactly the clone's own tool. NOT `noTools:
        // "all"`, whose doc comment ("start with no tools enabled") reads like
        // it spares custom tools and does not: it resolves to an EMPTY
        // allowlist, and `isAllowedTool` then drops every tool from the
        // registry — the custom one included. The clone would be prompted with
        // nothing to call, answer in prose, and every mention would fall
        // through to the direct start with a warning. Same idiom as
        // agent-runner's `tools: sessionTools` beside its nested `customTools`.
        tools: [cloneAgentTool.name],
        customTools: [cloneAgentTool],
      } as Parameters<typeof createAgentSession>[0]),
    );
    session = created.session;

    // User text first, reminder after — the order Claude Code's attachment
    // renderer produces, where the reminder trails the message it is about.
    await session.prompt(`${message}\n\n${agentMentionReminder(type)}`);
  } catch (err) {
    return { spawned, error: err instanceof Error ? err.message : String(err) };
  } finally {
    session?.dispose?.();
  }

  return spawned
    ? { spawned: true }
    : { spawned: false, error: "the conversation clone did not start it" };
}
