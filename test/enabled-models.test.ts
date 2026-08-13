import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ModelRegistryRef, readEnabledModels, resolveEnabledModels as resolveEnabledModelsActual } from "../src/enabled-models.js";

/**
 * `resolveEnabledModels` now requires the session cwd (#206 — no
 * `process.cwd()` parameter default). These tests exercise pattern
 * resolution, not settings discovery, so a directory with no settings
 * files serves them all.
 */
const resolveEnabledModels = (
  patterns: string[] | undefined,
  registry: ModelRegistryRef,
  cwd: string = join(tmpdir(), "pi-subagents-enabled-models-no-settings"),
) => resolveEnabledModelsActual(patterns, registry, cwd);

/** Mock models matching typical registry shape. */
const MODELS = [
  { id: "gemma-4-31b-it", name: "Gemma 4 31B", provider: "google" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

function makeRegistry(models = MODELS, available?: typeof MODELS): ModelRegistryRef {
  return {
    getAll() { return models; },
    getAvailable: available ? () => available : undefined,
  };
}

describe("readEnabledModels", () => {
  let agentDir: string;
  let projectDir: string;
  let originalEnv: string | undefined;

  const projectFile = () => join(projectDir, ".pi", "settings.json");
  const globalFile = () => join(agentDir, "settings.json");

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-em-global-"));
    projectDir = mkdtempSync(join(tmpdir(), "pi-em-project-"));
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (originalEnv == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function writeProject(obj: unknown) {
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), JSON.stringify(obj));
  }

  it("returns undefined when both settings files are missing", () => {
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns undefined when field absent from both files", () => {
    writeFileSync(globalFile(), JSON.stringify({ defaultProvider: "openai" }));
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns enabledModels from global when project file absent", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6", "google/gemma-4-31b-it"],
    }));
    expect(readEnabledModels(projectDir)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemma-4-31b-it",
    ]);
  });

  it("returns enabledModels from project when global file absent", () => {
    writeProject({ enabledModels: ["anthropic/claude-haiku-4-5"] });
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("project overrides global (array replaces wholly, mirrors pi's deep-merge)", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-6"],
    }));
    writeProject({ enabledModels: ["anthropic/claude-haiku-4-5"] });
    // Project replaces wholly — globals NOT merged in
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("falls back to global when project file has no enabledModels field", () => {
    writeFileSync(globalFile(), JSON.stringify({
      enabledModels: ["anthropic/claude-sonnet-4-6"],
    }));
    writeProject({ defaultProvider: "anthropic" }); // project exists but no enabledModels
    expect(readEnabledModels(projectDir)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("returns undefined when global JSON is corrupt (try/catch swallow)", () => {
    writeFileSync(globalFile(), "not json {{{");
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns undefined when enabledModels is not an array (global)", () => {
    writeFileSync(globalFile(), JSON.stringify({ enabledModels: "anthropic/claude-sonnet-4-6" }));
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });

  it("returns undefined when enabledModels is not an array (project)", () => {
    writeProject({ enabledModels: "anthropic/claude-haiku-4-5" });
    // Project's non-array enabledModels is invalid → falls back to global; global empty → undefined
    expect(readEnabledModels(projectDir)).toBeUndefined();
  });
});

describe("resolveEnabledModels", () => {
  it("returns undefined for empty patterns", () => {
    expect(resolveEnabledModels([], makeRegistry())).toBeUndefined();
    expect(resolveEnabledModels(undefined, makeRegistry())).toBeUndefined();
  });

  it("returns undefined when no matches", () => {
    expect(resolveEnabledModels(["nonexistent/foo"], makeRegistry())).toBeUndefined();
  });

  it("skips empty string patterns", () => {
    const result = resolveEnabledModels(["", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"], makeRegistry());
    // Empty string should not match — only exact patterns should match
    expect(result!.size).toBe(2);
  });

  it("skips whitespace-only patterns", () => {
    const result = resolveEnabledModels(["  ", "google/gemma-4-31b-it"], makeRegistry());
    expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
  });

  it("returns undefined when getAvailable returns empty array", () => {
    const result = resolveEnabledModels(
      ["anthropic/claude-haiku-4-5"],
      makeRegistry(MODELS, []),
    );
    expect(result).toBeUndefined();
  });

  it("deduplicates duplicate patterns", () => {
    const result = resolveEnabledModels(
      ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5"],
      makeRegistry(),
    );
    expect(result!.size).toBe(1); // duplicate resolves to one entry
  });

  describe("exact provider/modelId", () => {
    it("resolves exact match (key stored lowercase)", () => {
      const result = resolveEnabledModels(["google/gemma-4-31b-it"], makeRegistry());
      expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
    });

    it("resolves model id with colon (part of id, not split)", () => {
      const result = resolveEnabledModels(
        ["anthropic/claude-opus-4-6"],
        makeRegistry(),
      );
      expect(result).toEqual(new Set(["anthropic/claude-opus-4-6"]));
    });

    it("is case-insensitive", () => {
      const result = resolveEnabledModels(["GOOGLE/GEMMA-4-31B-IT"], makeRegistry());
      expect(result).toEqual(new Set(["google/gemma-4-31b-it"]));
    });
  });

  describe("no bare modelId or fuzzy matching", () => {
    it("returns undefined for bare id (pi always writes provider/modelId)", () => {
      const result = resolveEnabledModels(["gemma-4-31b-it"], makeRegistry());
      expect(result).toBeUndefined();
    });

    it("returns undefined for bare substring patterns", () => {
      const result = resolveEnabledModels(["Opus"], makeRegistry());
      expect(result).toBeUndefined();
    });
  });



  describe("mixed patterns", () => {
    it("combines multiple exact provider/modelId in one call", () => {
      const result = resolveEnabledModels(
        ["google/gemma-4-31b-it", "anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"],
        makeRegistry(),
      );
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(true);
      expect(result!.has("google/gemini-2.5-pro".toLowerCase())).toBe(false);
      expect(result!.has("anthropic/claude-opus-4-6".toLowerCase())).toBe(false);
    });
  });

  describe("getAvailable filtering", () => {
    it("resolves only against available models when getAvailable present", () => {
      const available = [MODELS[0], MODELS[3]]; // google + haiku only
      const result = resolveEnabledModels(
        ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6", "google/gemma-4-31b-it"],
        makeRegistry(MODELS, available),
      );
      // haiku and google are available; sonnet is not
      expect(result!.has("anthropic/claude-haiku-4-5".toLowerCase())).toBe(true);
      expect(result!.has("anthropic/claude-sonnet-4-6".toLowerCase())).toBe(false); // not available
      expect(result!.has("google/gemma-4-31b-it".toLowerCase())).toBe(true);
    });
  });
});
