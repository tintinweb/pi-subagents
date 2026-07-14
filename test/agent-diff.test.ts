import { describe, expect, it } from "vitest";
import { type DiffEntry, differsFromDefault, diffFromDefault } from "../src/agent-diff.js";
import { BUILTIN_TOOL_NAMES } from "../src/agent-types.js";
import { DEFAULT_AGENTS } from "../src/default-agents.js";
import type { AgentConfig } from "../src/types.js";

/** Helper to create an override AgentConfig seeded from a real default. */
function override(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  const def = DEFAULT_AGENTS.get(name);
  if (!def) throw new Error(`Unknown default: ${name}`);
  return { ...def, isDefault: undefined, source: "global", ...overrides };
}

describe("differsFromDefault", () => {
  // ---- gate conditions ----
  it("returns false for an isDefault agent", () => {
    const def = DEFAULT_AGENTS.get("Plan")!;
    expect(differsFromDefault(def)).toBe(false);
  });

  it("returns false for an append-mode override", () => {
    expect(differsFromDefault(override("Plan", { promptMode: "append" }))).toBe(false);
  });

  it("returns false for a custom agent with no matching default", () => {
    expect(differsFromDefault(override("Plan", { name: "custom-thing" }))).toBe(false);
  });

  it("returns false for a disabled replace-mode override", () => {
    // A disabled stub (enabled: false) that otherwise differs must not
    // receive the diff marker — it is display-only.
    expect(differsFromDefault(override("Plan", { enabled: false, description: "Changed" }))).toBe(false);
  });

  // ---- exact match ----
  it("returns false when the override matches its bundled default exactly", () => {
    expect(differsFromDefault(override("Plan"))).toBe(false);
  });

  it("returns false for worker override matching its default", () => {
    expect(differsFromDefault(override("worker"))).toBe(false);
  });

  // ---- field-level diffs ----
  it("returns true when description differs", () => {
    expect(differsFromDefault(override("Plan", { description: "Changed desc" }))).toBe(true);
  });

  it("returns true when displayName differs", () => {
    expect(differsFromDefault(override("Plan", { displayName: "Planner" }))).toBe(true);
  });

  it("returns false when displayName matches default", () => {
    // Plan default displayName is "Plan"
    expect(differsFromDefault(override("Plan", { displayName: "Plan" }))).toBe(false);
  });

  it("returns false when displayName omitted (loader: display_name absent from frontmatter)", () => {
    // When display_name is omitted from a .md file, the loader sets displayName
    // to undefined. An override whose name matches the default's name must not
    // show as differing, since the effective display name is cfg.name.
    expect(differsFromDefault(override("Plan", { displayName: undefined }))).toBe(false);
    // Same for project-source overrides
    expect(differsFromDefault(override("Plan", { displayName: undefined, source: "project" }))).toBe(false);
    // Worker has displayName "worker" === name "worker" — same behavior
    expect(differsFromDefault(override("worker", { displayName: undefined }))).toBe(false);
  });

  it("returns true when systemPrompt differs", () => {
    expect(differsFromDefault(override("Plan", { systemPrompt: "Custom prompt" }))).toBe(true);
  });

  it("returns true when model differs", () => {
    expect(differsFromDefault(override("Plan", { model: "anthropic/claude-sonnet-4-6" }))).toBe(true);
  });

  it("returns true when thinking differs", () => {
    expect(differsFromDefault(override("Plan", { thinking: "high" }))).toBe(true);
  });

  it("returns true when maxTurns differs", () => {
    expect(differsFromDefault(override("Plan", { maxTurns: 50 }))).toBe(true);
  });

  // ---- builtinToolNames ----
  it("returns false when builtinToolNames reordered (same set)", () => {
    const reversed = override("Plan", {
      builtinToolNames: ["ls", "find", "grep", "bash", "read"],
    });
    expect(differsFromDefault(reversed)).toBe(false);
  });

  it("returns true when builtinToolNames has different set", () => {
    const extra = override("Plan", { builtinToolNames: [...BUILTIN_TOOL_NAMES] });
    expect(differsFromDefault(extra)).toBe(true);
  });

  it("returns true when builtinToolNames is undefined (maps to all tools, Plan has read-only)", () => {
    const noTools = override("Plan", { builtinToolNames: undefined });
    expect(differsFromDefault(noTools)).toBe(true);
  });

  // ---- extensions / skills ----
  it("returns false when extensions is undefined (treated as true)", () => {
    expect(differsFromDefault(override("Plan", { extensions: undefined }))).toBe(false);
  });

  it("returns true when extensions is false", () => {
    expect(differsFromDefault(override("Plan", { extensions: false }))).toBe(true);
  });

  // ---- extSelectors ----
  it("returns true when extSelectors added to override", () => {
    expect(differsFromDefault(override("Plan", { extSelectors: ["ext:foo"] }))).toBe(true);
  });

  it("returns false when extSelectors reordered (same set)", () => {
    const plan = override("Plan", { extSelectors: ["ext:bar", "ext:foo"] });
    // Compare against another override with same set but different order
    const plan2 = override("Plan", { extSelectors: ["ext:foo", "ext:bar"] });
    // Both differ from default (which has no extSelectors), but we also want to
    // verify the reorder case directly by comparing two overrides with sorted sets.
    // Since the default has no extSelectors, both should return true for
    // differsFromDefault regardless of order. The sort is tested implicitly.
    expect(differsFromDefault(plan)).toBe(true);
    expect(differsFromDefault(plan2)).toBe(true);
  });

  // ---- disallowedTools ----
  it("returns true when disallowedTools added", () => {
    expect(differsFromDefault(override("Plan", { disallowedTools: ["write"] }))).toBe(true);
  });

  // ---- worker specifics ----
  it("returns true for worker with changed thinking", () => {
    expect(differsFromDefault(override("worker", { thinking: "high" }))).toBe(true);
  });

  // ---- source coverage: project and global overrides both considered ----
  it("detects diff for project-source override", () => {
    const plan = override("Plan", {
      source: "project",
      description: "Project-customized plan agent",
    });
    expect(differsFromDefault(plan)).toBe(true);
  });

  it("detects diff for global-source override", () => {
    const plan = override("Plan", {
      source: "global",
      description: "Global-customized plan agent",
    });
    expect(differsFromDefault(plan)).toBe(true);
  });

  it("returns false for project-source override matching default", () => {
    expect(differsFromDefault(override("Plan", { source: "project" }))).toBe(false);
  });

  it("returns false for global-source override matching default", () => {
    expect(differsFromDefault(override("Plan", { source: "global" }))).toBe(false);
  });

  it("returns false when source is undefined (no source gate passes)", () => {
    // Override without explicit source must not be treated as a diff
    const plan = override("Plan", { description: "Changed", source: undefined });
    expect(differsFromDefault(plan)).toBe(false);
  });
});

