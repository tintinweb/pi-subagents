import { describe, expect, it } from "vitest";
import {
  findOverlappingMemberFiles,
  formatConcurrentActivityNote,
  isAgentReadOnly,
} from "../src/agent-guards.js";

// ---------------------------------------------------------------------------
// isAgentReadOnly
// ---------------------------------------------------------------------------

describe("isAgentReadOnly", () => {
  it("returns false when builtinToolNames is undefined (no explicit list)", () => {
    expect(isAgentReadOnly(undefined)).toBe(false);
  });

  it("returns false when the list includes 'edit'", () => {
    expect(isAgentReadOnly(["read", "bash", "edit", "grep", "find", "ls"])).toBe(false);
  });

  it("returns false when the list includes 'write'", () => {
    expect(isAgentReadOnly(["read", "bash", "write"])).toBe(false);
  });

  it("returns false when the list includes both 'edit' and 'write'", () => {
    expect(isAgentReadOnly(["read", "bash", "edit", "write", "grep", "find", "ls"])).toBe(false);
  });

  it("returns true when the list contains neither 'edit' nor 'write'", () => {
    expect(isAgentReadOnly(["read", "bash", "grep", "find", "ls"])).toBe(true);
  });

  it("is case-insensitive (Read, BASH, GREP do not count as edit/write)", () => {
    expect(isAgentReadOnly(["Read", "Bash", "Grep", "Find", "Ls"])).toBe(true);
  });

  it("returns true when the list is empty (no edit or write present)", () => {
    // An empty explicit tool list has neither 'edit' nor 'write', so it is
    // treated as read-only — the agent cannot write files.
    expect(isAgentReadOnly([])).toBe(true);
  });

  // disallowedTools

  it("returns true when edit and write are present but both are denylisted", () => {
    expect(
      isAgentReadOnly(["read", "bash", "edit", "write"], ["edit", "write"])
    ).toBe(true);
  });

  it("returns false when only edit is denylisted but write is still available", () => {
    expect(
      isAgentReadOnly(["read", "bash", "edit", "write"], ["edit"])
    ).toBe(false);
  });

  it("returns false when builtinToolNames is undefined and only edit is denied (write still default-available)", () => {
    expect(isAgentReadOnly(undefined, ["edit"])).toBe(false);
  });

  it("returns true when builtinToolNames is undefined but both edit AND write are denied", () => {
    expect(isAgentReadOnly(undefined, ["edit", "write"])).toBe(true);
  });

  it("is case-insensitive for disallowedTools (Edit/Write match)", () => {
    expect(
      isAgentReadOnly(["read", "bash", "edit", "write"], ["Edit", "Write"])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatConcurrentActivityNote
// ---------------------------------------------------------------------------

describe("formatConcurrentActivityNote", () => {
  it("uses singular phrasing for one other agent", () => {
    const text = formatConcurrentActivityNote(1);
    expect(text).toContain("1 other writable agent is currently active");
    expect(text).toContain("do not flag them as issues");
  });

  it("uses plural phrasing for multiple other agents", () => {
    const text = formatConcurrentActivityNote(2);
    expect(text).toContain("2 other writable agents are currently active");
  });
});

// ---------------------------------------------------------------------------
// findOverlappingMemberFiles
// ---------------------------------------------------------------------------

describe("findOverlappingMemberFiles", () => {
  it("returns empty when members have disjoint files", () => {
    const result = findOverlappingMemberFiles([
      { memberIndex: 0, displayName: "worker", files: ["/repo/a.ts"] },
      { memberIndex: 1, displayName: "worker", files: ["/repo/b.ts"] },
    ]);
    expect(result).toHaveLength(0);
  });

  it("returns empty for a single member", () => {
    const result = findOverlappingMemberFiles([
      { memberIndex: 0, displayName: "worker", files: ["/repo/a.ts", "/repo/b.ts"] },
    ]);
    expect(result).toHaveLength(0);
  });

  it("returns empty when members have no files", () => {
    const result = findOverlappingMemberFiles([
      { memberIndex: 0, displayName: "worker", files: [] },
      { memberIndex: 1, displayName: "worker", files: [] },
    ]);
    expect(result).toHaveLength(0);
  });

  it("detects a single overlapping file across two members", () => {
    const result = findOverlappingMemberFiles([
      { memberIndex: 0, displayName: "worker-a", files: ["/repo/shared.ts", "/repo/a.ts"] },
      { memberIndex: 1, displayName: "worker-b", files: ["/repo/shared.ts", "/repo/b.ts"] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("/repo/shared.ts");
    expect(result[0].members).toHaveLength(2);
    expect(result[0].members[0].index).toBe(0);
    expect(result[0].members[1].index).toBe(1);
  });

  it("detects multiple overlapping files", () => {
    const result = findOverlappingMemberFiles([
      { memberIndex: 0, displayName: "w1", files: ["/repo/x.ts", "/repo/y.ts"] },
      { memberIndex: 1, displayName: "w2", files: ["/repo/x.ts", "/repo/y.ts"] },
    ]);
    expect(result).toHaveLength(2);
    const files = result.map((o) => o.file).sort();
    expect(files).toEqual(["/repo/x.ts", "/repo/y.ts"]);
  });

  it("detects overlap among three members", () => {
    const result = findOverlappingMemberFiles([
      { memberIndex: 0, displayName: "w1", files: ["/repo/common.ts"] },
      { memberIndex: 1, displayName: "w2", files: ["/repo/common.ts"] },
      { memberIndex: 2, displayName: "w3", files: ["/repo/common.ts"] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("/repo/common.ts");
    // First two claimants are captured; third also flagged.
    expect(result[0].members.length).toBeGreaterThanOrEqual(2);
  });
});
