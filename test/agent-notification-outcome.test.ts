import { describe, expect, it, vi } from "vitest";
import subagentsExtension, { formatTaskNotification } from "../src/index.js";
import type { AgentOutcome, AgentRecord } from "../src/types.js";

function makePi() {
  let renderer:
    | ((message: { details?: unknown }, options: { expanded: boolean }, theme: Theme) => { render(width: number): string[] } | undefined)
    | undefined;
  const pi = {
    registerMessageRenderer: vi.fn((_name: string, value: typeof renderer) => {
      renderer = value;
    }),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi, renderer: () => renderer };
}

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function recordWithOutcome(
  status: AgentRecord["status"],
  outcome: Omit<AgentOutcome, "agentId" | "status" | "hasOutput">,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "background <job>",
    status,
    toolUses: 0,
    startedAt: 1,
    completedAt: 2,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    outcome: {
      agentId: "agent-1",
      status,
      hasOutput: Boolean(overrides.result?.trim()),
      ...outcome,
    },
    ...overrides,
  };
}

describe("background notification lifecycle outcome", () => {
  it("renders an empty failed result without duplicating the error as output", () => {
    const { pi, renderer } = makePi();
    subagentsExtension(pi as never);
    const render = renderer();
    expect(render).toBeTypeOf("function");

    const details = {
      id: "agent-1",
      description: "provider failure",
      status: "error",
      toolUses: 0,
      turnCount: 1,
      totalTokens: 0,
      durationMs: 10,
      error: "provider rejected request",
      outcome: {
        agentId: "agent-1",
        status: "error",
        phase: "run",
        category: "provider",
        retryable: false,
        recovery: "resume_same_agent",
        freshSpawn: "forbidden",
        hasOutput: false,
      },
    } satisfies Record<string, unknown>;

    const output = render?.({ details }, { expanded: false }, theme)?.render(120).join("\n") ?? "";
    expect(output).toContain("provider failure error");
    expect(output).not.toContain("provider rejected request");
    expect(output).not.toContain("⎿");
  });

  it("does not repeat an empty background failure as partial output", () => {
    const record = recordWithOutcome("error", {
      phase: "run",
      category: "provider",
      retryable: false,
      recovery: "resume_same_agent",
      freshSpawn: "forbidden",
      message: "provider <failed> & stopped",
    }, {
      error: "provider <failed> & stopped",
    });

    const content = formatTaskNotification(record, 500);

    expect(content).toContain("message: provider &lt;failed&gt; &amp; stopped");
    expect(content).not.toContain("Partial output before the failure");
    expect(content).not.toContain("No output");
  });

  it.each([
    {
      name: "provider error",
      record: recordWithOutcome("error", {
        phase: "run",
        category: "provider",
        retryable: false,
        recovery: "resume_same_agent",
        freshSpawn: "forbidden",
        message: "provider <failed> & stopped",
      }, {
        error: "provider <failed> & stopped",
        result: "partial <output> & detail",
      }),
    },
    {
      name: "caller stop",
      record: recordWithOutcome("stopped", {
        phase: "run",
        category: "caller_stop",
        retryable: false,
        recovery: "none",
        freshSpawn: "forbidden",
      }, {
        result: "partial stop output",
      }),
    },
    {
      name: "max turns",
      record: recordWithOutcome("aborted", {
        phase: "run",
        category: "max_turns",
        retryable: false,
        recovery: "resume_same_agent",
        freshSpawn: "forbidden",
      }, {
        result: "partial turn output",
      }),
    },
  ])("formats a model-visible Agent outcome block before separate output for $name", ({ record }) => {
    const content = formatTaskNotification(record, 500);

    expect(content.indexOf("Agent outcome:")).toBeGreaterThan(-1);
    expect(content.indexOf("Agent outcome:")).toBeLessThan(content.indexOf("Partial output"));
    expect(content).toContain(`category: ${record.outcome?.category}`);
    expect(content).toContain(`recovery: ${record.outcome?.recovery}`);
    expect(content).toContain("partial");
    expect(content).not.toContain("<output>");
    if (record.result?.includes("<output>")) {
      expect(content).toContain("&lt;output&gt;");
    }
  });

  it("preserves notification truncation after the outcome block", () => {
    const record = recordWithOutcome("error", {
      phase: "run",
      category: "provider",
      retryable: false,
      recovery: "resume_same_agent",
      freshSpawn: "forbidden",
      message: "provider failed",
    }, {
      result: "x".repeat(200),
    });

    const content = formatTaskNotification(record, 40);

    expect(content).toContain("Agent outcome:");
    expect(content).toContain("...(truncated, use get_subagent_result for full output)");
    expect(content).not.toContain("x".repeat(41));
  });
});
