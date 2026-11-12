/**
 * settings-menu.ts — the `/agents → Settings` page.
 *
 * ```
 *  ⚙  Subagent Settings · Saving to: Project · Tab to switch
 *     .pi/subagents.json · tagged rows are set in a file
 *  > cost
 *
 *    Show cost                   global    on
 *
 *    Type to filter · ↓ or Enter to the list · Esc to clear
 * ```
 *
 * The page owns presentation and keys: the filter, focus, the number editor,
 * the file-tag column and the height the terminal leaves. What each row means
 * (its values, what changing or resetting it does, which file it is saved to)
 * stays with the caller, behind `SettingsPageDeps`.
 */

import { getSettingsListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  fuzzyFilter,
  Input,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isNumericSettingKey, NUMERIC_SETTING_BOUNDS, type NumericSettingKey, type SettingsScope } from "../settings.js";
import { formatKeyLabel } from "./viewer-keys.js";

/**
 * Rows the page leaves for what pi draws under it — its footer and any
 * widgets below the editor, which the page cannot measure.
 */
const FOOTER_ROWS = 2;
/** The fewest settings rows the page shows, however short the terminal. */
const MIN_ROWS = 3;

export interface SettingsPageDeps {
  /** The rows with their current effective values, labels untagged. */
  buildItems(): SettingItem[];
  /** The file that sets each row's value; called once per refresh. */
  fileTags(): (id: string) => SettingsScope | undefined;
  /** Apply and save a row's new value, and notify. */
  apply(id: string, value: string): void;
  /** Remove the row's setting from the file that sets it, and notify. */
  reset(id: string): void;
  /** The scope changes are saved to, and its file as the header shows it. */
  header(): { scope: SettingsScope; file: string };
  toggleScope(): void;
}

