/** Native Pi discovery and the actual declarations received by a faux provider. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Context,
  fauxText,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  createToolSearchExtension,
  getAgentDir,
  type InlineExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokedToolNames,
  type PrintModeRun,
  runPrintMode,
  toolResultsNamed,
} from "../helpers/print-mode-runner.js";

const WORKFLOW = "SubagentWorkflow";
const nativeSearch: InlineExtension = {
  name: "tool-search",
  builtin: true,
  factory: createToolSearchExtension(),
};
const foreignWorkflow: InlineExtension = pi => {
  pi.registerTool({
    name: "Workflow",
    label: "Other workflow",
    description: "Another extension's workflow orchestrator",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "other workflow" }] };
    },
  });
};

function requestSnapshot(context: Context) {
  // The helper gives each run its own global directory. Normalize that one
  // environmental difference when comparing complete default/direct loadouts.
  const normalize = (text: string) => text.replaceAll(getAgentDir(), "<agent-dir>");
  return {
    tools: JSON.parse(normalize(JSON.stringify(getCurrentTools(context.messages)))) as ReturnType<typeof getCurrentTools>,
    system: normalize(getCurrentSystemPrompt(context.messages)),
    raw: normalize(JSON.stringify(context.messages)),
  };
}

describe("Workflow native deferred exposure", () => {
  const dirs: string[] = [];
  let run: PrintModeRun | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(settings: Record<string, unknown>) {
    const cwd = mkdtempSync(join(tmpdir(), "workflow-discovery-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeSettings(cwd, settings);
    return cwd;
  }

  function writeSettings(cwd: string, settings: Record<string, unknown>) {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
  }

  it("keeps the complete initial loadout unchanged for default and explicit direct", async () => {
    const cwd = project({});
    const firstRequests: ReturnType<typeof requestSnapshot>[] = [];
    for (const settings of [{}, { workflowToolExposure: "direct" }]) {
      writeSettings(cwd, settings);
      run = await runPrintMode({
        cwd,
        prompt: "Do not start a workflow.",
        systemPrompt: "",
        live: false,
        respond: context => {
          firstRequests.push(requestSnapshot(context));
          return fauxText("done");
        },
      });
      await run.dispose();
      run = undefined;
    }
    expect(firstRequests).toHaveLength(2);
    expect(firstRequests[0].tools).toEqual(firstRequests[1].tools);
    expect(firstRequests[0].system).toEqual(firstRequests[1].system);
    expect(firstRequests[0].tools.some(tool => tool.name === WORKFLOW)).toBe(true);
  });

  it.each(["SubagentWorkflow", "orchestrate subagents pipeline parallel workflow script"])(
    "discovers %s through real tool_search, then executes the original workflow",
    async query => {
      const cwd = project({ workflowToolExposure: "deferred" });
      const requests: ReturnType<typeof requestSnapshot>[] = [];
      const childPrompts: string[] = [];
      const completed = Promise.withResolvers<void>();
      let notified = false;
      const script = [
        'export const meta = { name: "deferred-e2e", description: "native discovery execution" };',
        'return await agent("DEFERRED-WORKFLOW-CHILD", { agentType: "Explore", label: "echo" });',
      ].join("\n");

      run = await runPrintMode({
        cwd,
        prompt: "Use a workflow for the requested task.",
        systemPrompt: "",
        live: false,
        extensionFactories: [nativeSearch],
        defaultTools: ["+tool_search"],
        maxModelCalls: 32,
        onParentSession: session => {
          session.subscribe(event => {
            if (event.type === "agent_end" && notified) completed.resolve();
          });
        },
        respond: context => {
          // Initial deferred parent requests also lack Workflow. Route by the
          // child context bridge, not by whether Workflow has been declared.
          if (getCurrentSystemPrompt(context.messages).includes("<workflow_child>")) {
            childPrompts.push(JSON.stringify(context.messages));
            return fauxText("DEFERRED-WORKFLOW-DONE");
          }
          requests.push(requestSnapshot(context));
          const text = JSON.stringify(context.messages);
          if (text.includes("<task-notification>")) {
            notified = true;
            return fauxText("workflow completed");
          }
          if (text.includes("Task ID:")) return fauxText("workflow launched");
          if (getCurrentTools(context.messages).some(tool => tool.name === WORKFLOW)) {
            return fauxToolCall(WORKFLOW, { script }, { id: "workflow-after-discovery" });
          }
          return fauxToolCall("tool_search", { query }, { id: "discover-workflow" });
        },
      });

      await completed.promise;
      const registered = run.parentSession.getAllTools().find(tool => tool.name === WORKFLOW)!;
      const initial = requests[0];
      const activated = requests[1];
      expect(registered.exposure).toBe("deferred");
      expect(initial.tools.some(tool => tool.name === "tool_search")).toBe(true);
      expect(initial.tools.some(tool => tool.name === WORKFLOW)).toBe(false);
      expect(initial.raw).not.toContain(JSON.stringify(registered.description).slice(1, -1));
      for (const guideline of registered.promptGuidelines ?? []) {
        expect(initial.system).not.toContain(guideline);
        expect(activated.system.split(guideline)).toHaveLength(2);
      }
      expect(activated.tools.filter(tool => tool.name === WORKFLOW)).toEqual([{
        name: WORKFLOW,
        description: registered.description,
        parameters: registered.parameters,
      }]);
      expect(toolResultsNamed(run.parentSession, "tool_search").join("\n")).toContain("SubagentWorkflow");
      expect(invokedToolNames(run.parentSession).slice(0, 2)).toEqual(["tool_search", WORKFLOW]);
      expect(childPrompts).toHaveLength(1);
      expect(childPrompts[0]).toContain("DEFERRED-WORKFLOW-CHILD");
      expect(requests.at(-1)!.raw).toContain("DEFERRED-WORKFLOW-DONE");
    },
    30_000,
  );

  it.each(["direct", "deferred"])("cannot rediscover a disabled %s Workflow", async exposure => {
    run = await runPrintMode({
      cwd: project({ workflowsEnabled: false, workflowToolExposure: exposure }),
      prompt: "Find the Workflow tool.",
      systemPrompt: "",
      live: false,
      extensionFactories: [nativeSearch],
      defaultTools: ["+tool_search"],
      respond: context => context.messages.some(message => message.role === "toolResult")
        ? fauxText("done")
        : fauxToolCall("tool_search", { query: WORKFLOW }),
    });
    expect(run.parentSession.getAllTools().some(tool => tool.name === WORKFLOW)).toBe(false);
    expect(toolResultsNamed(run.parentSession, "tool_search").join("\n")).toContain("No matching tools found.");
    expect(getCurrentTools(run.parentSession.messages).some(tool => tool.name === WORKFLOW)).toBe(false);
  });

  it.each([false, true])("preserves collision auto/pin behavior (pinned=%s)", async pinned => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const settings = { workflowToolExposure: "deferred", ...(pinned ? { workflowsEnabled: true } : {}) };
    run = await runPrintMode({
      cwd: project(settings),
      prompt: "Find the Workflow tool.",
      systemPrompt: "",
      live: false,
      extensionFactories: [nativeSearch, foreignWorkflow],
      defaultTools: ["+tool_search"],
      respond: context => context.messages.some(message => message.role === "toolResult")
        ? fauxText("done")
        : fauxToolCall("tool_search", { query: WORKFLOW }),
    });
    expect(run.parentSession.getAllTools().find(tool => tool.name === WORKFLOW)?.exposure)
      .toBe(pinned ? "deferred" : "hidden");
    expect(getCurrentTools(run.parentSession.messages).some(tool => tool.name === WORKFLOW)).toBe(pinned);
    expect(toolResultsNamed(run.parentSession, "tool_search").join("\n"))
      .toContain(pinned ? "Loaded 1 tool" : "No matching tools found.");
  });

  it("keeps deferred inactive when native search is registered but inactive, and warns", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requests: ReturnType<typeof requestSnapshot>[] = [];
    run = await runPrintMode({
      cwd: project({ workflowToolExposure: "deferred" }),
      prompt: "Do not start a workflow.",
      systemPrompt: "",
      live: false,
      extensionFactories: [nativeSearch],
      respond: context => {
        requests.push(requestSnapshot(context));
        return fauxText("done");
      },
    });
    expect(run.parentSession.getAllTools().some(tool => tool.name === "tool_search")).toBe(true);
    expect(requests[0].tools.some(tool => tool.name === "tool_search" || tool.name === WORKFLOW)).toBe(false);
    expect(warning.mock.calls.flat().join("\n")).toMatch(/tool_search.*inactive|inactive.*tool_search/);
  });

  it.each([
    { selection: ["read", "tool_search"], discoverable: false, initiallyActive: false },
    { selection: ["+tool_search"], discoverable: true, initiallyActive: false },
    { selection: ["read", "tool_search", WORKFLOW], discoverable: true, initiallyActive: true },
  ])("diagnoses the host tool selection $selection", async ({ selection, discoverable, initiallyActive }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requests: ReturnType<typeof requestSnapshot>[] = [];
    run = await runPrintMode({
      cwd: project({ workflowToolExposure: "deferred" }),
      prompt: "Find the Workflow tool.",
      systemPrompt: "",
      live: false,
      extensionFactories: [nativeSearch],
      tools: selection,
      respond: context => {
        requests.push(requestSnapshot(context));
        return context.messages.some(message => message.role === "toolResult")
          ? fauxText("done")
          : fauxToolCall("tool_search", { query: WORKFLOW });
      },
    });
    expect(requests[0].tools.some(tool => tool.name === WORKFLOW)).toBe(initiallyActive);
    expect(run.parentSession.getAllTools().some(tool => tool.name === WORKFLOW)).toBe(discoverable);
    expect(getCurrentTools(run.parentSession.messages).some(tool => tool.name === WORKFLOW)).toBe(discoverable);
    if (discoverable) expect(warning).not.toHaveBeenCalled();
    else expect(warning.mock.calls.flat().join("\n")).toMatch(/SubagentWorkflow.*(excluded|tool selection)/);
  });

  it("preserves reload activation and rediscovers in fresh and SDK-reopened sessions", async () => {
    const cwd = project({ workflowToolExposure: "deferred" });
    const requests: ReturnType<typeof requestSnapshot>[] = [];
    let search = true;
    const options = {
      cwd,
      prompt: "Discover the workflow.",
      systemPrompt: "",
      live: false as const,
      extensionFactories: [nativeSearch],
      defaultTools: ["+tool_search"],
      respond: (context: Context) => {
        requests.push(requestSnapshot(context));
        if (search) {
          search = false;
          return fauxToolCall("tool_search", { query: WORKFLOW });
        }
        return fauxText("done");
      },
    };
    run = await runPrintMode({ ...options, sessionManager: SessionManager.create(cwd, join(cwd, "sessions")) });
    const sessionFile = run.parentSession.sessionFile!;
    expect(requests[0].tools.some(tool => tool.name === WORKFLOW)).toBe(false);
    expect(requests[1].tools.some(tool => tool.name === WORKFLOW)).toBe(true);

    await run.parentSession.reload();
    await run.parentSession.prompt("Check the reloaded loadout.");
    expect(requests.at(-1)!.tools.some(tool => tool.name === WORKFLOW)).toBe(true);
    await run.dispose();
    run = undefined;

    run = await runPrintMode(options);
    expect(requests.at(-1)!.tools.some(tool => tool.name === WORKFLOW)).toBe(false);
    await run.dispose();
    run = undefined;

    // Activation restoration belongs to Pi. Search again if necessary, and
    // prove this is the existing transcript rather than another fresh session.
    search = true;
    run = await runPrintMode({ ...options, sessionManager: SessionManager.open(sessionFile) });
    expect(toolResultsNamed(run.parentSession, "tool_search")).toHaveLength(2);
    expect(requests.at(-1)!.tools.some(tool => tool.name === WORKFLOW)).toBe(true);
  }, 30_000);
});
