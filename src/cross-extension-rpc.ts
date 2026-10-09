/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, and consume RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 *
 * @see docs/rpc.md — the caller-facing integration reference: spawn options
 * (including the fields spawnTopLevel strips), every error string, the
 * completion-notification race, and what protocol version 2 does not promise.
 */

import { isTopLevelAgent } from "./agent-manager.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import type { AgentRecord } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop/consume RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  /** Resolves once the spawned agent is running; rejects on a startup failure. */
  awaitStartup(id: string): Promise<void>;
  abort(id: string): boolean;
  /**
   * The record behind an id, for the stop handler's ownership check. Narrowed
   * to the two fields `isTopLevelAgent` reads, so the RPC layer keeps its
   * deliberately shallow view of the manager.
   */
  getRecord(id: string): Pick<AgentRecord, "parentAgentId" | "workflowId"> | undefined;
  /**
   * Mark a settled agent's result as read by the caller, suppressing the
   * completion notification — what `get_subagent_result` does when it returns
   * one. False when there is no such agent, or it has not settled yet.
   */
  consumeResult(id: string): boolean;
  /**
   * Deliver a message to a running or queued agent's conversation — what
   * `steer_subagent` does. False when the agent is unknown or has settled.
   */
  steer(id: string, message: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
  unsubSteer: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, stop, and consume RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", async ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = options ?? {};
      // `!= null` on purpose: a JSON-forwarding caller can serialize an unset
      // field as null, and the runner reads `options.model ?? default`, so null
      // means "inherit" — not an override to resolve or scope-check.
      const override = normalizedOptions.model;
      if (override != null) {
        const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
        // Names the override the same way in both messages below; an object
        // override would otherwise interpolate as "[object Object]".
        const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
        if (!modelRegistry) {
          throw new Error(`Model override "${label}" provided but ctx.modelRegistry is unavailable`);
        }
        let model = override;
        if (typeof override === "string") {
          const resolved = resolveModel(override, modelRegistry);
          if (typeof resolved === "string") {
            // resolveModel returns a human-readable error string when the
            // input doesn't match any available model. Surface it instead of
            // silently falling back so the caller sees the auth/typo issue.
            throw new Error(resolved);
          }
          model = resolved;
          normalizedOptions = { ...normalizedOptions, model: resolved };
        }

        // A model on the RPC payload is an orchestrator-level choice, exactly
        // like Agent({ model }) — so it gets the Agent tool's hard error, never
        // the frontmatter warn (#240). The check reads the RESOLVED model:
        // resolveModel is fuzzy, so a bare "sonnet" can land on a provider the
        // caller never named. Frontmatter-pinned and parent-inherited models are
        // resolved later, in agent-runner, and keep warn-and-proceed.
        const verdict = checkModelScope({
          model,
          cwd: cwd ?? process.cwd(),
          modelRegistry,
          callerSupplied: true,
          agentLabel: type,
          modelInput: label,
        });
        if (verdict.kind === "error") throw new Error(verdict.message);
      }

      const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
      // With isolation: "worktree" the agent starts asynchronously — wait for
      // it, so a strict-isolation failure is still an error envelope rather
      // than an id for an agent that never ran.
      await manager.awaitStartup(id);
      return { id };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      const record = manager.getRecord(agentId);
      if (!record) throw new Error("Agent not found");
      // Only the session's own agents are this RPC's to stop. A nested child or
      // a workflow's agent is owned by something that is *waiting on it*, and
      // aborting it out from under that owner turns another extension's stop
      // into a failed step here. Defence in depth rather than a live hole: no
      // RPC hands out agent ids, so a caller has no ordinary way to name one it
      // does not own — but the guard is cheap and the id may leak some other
      // way. Same refuse-what-we-should-not-touch stance as `consume` below.
      if (!isTopLevelAgent(record)) throw new Error("Agent is owned by another agent or workflow");
      // Not "not found" — the lookup above already proved it exists. `abort`
      // returns false only for a record that is neither running nor queued,
      // which is an agent that has already finished.
      if (!manager.abort(agentId)) throw new Error("Agent is not running");
    },
  );

  // A caller that has already shown the model an agent's result — pi-tasks'
  // TaskOutput is the one in practice — says so here, so the completion
  // notification for that same result is not delivered on top of it and does
  // not cost the parent a turn. Deliberately outside the ping version
  // handshake: an extension built against protocol v2 simply never calls it.
  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:consume", ({ agentId }) => {
      if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
    },
  );

  // An extension that spawned an agent over the bus and then learns something
  // that agent needs — a second CI failure on the head it is already fixing, a
  // review that landed mid-run — can hand it over instead of spawning a second
  // agent for the same work or dropping the fact. Same ownership guard as stop:
  // an agent something else is waiting on is not this caller's to redirect.
  // Outside the ping version handshake, like consume: additive and best-effort.
  const unsubSteer = handleRpc<{ requestId: string; agentId: string; message: unknown }>(
    events, "subagents:rpc:steer", ({ agentId, message }) => {
      if (typeof message !== "string" || message.trim().length === 0) throw new Error("Steer message must be a non-empty string");
      const record = manager.getRecord(agentId);
      if (!record) throw new Error("Agent not found");
      if (!isTopLevelAgent(record)) throw new Error("Agent is owned by another agent or workflow");
      if (!manager.steer(agentId, message)) throw new Error("Agent is not running");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop, unsubConsume, unsubSteer };
}
