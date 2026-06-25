import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { type AgentActivity, buildTreeRows, type Theme } from "../src/ui/agent-widget.js";

const theme: Theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const activity = (): AgentActivity => ({
  activeTools: new Map([['k', 'bash']]),
  toolUses: 3,
  responseText: "Working",
  turnCount: 2,
  maxTurns: 8,
  lifetimeUsage: { input: 12, output: 34, cacheWrite: 5 },
});

const makeRecord = (overrides: Partial<AgentRecord> & Pick<AgentRecord, "id" | "type" | "description" | "status" | "toolUses" | "startedAt" | "compactionCount">): AgentRecord => ({
  id: overrides.id,
  type: overrides.type,
  description: overrides.description,
  status: overrides.status,
  toolUses: overrides.toolUses,
  startedAt: overrides.startedAt,
  compactionCount: overrides.compactionCount,
  lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  ...overrides,
});

describe("buildTreeRows", () => {
  it("renders nested tree connectors and row heights", () => {
    const records: AgentRecord[] = [
      makeRecord({ id: "root-a", type: "worker", description: "root a", status: "running", toolUses: 1, startedAt: 1000, compactionCount: 0 }),
      makeRecord({ id: "child-a-mid", parentId: "root-a", type: "Explore", description: "child mid", status: "running", toolUses: 2, startedAt: 900, compactionCount: 0 }),
      makeRecord({ id: "child-a-last", parentId: "root-a", type: "reviewer", description: "child last", status: "completed", toolUses: 0, startedAt: 800, completedAt: 850, compactionCount: 0 }),
      makeRecord({ id: "root-b", type: "Plan", description: "root b", status: "completed", toolUses: 0, startedAt: 700, completedAt: 760, compactionCount: 0 }),
      makeRecord({ id: "child-b-last", parentId: "root-b", type: "oracle", description: "child b", status: "queued", toolUses: 0, startedAt: 650, compactionCount: 0 }),
    ];

    const rows = buildTreeRows(records, {
      activityFor: (id) => (id === "root-a" || id === "child-a-mid" ? activity() : undefined),
      theme,
      frame: "⠋",
      shouldShowFinished: () => true,
      truncate: (s: string) => s,
    });

    expect(rows.map((row) => row.lines.length)).toEqual([2, 2, 1, 1, 1]);
    expect(rows[0].lines[0]).toContain("├─ ");
    expect(rows[0].lines[1]).toContain("│    ⎿  ");
    expect(rows[1].lines[0]).toContain("│    ├─ ");
    expect(rows[1].lines[1]).toContain("│    │    ⎿  ");
    expect(rows[2].lines[0]).toContain("│    └─ ");
    expect(rows[3].lines[0]).toContain("└─ ");
    expect(rows[4].lines[0]).toContain("     └─ ");
  });
});
