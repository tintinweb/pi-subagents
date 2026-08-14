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
  it("renders a padded truecolor badge with readable foreground", () => {
    const ansiTheme = {
      ...theme,
      bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
    };
    const badge = renderAgentNameLabel("Code Reviewer", "purple", ansiTheme, { bold: true });
    expect(badge).toContain("\u001b[48;2;130;125;189m");
    expect(badge).toContain(" Code Reviewer ");
    expect(visibleWidth(badge)).toBe("Code Reviewer".length + 2);

    // Badge text follows the background's luminance: #827DBD is light enough for black,
    // #1E3A8A is not. Both sit either side of the 0.179 WCAG threshold.
    expect(badge).toContain("\u001b[38;2;0;0;0m");
    expect(renderAgentNameLabel("Tester", "navy", theme)).toContain("\u001b[38;2;255;255;255m");
  });

  it("judges contrast against the effective color in 256-color mode", () => {
    const ansiTheme = { ...theme, getColorMode: () => "256color" as const };
    const label = renderAgentNameLabel("Reviewer", "#C430C4", ansiTheme);
    expect(label).toContain("\u001b[48;5;170m");
    expect(label).toContain("\u001b[38;5;16m");

    const neutral = renderAgentNameLabel("Reviewer", "#808080", ansiTheme);
    expect(neutral).toContain("\u001b[48;5;244m");
  });

  it("restores an enclosing tool background after the badge", () => {
    const label = renderAgentNameLabel("Reviewer", "purple", theme, {
      restoreBackground: "\u001b[48;2;1;2;3m",
    });
    expect(label).toMatch(/\u001b\[39m\u001b\[48;2;1;2;3m$/);
  });

  it("resets the background when the caller paints none", () => {
    expect(renderAgentNameLabel("Reviewer", "purple", theme)).toMatch(/\u001b\[39m\u001b\[49m$/);
  });

  it("preserves existing theme styling without a valid color", () => {
    expect(renderAgentNameLabel("Agent", undefined, theme, { fallbackColor: "toolTitle", bold: true }))
      .toBe("<toolTitle>*Agent*</toolTitle>");
    expect(renderAgentNameLabel("Agent", "invalid", theme, { fallbackColor: "muted" }))
      .toBe("<muted>Agent</muted>");
  });
});
