import { isBinary } from "istextorbinary";

const UNSAFE_CODE_POINT = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const SHAPING_FORMAT_CONTROLS = new Set([0x200c, 0x200d]);

export interface PreparedConversationDisplay {
  text: string;
  lines: string[];
  warning?: string;
  binary: boolean;
}

function escapeUnsafeTerminalText(text: string): string {
  let escaped = "";

  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;

    if (character === "\n" || character === "\t") {
      escaped += character;
    } else if (
      codePoint === 0xfffd
      || (codePoint >= 0xfff9 && codePoint <= 0xfffb)
      || (UNSAFE_CODE_POINT.test(character) && !SHAPING_FORMAT_CONTROLS.has(codePoint))
    ) {
      escaped += `\\u{${codePoint.toString(16).toUpperCase()}}`;
    } else {
      escaped += character;
    }
  }

  return escaped;
}

export function prepareConversationDisplay(rawText: string, maxCodePoints?: number): PreparedConversationDisplay {
  const codePoints = Array.from(rawText);
  const displayText = maxCodePoints !== undefined && codePoints.length > maxCodePoints
    ? `${codePoints.slice(0, maxCodePoints).join("")}... (truncated)`
    : rawText;
  if (isBinary(null, Buffer.from(displayText, "utf8"))) {
    return { text: "[binary content]", lines: ["[binary content]"], binary: true };
  }

  const text = escapeUnsafeTerminalText(displayText);
  return {
    text,
    lines: text.split("\n"),
    warning: text === displayText ? undefined : "[unsafe terminal content escaped]",
    binary: false,
  };
}
