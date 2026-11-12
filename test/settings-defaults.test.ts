/**
 * settings-defaults.test.ts — `SETTING_DEFAULTS` matches what the code ships.
 *
 * Del on `/agents` → Settings resets a row to `SETTING_DEFAULTS` when no file
 * sets it any more. The table restates initial values that live in several
 * modules, so this boots the extension with no settings files — in its own
 * test file, so no other test has moved module state first — and compares
 * the full snapshot the first change emits against it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The page renders through pi's theme, which a test process never initializes.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: ">",
    hint: (text: string) => text,
  }),
}));

import subagentsExtension from "../src/index.js";
import { SETTING_DEFAULTS } from "../src/settings.js";

let cwd: string;
let originalCwd: string;
const originalEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };

beforeAll(() => {
  originalCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), "settings-defaults-"));
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-dir");
  process.env.HOME = cwd;
});

afterAll(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  process.chdir(originalCwd);
  for (const [name, value] of [["PI_CODING_AGENT_DIR", originalEnv.agentDir], ["HOME", originalEnv.home]] as const) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(cwd, { recursive: true, force: true });
});

it("lists every setting at the value a boot with no settings files runs with", async () => {
  const commands = new Map<string, any>();
  const emit = vi.fn();
  subagentsExtension({
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, cmd: any) => commands.set(name, cmd)),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit, on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any);

  // Any change emits the full in-memory snapshot. Tab to Global is a no-op
  // here; Down×7 (the first leaves the filter) + Enter cycles Join mode, the
  // one key this test changes.
  const kb = { matches: (data: string, id: string) => ({ "tui.select.down": "\x1b[B", "tui.select.confirm": "\r" })[id] === data, getKeys: () => [] };
  await commands.get("agents").handler("", {
    hasUI: true,
    cwd,
    ui: {
      notify: vi.fn(),
      select: vi.fn().mockResolvedValueOnce("Settings").mockResolvedValue(undefined),
      custom: vi.fn((factory: (...args: any[]) => any) => {
        const page = factory({ requestRender: vi.fn() }, { fg: (_c: string, t: string) => t }, kb, vi.fn());
        for (const key of [...Array<string>(7).fill("\x1b[B"), "\r"]) page.handleInput(key);
        return Promise.resolve(undefined);
      }),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  });

  const [, payload] = emit.mock.calls.find(([event]) => event === "subagents:settings_changed")!;
  expect(payload.settings).toEqual({ ...SETTING_DEFAULTS, defaultJoinMode: "group" });
});
