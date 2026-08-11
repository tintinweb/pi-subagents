/**
 * agent-color.ts — Claude Code-compatible agent name color rendering.
 *
 * Claude Code defines eight named subagent colors. Agency Agents also uses
 * six-digit hex values and a small set of additional palette names, which are
 * accepted here so those definitions render without conversion.
 */

import { getConfig } from "./agent-types.js";

const NAMED_AGENT_COLORS: Readonly<Record<string, string>> = {
  red: "#E74C3C",
  blue: "#3498DB",
  green: "#2ECC71",
  yellow: "#EAB308",
  purple: "#9B59B6",
  orange: "#F39C12",
  pink: "#E84393",
  cyan: "#00FFFF",
  amber: "#F59E0B",
  teal: "#008080",
  indigo: "#6366F1",
  gold: "#EAB308",
  "neon-green": "#10B981",
  "neon-cyan": "#06B6D4",
  "metallic-blue": "#3B82F6",
  violet: "#8B5CF6",
  rose: "#F43F5E",
  lime: "#84CC16",
  gray: "#6B7280",
  grey: "#6B7280",
  fuchsia: "#D946EF",
  slate: "#64748B",
  navy: "#1E3A8A",
};

const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

type Rgb = { r: number; g: number; b: number };
type ColorMode = "truecolor" | "256color";

export interface AgentNameTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  getColorMode?(): ColorMode;
}

export interface AgentNameStyle {
  /** Existing theme foreground used when no valid agent color is configured. */
  fallbackColor?: string;
  /** Reapply an enclosing background after the badge instead of resetting it. */
  restoreBackground?: string;
  bold?: boolean;
}

/** Resolve Claude Code/Agency Agents color syntax to normalized #RRGGBB. */
export function resolveAgentColor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const resolved = NAMED_AGENT_COLORS[normalized] ?? normalized;
  return /^#[0-9a-f]{6}$/i.test(resolved) ? resolved.toUpperCase() : undefined;
}

function parseHex(hex: string): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function nearestCubeIndex(value: number): number {
  let best = 0;
  for (let i = 1; i < CUBE_VALUES.length; i++) {
    if (Math.abs(value - CUBE_VALUES[i]) < Math.abs(value - CUBE_VALUES[best])) best = i;
  }
  return best;
}

function rgbTo256({ r, g, b }: Rgb): { index: number; rgb: Rgb } {
  const rIndex = nearestCubeIndex(r);
  const gIndex = nearestCubeIndex(g);
  const bIndex = nearestCubeIndex(b);
  const cubeRgb = { r: CUBE_VALUES[rIndex], g: CUBE_VALUES[gIndex], b: CUBE_VALUES[bIndex] };
  const distance = (candidate: Rgb) => {
    const dr = r - candidate.r;
    const dg = g - candidate.g;
    const db = b - candidate.b;
    return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
  };

  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  let grayIndex = 0;
  for (let i = 1; i < GRAY_VALUES.length; i++) {
    if (Math.abs(gray - GRAY_VALUES[i]) < Math.abs(gray - GRAY_VALUES[grayIndex])) grayIndex = i;
  }
  const grayRgb = { r: GRAY_VALUES[grayIndex], g: GRAY_VALUES[grayIndex], b: GRAY_VALUES[grayIndex] };
  if (Math.max(r, g, b) - Math.min(r, g, b) < 10 && distance(grayRgb) < distance(cubeRgb)) {
    return { index: 232 + grayIndex, rgb: grayRgb };
  }
  return { index: 16 + 36 * rIndex + 6 * gIndex + bIndex, rgb: cubeRgb };
}

function ansiColor(layer: "foreground" | "background", color: Rgb | number): string {
  const code = layer === "foreground" ? 38 : 48;
  return typeof color === "number"
    ? `\u001b[${code};5;${color}m`
    : `\u001b[${code};2;${color.r};${color.g};${color.b}m`;
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Render one name as a padded background badge when `color` is valid.
 * Black/white foreground is selected by WCAG contrast; invalid or omitted
 * colors preserve the caller's existing theme styling.
 */
export function renderAgentNameLabel(
  name: string,
  color: string | undefined,
  theme: AgentNameTheme,
  style: AgentNameStyle = {},
): string {
  const resolved = resolveAgentColor(color);
  if (!resolved) {
    const text = style.bold ? theme.bold(name) : name;
    return style.fallbackColor ? theme.fg(style.fallbackColor, text) : text;
  }

  const backgroundRgb = parseHex(resolved);
  const mode = theme.getColorMode?.() ?? "truecolor";
  let background: Rgb | number = backgroundRgb;
  let effectiveBackground = backgroundRgb;
  if (mode === "256color") {
    const quantized = rgbTo256(backgroundRgb);
    background = quantized.index;
    effectiveBackground = quantized.rgb;
  }
  const foregroundRgb = relativeLuminance(effectiveBackground) > 0.179
    ? { r: 0, g: 0, b: 0 }
    : { r: 255, g: 255, b: 255 };
  const foreground = mode === "256color" ? rgbTo256(foregroundRgb).index : foregroundRgb;
  const label = style.bold ? theme.bold(` ${name} `) : ` ${name} `;

  return ansiColor("background", background)
    + ansiColor("foreground", foreground)
    + label
    + "\u001b[39m"
    + (style.restoreBackground ?? "\u001b[49m");
}

/** Render a registered agent's display name with its configured color. */
export function renderAgentName(
  type: string | undefined,
  theme: AgentNameTheme,
  style: AgentNameStyle = {},
): string {
  if (!type) return renderAgentNameLabel("Agent", undefined, theme, style);
  const config = getConfig(type);
  return renderAgentNameLabel(config.displayName, config.color, theme, style);
}
