import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preloadSkills } from "../src/skill-loader.js";

describe("preloadSkills", () => {
  let tmpDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-skill-test-"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "user-agent-dir");
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const projectRoot = () => join(tmpDir, ".pi", "skills");
  const globalRoot = () => join(process.env.PI_CODING_AGENT_DIR!, "skills");

  function writeFlat(root: string, name: string, content: string, ext = ".md") {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, name + ext), content);
  }

  function writeSkillDir(root: string, name: string, content: string) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
  }

  it("returns empty array for empty skill list", () => {
    expect(preloadSkills([], tmpDir)).toEqual([]);
  });

  it("loads a top-level flat .md skill from project", () => {
    writeFlat(projectRoot(), "api-conventions", "# API Conventions");
    const result = preloadSkills(["api-conventions"], tmpDir);
    expect(result[0].content).toContain("API Conventions");
  });

  it("ignores .txt files (only .md is supported)", () => {
    writeFlat(projectRoot(), "error-handling", "should not load", ".txt");
    expect(preloadSkills(["error-handling"], tmpDir)[0].content).toContain("not found");
  });

  it("ignores extensionless files (only .md is supported)", () => {
    writeFlat(projectRoot(), "bare-skill", "should not load", "");
    expect(preloadSkills(["bare-skill"], tmpDir)[0].content).toContain("not found");
  });

  it("loads a top-level <name>/SKILL.md from project", () => {
    writeSkillDir(projectRoot(), "writing-go", "# Writing Go");
    expect(preloadSkills(["writing-go"], tmpDir)[0].content).toContain("Writing Go");
  });

  it("loads a top-level <name>/SKILL.md from getAgentDir()/skills", () => {
    writeSkillDir(globalRoot(), "writing-python", "# Writing Python");
    expect(preloadSkills(["writing-python"], tmpDir)[0].content).toContain("Writing Python");
  });

  it("loads a flat .md from getAgentDir()/skills", () => {
    writeFlat(globalRoot(), "shell-tips", "use rg");
    expect(preloadSkills(["shell-tips"], tmpDir)[0].content).toBe("use rg");
  });

  it("finds nested <subdir>/<name>/SKILL.md in getAgentDir()/skills", () => {
    writeSkillDir(join(globalRoot(), "dev-tools"), "using-modern-cli", "# Modern CLI");
    expect(preloadSkills(["using-modern-cli"], tmpDir)[0].content).toContain("Modern CLI");
  });

  it("loads <name>/SKILL.md from project .agents/skills (Agent Skills spec)", () => {
    writeSkillDir(join(tmpDir, ".agents", "skills"), "writing-rust", "# Writing Rust");
    expect(preloadSkills(["writing-rust"], tmpDir)[0].content).toContain("Writing Rust");
  });

  it("prefers .pi/skills over .agents/skills in the same project", () => {
    writeSkillDir(projectRoot(), "shared", "from-pi");
    writeSkillDir(join(tmpDir, ".agents", "skills"), "shared", "from-agents");
    expect(preloadSkills(["shared"], tmpDir)[0].content).toBe("from-pi");
  });

  it("finds nested <subdir>/<name>/SKILL.md", () => {
    writeSkillDir(join(projectRoot(), "dev-tools"), "using-modern-cli", "# Modern CLI");
    expect(preloadSkills(["using-modern-cli"], tmpDir)[0].content).toContain("Modern CLI");
  });

  it("prefers project over global", () => {
    writeSkillDir(projectRoot(), "shared", "from-project");
    writeSkillDir(globalRoot(), "shared", "from-global");
    expect(preloadSkills(["shared"], tmpDir)[0].content).toBe("from-project");
  });

  it("prefers shallower match (lex tie-break)", () => {
    // Different depths — shallower wins.
    writeSkillDir(join(projectRoot(), "z-deep", "nested"), "collide", "deep");
    writeSkillDir(join(projectRoot(), "a-shallow"), "collide", "shallow");
    expect(preloadSkills(["collide"], tmpDir)[0].content).toBe("shallow");

    // Same depth — alphabetical wins.
    writeSkillDir(join(projectRoot(), "b-sibling"), "tie", "b");
    writeSkillDir(join(projectRoot(), "a-sibling"), "tie", "a");
    expect(preloadSkills(["tie"], tmpDir)[0].content).toBe("a");
  });

  it("descends past a same-named dir that lacks SKILL.md to find a deeper match", () => {
    // .pi/skills/foo exists empty; .pi/skills/foo/inner/foo/SKILL.md is the real skill.
    mkdirSync(join(projectRoot(), "foo"), { recursive: true });
    writeSkillDir(join(projectRoot(), "foo", "inner"), "foo", "deeper");
    expect(preloadSkills(["foo"], tmpDir)[0].content).toBe("deeper");
  });

  it("does not descend into a sibling skill directory (skills don't nest)", () => {
    // .pi/skills/outer is itself a skill; .pi/skills/outer/target/SKILL.md must NOT be found.
    writeSkillDir(projectRoot(), "outer", "outer-skill");
    writeSkillDir(join(projectRoot(), "outer"), "target", "hidden");
    expect(preloadSkills(["target"], tmpDir)[0].content).toContain("not found");
  });

  it("skips node_modules during recursion", () => {
    writeSkillDir(join(projectRoot(), "node_modules", "some-pkg"), "leaked", "should not load");
    expect(preloadSkills(["leaked"], tmpDir)[0].content).toContain("not found");
  });

  it("skips dotfile directories during recursion", () => {
    writeSkillDir(join(projectRoot(), ".hidden-tree"), "buried", "should not load");
    expect(preloadSkills(["buried"], tmpDir)[0].content).toContain("not found");
  });

  it("returns fallback for missing skills", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(result[0].name).toBe("nonexistent");
    expect(result[0].content).toContain("not found");
  });

  it("loads multiple skills", () => {
    writeFlat(projectRoot(), "a", "Content A");
    writeSkillDir(projectRoot(), "b", "Content B");
    const result = preloadSkills(["a", "b"], tmpDir);
    expect(result.map((r) => r.content)).toEqual(["Content A", expect.stringContaining("Content B")]);
  });

  it("skips skill names with path traversal (..)", () => {
    expect(preloadSkills(["../../etc/passwd"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names with forward slash", () => {
    expect(preloadSkills(["sub/dir"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names with backslash", () => {
    expect(preloadSkills(["sub\\dir"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names with spaces", () => {
    expect(preloadSkills(["my skill"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names starting with a dot", () => {
    expect(preloadSkills([".hidden"], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips empty skill names", () => {
    expect(preloadSkills([""], tmpDir)[0].content).toContain("path traversal");
  });

  it("skips skill names exceeding 128 characters", () => {
    const longName = "a".repeat(129);
    expect(preloadSkills([longName], tmpDir)[0].content).toContain("path traversal");
  });

  it("loads valid skills alongside skipped unsafe ones", () => {
    writeFlat(projectRoot(), "legit", "Good content");
    const result = preloadSkills(["../evil", "legit"], tmpDir);
    expect(result[0].content).toContain("path traversal");
    expect(result[1].content).toBe("Good content");
  });

  it("rejects symlinked flat .md files", () => {
    mkdirSync(projectRoot(), { recursive: true });
    const secret = join(tmpDir, "secret.md");
    writeFileSync(secret, "TOP SECRET");
    symlinkSync(secret, join(projectRoot(), "evil.md"));
    const result = preloadSkills(["evil"], tmpDir);
    expect(result[0].content).toContain("not found");
    expect(result[0].content).not.toContain("TOP SECRET");
  });

  it("rejects symlinked skill directories", () => {
    mkdirSync(projectRoot(), { recursive: true });
    const realDir = join(tmpDir, "real-skill");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), "TOP SECRET");
    symlinkSync(realDir, join(projectRoot(), "evil-dir"));
    const result = preloadSkills(["evil-dir"], tmpDir);
    expect(result[0].content).toContain("not found");
    expect(result[0].content).not.toContain("TOP SECRET");
  });

  it("rejects symlinked skill root", () => {
    // <cwd>/.pi/skills → symlink to a directory that holds real-looking skills.
    const realRoot = join(tmpDir, "elsewhere");
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, "leaked-flat.md"), "TOP SECRET FLAT");
    mkdirSync(join(realRoot, "leaked-dir"), { recursive: true });
    writeFileSync(join(realRoot, "leaked-dir", "SKILL.md"), "TOP SECRET DIR");
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    symlinkSync(realRoot, projectRoot());

    const flatResult = preloadSkills(["leaked-flat"], tmpDir)[0].content;
    expect(flatResult).toContain("not found");
    expect(flatResult).not.toContain("TOP SECRET");

    const dirResult = preloadSkills(["leaked-dir"], tmpDir)[0].content;
    expect(dirResult).toContain("not found");
    expect(dirResult).not.toContain("TOP SECRET");
  });

  it("rejects symlinked SKILL.md inside a real skill directory", () => {
    const skillDir = join(projectRoot(), "evil-inner");
    mkdirSync(skillDir, { recursive: true });
    const secret = join(tmpDir, "secret.md");
    writeFileSync(secret, "TOP SECRET");
    symlinkSync(secret, join(skillDir, "SKILL.md"));
    const result = preloadSkills(["evil-inner"], tmpDir);
    expect(result[0].content).toContain("not found");
    expect(result[0].content).not.toContain("TOP SECRET");
  });
});
