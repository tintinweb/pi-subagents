/**
 * boot-extension.ts — the mock `pi` / `ctx` pair the wiring tests use to boot the
 * REAL extension (src/index.ts) and drive its registered tools directly.
 *
 * The 14 pre-existing wiring tests each inline their own near-identical copy of
 * this. They are deliberately NOT migrated: `test/` is outside the tsconfig
 * `include`, so that churn would be unchecked by `tsc`, and those copies have
 * small divergences that would have to be reconciled blind. New files use this.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export interface BootedPi {
  pi: any;
  tools: Map<string, any>;
  lifecycle: Map<string, any>;
  /** Custom entry renderers, by `customType`. */
  entryRenderers: Map<string, any>;
  /** Flags the extension registered, by name. */
  registeredFlags: Map<string, any>;
  /** Slash commands the extension registered, by name. */
  commands: Map<string, any>;
}

/**
 * A mock ExtensionAPI that records every tool and lifecycle handler registered.
 *
 * `flags` seeds what `pi.getFlag` returns. It is deliberately separate from the
 * values passed to `registerFlag`: the host applies CLI values only AFTER every
 * extension has activated, so a test that seeds them here and reads them from
 * `session_start` reproduces the real ordering.
 */
export function makePi(flags: Record<string, boolean | string> = {}): BootedPi {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const entryRenderers = new Map<string, any>();
  const registeredFlags = new Map<string, any>();
  const commands = new Map<string, any>();
  const activeTools: string[] = [];
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn((customType: string, renderer: any) => entryRenderers.set(customType, renderer)),
    registerTool: vi.fn((t: any) => {
      tools.set(t.name, t);
      if (!activeTools.includes(t.name)) activeTools.push(t.name);
    }),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerFlag: vi.fn((name: string, options: any) => registeredFlags.set(name, options)),
    getFlag: vi.fn((name: string) => flags[name]),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    // Only bound after the session exists in real pi — the extension calls these
    // from `session_start` for exactly that reason. Default to "nothing else is
    // registered"; a test that cares overrides them.
    getAllTools: vi.fn(() => [] as any[]),
    getCommands: vi.fn(() => [] as any[]),
    // The active set starts as whatever was registered, which is what pi does
    // for a freshly loaded extension tool. `setActiveTools` writes it back so a
    // test can assert on a withdrawal.
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => {
      activeTools.length = 0;
      activeTools.push(...names);
    }),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
  } as any;
  return { pi, tools, lifecycle, entryRenderers, registeredFlags, commands };
}

/** A mock ExtensionContext — the second half of what a tool's `execute` receives. */
export function ctx(overrides: Record<string, unknown> = {}) {
  return {
    // The interactive mode extensions normally run in. Set explicitly because
    // the `@handle` input hook is TUI-only, so an absent mode would make every
    // mention test exercise the headless fall-through instead.
    mode: "tui",
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
    ...overrides,
  } as any;
}

/** Text of a tool result. */
export const textOf = (r: any): string => r.content[0].text;

/** Let queued microtasks run — enough for the manager's internal chaining. */
export const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

export interface Hermetic {
  dir: string;
  restore: () => void;
}

/**
 * Redirect cwd, `PI_CODING_AGENT_DIR` and `HOME` into a fresh temp dir, so the
 * developer's real settings and agent files can't reach the extension under
 * test. Call BEFORE instantiating the extension — settings are read at boot.
 */
export function hermeticDir(opts: {
  settings?: Record<string, unknown>;
  agentFiles?: Record<string, string>;
} = {}): Hermetic {
  const dir = mkdtempSync(join(tmpdir(), "pi-boot-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-boot-agentdir-"));
  const prevCwd = process.cwd();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevHome = process.env.HOME;

  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (opts.settings) {
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify(opts.settings));
  }
  if (opts.agentFiles) {
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    for (const [name, content] of Object.entries(opts.agentFiles)) {
      writeFileSync(join(dir, ".pi", "agents", `${name}.md`), content);
    }
  }

  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = agentDir;
  process.chdir(dir);

  return {
    dir,
    restore() {
      process.chdir(prevCwd);
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      if (prevHome == null) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}
