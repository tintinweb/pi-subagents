import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Callback = (...args: unknown[]) => unknown;
type Deferred = { run(): void; cancel(): void };
type Runtime = {
  api: ExtensionAPI;
  context?: ExtensionContext;
  proxy?: ExtensionContext;
  callbacks: Map<string, Callback>;
  pending: Deferred[];
  detached: boolean;
  closed: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  keepAlive?: () => boolean;
};

// The loader reimports modules on reload. A module-local map would disappear
// at exactly the moment it is needed. Session identity prevents another root
// session (or a child) from claiming an unrelated manager and workflow table.
const KEY = Symbol.for("pi-subagents:reload-runtime:v1");
const globals = globalThis as unknown as Record<symbol, Map<string, Runtime> | undefined>;
const retained = globals[KEY] ?? new Map<string, Runtime>();
globals[KEY] = retained;
const REATTACH_TIMEOUT_MS = 30_000;

/** Keep the running closure, but replace its host API and UI on /reload. */
export function registerReloadable(pi: ExtensionAPI, setup: (api: ExtensionAPI) => () => boolean): void {
  const created: Runtime = { api: pi, callbacks: new Map(), pending: [], detached: false, closed: false };
  let current = created;
  let sessionKey: string | undefined;

  const context = new Proxy({} as ExtensionContext, {
    get: (_target, key) => {
      const value: unknown = Reflect.get(created.context ?? {}, key);
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(Reflect.get(created.context ?? {}, key), created.context, args)
        : value;
    },
  });
  created.proxy = context;

  const send = (method: PropertyKey, args: unknown[], bus = false): unknown => {
    const invoke = () => {
      const target = bus ? created.api.events : created.api;
      return Reflect.apply(Reflect.get(target, method), target, args);
    };
    if (created.closed) {
      if (method === "exec") return Promise.reject(new Error("Subagents runtime closed"));
      return;
    }
    if (!created.detached) return invoke();
    if (method === "exec") {
      return new Promise((resolve, reject) => created.pending.push({
        run: () => { try { resolve(invoke()); } catch (error) { reject(error); } },
        cancel: () => reject(new Error("Subagents reload was not reattached")),
      }));
    }
    if (bus || method === "sendMessage" || method === "sendUserMessage" || method === "appendEntry") {
      created.pending.push({ run: () => { invoke(); }, cancel() {} });
      return;
    }
    // Registration and configuration reads run at activation, not in a worker.
    return invoke();
  };

  const dispose = async (runtime: Runtime) => {
    runtime.closed = true;
    if (runtime.expiry) clearTimeout(runtime.expiry);
    for (const pending of runtime.pending.splice(0)) pending.cancel();
    await runtime.callbacks.get("on:session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, runtime.context);
  };

  const wrap = (key: string, callback: Callback): Callback => {
    created.callbacks.set(key, callback);
    return (...incoming: unknown[]) => {
      const lifecycle = key.startsWith("on:");
      const ctxIndex = lifecycle ? 1 : key.endsWith(":execute") ? 4 : key.endsWith(":handler") ? 1 : -1;
      const ctx = ctxIndex >= 0 ? incoming[ctxIndex] as ExtensionContext | undefined : undefined;
      if (ctx && ctx !== current.proxy) current.context = ctx;
      const event = incoming[0] as { reason?: string } | undefined;
      if (key === "on:session_start" && ctx) {
        return (async () => {
          sessionKey = JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()]);
          const previous = event?.reason === "reload" ? retained.get(sessionKey) : undefined;
          if (previous && previous !== current) {
            await dispose(created);
            retained.delete(sessionKey);
            current = previous;
            current.api = pi;
            current.context = ctx;
            current.detached = false;
            if (current.expiry) clearTimeout(current.expiry);
          }
          // The saved callbacks captured their own stable context proxy.
          const result = await current.callbacks.get(key)?.(incoming[0], current.proxy);
          for (const pending of current.pending.splice(0)) pending.run();
          return result;
        })();
      }
      if (key === "on:session_shutdown" && event?.reason === "reload" && sessionKey && ctx) {
        return (async () => {
          if (!current.keepAlive?.()) {
            await dispose(current);
            return;
          }
          // Snapshot guarded getters while the old runner is still valid. The
          // worker can finish a child/start another during the reload gap.
          const systemPrompt = ctx.getSystemPrompt();
          const snapshot = { ...ctx, hasUI: false, getSystemPrompt: () => systemPrompt };
          await current.callbacks.get(key)?.(...incoming);
          current.context = snapshot;
          current.detached = true;
          retained.set(sessionKey!, current);
          const saved = current;
          saved.expiry = setTimeout(() => {
            if (retained.get(sessionKey!) !== saved) return;
            retained.delete(sessionKey!);
            void dispose(saved).catch(() => {});
          }, REATTACH_TIMEOUT_MS);
          saved.expiry.unref();
        })();
      }
      if (key === "on:session_shutdown" && event?.reason !== "reload") {
        if (sessionKey && retained.get(sessionKey) === current) retained.delete(sessionKey);
        if (current.expiry) clearTimeout(current.expiry);
      }
      const args = [...incoming];
      if (ctx) args[ctxIndex] = current.proxy;
      return current.callbacks.get(key)?.(...args);
    };
  };

  const facade = new Proxy(pi, {
    get: (_target, method) => {
      if (method === "events") return {
        emit: (...args: unknown[]) => send("emit", args, true),
        on: (...args: unknown[]) => send("on", args, true),
      };
      if (method === "on") return (event: string, handler: Callback) =>
        Reflect.apply(pi.on, pi, [event, wrap(`on:${event}`, handler)]);
      if (typeof method === "string" && method.startsWith("register") && method !== "registerFlag") {
        return (...args: unknown[]) => {
          const first = args[0];
          const name = typeof first === "string" ? first : (first as { name: string }).name;
          const wrapped = args.map(value => {
            if (typeof value === "function") return wrap(`${method}:${name}`, value as Callback);
            if (value && typeof value === "object") {
              const wrappedObject = Object.fromEntries(Object.entries(value).map(([field, item]) => [field,
                typeof item === "function" ? wrap(`${method}:${name}:${field}`, item as Callback) : item]));
              // Mention dispatch passes the registered Agent definition directly.
              return method === "registerTool" ? Object.assign(value, wrappedObject) : wrappedObject;
            }
            return value;
          });
          return Reflect.apply(Reflect.get(created.api, method), created.api, wrapped);
        };
      }
      const value: unknown = Reflect.get(created.api, method);
      return typeof value === "function" ? (...args: unknown[]) => send(method, args) : value;
    },
  });
  created.keepAlive = setup(facade);
}
