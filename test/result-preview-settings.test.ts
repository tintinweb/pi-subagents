import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "../src/settings.js";

describe("result preview settings sanitizer + persistence", () => {
  let globalDir: string;
  let projectDir: string;
  let originalAgentDirEnv: string | undefined;

  const globalFile = () => join(globalDir, "subagents.json");
  const projectFile = () => join(projectDir, ".pi", "subagents.json");

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "pi-settings-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-settings-project-"));
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (originalAgentDirEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeGlobal(obj: unknown) {
    writeFileSync(globalFile(), JSON.stringify(obj));
  }

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  describe("resultPreviewMode sanitizer", () => {
    it("accepts valid values", () => {
      writeProject({ resultPreviewMode: "plain" });
      expect(loadSettings(projectDir).resultPreviewMode).toBe("plain");

      writeProject({ resultPreviewMode: "markdown" });
      expect(loadSettings(projectDir).resultPreviewMode).toBe("markdown");
    });

    it("drops invalid values", () => {
      writeProject({ resultPreviewMode: "foo" });
      expect(loadSettings(projectDir).resultPreviewMode).toBeUndefined();

      writeProject({ resultPreviewMode: null });
      expect(loadSettings(projectDir).resultPreviewMode).toBeUndefined();

      writeProject({ resultPreviewMode: 42 });
      expect(loadSettings(projectDir).resultPreviewMode).toBeUndefined();

      writeProject({ resultPreviewMode: "undefined" });
      expect(loadSettings(projectDir).resultPreviewMode).toBeUndefined();
    });
  });

  describe("resultPreviewExpanded sanitizer", () => {
    it("accepts boolean values", () => {
      writeProject({ resultPreviewExpanded: true });
      expect(loadSettings(projectDir).resultPreviewExpanded).toBe(true);

      writeProject({ resultPreviewExpanded: false });
      expect(loadSettings(projectDir).resultPreviewExpanded).toBe(false);
    });

    it("drops non-boolean values", () => {
      writeProject({ resultPreviewExpanded: "true" });
      expect(loadSettings(projectDir).resultPreviewExpanded).toBeUndefined();

      writeProject({ resultPreviewExpanded: 1 });
      expect(loadSettings(projectDir).resultPreviewExpanded).toBeUndefined();

      writeProject({ resultPreviewExpanded: null });
      expect(loadSettings(projectDir).resultPreviewExpanded).toBeUndefined();
    });
  });

  describe("failurePreviewMaxChars sanitizer", () => {
    it("accepts valid integers in range", () => {
      writeProject({ failurePreviewMaxChars: 1 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBe(1);

      writeProject({ failurePreviewMaxChars: 65536 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBe(65536);

      writeProject({ failurePreviewMaxChars: 1048576 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBe(1048576);
    });

    it("drops out-of-range values", () => {
      writeProject({ failurePreviewMaxChars: 0 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBeUndefined();

      writeProject({ failurePreviewMaxChars: -1 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBeUndefined();

      writeProject({ failurePreviewMaxChars: 2000000 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBeUndefined();
    });

    it("drops non-integer values", () => {
      writeProject({ failurePreviewMaxChars: 1.5 });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBeUndefined();

      writeProject({ failurePreviewMaxChars: NaN });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBeUndefined();

      writeProject({ failurePreviewMaxChars: "1000" });
      expect(loadSettings(projectDir).failurePreviewMaxChars).toBeUndefined();
    });
  });

  describe("persistence roundtrip", () => {
    it("writes and reloads all three fields", () => {
      const settings = {
        resultPreviewMode: "plain" as const,
        resultPreviewExpanded: false,
        failurePreviewMaxChars: 32768,
      };

      expect(saveSettings(settings, projectDir)).toBe(true);
      expect(existsSync(projectFile())).toBe(true);

      const reloaded = loadSettings(projectDir);
      expect(reloaded.resultPreviewMode).toBe("plain");
      expect(reloaded.resultPreviewExpanded).toBe(false);
      expect(reloaded.failurePreviewMaxChars).toBe(32768);
    });
  });

  describe("project precedence", () => {
    it("project overrides global on each field", () => {
      writeGlobal({
        resultPreviewMode: "plain",
        resultPreviewExpanded: true,
        failurePreviewMaxChars: 1000,
      });

      writeProject({
        resultPreviewMode: "markdown",
        resultPreviewExpanded: false,
        failurePreviewMaxChars: 2000,
      });

      const merged = loadSettings(projectDir);
      expect(merged.resultPreviewMode).toBe("markdown");
      expect(merged.resultPreviewExpanded).toBe(false);
      expect(merged.failurePreviewMaxChars).toBe(2000);
    });
  });
});