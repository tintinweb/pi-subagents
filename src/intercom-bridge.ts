/**
 * intercom-bridge.ts — Optional bridge to pi-intercom's `contact_supervisor` tool.
 *
 * pi-intercom (https://github.com/nicobailon/pi-intercom), when installed,
 * registers a child-only `contact_supervisor` tool on subagent sessions iff the
 * process env advertises bridge metadata (the PI_SUBAGENT_* keys) at the moment
 * the child's extensions load. pi-subagents owns that advertisement.
 *
 * Contract (verified against pi-intercom index.ts):
 *  - The child extension's factory reads `process.env.PI_SUBAGENT_*` synchronously
 *    during `await loader.reload()`. So the env must be set before that call and
 *    restored after, to stay invisible to sibling spawns.
 *  - `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` is resolved by intercom against its
 *    broker session list; `PI_SUBAGENT_ORCHESTRATOR_TARGET` is the display
 *    fallback. Both are set to the orchestrator's pi session id, which is the
 *    same value intercom registers with its broker (intercom index.ts:938 uses
 *    `ctx.sessionManager.getSessionId()`). We read it from our own `ctx` in
 *    agent-runner — NOT from `PI_INTERCOM_SESSION_ID` — so the bridge works with
 *    any intercom version and has no timing dependency on the orchestrator's
 *    intercom session_start having fired.
 *  - The child's intercom `session_start` handler overwrites
 *    `PI_INTERCOM_SESSION_ID` with the child's own broker id. We snapshot/restore
 *    it around bindExtensions so the orchestrator-side intercom runtime keeps a
 *    stable view of its own id across spawns.
 *
 * When pi-intercom is not installed, the PI_SUBAGENT_* env is emitted but nothing
 * reads it — harmless. Children behave as plain ephemeral subagents and any
 * `contact_supervisor` call would simply fail to deliver (no broker peer).
 *
 * Nested subagents: because the orchestrator id is read from each spawner's own
 * `ctx`, a grandchild's contact_supervisor routes to its immediate parent worker,
 * not the top user session.
 */

const SUBAGENT_BRIDGE_KEYS = [
  "PI_SUBAGENT_ORCHESTRATOR_TARGET",
  "PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_CHILD_INDEX",
  "PI_SUBAGENT_INTERCOM_SESSION_NAME",
] as const;

const INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";

let bridgeChain: Promise<unknown> = Promise.resolve();

/**
 * Serialize the env-sensitive windows (loader.reload + bindExtensions) across
 * concurrent spawns. `process.env` is process-global, so without this lock two
 * sibling spawns could interleave and a child's factory would read the wrong
 * sibling's metadata. The locked regions are short (extension setup only); the
 * (long) agent run happens outside the lock.
 */
export function withIntercomBridgeLock<T>(task: () => Promise<T>): Promise<T> {
  const run = bridgeChain.then(task, task);
  bridgeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

/**
 * Set the PI_SUBAGENT_* bridge env for the child about to load extensions.
 * Returns a restore function that resets each key to its prior value. Caller
 * invokes it after `await loader.reload()` resolves, inside the same lock.
 *
 * `orchestratorSessionId` is the spawner's pi session id
 * (`ctx.sessionManager.getSessionId()`), which is the value intercom registers
 * with its broker — so the child's contact_supervisor routes back to the
 * spawner regardless of intercom version.
 */
export function applySubagentBridgeEnv(values: {
  orchestratorSessionId: string;
  runId: string;
  agent: string;
  index: string;
  sessionName?: string;
}): () => void {
  const snapshot: Record<string, string | undefined> = {};
  const toSet: Record<string, string> = {
    PI_SUBAGENT_ORCHESTRATOR_TARGET: values.orchestratorSessionId,
    PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: values.orchestratorSessionId,
    PI_SUBAGENT_RUN_ID: values.runId,
    PI_SUBAGENT_CHILD_AGENT: values.agent,
    PI_SUBAGENT_CHILD_INDEX: values.index,
  };
  if (values.sessionName) toSet.PI_SUBAGENT_INTERCOM_SESSION_NAME = values.sessionName;
  for (const k of SUBAGENT_BRIDGE_KEYS) snapshot[k] = process.env[k];
  for (const [k, v] of Object.entries(toSet)) process.env[k] = v;
  return () => {
    for (const k of SUBAGENT_BRIDGE_KEYS) {
      const prev = snapshot[k];
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  };
}

/**
 * Snapshot PI_INTERCOM_SESSION_ID so it can be restored after the child's
 * intercom session_start overwrites it with the child's own broker id. Call
 * before `await session.bindExtensions()` (inside the lock); invoke the
 * returned restore function after bind resolves.
 */
export function snapshotIntercomSessionId(): () => void {
  const prev = process.env[INTERCOM_SESSION_ID_ENV];
  return () => {
    if (prev === undefined) delete process.env[INTERCOM_SESSION_ID_ENV];
    else process.env[INTERCOM_SESSION_ID_ENV] = prev;
  };
}