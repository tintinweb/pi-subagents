// `/agents → Agent types` badges each row with where the agent came from, and
// prints a legend explaining the badges. Those two had drifted apart: the `▪`
// package badge shipped without a legend key, so a package agent rendered a
// glyph nothing on screen explained.
//
// These helpers live in src/agent-source-badge.ts rather than inside the
// `/agents` command closure because `registerCommand` is mocked in every wiring
// test, which is why the list rendering had no coverage at all.

import { describe, expect, it } from "vitest";
import { rowDescription, sourceIndicator, sourceLegend } from "../src/agent-source-badge.js";
import type { AgentConfig } from "../src/types.js";

/** An agent config with only the fields these helpers read. */
function cfg(partial: Partial<AgentConfig>): AgentConfig {
  return { description: "d", prompt: "p", ...partial } as AgentConfig;
}

describe("sourceIndicator", () => {
  it("badges each source, and leaves built-in defaults unmarked", () => {
    expect(sourceIndicator(cfg({ source: "project" }))).toBe("•  ");
    expect(sourceIndicator(cfg({ source: "global" }))).toBe("◦  ");
    expect(sourceIndicator(cfg({ source: "package" }))).toBe("▪  ");
    // A default leaves `source` undefined — the "default" member of the union is
    // never assigned — so it must fall through to blank, not to some badge.
    expect(sourceIndicator(cfg({ isDefault: true }))).toBe("   ");
    expect(sourceIndicator(undefined)).toBe("   ");
  });

  it("prefixes ✕ when disabled, keeping the source badge", () => {
    expect(sourceIndicator(cfg({ source: "project", enabled: false }))).toBe("✕• ");
    expect(sourceIndicator(cfg({ source: "global", enabled: false }))).toBe("✕◦ ");
    expect(sourceIndicator(cfg({ source: "package", enabled: false }))).toBe("✕▪ ");
    expect(sourceIndicator(cfg({ isDefault: true, enabled: false }))).toBe("✕  ");
  });
});

describe("sourceLegend", () => {
  it("explains the package badge", () => {
    // The regression this module exists for: `▪` used to render with no key.
    expect(sourceLegend([cfg({ source: "package" })])).toBe("▪ = package");
  });

  it("names only the badges actually on screen", () => {
    // Previously project and global were emitted as one string, so a
    // global-only roster advertised a `•` that appeared nowhere.
    expect(sourceLegend([cfg({ source: "global" })])).toBe("◦ = global");
    expect(sourceLegend([cfg({ source: "project" })])).toBe("• = project");
  });

  it("returns an empty string for a defaults-only roster", () => {
    expect(sourceLegend([cfg({ isDefault: true }), cfg({ isDefault: true }), undefined])).toBe("");
  });

  it("orders keys as the badge column does, and adds ✕ last", () => {
    const legend = sourceLegend([
      cfg({ isDefault: true }),
      cfg({ source: "package" }),
      cfg({ source: "global", enabled: false }),
      cfg({ source: "project" }),
    ]);
    expect(legend).toBe("• = project  ◦ = global  ▪ = package  ✕ = disabled");
  });

  it("explains ✕ for a disabled built-in, which carries no source", () => {
    expect(sourceLegend([cfg({ isDefault: true, enabled: false })])).toBe("✕ = disabled");
  });
});

describe("rowDescription", () => {
  it("prefixes the package name, so the row says which package", () => {
    expect(rowDescription("reviewer", cfg({ source: "package", description: "Reviews a diff" }), "@acme/tools")).toBe(
      "@acme/tools · Reviews a diff",
    );
  });

  it("leaves a non-package row's description untouched", () => {
    expect(rowDescription("reviewer", cfg({ source: "project", description: "Reviews a diff" }))).toBe("Reviews a diff");
  });

  it("prefixes the package name onto (disabled) too", () => {
    expect(rowDescription("reviewer", cfg({ source: "package", enabled: false }), "@acme/tools")).toBe(
      "@acme/tools · (disabled)",
    );
    expect(rowDescription("reviewer", cfg({ source: "package", enabled: false }))).toBe("(disabled)");
  });

  it("falls back to the agent's name when it has no description", () => {
    expect(rowDescription("reviewer", { prompt: "p" } as AgentConfig)).toBe("reviewer");
    expect(rowDescription("reviewer", undefined)).toBe("reviewer");
  });
});