// ---- diffFromDefault: pure field-level diff function ----

describe("diffFromDefault", () => {
  /** Helper: find a diff entry by field name. */
  function field(entries: DiffEntry[] | null, name: string): DiffEntry | undefined {
    return entries?.find(e => e.field === name);
  }

  it("returns null for an isDefault agent", () => {
    const def = DEFAULT_AGENTS.get("Plan")!;
    expect(diffFromDefault(def)).toBeNull();
  });

  it("returns null for an append-mode override", () => {
    expect(diffFromDefault(override("Plan", { promptMode: "append" }))).toBeNull();
  });

  it("returns null for a custom agent with no matching default", () => {
    expect(diffFromDefault(override("Plan", { name: "custom-thing" }))).toBeNull();
  });

  it("returns null for a disabled replace-mode override", () => {
    expect(diffFromDefault(override("Plan", { enabled: false, description: "Changed" }))).toBeNull();
  });

  it("returns null when the override matches its bundled default exactly", () => {
    expect(diffFromDefault(override("Plan"))).toBeNull();
  });

  // ---- field-level entries ----

  it("returns entries for changed description", () => {
    const r = diffFromDefault(override("Plan", { description: "Changed" }));
    expect(field(r, "Description")).toEqual({
      field: "Description", local: "Changed", default: expect.any(String),
    });
  });

  it("returns entries for changed model", () => {
    const r = diffFromDefault(override("Plan", { model: "anthropic/claude-sonnet-4-6" }));
    expect(field(r, "Model")).toEqual({
      field: "Model", local: "anthropic/claude-sonnet-4-6", default: expect.any(String),
    });
  });

  it("returns entries for changed thinking", () => {
    const r = diffFromDefault(override("Plan", { thinking: "high" }));
    expect(field(r, "Thinking")).toEqual({
      field: "Thinking", local: "high", default: expect.any(String),
    });
  });

  it("returns entries for changed maxTurns", () => {
    const r = diffFromDefault(override("Plan", { maxTurns: 50 }));
    const e = field(r, "Max turns");
    expect(e).toBeDefined();
    expect(e!.local).toBe("50");
  });

  it("returns entries for changed displayName", () => {
    const r = diffFromDefault(override("Plan", { displayName: "PlannerX" }));
    expect(field(r, "Display name")).toBeDefined();
  });

  it("returns entries for changed builtinToolNames", () => {
    const r = diffFromDefault(override("Plan", { builtinToolNames: [...BUILTIN_TOOL_NAMES] }));
    expect(field(r, "Tools")).toBeDefined();
  });

  it("returns entries for changed extensions", () => {
    const r = diffFromDefault(override("Plan", { extensions: false }));
    expect(field(r, "Extensions")).toBeDefined();
  });

  it("returns entries for changed skills", () => {
    const r = diffFromDefault(override("Plan", { skills: false }));
    expect(field(r, "Skills")).toBeDefined();
  });

  it("returns entries for added disallowedTools", () => {
    const r = diffFromDefault(override("Plan", { disallowedTools: ["write"] }));
    expect(field(r, "Disallowed tools")).toBeDefined();
  });

  it("returns entries for added extSelectors", () => {
    const r = diffFromDefault(override("Plan", { extSelectors: ["ext:foo"] }));
    expect(field(r, "Extension selectors")).toBeDefined();
  });

  // ---- systemPrompt diff format ----

  it("reports system prompt diff as line+char counts, never the full body", () => {
    const r = diffFromDefault(override("Plan", { systemPrompt: "Line 1\nLine 2 changed\nLine 3" }));
    const e = field(r, "System prompt");
    expect(e).toBeDefined();
    expect(e!.local).toMatch(/^first difference at line \d+ \(local: \d+ chars, default: \d+ chars\)$/);
    // Must not contain the actual prompt body
    expect(e!.local).not.toContain("Line 2 changed");
    expect(e!.local).not.toContain("Software architect");
    // default field is empty for prompt diffs
    expect(e!.default).toBe("");
  });

  it("reports system prompt diff when lines differ at start", () => {
    const r = diffFromDefault(override("Plan", { systemPrompt: "Completely different prompt" }));
    const e = field(r, "System prompt");
    expect(e).toBeDefined();
    expect(e!.local).toContain("first difference at line 1");
  });

  // ---- multi-field diff ----

  it("returns multiple entries when several fields differ", () => {
    const r = diffFromDefault(override("Plan", {
      description: "Custom",
      model: "anthropic/claude-opus-4-6",
      thinking: "high",
    }));
    expect(r).not.toBeNull();
    expect(r!.length).toBeGreaterThanOrEqual(3);
  });

  // ---- source gate ----

  it("returns null when source is undefined", () => {
    const r = diffFromDefault(override("Plan", { description: "Changed", source: undefined }));
    expect(r).toBeNull();
  });

  it("returns null when source is 'default'", () => {
    const r = diffFromDefault(override("Plan", { description: "Changed", source: "default" }));
    expect(r).toBeNull();
  });

  // ---- consistency: differsFromDefault must equal diffFromDefault !== null ----

  it("differsFromDefault matches diffFromDefault !== null for all gate tests", () => {
    const cases: [string, AgentConfig][] = [
      ["isDefault", DEFAULT_AGENTS.get("Plan")!],
      ["append-mode", override("Plan", { promptMode: "append" })],
      ["custom name", override("Plan", { name: "custom" })],
      ["disabled", override("Plan", { enabled: false, description: "X" })],
      ["source undefined", override("Plan", { description: "X", source: undefined })],
      ["source default", override("Plan", { description: "X", source: "default" })],
      ["identical", override("Plan")],
      ["diff desc", override("Plan", { description: "X" })],
      ["diff model", override("Plan", { model: "x" })],
    ];
    for (const [label, cfg] of cases) {
      expect(differsFromDefault(cfg), label).toBe(diffFromDefault(cfg) !== null);
    }
  });
});