export function createSettingsPage(
  deps: SettingsPageDeps,
  tui: TUI,
  theme: Theme,
  kb: KeybindingsManager,
  done: () => void,
): Component {
  const items = deps.buildItems();
  const baseLabels = new Map(items.map(item => [item.id, item.label]));
  // Tags sit in their own column after the longest label, and every label is
  // padded to the tagged width, so the value column stays put whichever rows
  // a filter leaves. The widest (26 + 2 + "project") stays inside
  // SettingsList's 36-column label cap.
  const tagColumn = Math.max(...items.map(item => visibleWidth(item.label))) + 2;
  const labelWidth = tagColumn + "project".length;
  const title = new Text("", 0, 0);
  const fileLine = new Text("", 0, 0);
  const tabKey = kb.getKeys("tui.input.tab")[0];
  const keyLabel = (id: Parameters<typeof kb.getKeys>[0]) => {
    const key = kb.getKeys(id)[0];
    return key ? formatKeyLabel(key) : id;
  };
  const renderHeader = () => {
    const { scope, file } = deps.header();
    const switchHint = tabKey ? theme.fg("muted", ` · ${formatKeyLabel(tabKey)} to switch`) : "";
    title.setText(`⚙  Subagent Settings · Saving to: ${scope === "global" ? "Global" : "Project"}${switchHint}`);
    fileLine.setText(theme.fg("muted", `   ${file} · tagged rows are set in a file`));
  };
  // Re-read values and file tags after every change: a save can move a key
  // into the other file, and some rows' values depend on others.
  const refreshRows = () => {
    const tagOf = deps.fileTags();
    const fresh = new Map(deps.buildItems().map(item => [item.id, item]));
    for (const item of items) {
      const next = fresh.get(item.id);
      if (next) Object.assign(item, { currentValue: next.currentValue, values: next.values, description: next.description });
      const source = tagOf(item.id);
      const base = baseLabels.get(item.id) ?? item.label;
      item.label = source ? `${base.padEnd(tagColumn)}${theme.fg("muted", source.padEnd(labelWidth - tagColumn))}` : base.padEnd(labelWidth);
    }
    renderHeader();
  };


  // The rows the filter leaves, in an array the list holds by reference:
  // filtering rewrites it in place rather than rebuilding the list.
  const shown = [...items];
  // The filter is a stop above the first row. While it has focus, typing,
  // Backspace and Del edit it, and the list draws no cursor; on a row,
  // Backspace and Del reset that row. Typing on a row jumps back here.
  const filter = new Input();
  let filterFocused = true;
  const baseTheme = getSettingsListTheme();
  const listTheme: SettingsListTheme = {
    ...baseTheme,
    label: (text, isSelected) => baseTheme.label(text, isSelected && !filterFocused),
    value: (text, isSelected) => baseTheme.value(text, isSelected && !filterFocused),
    get cursor() {
      return filterFocused ? " ".repeat(visibleWidth(baseTheme.cursor)) : baseTheme.cursor;
    },
  };
  // `maxVisible` is fixed per list, so a list is rebuilt when the rows the
  // terminal has room for change.
  const makeList = (maxVisible: number) => new SettingsList(
    shown,
    maxVisible,
    listTheme,
    (id, newValue) => {
      deps.apply(id, newValue);
      refreshRows();
    },
    done,
  );
  let listRows = shown.length;
  let list = makeList(listRows);
  refreshRows();

  // The selected row, an index into `shown`, owned here: SettingsList
  // doesn't expose its own, and Enter and Del must know which row it is.
  let selected = 0;
  // The list draws no cursor while the filter has focus, so the selection
  // resets to the first row, which is where Down or Enter lands.
  const applyFilter = () => {
    shown.splice(0, shown.length, ...fuzzyFilter(items, filter.getValue(), item => baseLabels.get(item.id) ?? item.label));
    selected = 0;
    if (shown[0]) list.selectItem(shown[0].id);
  };
  // The number editor under the list, while one is open.
  let editing: { id: NumericSettingKey; input: Input; error: Text } | undefined;
  const editor = new Container();

  const closeEditor = () => {
    editing = undefined;
    editor.clear();
  };
  const openEditor = (item: SettingItem, id: NumericSettingKey) => {
    const { min, max } = NUMERIC_SETTING_BOUNDS[id];
    // Empty, not pre-filled: Input.setValue leaves the cursor at column 0,
    // so typed digits would land in front of the old value.
    const input = new Input();
    input.focused = true;
    const error = new Text("", 0, 0);
    editing = { id, input, error };
    editor.clear();
    editor.addChild(new Spacer(1));
    editor.addChild(new Text(
      `${baseLabels.get(id)} (${min}–${max}, now ${item.currentValue})`
        + theme.fg("muted", ` · ${keyLabel("tui.input.submit")} to save · ${keyLabel("tui.select.cancel")} to cancel`),
      0,
      0,
    ));
    editor.addChild(input);
    editor.addChild(error);
  };
  const submitEditor = ({ id, input, error }: NonNullable<typeof editing>) => {
    const { min, max } = NUMERIC_SETTING_BOUNDS[id];
    const trimmed = input.getValue().trim();
    const n = Number(trimmed);
    if (trimmed === "" || !Number.isInteger(n) || n < min || n > max) {
      error.setText(theme.fg("error", `Enter a whole number from ${min} to ${max}`));
      return;
    }
    closeEditor();
    deps.apply(id, String(n));
    refreshRows();
  };

  const hint = () => {
    const keys = filterFocused
      ? `Type to filter · ${keyLabel("tui.select.down")} or Enter to the list`
      : `Enter/Space to change · ${keyLabel("tui.editor.deleteCharForward")} to reset`;
    const esc = filter.getValue() ? "clear" : "close";
    return listTheme.hint(`  ${keys} · Esc to ${esc}`);
  };

  return {
    render: (w: number) => {
      filter.focused = filterFocused && !editing;
      const head = [...title.render(w), ...fileLine.render(w), "", ...filter.render(w), ""];
      const tail = editing ? editor.render(w) : ["", truncateToWidth(hint(), w)];
      if (shown.length === 0) return [...head, listTheme.hint("  No matching settings"), ...tail];
      // Rows left once everything else is drawn: the description under the
      // list (blank + wrapped, sized by the longest in view so the window
      // doesn't resize as the cursor moves), the list's (n/N) line, and
      // pi's footer, which stays below the page.
      const description = Math.max(...shown.map(item => (item.description ? wrapTextWithAnsi(item.description, w - 4).length + 1 : 0)));
      const room = tui.terminal.rows - head.length - tail.length - description - 1 - FOOTER_ROWS;
      const rows = Math.min(shown.length, Math.max(MIN_ROWS, room));
      if (rows !== listRows) {
        listRows = rows;
        list = makeList(rows);
        list.selectItem(shown[selected].id);
      }
      // Its own hint (blank + "Enter/Space to change · Esc to cancel") is
      // replaced by ours, which names the filter and Del.
      return [...head, ...list.render(w).slice(0, -2), ...tail];
    },
    invalidate: () => {
      title.invalidate();
      fileLine.invalidate();
      editor.invalidate();
      filter.invalidate();
      list.invalidate();
    },
    handleInput: (data: string) => {
      // pi repaints after every keystroke it hands the page.
      if (editing) {
        if (kb.matches(data, "tui.input.submit")) submitEditor(editing);
        else if (kb.matches(data, "tui.select.cancel")) closeEditor();
        else if (!kb.matches(data, "tui.input.tab")) editing.input.handleInput(data);
        return;
      }
      if (kb.matches(data, "tui.input.tab")) {
        deps.toggleScope();
        renderHeader();
        return;
      }
      const query = filter.getValue();
      if (kb.matches(data, "tui.select.cancel")) {
        if (!query) {
          done();
          return;
        }
        filter.setValue("");
        filterFocused = true;
        applyFilter();
        return;
      }
      // Delete, and Backspace: it is the key labelled "delete" on a Mac.
      const deletes = kb.matches(data, "tui.editor.deleteCharForward") || kb.matches(data, "tui.editor.deleteCharBackward");
      if (deletes && !filterFocused) {
        if (shown[selected]) {
          deps.reset(shown[selected].id);
          refreshRows();
        }
        return;
      }
      // One cycle through the filter and the rows: Down (or Enter) from the
      // filter enters the first row, Up from the first row returns to the
      // filter, and both ends wrap through it. Enter in the filter changes
      // nothing: a change always needs the cursor on its row.
      const up = kb.matches(data, "tui.select.up");
      const confirm = kb.matches(data, "tui.select.confirm");
      if (up || kb.matches(data, "tui.select.down") || (confirm && filterFocused)) {
        if (shown.length === 0) return;
        if (filterFocused) {
          filterFocused = false;
          selected = up ? shown.length - 1 : 0;
        } else if (selected === (up ? 0 : shown.length - 1)) {
          filterFocused = true;
          selected = 0;
        } else {
          selected += up ? -1 : 1;
        }
        list.selectItem(shown[selected].id);
        return;
      }
      // Space in the filter types a space.
      if (!filterFocused && (confirm || data === " ")) {
        const item = shown[selected];
        if (!item) return;
        if (confirm && isNumericSettingKey(item.id)) openEditor(item, item.id);
        else list.handleInput(data);
        return;
      }
      filter.handleInput(data);
      if (filter.getValue() !== query) {
        filterFocused = true;
        applyFilter();
      }
    },
  };
}
