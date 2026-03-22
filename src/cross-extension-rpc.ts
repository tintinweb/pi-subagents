/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping and spawn RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 */

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
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
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = events.on("subagents:rpc:ping", (raw: unknown) => {
    const { requestId } = raw as { requestId: string };
    events.emit(`subagents:rpc:ping:reply:${requestId}`, {});
  });

  const unsubSpawn = events.on("subagents:rpc:spawn", async (raw: unknown) => {
    const { requestId, type, prompt, options } = raw as {
      requestId: string; type: string; prompt: string; options?: any;
    };
    const ctx = getCtx();
    if (!ctx) {
      events.emit(`subagents:rpc:spawn:reply:${requestId}`, { error: "No active session" });
      return;
    }
    try {
      const id = manager.spawn(pi, ctx, type, prompt, options ?? {});
      events.emit(`subagents:rpc:spawn:reply:${requestId}`, { id });
    } catch (err: any) {
      events.emit(`subagents:rpc:spawn:reply:${requestId}`, { error: err.message });
    }
  });

  const unsubStop = events.on("subagents:rpc:stop", (raw: unknown) => {
    const { requestId, agentId } = raw as { requestId: string; agentId: string };
    try {
      const success = manager.abort(agentId);
      events.emit(`subagents:rpc:stop:reply:${requestId}`, { success });
    } catch {
      events.emit(`subagents:rpc:stop:reply:${requestId}`, { success: false });
    }
  });

  return { unsubPing, unsubSpawn, unsubStop };
}
