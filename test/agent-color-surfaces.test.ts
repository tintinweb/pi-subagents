import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { type AgentActivity, AgentWidget } from "../src/ui/agent-widget.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

const TYPE = "colored-reviewer";
const DISPLAY_NAME = "Code Reviewer";
const PURPLE_FOREGROUND = "\u001b[38;2;130;125;189m";

const config: AgentConfig = {
  name: TYPE,
  displayName: DISPLAY_NAME,
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
  getColorMode: () => "truecolor" as const,
};

type RenderedComponent = { render(width?: number): string[] };
type WidgetFactory = (
  tui: { terminal: { columns: number; rows?: number }; requestRender: ReturnType<typeof vi.fn> },
  activeTheme: typeof theme,
) => RenderedComponent;
type SessionHandler = (...args: unknown[]) => unknown;

interface RegisteredTool {
  name: string;
  renderCall(
    args: Record<string, unknown>,
    activeTheme: typeof theme,
    context: { isPartial: boolean; isError: boolean },
  ): RenderedComponent;
}

function registerColoredReviewer(color = "purple"): void {
  registerAgents(new Map([[TYPE, { ...config, color }]]));
}

function makeRecord(): AgentRecord {
  return {
    id: "review-1",
    type: TYPE,
    description: "Review this change",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: {
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as AgentRecord["session"],
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function makeActivity(): AgentActivity {
  return {
    activeTools: new Map(),
    toolUses: 0,
    responseText: "",
    turnCount: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, SessionHandler>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => handlers.set(event, handler as SessionHandler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as Parameters<typeof subagentsExtension>[0];
  return { pi, tools, handlers };
}

beforeEach(() => {
  registerColoredReviewer();
});

afterEach(() => {
  registerAgents(new Map());
});

describe("custom agent color runtime surfaces", () => {
  it("renders the registered Agent tool call header with the display name and color", async () => {
    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    registerColoredReviewer();

    try {
      const tool = tools.get("Agent");
      if (!tool) throw new Error("Agent tool was not registered");
      const output = tool.renderCall(
        { subagent_type: TYPE, description: "Review this change" },
        theme,
        { isPartial: false, isError: false },
      ).render(120).join("\n");

      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_FOREGROUND);
      // The tool block paints its own row background — the name must not reset it.
      expect(output).not.toContain("\u001b[49m");

      const missingType = tool.renderCall(
        { description: "Review this change" },
        theme,
        { isPartial: false, isError: false },
      ).render(120).join("\n");
      expect(missingType).toContain("<toolTitle>*Agent*</toolTitle>");
      expect(missingType).not.toContain(PURPLE_FOREGROUND);
    } finally {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} });
    }
  });

  it("renders the above-editor Agent widget with the display name and color", () => {
    const record = makeRecord();
    const widget = new AgentWidget(
      { listAgents: () => [record] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map([[record.id, makeActivity()]]),
      () => "all",
    );
    let factory: WidgetFactory | undefined;
    let placement: string | undefined;
    widget.setUICtx({
      setStatus: vi.fn(),
      setWidget: (_key, content, options) => {
        if (typeof content === "function") factory = content as WidgetFactory;
        placement = options?.placement;
      },
    });

    try {
      widget.update();
      const output = factory?.(
        { terminal: { columns: 120 }, requestRender: vi.fn() },
        theme,
      ).render().join("\n");

      expect(placement).toBe("aboveEditor");
      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_FOREGROUND);
    } finally {
      widget.dispose();
    }
  });

  it("renders the FleetView row with the display name and color", () => {
    const record = makeRecord();
    const manager = {
      listAgents: () => [record],
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof FleetList>[0];
    const fleet = new FleetList(manager, new Map());
    let factory: WidgetFactory | undefined;
    fleet.setUICtx({
      setWidget: (_key, content) => {
        if (typeof content === "function") factory = content as WidgetFactory;
      },
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      notify: vi.fn(),
      custom: (() => new Promise<undefined>(() => {})) as FleetUICtx["custom"],
    });

    try {
      fleet.update();
      const output = factory?.(
        { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
        theme,
      ).render(120).join("\n");

      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_FOREGROUND);

      registerColoredReviewer("invalid");
      const fallback = factory?.(
        { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
        theme,
      ).render(120).join("\n");
      expect(fallback).toContain(`<muted>${DISPLAY_NAME}</muted>`);
      expect(fallback).not.toContain(PURPLE_FOREGROUND);
    } finally {
      fleet.dispose();
    }
  });

  it("renders the conversation viewer header with the display name and color", () => {
    const record = makeRecord();
    const viewer = new ConversationViewer(
      { terminal: { rows: 30, columns: 120 }, requestRender: vi.fn() } as unknown as ConstructorParameters<typeof ConversationViewer>[0],
      record.session!,
      record,
      undefined,
      theme,
      vi.fn(),
    );

    try {
      const output = viewer.render(120).join("\n");
      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_FOREGROUND);
    } finally {
      viewer.dispose();
    }
  });
});
