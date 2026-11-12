/**
 * settings-menu-wiring.test.ts — `/agents` → Settings through the real
 * extension writes only the setting the user changed (#391).
 *
 * The unit tests in settings.test.ts pin `saveSettings`' merge. What they
 * cannot see is the baseline `index.ts` diffs against: it must be taken after
 * the persisted settings are applied, and move forward only when a write
 * lands. Get either wrong and a single change re-writes every effective value
 * — built-in defaults and the other layer's keys — into the target file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real page component renders through pi's theme, which a test process
// never initializes. Plain-text styling is enough to read the header.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "> ",
    hint: (text: string) => text,
  }),
}));

import subagentsExtension from "../src/index.js";
import { loadSettings } from "../src/settings.js";

let cwd: string;
let agentDir: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalHome: string | undefined;

const globalFile = () => join(agentDir, "subagents.json");
const projectFile = () => join(cwd, ".pi", "subagents.json");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf-8"));

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}

/** Boot the extension and return the `/agents` command handler. */
function boot(): (ctx: any) => Promise<void> {
  const commands = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return (ctx) => commands.get("agents").handler("", ctx);
}

const KEYS: Record<string, string> = {
  "tui.input.tab": "\t",
  "tui.input.submit": "\r",
  "tui.select.confirm": "\r",
  "tui.select.cancel": "\x1b",
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.editor.deleteCharForward": "\x1b[3~",
  "tui.editor.deleteCharBackward": "\x7f",
};
const TAB = "\t";
const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const DEL = "\x1b[3~";
const BACKSPACE = "\x7f";

/** Row order of the number settings on the page. */
const ROW: Record<string, number> = {
  maxConcurrent: 0, maxConcurrentForeground: 1, maxConcurrentNested: 2,
  maxSubagentDepth: 3, defaultMaxTurns: 4, graceTurns: 5,
};

/** Keystrokes that open the editor on the selected row, type `value`, and submit it. */
const typeValue = (value: string) => [ENTER, ...value, ENTER];

/**
 * One trip through `/agents` → Settings with the real page component. The
 * keystrokes go to the page in order until it closes itself; the rendered
 * screen is then recorded, and the page is closed as Esc would close it.
 */
function drivePage(keys: string[]) {
  const kb = {
    matches: (data: string, id: string) => KEYS[id] === data,
    getKeys: (id: string) => (id === "tui.input.tab" ? ["tab"] : id in KEYS ? ["enter"] : []),
  };
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const page = { header: "", screen: "", closedItself: false };
  const custom = vi.fn(
    (factory: (...args: any[]) => any) =>
      new Promise((resolve) => {
        const component = factory({ requestRender: vi.fn() }, theme, kb, () => {
          page.closedItself = true;
          resolve(undefined);
        });
        for (const key of keys) {
          if (page.closedItself) break;
          component.handleInput(key);
        }
        const lines: string[] = component.render(120);
        page.header = lines.slice(0, 2).join("\n");
        page.screen = lines.join("\n");
        resolve(undefined);
      }),
  );
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      notify,
      select: vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined),
      custom,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
  return { ctx, notify, custom, page };
}

/** `/agents` → Settings that types `value` into the number row `id`. */
const typeSetting = (id: string, value: string) =>
  drivePage([...Array<string>(ROW[id]).fill(DOWN), ...typeValue(value)]);

/** A fresh extension instance, as on the next pi start. */
function restart(): (ctx: any) => Promise<void> {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  return boot();
}

