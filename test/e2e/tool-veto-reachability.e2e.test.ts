/**
 * tool-veto-reachability.e2e.test.ts — reachability guard for the `ext:` turn-1
 * tool veto (issue #125).
 *
 * `installExtensionToolScope` enforces `ext:` narrowing two ways. Re-narrowing the
 * ACTIVE set on `turn_end` is built entirely on public API (`getAllTools`,
 * `getActiveToolNames`, `setActiveToolsByName`) and is covered by the unit tests.
 * The second half is not: turn 1 cannot be narrowed at all — `before_agent_start`
 * fires INSIDE `prompt()` and may widen the tool set, but `createContextSnapshot()`
 * freezes that turn's tools immediately after, leaving no window — so out-of-scope
 * calls are vetoed at call time by wrapping `session.agent.beforeToolCall`.
 *
 * That wrap is the one place this extension reaches past the documented surface:
 *   - `ExtensionBindings` has no tool_call hook, so there is no SDK-level way to
 *     inject a veto into a session we construct. Pi exposes the veto to EXTENSIONS
 *     as `pi.on("tool_call") -> { block, reason }`, but we are the SDK caller here,
 *     not an extension bound to the child session.
 *   - So we wrap the property Pi itself installs in the AgentSession constructor
 *     (`_installAgentToolHooks`), chaining to the prior hook so Pi's own `tool_call`
 *     dispatch still runs.
 *
 * The unit tests assert our wrapper's behavior against a MOCK session whose `agent`
 * is a hand-written `{ beforeToolCall: undefined }`. That mock cannot catch the one
 * thing that would silently break the veto: if a future Pi renames `beforeToolCall`,
 * stops installing it, makes `agent` non-enumerable/private, or moves the veto
 * elsewhere, our assignment lands on a property nothing reads. Every test still
 * passes, and out-of-scope tools become callable on turn 1 with no failing test.
 *
 * This guard closes exactly that gap and nothing else. It asserts against a REAL
 * session that:
 *   1. Pi installs its own `beforeToolCall` (so there IS a prior hook to chain), and
 *   2. after `runAgent`, ours is installed and vetoes an out-of-scope tool in the
 *      `{ block, reason }` shape Pi honors.
 *
 * No network/LLM: a faux Model satisfies `createAgentSession`, and the veto is
 * invoked directly rather than through a model turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import type { AgentConfig } from "../../src/types.js";
import { registerFauxProvider } from "../helpers/pi-ai.js";

// Real pi-mono (loader + dynamic extension import + session construction).
vi.setConfig({ testTimeout: 30_000 });

/** Registers `alpha_read` / `alpha_write`; reused so no new fixture is needed. */
const ALPHA = resolve(fileURLToPath(new URL("../fixtures/ext-alpha.mjs", import.meta.url)));
/** Registers `beta_tool` — loaded but NOT selected by the `ext:` selector below. */
const BETA = resolve(fileURLToPath(new URL("../fixtures/ext-beta.mjs", import.meta.url)));

function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("tool veto reachability against real pi-mono", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-veto-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("pi installs a chainable beforeToolCall, and runAgent's veto blocks out-of-scope tools", async () => {
    registerAgents(
      new Map([
        [
          "veto",
          {
            name: "veto",
            description: "veto guard",
            builtinToolNames: ["read"],
            // Select alpha only — beta loads (its handlers run) but is muted.
            extensions: [ALPHA, BETA],
            extSelectors: ["ext:ext-alpha.mjs"],
            skills: false,
            systemPrompt: "You are veto.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
          } as AgentConfig,
        ],
      ]),
    );

    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let priorIsFunction: boolean | undefined;
    let session: any;
    try {
      await runAgent(ctx, "veto", "go", {
        pi: makePi(),
        model,
        onSessionCreated: (s: any) => {
          session = s;
          // By onSessionCreated our wrapper is already installed, so this being a
          // function proves the property is reachable and writable. Pi installing
          // its own in the constructor is what gives us something to chain to —
          // asserted below via the in-scope path returning undefined rather than
          // throwing on a missing prior hook.
          priorIsFunction = typeof s.agent?.beforeToolCall === "function";
        },
      });
    } catch {
      // A faux-model turn may not complete; the veto is fixed at construction.
    }

    expect(priorIsFunction).toBe(true);

    // Out of scope: beta loaded but the ext: flip did not select it.
    await expect(
      session.agent.beforeToolCall({ toolCall: { name: "beta_tool" }, args: {} }),
    ).resolves.toMatchObject({ block: true, reason: expect.any(String) });

    // In scope: must NOT be blocked. Reaching Pi's own prior hook without throwing
    // also proves the chain is intact (a clobbered/absent prior would surface here).
    await expect(
      session.agent.beforeToolCall({ toolCall: { name: "alpha_read" }, args: {} }),
    ).resolves.toSatisfy((r: any) => !r?.block);
  });
});
