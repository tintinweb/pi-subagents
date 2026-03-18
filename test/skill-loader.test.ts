import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preloadSkills } from "../src/skill-loader.js";

describe("preloadSkills", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-skill-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(name: string, content: string, ext = ".md") {
    const dir = join(tmpDir, ".pi", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name + ext), content);
  }

  it("returns empty array for empty skill list", () => {
    const result = preloadSkills([], tmpDir);
    expect(result).toEqual([]);
  });

  it("loads a .md skill file", () => {
    writeSkill("api-conventions", "# API Conventions\nUse REST.");
    const result = preloadSkills(["api-conventions"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("api-conventions");
    expect(result[0].content).toContain("API Conventions");
  });

  it("loads a .txt skill file", () => {
    writeSkill("error-handling", "Handle errors gracefully.", ".txt");
    const result = preloadSkills(["error-handling"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Handle errors gracefully");
  });

  it("prefers .md over .txt", () => {
    writeSkill("dual", "MD content", ".md");
    writeSkill("dual", "TXT content", ".txt");
    const result = preloadSkills(["dual"], tmpDir);
    expect(result[0].content).toBe("MD content");
  });

  it("returns fallback message for missing skills", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
  });

  it("loads multiple skills", () => {
    writeSkill("skill-a", "Content A");
    writeSkill("skill-b", "Content B");
    const result = preloadSkills(["skill-a", "skill-b"], tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain("Content A");
    expect(result[1].content).toContain("Content B");
  });

  it("loads skills without extension", () => {
    writeSkill("bare-skill", "Bare content", "");
    const result = preloadSkills(["bare-skill"], tmpDir);
    expect(result[0].content).toBe("Bare content");
  });

  it("skips skill names with path traversal (..)", () => {
    const result = preloadSkills(["../../etc/passwd"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("path traversal");
  });

  it("skips skill names with forward slash", () => {
    const result = preloadSkills(["sub/dir"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("path traversal");
  });

  it("skips skill names with backslash", () => {
    const result = preloadSkills(["sub\\dir"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("path traversal");
  });

  it("loads valid skills alongside skipped unsafe ones", () => {
    writeSkill("legit", "Good content");
    const result = preloadSkills(["../evil", "legit"], tmpDir);
    expect(result).toHaveLength(2);
    expect(result[0].content).toContain("path traversal");
    expect(result[1].content).toContain("Good content");
  });

  it("rejects symlinked skill files", () => {
    const dir = join(tmpDir, ".pi", "skills");
    mkdirSync(dir, { recursive: true });
    const secretFile = join(tmpDir, "secret.md");
    writeFileSync(secretFile, "TOP SECRET CONTENT");
    symlinkSync(secretFile, join(dir, "evil-skill.md"));
    const result = preloadSkills(["evil-skill"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("not found");
    expect(result[0].content).not.toContain("TOP SECRET");
  });

  it("skips names with spaces (whitelist validation)", () => {
    const result = preloadSkills(["my skill"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("path traversal");
  });

  it("skips names starting with dot", () => {
    const result = preloadSkills([".hidden"], tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("path traversal");
  });
});
