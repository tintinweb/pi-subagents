/**
 * agent-color.ts — Claude Code-compatible agent name badges.
 *
 * Claude Code renders a subagent's name as a badge: the configured color is the
 * background, the text an inverse foreground. Its eight named colors are
 * reproduced here, along with six-digit hex and the extra palette names Agency
 * Agents uses, so those definitions render as written.
 */

import { getConfig } from "./agent-types.js";

const NAMED_AGENT_COLORS: Readonly<Record<string, string>> = {
  // Claude Code's eight subagent colors, as its default theme renders them.
  red: "#DC2626",
  blue: "#6A9BCC",
  green: "#16A34A",
  yellow: "#CA8A04",
  purple: "#827DBD",
  orange: "#D97757",
  pink: "#C46686",
  cyan: "#0891B2",
  // Agency Agents palette aliases.
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

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);
const BLACK = { r: 0, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

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

/** Index of the entry in `values` closest to `value`. */
function nearest(values: readonly number[], value: number): number {
  return values.reduce((best, v, i) => (Math.abs(value - v) < Math.abs(value - values[best]) ? i : best), 0);
}

/**
 * Quantize to the xterm-256 palette the way pi's own theme does, returning both
 * the index to emit and the color the terminal will actually show — badge
 * contrast is judged against the latter.
 */
function rgbTo256({ r, g, b }: Rgb): { index: number; rgb: Rgb } {
  const [rIndex, gIndex, bIndex] = [r, g, b].map((channel) => nearest(CUBE_VALUES, channel));
  const distance = ({ r: cr, g: cg, b: cb }: Rgb) => 0.299 * (r - cr) ** 2 + 0.587 * (g - cg) ** 2 + 0.114 * (b - cb) ** 2;
  const grayIndex = nearest(GRAY_VALUES, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
  const gray = { r: GRAY_VALUES[grayIndex], g: GRAY_VALUES[grayIndex], b: GRAY_VALUES[grayIndex] };
  const cube = { r: CUBE_VALUES[rIndex], g: CUBE_VALUES[gIndex], b: CUBE_VALUES[bIndex] };
  // Only near-neutral colors may take the gray ramp; anything else keeps its tint.
  if (Math.max(r, g, b) - Math.min(r, g, b) < 10 && distance(gray) < distance(cube)) {
    return { index: 232 + grayIndex, rgb: gray };
  }
  return { index: 16 + 36 * rIndex + 6 * gIndex + bIndex, rgb: cube };
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
 * Render one name as a padded background badge when `color` is valid. Claude
 * Code uses one inverse color for every badge's text; black or white is picked
 * by WCAG contrast here instead, so each palette entry stays readable. Invalid
 * or omitted colors preserve the caller's existing theme styling.
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

  const rgb = parseHex(resolved);
  const quantized = (theme.getColorMode?.() ?? "truecolor") === "256color" ? rgbTo256(rgb) : undefined;
  const shown = quantized?.rgb ?? rgb;
  const contrasting = relativeLuminance(shown) > 0.179 ? BLACK : WHITE;
  const label = style.bold ? theme.bold(` ${name} `) : ` ${name} `;

  return ansiColor("background", quantized?.index ?? rgb)
    + ansiColor("foreground", quantized ? rgbTo256(contrasting).index : contrasting)
    + label
    + "\u001b[39m"
    + (style.restoreBackground ?? "\u001b[49m");
}

/** Whether an agent renders as a badge — i.e. it has a valid configured color. */
export function hasAgentBadge(type: string | undefined): boolean {
  return type !== undefined && resolveAgentColor(getConfig(type).color) !== undefined;
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
