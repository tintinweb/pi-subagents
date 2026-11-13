/**
 * viewer-keys.ts — Scroll, expand and jump key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*`, `app.tools.expand` and the `tui.altScreen.top`/
 * `tui.altScreen.bottom` jump keys through the user's keybindings when pi
 * provides a manager, falling back to the previous hardcoded keys otherwise. The
 * viewer's k/j, shift+arrow and home/end aliases always work alongside whatever
 * is bound.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** The pi keybinding ids the viewer resolves. */
export type ViewerKeybindingId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "app.tools.expand"
  | "tui.altScreen.top"
  | "tui.altScreen.bottom";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerKeybindingId): boolean;
  getKeys(keybinding: ViewerKeybindingId): KeyId[];
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  /** Unfold the output of the viewer's tool blocks, as in the main transcript. */
  expand(data: string): boolean;
  /** Scroll to the start of the conversation (`tui.altScreen.top`). */
  top(data: string): boolean;
  /** Jump to the latest message and resume following (`tui.altScreen.bottom`). */
  bottom(data: string): boolean;
  /** Display label for the jump-to-latest key, e.g. `Ctrl+End`, for the divider. */
  jumpToLatestLabel(): string;
}

/**
 * `ctrl+end` → `Ctrl+End`. The pure formatter pi uses (`formatKeyText`) lives in
 * an unexported submodule, and the exported hint helpers resolve the extension's
 * own package copy — whose global keybindings are empty — so they render without
 * the key (pi #4748). Formatting the injected manager's own resolved keys here
 * sidesteps both.
 */
function formatKeyLabel(key: KeyId): string {
  return key
    .split("+")
    .map(part => {
      // `alt` reads as `option` on macOS, the way pi's own `formatKeyPart` renders it.
      const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
      return display.charAt(0).toUpperCase() + display.slice(1);
    })
    .join("+");
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerKeybindingId, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    expand: (data) => matches(data, "app.tools.expand", "ctrl+o"),
    // The configurable binding only; the home/end aliases stay at the call sites
    // so the fullscreen "end only when not composing" rule is preserved.
    top: (data) => matches(data, "tui.altScreen.top", "home"),
    bottom: (data) => matches(data, "tui.altScreen.bottom", "ctrl+end"),
    jumpToLatestLabel: () => {
      const keys = keybindings ? keybindings.getKeys("tui.altScreen.bottom") : (["ctrl+end"] as KeyId[]);
      // Unbound → the bare `end` alias is still live, so name it.
      return keys.length > 0 ? formatKeyLabel(keys[0]) : "End";
    },
  };
}
