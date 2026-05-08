import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const FG_RESET = "\x1b[39m";

export interface CardTheme {
  bg: string;
  br: string;
}

export interface RenderCardOptions {
  title: string;
  badge?: string;
  content?: string;
  footer?: string;
  footerRight?: string;
  colWidth: number;
  theme: {
    fg(color: string, text: string): string;
  };
  cardTheme: CardTheme;
}

export const CARD_THEMES: CardTheme[] = [
  { bg: "\x1b[48;2;20;30;75m", br: "\x1b[38;2;70;110;210m" },
  { bg: "\x1b[48;2;80;18;28m", br: "\x1b[38;2;210;65;85m" },
  { bg: "\x1b[48;2;50;22;85m", br: "\x1b[38;2;145;80;220m" },
  { bg: "\x1b[48;2;12;65;75m", br: "\x1b[38;2;40;175;195m" },
  { bg: "\x1b[48;2;55;50;10m", br: "\x1b[38;2;190;170;50m" },
  { bg: "\x1b[48;2;15;55;30m", br: "\x1b[38;2;50;185;100m" },
];

function padVisibleText(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function renderCard(opts: RenderCardOptions): string[] {
  void opts.theme;

  const width = Math.max(0, Math.floor(opts.colWidth));
  if (width < 2) {
    return [];
  }

  const innerW = Math.max(0, width - 2);
  const border = opts.cardTheme.br;
  const bg = opts.cardTheme.bg;
  const contentBg = `${bg}${FG_RESET}`;
  const top = `${border}╭${"─".repeat(innerW)}╮${FG_RESET}`;
  const bottom = `${border}╰${"─".repeat(innerW)}╯${FG_RESET}`;

  const lines: string[] = [top];
  const titleText = ` ${opts.title} `;
  const badgeText = opts.badge ? ` ${opts.badge} ` : "";
  const titleAvailable = Math.max(0, innerW - visibleWidth(badgeText));
  const title = truncateToWidth(
    padVisibleText(titleText, titleAvailable),
    titleAvailable
  );
  const titlePad = " ".repeat(Math.max(0, innerW - visibleWidth(title) - visibleWidth(badgeText)));
  lines.push(
    `${border}│${contentBg}${title}${titlePad}${badgeText}${border}│${FG_RESET}`
  );

  const contentLines = (opts.content ?? "").split("\n");
  for (const line of contentLines) {
    const text = truncateToWidth(padVisibleText(line, innerW), innerW);
    lines.push(`${border}│${contentBg}${text}${border}│${FG_RESET}`);
  }

  if (opts.footer !== undefined || opts.footerRight !== undefined) {
    const footerLeft = opts.footer ?? "";
    const footerRight = opts.footerRight ? opts.footerRight : "";
    const gap = Math.max(
      1,
      innerW - visibleWidth(footerLeft) - visibleWidth(footerRight)
    );
    const footer = truncateToWidth(
      padVisibleText(footerLeft, innerW - visibleWidth(footerRight) - gap) +
        " ".repeat(gap) +
        footerRight,
      innerW
    );
    lines.push(`${border}│${contentBg}${footer}${border}│${FG_RESET}`);
  }

  lines.push(bottom);
  return lines;
}

export function formatElapsed(startedAt: number, endedAt?: number): string {
  const elapsed = Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
