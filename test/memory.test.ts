import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryBlock, buildReadOnlyMemoryBlock, ensureMemoryDir, isSymlink, isUnsafeName, readMemoryIndex, resolveMemoryDir, safeReadFile } from "../src/memory.js";

describe("memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-mem-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("resolveMemoryDir", () => {
    it("resolves project scope to .pi/agent-memory/<name>", () => {
      const dir = resolveMemoryDir("auditor", "project", "/workspace");
      expect(dir).toBe("/workspace/.pi/agent-memory/auditor");
    });

    it("resolves local scope to .pi/agent-memory-local/<name>", () => {
      const dir = resolveMemoryDir("auditor", "local", "/workspace");
      expect(dir).toBe("/workspace/.pi/agent-memory-local/auditor");
    });

    it("resolves user scope to ~/.pi/agent-memory/<name>", () => {
      const dir = resolveMemoryDir("auditor", "user", "/workspace");
      expect(dir).toContain(".pi/agent-memory/auditor");
      expect(dir).not.toContain("/workspace");
    });

    it("throws on names with path traversal (..)", () => {
      expect(() => resolveMemoryDir("../../etc/evil", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with forward slash", () => {
      expect(() => resolveMemoryDir("foo/bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with backslash", () => {
      expect(() => resolveMemoryDir("foo\\bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with null byte", () => {
      expect(() => resolveMemoryDir("foo\0bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on empty name", () => {
      expect(() => resolveMemoryDir("", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names starting with dot", () => {
      expect(() => resolveMemoryDir(".hidden", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("throws on names with spaces", () => {
      expect(() => resolveMemoryDir("foo bar", "project", "/workspace")).toThrow("Unsafe agent name");
    });

    it("allows hyphens, underscores, and dots in names", () => {
      expect(() => resolveMemoryDir("my-agent_v2.1", "project", "/workspace")).not.toThrow();
    });
  });

  describe("isUnsafeName (whitelist validation)", () => {
    it("rejects empty string", () => {
      expect(isUnsafeName("")).toBe(true);
    });

    it("rejects names longer than 128 chars", () => {
      expect(isUnsafeName("a".repeat(129))).toBe(true);
    });

    it("rejects path traversal", () => {
      expect(isUnsafeName("../../etc")).toBe(true);
    });

    it("rejects names starting with dot", () => {
      expect(isUnsafeName(".hidden")).toBe(true);
    });

    it("rejects names with spaces", () => {
      expect(isUnsafeName("foo bar")).toBe(true);
    });

    it("rejects names with special characters", () => {
      expect(isUnsafeName("foo;bar")).toBe(true);
      expect(isUnsafeName("foo|bar")).toBe(true);
      expect(isUnsafeName("foo`bar")).toBe(true);
    });

    it("allows valid names", () => {
      expect(isUnsafeName("my-agent")).toBe(false);
      expect(isUnsafeName("agent_v2")).toBe(false);
      expect(isUnsafeName("Agent123")).toBe(false);
      expect(isUnsafeName("my-agent.v2")).toBe(false);
    });
  });

  describe("ensureMemoryDir", () => {
    it("creates directory if it doesn't exist", () => {
      const dir = join(tmpDir, "agent-memory", "test");
      expect(existsSync(dir)).toBe(false);
      ensureMemoryDir(dir);
      expect(existsSync(dir)).toBe(true);
    });

    it("no-ops if directory already exists", () => {
      const dir = join(tmpDir, "agent-memory", "test");
      mkdirSync(dir, { recursive: true });
      ensureMemoryDir(dir); // should not throw
      expect(existsSync(dir)).toBe(true);
    });

    it("throws on symlinked directory", () => {
      const realDir = join(tmpDir, "real-dir");
      const linkDir = join(tmpDir, "symlink-dir");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, linkDir);
      expect(() => ensureMemoryDir(linkDir)).toThrow("symlinked memory directory");
    });
  });

  describe("isSymlink", () => {
    it("returns false for regular file", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "content");
      expect(isSymlink(file)).toBe(false);
    });

    it("returns true for symlink", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "content");
      symlinkSync(file, link);
      expect(isSymlink(link)).toBe(true);
    });

    it("returns false for nonexistent path", () => {
      expect(isSymlink(join(tmpDir, "nope"))).toBe(false);
    });
  });

  describe("safeReadFile", () => {
    it("reads regular files", () => {
      const file = join(tmpDir, "regular.txt");
      writeFileSync(file, "hello");
      expect(safeReadFile(file)).toBe("hello");
    });

    it("rejects symlinked files", () => {
      const file = join(tmpDir, "real.txt");
      const link = join(tmpDir, "link.txt");
      writeFileSync(file, "secret");
      symlinkSync(file, link);
      expect(safeReadFile(link)).toBeUndefined();
    });

    it("returns undefined for nonexistent files", () => {
      expect(safeReadFile(join(tmpDir, "nope.txt"))).toBeUndefined();
    });
  });

  describe("readMemoryIndex", () => {
    it("returns undefined when MEMORY.md doesn't exist", () => {
      const result = readMemoryIndex(tmpDir);
      expect(result).toBeUndefined();
    });

    it("reads MEMORY.md content", () => {
      writeFileSync(join(tmpDir, "MEMORY.md"), "# Memories\n- Item 1\n- Item 2");
      const result = readMemoryIndex(tmpDir);
      expect(result).toBe("# Memories\n- Item 1\n- Item 2");
    });

    it("rejects symlinked memory directory", () => {
      const realDir = join(tmpDir, "real-mem");
      const linkDir = join(tmpDir, "link-mem");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "MEMORY.md"), "# Secret");
      symlinkSync(realDir, linkDir);
      expect(readMemoryIndex(linkDir)).toBeUndefined();
    });

    it("rejects symlinked MEMORY.md file", () => {
      const realFile = join(tmpDir, "secret.md");
      writeFileSync(realFile, "# Secret");
      const memDir = join(tmpDir, "mem-dir");
      mkdirSync(memDir);
      symlinkSync(realFile, join(memDir, "MEMORY.md"));
      expect(readMemoryIndex(memDir)).toBeUndefined();
    });

    it("truncates content beyond 200 lines", () => {
      const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1}`);
      writeFileSync(join(tmpDir, "MEMORY.md"), lines.join("\n"));
      const result = readMemoryIndex(tmpDir)!;
      expect(result).toContain("Line 200");
      expect(result).not.toContain("Line 201");
      expect(result).toContain("truncated at 200 lines");
    });
  });

  describe("buildMemoryBlock", () => {
    it("builds memory block with no existing MEMORY.md", () => {
      const block = buildMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Agent Memory");
      expect(block).toContain("agent-memory/test-agent");
      expect(block).toContain("No MEMORY.md exists yet");
      expect(block).toContain("Memory Instructions");
    });

    it("builds memory block with existing MEMORY.md", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "test-agent");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Existing\n- recall this");
      const block = buildMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Existing");
      expect(block).toContain("recall this");
      expect(block).not.toContain("No MEMORY.md exists yet");
    });

    it("creates memory directory if it doesn't exist", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "new-agent");
      expect(existsSync(memDir)).toBe(false);
      buildMemoryBlock("new-agent", "project", tmpDir);
      expect(existsSync(memDir)).toBe(true);
    });

    it("includes Read/Write/Edit instructions", () => {
      const block = buildMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Read, Write, and Edit tools");
    });

    it("uses correct directory for local scope", () => {
      const block = buildMemoryBlock("test-agent", "local", tmpDir);
      expect(block).toContain("agent-memory-local/test-agent");
    });

    it("uses correct directory for user scope", () => {
      const block = buildMemoryBlock("test-agent", "user", tmpDir);
      expect(block).toContain(".pi/agent-memory/test-agent");
      expect(block).not.toContain(tmpDir);
    });

    it("includes scope label in header", () => {
      expect(buildMemoryBlock("a", "project", tmpDir)).toContain("Memory scope: project");
      expect(buildMemoryBlock("a", "local", tmpDir)).toContain("Memory scope: local");
      expect(buildMemoryBlock("a", "user", tmpDir)).toContain("Memory scope: user");
    });
  });

  describe("buildReadOnlyMemoryBlock", () => {
    it("returns read-only instructions without write/edit mention", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("read-only");
      expect(block).not.toContain("Write");
      expect(block).not.toContain("Edit");
      expect(block).not.toContain("Memory Instructions");
    });

    it("does NOT create the memory directory", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "ro-agent");
      expect(existsSync(memDir)).toBe(false);
      buildReadOnlyMemoryBlock("ro-agent", "project", tmpDir);
      expect(existsSync(memDir)).toBe(false);
    });

    it("includes existing MEMORY.md content", () => {
      const memDir = join(tmpDir, ".pi", "agent-memory", "test-agent");
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(memDir, "MEMORY.md"), "# Existing\n- recall this");
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("Existing");
      expect(block).toContain("recall this");
    });

    it("returns 'no memory available' when no MEMORY.md exists", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).toContain("No memory is available yet");
      expect(block).not.toContain("Create one");
    });

    it("includes scope label in header", () => {
      expect(buildReadOnlyMemoryBlock("a", "project", tmpDir)).toContain("Memory scope: project");
      expect(buildReadOnlyMemoryBlock("a", "local", tmpDir)).toContain("Memory scope: local");
      expect(buildReadOnlyMemoryBlock("a", "user", tmpDir)).toContain("Memory scope: user");
    });

    it("does not mention memory directory path for write access", () => {
      const block = buildReadOnlyMemoryBlock("test-agent", "project", tmpDir);
      expect(block).not.toContain("persistent memory directory at:");
      expect(block).not.toContain("Create one at");
    });

    it("rejects symlinked memory directory in read-only mode", () => {
      const realDir = join(tmpDir, ".pi", "agent-memory", "test-agent");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "MEMORY.md"), "# Secret");
      const linkDir = join(tmpDir, ".pi", "agent-memory", "linked-agent");
      mkdirSync(join(tmpDir, ".pi", "agent-memory"), { recursive: true });
      symlinkSync(realDir, linkDir);
      // Should not read through the symlink
      const block = buildReadOnlyMemoryBlock("linked-agent", "project", tmpDir);
      expect(block).toContain("No memory is available yet");
    });
  });
});
