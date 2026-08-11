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
    expect(resolveAgentColor("purple")).toBe("#9B59B6");
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
    const dark = renderAgentNameLabel("Code Reviewer", "purple", ansiTheme, { bold: true });
    expect(dark).toContain("\u001b[48;2;155;89;182m");
    expect(dark).toContain("\u001b[38;2;255;255;255m");
    expect(dark).toContain(" Code Reviewer ");
    expect(visibleWidth(dark)).toBe("Code Reviewer".length + 2);

    const light = renderAgentNameLabel("Tester", "yellow", theme);
    expect(light).toContain("\u001b[38;2;0;0;0m");
  });

  it("uses effective xterm palette colors for 256-color contrast", () => {
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

  it("preserves existing theme styling without a valid color", () => {
    expect(renderAgentNameLabel("Agent", undefined, theme, { fallbackColor: "toolTitle", bold: true }))
      .toBe("<toolTitle>*Agent*</toolTitle>");
    expect(renderAgentNameLabel("Agent", "invalid", theme, { fallbackColor: "muted" }))
      .toBe("<muted>Agent</muted>");
  });
});