describe("/agents → Settings writes only the changed setting", () => {
  beforeEach(() => {
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "settings-menu-wiring-"));
    agentDir = join(cwd, "agent-dir");
    process.chdir(cwd);
    // Keep a developer's real ~/.pi/agent/subagents.json out of the test.
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    originalHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = cwd;
  });

  afterEach(() => {
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    process.chdir(originalCwd);
    if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("with no project file: writes the one key to the global file, no defaults, no .pi", async () => {
    const agents = boot();
    const { ctx, notify } = typeSetting("maxConcurrent", "4");

    await agents(ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 4 });
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(notify).toHaveBeenCalledWith("Max background concurrency set to 4 (saved to global settings)", "info");
  });

  it("typing the current value writes no file", async () => {
    const agents = boot();
    const { ctx, notify } = typeSetting("maxConcurrent", "10"); // the built-in default

    await agents(ctx);

    expect(existsSync(globalFile())).toBe(false);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(notify).toHaveBeenCalledWith("Max background concurrency set to 10 (saved to global settings)", "info");
  });

  it("with a project file: writes the one key there and copies no global value into it", async () => {
    writeJson(globalFile(), { graceTurns: 7 });
    writeJson(projectFile(), {});
    const agents = boot();

    await agents(typeSetting("maxConcurrent", "4").ctx);

    // graceTurns 7 is loaded into memory before the baseline is taken, so it
    // is not a change — it stays in the global layer only.
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 4 });
    expect(readJson(globalFile())).toEqual({ graceTurns: 7 });
  });

  it("does not re-write an earlier change over what another session saved since", async () => {
    const agents = boot();
    await agents(typeSetting("maxConcurrent", "4").ctx);

    // Another pi session saves its own max concurrency to the shared file.
    writeJson(globalFile(), { maxConcurrent: 8 });
    await agents(typeSetting("graceTurns", "3").ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 8, graceTurns: 3 });
  });

  it("retries a change whose write failed on the next save", async () => {
    const agents = boot();
    // The agent dir sits under a regular file, so the global write fails.
    const blocker = join(cwd, "blocker");
    writeFileSync(blocker, "");
    process.env.PI_CODING_AGENT_DIR = join(blocker, "agent");
    const failed = typeSetting("maxConcurrent", "4");
    await agents(failed.ctx);
    expect(failed.notify).toHaveBeenCalledWith(
      "Max background concurrency set to 4 (session only; failed to persist)",
      "warning",
    );

    process.env.PI_CODING_AGENT_DIR = agentDir;
    // Grace turns is module state and survives between tests in this file, so
    // each test types a value no earlier test left behind.
    await agents(typeSetting("graceTurns", "6").ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 4, graceTurns: 6 });
  });

  it("Tab switches the page to Project, and the change creates the project file", async () => {
    const agents = boot();
    const { ctx, notify, page } = drivePage([TAB, ...typeValue("4")]);

    await agents(ctx);

    expect(page.header).toContain("Saving to: Project");
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 4 });
    expect(existsSync(globalFile())).toBe(false);
    expect(notify).toHaveBeenCalledWith("Max background concurrency set to 4 (saved to project settings)", "info");
  });

  it("types a number under the list: the list stays on screen, and the page and its scope stay after the save", async () => {
    // The project file makes the default Project; Tab moves the page to Global.
    writeJson(projectFile(), {});
    const agents = boot();
    const editing = drivePage([TAB, ENTER, "4"]);
    await agents(editing.ctx);
    expect(editing.page.screen).toMatch(/Max background concurrency +10\b/);
    expect(editing.page.screen).toMatch(/Grace turns +\d+/);
    expect(editing.page.screen).toContain("Max background concurrency (1–1024, now 10)");
    expect(editing.page.screen).toMatch(/^> 4/m);

    const { ctx, custom, page } = drivePage([TAB, ...typeValue("4"), ...typeValue("5")]);
    await agents(ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(page.closedItself).toBe(false);
    expect(page.header).toContain("Saving to: Global");
    expect(page.screen).not.toContain("to save");
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 5 });
    expect(readJson(projectFile())).toEqual({});
  });

  it("Esc in the number editor returns to the list and saves nothing", async () => {
    const agents = boot();
    // Esc, then Tab: the Tab reaches the list page, so the page is still open.
    const { ctx, notify, page } = drivePage([ENTER, "4", ESC, TAB]);

    await agents(ctx);

    expect(page.closedItself).toBe(false);
    expect(page.header).toContain("Saving to: Project");
    expect(page.screen).not.toContain("to save");
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(globalFile())).toBe(false);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it.each([
    ["not a whole number", "2.5"],
    ["below the minimum", "0"],
    ["above the ceiling, which a reload would drop", "1025"],
  ])("refuses a value %s and keeps the editor open", async (_case, value) => {
    const agents = boot();
    const { ctx, notify, page } = drivePage(typeValue(value));

    await agents(ctx);

    expect(page.screen).toContain("Enter a whole number from 1 to 1024");
    expect(page.screen).toContain("to save");
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(globalFile())).toBe(false);
  });

  it("Up from the first row wraps to the last row, and Enter acts on that row", async () => {
    const agents = boot();
    // The last row is Tool description, which cycles full → compact.
    const { ctx, notify, page } = drivePage([UP, ENTER]);

    await agents(ctx);

    expect(page.screen).not.toContain("to save");
    // The cursor the user sees is on the row Enter acted on.
    expect(page.screen).toMatch(/^> Tool description +global +compact\b/m);
    expect(readJson(globalFile())).toEqual({ toolDescriptionMode: "compact" });
    expect(notify).toHaveBeenCalledWith(
      "Tool description set to compact. Takes effect on next pi session. (saved to global settings)",
      "info",
    );
  });

  it("tags each row set in a file with that file, and retags a row after a save moves it", async () => {
    writeJson(globalFile(), { graceTurns: 7, maxConcurrent: 8 });
    writeJson(projectFile(), { maxConcurrent: 3 });
    const agents = boot();
    const before = drivePage([]);
    await agents(before.ctx);

    expect(before.page.screen).toMatch(/Max background concurrency +project +3\b/);
    expect(before.page.screen).toMatch(/Grace turns +global +7\b/);
    // The tags line up in one column, whatever the label's length.
    const lines = before.page.screen.split("\n");
    const tagAt = (label: string, tag: string) => lines.find(line => line.includes(label))!.indexOf(tag);
    expect(tagAt("Grace turns", "global")).toBe(tagAt("Max background concurrency", "project"));
    expect(before.page.screen).toMatch(/Nested depth +2\b/);
    expect(before.page.screen).not.toMatch(/Nested depth +(project|global)/);

    // Project is the default scope here: the save puts graceTurns in the project file.
    const after = typeSetting("graceTurns", "9");
    await agents(after.ctx);

    expect(after.page.screen).toMatch(/Grace turns +project +9\b/);
  });

  it("Del removes the row's setting from its file, and the row goes back to the default", async () => {
    writeJson(globalFile(), { maxConcurrent: 4, graceTurns: 7 });
    const agents = boot();
    const { ctx, notify, page } = drivePage([DEL]);

    await agents(ctx);

    expect(readJson(globalFile())).toEqual({ graceTurns: 7 });
    expect(page.screen).toMatch(/^> Max background concurrency +10\b/m);
    expect(notify).toHaveBeenCalledWith(
      "Max background concurrency reset to the default, 10 (removed from global settings)",
      "info",
    );
    // In memory too, not just on screen: the next opening reads the manager.
    const next = drivePage([]);
    await agents(next.ctx);
    expect(next.page.screen).toMatch(/Max background concurrency +10\b/);
  });

  it("Backspace removes the tagged project value; the global value then shows, and a second press removes that", async () => {
    writeJson(globalFile(), { maxConcurrent: 8 });
    writeJson(projectFile(), { maxConcurrent: 3 });
    const agents = boot();
    const first = drivePage([BACKSPACE]);
    await agents(first.ctx);

    expect(readJson(projectFile())).toEqual({});
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 8 });
    expect(first.page.screen).toMatch(/Max background concurrency +global +8\b/);
    expect(first.notify).toHaveBeenCalledWith(
      "Max background concurrency is now 8 from global settings (removed from project settings)",
      "info",
    );

    const second = drivePage([BACKSPACE]);
    await agents(second.ctx);
    expect(readJson(globalFile())).toEqual({});
    expect(second.page.screen).toMatch(/Max background concurrency +10\b/);
  });

  it("Del on a row no file sets writes nothing", async () => {
    const agents = boot();
    const { ctx, notify } = drivePage([DEL]);

    await agents(ctx);

    expect(notify).toHaveBeenCalledWith("Max background concurrency is already at its default", "info");
    expect(existsSync(globalFile())).toBe(false);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("a change after Del does not write the removed setting back", async () => {
    writeJson(globalFile(), { maxConcurrent: 4 });
    const agents = boot();
    // Del on Max background concurrency, then cycle Join mode.
    const { ctx } = drivePage([DEL, ...Array<string>(6).fill(DOWN), ENTER]);

    await agents(ctx);

    expect(readJson(globalFile())).toEqual({ defaultJoinMode: "group" });
  });

  it("Del restores a setting that is unset by default", async () => {
    // Package agents is on by default because no gate is set at all.
    writeJson(globalFile(), { packageAgents: false });
    const agents = boot();
    const { ctx, page } = drivePage([...Array<string>(10).fill(DOWN), DEL]);

    await agents(ctx);

    expect(readJson(globalFile())).toEqual({});
    expect(page.screen).toMatch(/^> Package agents +on\b/m);
  });

  it("Backspace inside the number editor edits the text and resets nothing", async () => {
    writeJson(globalFile(), { maxConcurrent: 4 });
    const agents = boot();
    const { ctx } = drivePage([ENTER, "6", "5", BACKSPACE, ENTER]);

    await agents(ctx);

    expect(readJson(globalFile())).toEqual({ maxConcurrent: 6 });
  });

  it("re-setting the effective value in Project overwrites a different value stored there", async () => {
    // The Global save below is shadowed by the project's 3 and warns so. Doing
    // what the warning implies — set 8 again in Project — must replace the 3:
    // the value is unchanged in memory, but the chosen file disagrees with it.
    writeJson(projectFile(), { maxConcurrent: 3 });
    const agents = boot();
    // Project by default: Tab → Global, set 8; Tab → Project, set 8.
    const { ctx, notify } = drivePage([TAB, ...typeValue("8"), TAB, ...typeValue("8")]);

    await agents(ctx);

    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      "Max background concurrency set to 8 (saved to global settings; project settings override it)",
      "Max background concurrency set to 8 (saved to project settings)",
    ]);
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 8 });
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 8 });
    expect(loadSettings(cwd)).toEqual({ maxConcurrent: 8 });
  });

  it("drops the 'created on first change' note once a change has created the project file", async () => {
    const agents = boot();
    const tabbed = drivePage([TAB]);
    await agents(tabbed.ctx);
    expect(tabbed.page.header).toContain(".pi/subagents.json · created on first change");

    // Tab → Project, then Enter on Join mode (7th row), which cycles its value.
    const { ctx, page } = drivePage([TAB, ...Array<string>(6).fill(DOWN), ENTER]);
    await agents(ctx);

    expect(Object.keys(readJson(projectFile()) as object)).toEqual(["defaultJoinMode"]);
    expect(existsSync(globalFile())).toBe(false);
    expect(page.header).toContain("Saving to: Project");
    expect(page.header).not.toContain("created on first change");
    expect(page.screen).toMatch(/Join mode +project +group\b/);
  });

  it("opens on Global without a project file, and on Project once one exists — even an empty one", async () => {
    const agents = boot();
    const first = drivePage([]);
    await agents(first.ctx);
    expect(first.page.header).toContain("Saving to: Global · Tab to switch");
    expect(first.page.header).toContain("agent-dir/subagents.json");

    writeJson(projectFile(), {});
    const second = drivePage([]);
    await agents(second.ctx);
    expect(second.page.header).toContain("Saving to: Project");
    expect(second.page.header).not.toContain("created on first change");
  });

  it("Tab twice returns to the starting scope", async () => {
    const agents = boot();
    const { ctx, page } = drivePage([TAB, TAB, ...typeValue("4")]);

    await agents(ctx);

    expect(page.header).toContain("Saving to: Global");
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 4 });
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("shows the merged values: project wins, global fills in, defaults cover the rest", async () => {
    writeJson(globalFile(), { maxConcurrent: 8, graceTurns: 7 });
    writeJson(projectFile(), { maxConcurrent: 3 });
    const agents = boot();
    const { ctx, page } = drivePage([]);

    await agents(ctx);

    expect(page.screen).toMatch(/Max background concurrency +project +3\b/);
    expect(page.screen).toMatch(/Grace turns +global +7\b/);
    expect(page.screen).toMatch(/Nested depth +2\b/);
  });

  it("after a restart, a project file made via Tab is the default scope and its value loads", async () => {
    writeJson(globalFile(), { maxConcurrent: 8 });
    await boot()(drivePage([TAB, ...typeValue("4")]).ctx);
    expect(readJson(projectFile())).toEqual({ maxConcurrent: 4 });

    const next = drivePage([]);
    await restart()(next.ctx);

    expect(next.page.header).toContain("Saving to: Project");
    expect(next.page.screen).toMatch(/Max background concurrency +project +4\b/);
    expect(readJson(globalFile())).toEqual({ maxConcurrent: 8 });
  });
});
