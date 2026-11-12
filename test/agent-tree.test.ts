import { describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { agentTree } from "../src/ui/agent-tree.js";

const rec = (id: string, startedAt: number, parentAgentId?: string): AgentRecord =>
  ({ id, startedAt, parentAgentId }) as AgentRecord;

const layout = (records: AgentRecord[]) => agentTree(records).map(r => `${r.prefix}${r.record.id}`);

describe("agentTree", () => {
  it("keeps top-level order as given and lists children under their parent, earliest first", () => {
    // Newest-first top level, as `/agents` passes it; children out of order.
    expect(layout([
      rec("b", 20),
      rec("b-late", 40, "b"),
      rec("a", 10),
      rec("b-early", 30, "b"),
    ])).toEqual([
      "b",
      "├ b-early",
      "└ b-late",
      "a",
    ]);
  });

  it("continues a rail under `├` and blank under `└` for grandchildren", () => {
    expect(layout([
      rec("p", 0),
      rec("c1", 1, "p"),
      rec("g1", 2, "c1"),
      rec("c2", 3, "p"),
      rec("g2", 4, "c2"),
    ])).toEqual([
      "p",
      "├ c1",
      "│ └ g1",
      "└ c2",
      "  └ g2",
    ]);
  });

  it("drops a child whose parent is not in the list", () => {
    expect(layout([rec("p", 0), rec("orphan", 1, "gone")])).toEqual(["p"]);
  });
});
