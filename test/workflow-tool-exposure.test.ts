import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension, { WORKFLOW_ENTRY_TYPE, WORKFLOW_FILE_FLAG } from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("workflow tool exposure wiring", () => {
  let hermetic: Hermetic;
  const instances: ReturnType<typeof makePi>[] = [];

  function boot(settings: Record<string, unknown> = {}, flags: Record<string, boolean | string> = {}) {
    hermetic = hermeticDir({ settings });
    const booted = makePi(flags);
    subagentsExtension(booted.pi);
    instances.push(booted);
    // This helper predates exposure and activates every registration. Correct
    // its active set here; real-session tests verify native initial visibility.
    booted.pi.setActiveTools([...booted.tools.values()]
      .filter(tool => tool.exposure !== "deferred")
      .map(tool => tool.name));
    booted.pi.getAllTools.mockImplementation(() => [...booted.tools.values()]);
    return booted;
  }

  afterEach(async () => {
    for (const booted of instances.splice(0)) {
      await booted.lifecycle.get("session_shutdown")?.({}, ctx());
    }
    hermetic?.restore();
    vi.restoreAllMocks();
  });

  function nativeSearch(overrides: Partial<ToolInfo> = {}): ToolInfo {
    return {
      name: "tool_search",
      description: "Native tool discovery",
      parameters: Type.Object({ query: Type.String() }),
      exposure: "model-only",
      sourceInfo: { source: "builtin", path: "builtin:tool-search", scope: "temporary", origin: "top-level" },
      ...overrides,
    };
  }

  it("changes only exposure in the complete registered tool spec", async () => {
    const direct = boot();
    const directSpec = JSON.parse(JSON.stringify(direct.tools.get("SubagentWorkflow")));
    await direct.lifecycle.get("session_shutdown")?.({}, ctx());
    instances.splice(0);
    hermetic.restore();
    const deferred = boot({ workflowToolExposure: "deferred" });
    const deferredSpec = JSON.parse(JSON.stringify(deferred.tools.get("SubagentWorkflow")));
    expect(deferredSpec).toEqual({ ...directSpec, exposure: "deferred" });
    expect(deferred.tools.size).toBe(direct.tools.size);
  });

  it.each(["direct", "deferred"])("does not register workflows when disabled with %s exposure", exposure => {
    const booted = boot({ workflowsEnabled: false, workflowToolExposure: exposure });
    expect(booted.tools.has("SubagentWorkflow")).toBe(false);
    booted.lifecycle.get("context")({}, ctx());
    expect(booted.pi.getAllTools).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, "not registered"],
    ["inactive", nativeSearch(), "inactive"],
    ["foreign", nativeSearch({ sourceInfo: { source: "inline", path: "<inline:other>", scope: "temporary", origin: "top-level" } }), "cannot verify"],
    ["wrong path", nativeSearch({ sourceInfo: { source: "builtin", path: "builtin:other", scope: "temporary", origin: "top-level" } }), "cannot verify"],
    ["wrong exposure", nativeSearch({ exposure: "hidden" }), "cannot verify"],
  ] as const)("warns before requests for %s search and preserves deferred", (_label, search, reason) => {
    const booted = boot({ workflowToolExposure: "deferred" });
    booted.pi.getAllTools.mockReturnValue([booted.tools.get("SubagentWorkflow"), ...(search ? [search] : [])]);
    if (search && reason === "cannot verify") booted.pi.setActiveTools(["tool_search"]);
    const context = ctx({ hasUI: true });
    const check = booted.lifecycle.get("context");
    check({}, context);
    check({}, context);
    expect(context.ui.notify.mock.calls).toEqual([[
      expect.stringContaining(reason), "warning",
    ]]);
    expect(context.ui.notify.mock.calls[0][0]).toContain('"+tool_search"');
    expect(context.ui.notify.mock.calls[0][0]).toContain(".pi/settings.json");
    expect(context.ui.notify.mock.calls[0][0]).toContain("re-enable builtin:tool-search");
    expect(booted.tools.get("SubagentWorkflow").exposure).toBe("deferred");
  });

  it("rechecks active tools and warns again after discovery becomes unavailable", () => {
    const booted = boot({ workflowToolExposure: "deferred" });
    booted.pi.getAllTools.mockReturnValue([booted.tools.get("SubagentWorkflow"), nativeSearch()]);
    const context = ctx({ hasUI: true });
    const check = booted.lifecycle.get("context");
    booted.pi.setActiveTools(["tool_search"]);
    check({}, context);
    expect(context.ui.notify).not.toHaveBeenCalled();
    booted.pi.setActiveTools([]);
    check({}, context);
    expect(context.ui.notify).toHaveBeenCalledTimes(1);
    booted.pi.setActiveTools(["tool_search"]);
    check({}, context);
    booted.pi.setActiveTools([]);
    check({}, context);
    expect(context.ui.notify).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "direct"])("does not check discovery for %s exposure", exposure => {
    const booted = boot({ workflowToolExposure: exposure });
    booted.pi.setActiveTools([]);
    booted.lifecycle.get("context")({}, ctx());
    expect(booted.pi.getAllTools).not.toHaveBeenCalled();
  });

  it("does not warn when a deferred workflow is already active", () => {
    const booted = boot({ workflowToolExposure: "deferred" });
    booted.pi.setActiveTools(["SubagentWorkflow"]);
    booted.lifecycle.get("context")({}, ctx());
    expect(booted.pi.getAllTools).not.toHaveBeenCalled();
  });

  it("warns when the host excludes Workflow even with native search active", () => {
    const booted = boot({ workflowToolExposure: "deferred" });
    booted.pi.getAllTools.mockReturnValue([nativeSearch()]);
    booted.pi.setActiveTools(["tool_search"]);
    const context = ctx({ hasUI: true });
    booted.lifecycle.get("context")({}, context);
    expect(context.ui.notify).toHaveBeenCalledWith(expect.stringContaining("excluded from Pi's tool registry"), "warning");
    expect(context.ui.notify.mock.calls[0][0]).toContain("reload after enabling Workflows");
    expect(context.ui.notify.mock.calls[0][0]).toContain("--tools +tool_search");
    expect(context.ui.notify.mock.calls[0][0]).toContain("Plain --tools allowlists must also include SubagentWorkflow");
  });

  it("hides deferred workflows on auto collision and refuses retained execution", async () => {
    const booted = boot({ workflowToolExposure: "deferred" });
    const retained = booted.tools.get("SubagentWorkflow");
    booted.pi.getAllTools.mockReturnValue([{ name: "Workflow", description: "Another orchestrator" }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await booted.lifecycle.get("session_start")({}, ctx());
    expect(booted.tools.get("SubagentWorkflow").exposure).toBe("hidden");
    const result = await retained.execute("call", {}, undefined, undefined, ctx());
    expect(result.content[0].text).toBe("Workflows are disabled in this session.");
  });

  it("preserves deferred exposure when workflows are explicitly pinned on", async () => {
    const booted = boot({ workflowsEnabled: true, workflowToolExposure: "deferred" });
    booted.pi.getAllTools.mockReturnValue([{ name: "Workflow", description: "Another orchestrator" }]);
    await booted.lifecycle.get("session_start")({}, ctx());
    expect(booted.tools.get("SubagentWorkflow").exposure).toBe("deferred");
  });

  it.each(["direct", "deferred"])("keeps registered %s execution after a menu toggle until reload", async exposure => {
    const booted = boot({ workflowToolExposure: exposure });
    initTheme(undefined, false);
    let selected = false;
    const context = ctx({
      ui: {
        notify: vi.fn(),
        select: vi.fn(async () => {
          if (selected) return undefined;
          selected = true;
          return "Settings";
        }),
        custom: vi.fn(async (factory: (tui: object, theme: object, keys: object, done: () => void) => { render: (width: number) => string[]; handleInput: (data: string) => void }) => {
          const list = factory({}, {}, {}, () => {});
          for (let row = 0; row < 100; row++) {
            const selected = list.render(120).map(stripVTControlCharacters).find(line => line.startsWith("→ "));
            if (selected?.startsWith("→ Workflows ")) {
              list.handleInput(" ");
              return undefined;
            }
            list.handleInput("\u001b[B");
          }
          throw new Error("Workflows setting not found");
        }),
      },
    });
    await booted.commands.get("agents").handler("", context);
    const saved = JSON.parse(readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf-8"));
    expect(saved.workflowsEnabled).toBe(false);
    const result = await booted.tools.get("SubagentWorkflow").execute("call", {}, undefined, undefined, ctx());
    expect(result.content[0].text).toContain("Provide `script`");
  });

  it.each([true, false])("honors the deferred workflow CLI flag with workflowsEnabled=%s and no search", async enabled => {
    const booted = boot({ workflowsEnabled: enabled, workflowToolExposure: "deferred" }, { [WORKFLOW_FILE_FLAG]: "flow.js" });
    writeFileSync(join(hermetic.dir, "flow.js"), 'export const meta = { name: "cli", description: "Literal result" }; return "cli-result";');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await booted.lifecycle.get("session_start")({}, ctx());
    if (enabled) {
      await vi.waitFor(() => expect(booted.pi.appendEntry).toHaveBeenCalledWith(WORKFLOW_ENTRY_TYPE, expect.objectContaining({ status: "completed" })));
      expect(booted.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("<result>cli-result</result>") }), { deliverAs: "nextTurn" });
    } else {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignored: workflows are off"));
      expect(booted.pi.appendEntry).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, "direct", "deferred"])("preserves %s exposure while saving an unrelated setting", async exposure => {
    const booted = boot({ workflowToolExposure: exposure });
    initTheme(undefined, false);
    let selected = false;
    const context = ctx({
      ui: {
        notify: vi.fn(),
        select: vi.fn(async () => {
          if (selected) return undefined;
          selected = true;
          return "Settings";
        }),
        custom: vi.fn(async (factory: (tui: object, theme: object, keys: object, done: () => void) => { handleInput: (data: string) => void }) => {
          factory({}, {}, {}, () => {}).handleInput(" ");
          return undefined;
        }),
      },
    });
    await booted.commands.get("agents").handler("", context);
    const saved = JSON.parse(readFileSync(join(hermetic.dir, ".pi", "subagents.json"), "utf-8"));
    expect(saved.workflowToolExposure).toBe(exposure);
    if (exposure === undefined) expect(saved).not.toHaveProperty("workflowToolExposure");
  });
});
