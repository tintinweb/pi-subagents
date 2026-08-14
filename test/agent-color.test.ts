import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderAgentNameLabel, resolveAgentColor } from "../src/agent-color.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
  getColorMode: () => "truecolor" as const,
};

describe("resolveAgentColor", () => {
  it("resolves Claude Code names and Agency Agents aliases", () => {
    expect(resolveAgentColor("purple")).toBe("#827DBD");
    expect(resolveAgentColor("neon-cyan")).toBe("#06B6D4");
    expect(resolveAgentColor("slate")).toBe("#64748B");
  });

  it("normalizes six-digit hex and rejects unsupported values", () => {
    expect(resolveAgentColor(" #8b5cf6 ")).toBe("#8B5CF6");
    expect(resolveAgentColor("not-a-color")).toBeUndefined();
    expect(resolveAgentColor("#123")).toBeUndefined();
  });
});

describe("renderAgentNameLabel", () => {
  it("colors the name without changing its width", () => {
    const ansiTheme = {
      ...theme,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    const label = renderAgentNameLabel("Code Reviewer", "purple", ansiTheme, { bold: true });
    expect(label).toBe("\u001b[38;2;130;125;189m\u001b[1mCode Reviewer\u001b[22m\u001b[39m");
    expect(visibleWidth(label)).toBe("Code Reviewer".length);
  });

  it("quantizes to the xterm palette in 256-color mode", () => {
    const ansiTheme = { ...theme, getColorMode: () => "256color" as const };
    expect(renderAgentNameLabel("Reviewer", "#C430C4", ansiTheme)).toContain("\u001b[38;5;170m");
    expect(renderAgentNameLabel("Reviewer", "#808080", ansiTheme)).toContain("\u001b[38;5;244m");
  });

  it("preserves existing theme styling without a valid color", () => {
    expect(renderAgentNameLabel("Agent", undefined, theme, { fallbackColor: "toolTitle", bold: true }))
      .toBe("<toolTitle>*Agent*</toolTitle>");
    expect(renderAgentNameLabel("Agent", "invalid", theme, { fallbackColor: "muted" }))
      .toBe("<muted>Agent</muted>");
  });
});
