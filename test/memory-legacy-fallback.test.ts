import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock homedir so the legacy ~/.pi/agent-memory fallback can be exercised
// against a temp directory instead of the real home. The default return must
// be a valid string: pi-coding-agent evaluates getAgentDir() at module load
// (before beforeEach runs), so an undefined homedir would throw at import.
const mockHomedir = vi.hoisted(() => vi.fn(() => "/tmp"));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: mockHomedir };
});

import { resolveMemoryDir } from "../src/memory.js";

describe("resolveMemoryDir user-scope legacy fallback", () => {
  let tmpDir: string;
  let fakeHome: string;
  let agentDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-mem-legacy-test-"));
    fakeHome = join(tmpDir, "home");
    agentDir = join(tmpDir, "agent-dir");
    mkdirSync(fakeHome, { recursive: true });
    mockHomedir.mockReturnValue(fakeHome);
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses the agent dir location when no legacy memory exists", () => {
    const dir = resolveMemoryDir("chronicler", "user", "/workspace");
    expect(dir).toBe(join(agentDir, "agent-memory", "chronicler"));
  });

  it("falls back to legacy ~/.pi/agent-memory when it exists and the new location doesn't", () => {
    const legacy = join(fakeHome, ".pi", "agent-memory", "chronicler");
    mkdirSync(legacy, { recursive: true });

    const dir = resolveMemoryDir("chronicler", "user", "/workspace");
    expect(dir).toBe(legacy);
  });

  it("prefers the new location once it exists, even if legacy also exists", () => {
    const legacy = join(fakeHome, ".pi", "agent-memory", "chronicler");
    const current = join(agentDir, "agent-memory", "chronicler");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });

    const dir = resolveMemoryDir("chronicler", "user", "/workspace");
    expect(dir).toBe(current);
  });

  it("ignores a symlinked legacy directory", () => {
    const target = join(tmpDir, "elsewhere");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(fakeHome, ".pi", "agent-memory"), { recursive: true });
    symlinkSync(target, join(fakeHome, ".pi", "agent-memory", "chronicler"));

    const dir = resolveMemoryDir("chronicler", "user", "/workspace");
    expect(dir).toBe(join(agentDir, "agent-memory", "chronicler"));
  });

  it("scopes the fallback per agent name", () => {
    const legacyOther = join(fakeHome, ".pi", "agent-memory", "other-agent");
    mkdirSync(legacyOther, { recursive: true });

    // "other-agent" has legacy memory; "chronicler" doesn't — only the former falls back.
    expect(resolveMemoryDir("other-agent", "user", "/workspace")).toBe(legacyOther);
    expect(resolveMemoryDir("chronicler", "user", "/workspace")).toBe(join(agentDir, "agent-memory", "chronicler"));
  });
});
