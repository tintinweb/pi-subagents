import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import subagents from "../src/index.js";
import { runWorkflow } from "../src/workflow/runtime.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";

vi.mock("../src/workflow/runtime.js", () => ({ runWorkflow: vi.fn() }));

it("crosses real AgentSession.reload twice without stale context/API calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reload-host-"));
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  const model = faux.getModel();
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [subagents] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model,
    ...fauxModelBackend(model), resourceLoader: loader, sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  let release!: (value: Awaited<ReturnType<typeof runWorkflow>>) => void;
  vi.mocked(runWorkflow).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const errors: string[] = [];
  try {
    await session.bindExtensions({ onError: error => errors.push(error.message) });
    const ctx = session.extensionRunner!.createContext();
    const tool = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.values()])
      .find(tool => tool.definition.name === "SubagentWorkflow")!.definition;
    await tool.execute("call", { script: 'export const meta = {name: "test", description: "test"}; return 1;' }, undefined, undefined, ctx);
    const options = vi.mocked(runWorkflow).mock.calls[0][0];
    await session.reload();
    expect(options.signal?.aborted).toBe(false);
    expect(() => ctx.cwd).toThrow(); // This is a real stale host context.
    // A gate launched after reload reads the workflow's captured context and
    // calls the extension API. Both must now resolve to the new host runtime.
    const gate = await options.host.runGate?.("printf reload-ok", {});
    expect(gate).toMatchObject({ ok: true, output: "reload-ok" });
    await session.reload();
    const secondGate = await options.host.runGate?.("printf twice-ok", {});
    expect(secondGate).toMatchObject({ ok: true, output: "twice-ok" });
    expect(options.signal?.aborted).toBe(false);
    release({ status: "completed", value: "ok", meta: { name: "test", description: "test" }, agentCount: 0, replayedCount: 0 } as Awaited<ReturnType<typeof runWorkflow>>);
    await vi.waitFor(() => expect(session.state.messages.some(message => message.role === "custom" && message.customType === "subagent-notification")).toBe(true));
    expect(errors).toEqual([]);
  } finally {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    faux.unregister();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
