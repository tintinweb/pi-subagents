/**
 * shutdown-disposal.test.ts — pins #256: the root activation's `session_shutdown`
 * handler must also release the activation-owned resources it used to skip —
 * `AgentWidget` (the 80ms render interval and registered UI state) and
 * `GroupJoinManager` (pending 30s group timeouts).
 *
 * Why it matters: `session_shutdown` also runs for reload and session
 * replacement, where the Node process continues. A timer from the old activation
 * can retain it and fire its callbacks into the fresh activation's UI and group
 * state; repeated reloads accumulate them.
 *
 * These tests exercise the real wiring — the real extension activation and the
 * real session_shutdown handler — under a hermetic agent dir so the built-in
 * `general-purpose` type resolves everywhere.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupJoinManager } from "../src/group-join.js";
import subagentsExtension from "../src/index.js";
import { AgentWidget } from "../src/ui/agent-widget.js";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_before_switch, session_shutdown
  const events = new Map<string, any>(); // pi.events.on(...) — subagents:rpc:*, etc.
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        events.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, events };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("session_shutdown disposes activation-owned resources (#256)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir, scheduling off, so session_start doesn't spin a
    // scheduler or touch the dev's filesystem — same isolation as #108's wiring
    // tests, and it makes the built-in general-purpose type resolve.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-256-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-256-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("disposes the widget and group-join manager on shutdown", async () => {
    const { pi, lifecycle } = makePi();
    const widgetDispose = vi.spyOn(AgentWidget.prototype, "dispose");
    const groupJoinDispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    subagentsExtension(pi);

    await lifecycle.get("session_shutdown")?.({}, ctx());

    expect(widgetDispose).toHaveBeenCalledTimes(1);
    expect(groupJoinDispose).toHaveBeenCalledTimes(1);
  });

  it("does not dispose them on session_before_switch — a vetoed switch must keep the live UI", async () => {
    const { pi, lifecycle } = makePi();
    const widgetDispose = vi.spyOn(AgentWidget.prototype, "dispose");
    const groupJoinDispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    subagentsExtension(pi);

    // A switch begins but may be vetoed: the session continues, so the
    // activation-owned UI and group state must survive until a real shutdown.
    await lifecycle.get("session_before_switch")?.();

    expect(widgetDispose).not.toHaveBeenCalled();
    expect(groupJoinDispose).not.toHaveBeenCalled();

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });
});
