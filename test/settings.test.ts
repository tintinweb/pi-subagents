import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyAndEmitLoaded,
  applySettings,
  loadSettings,
  persistToastFor,
  type SettingsAppliers,
  saveAndEmitChanged,
  saveSettings,
} from "../src/settings.js";

/**
 * Tests for persistent settings. Uses two tmp directories:
 * - `globalDir`: redirected via PI_CODING_AGENT_DIR so getAgentDir() returns it.
 *   Simulates `~/.pi/agent/` — the global scope.
 * - `projectDir`: passed explicitly as cwd to load/save.
 *   Simulates the user's project root. Settings live at `<projectDir>/.pi/subagents.json`.
 */
describe("settings persistence", () => {
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

  it("returns {} when both files are missing", () => {
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("returns {} when both files are malformed JSON", () => {
    writeFileSync(globalFile(), "not json {{");
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(projectFile(), "also not json");
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("loads from global when no project file", () => {
    writeGlobal({ maxConcurrent: 16, graceTurns: 10 });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 16, graceTurns: 10 });
  });

  it("loads from project when no global file", () => {
    writeProject({ maxConcurrent: 8, defaultJoinMode: "group" });
    expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 8, defaultJoinMode: "group" });
  });

  it("merges global + project with project winning on conflicts", () => {
    writeGlobal({ maxConcurrent: 16, graceTurns: 10, defaultJoinMode: "async", isolationBackend: "jj" });
    writeProject({ maxConcurrent: 4, defaultMaxTurns: 50, isolationBackend: "git" });
    expect(loadSettings(projectDir)).toEqual({
      maxConcurrent: 4, // project wins
      graceTurns: 10, // from global
      defaultJoinMode: "async", // from global
      defaultMaxTurns: 50, // from project only
      isolationBackend: "git", // project wins
    });
  });

  it("round-trips values: saveSettings then loadSettings", () => {
    const settings = {
      maxConcurrent: 7,
      defaultMaxTurns: 30,
      graceTurns: 3,
      defaultJoinMode: "smart" as const,
      isolationBackend: "jj" as const,
      schedulingEnabled: false,
      toolDescriptionMode: "compact" as const,
    };
    saveSettings(settings, projectDir);
    expect(loadSettings(projectDir)).toEqual(settings);
  });

  it("round-trips schedulingEnabled (true and false), and absence stays absent", () => {
    saveSettings({ schedulingEnabled: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ schedulingEnabled: false });

    saveSettings({ schedulingEnabled: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ schedulingEnabled: true });

    // Absence — caller's "use default" signal — must not become a stored false.
    saveSettings({}, projectDir);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips fleetView (true and false); keeps boolean, drops non-boolean", () => {
    saveSettings({ fleetView: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ fleetView: false });
    saveSettings({ fleetView: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ fleetView: true });
    writeProject({ fleetView: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // non-boolean dropped
  });

  it("round-trips agentMentions modes; drops an unknown one", () => {
    for (const mode of ["model", "direct", "off"] as const) {
      saveSettings({ agentMentions: mode }, projectDir);
      expect(loadSettings(projectDir)).toEqual({ agentMentions: mode });
    }
    writeProject({ agentMentions: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // unknown mode dropped
  });

  it("reads the pre-mode agentMentions booleans as their modes", () => {
    // The setting shipped as a boolean before `model` existed, so a config
    // written then — or hand-written from the old README — must keep working.
    // `true` meant "on", and on is now `model`.
    writeProject({ agentMentions: true } as any);
    expect(loadSettings(projectDir)).toEqual({ agentMentions: "model" });
    writeProject({ agentMentions: false } as any);
    expect(loadSettings(projectDir)).toEqual({ agentMentions: "off" });
  });

  it("round-trips rememberAgents (true and false); keeps boolean, drops non-boolean", () => {
    saveSettings({ rememberAgents: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ rememberAgents: false });
    saveSettings({ rememberAgents: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ rememberAgents: true });
    writeProject({ rememberAgents: "on" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // non-boolean dropped
  });

  it("round-trips widgetMode; keeps valid values, drops invalid", () => {
    saveSettings({ widgetMode: "off" }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ widgetMode: "off" });
    saveSettings({ widgetMode: "background" }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ widgetMode: "background" });
    writeProject({ widgetMode: "sideways" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // invalid value dropped
  });

  it("round-trips outputTranscript; drops non-boolean", () => {
    saveSettings({ outputTranscript: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ outputTranscript: false });
    saveSettings({ outputTranscript: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ outputTranscript: true });
    writeProject({ outputTranscript: "no" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // non-boolean dropped
  });

  it("round-trips backgroundByDefault (true and false), and absence stays absent", () => {
    // `false` is the load-bearing case: it's how a user restores the previous
    // foreground default, so it must survive a save/load rather than being
    // read back as absent and re-defaulting to background.
    saveSettings({ backgroundByDefault: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ backgroundByDefault: false });

    saveSettings({ backgroundByDefault: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ backgroundByDefault: true });

    saveSettings({}, projectDir);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("sanitize drops non-boolean backgroundByDefault silently", () => {
    writeProject({ backgroundByDefault: "yes" } as any);
    expect(loadSettings(projectDir)).toEqual({});
    writeProject({ backgroundByDefault: 0 } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("round-trips worktreeIsolation; drops non-boolean", () => {
    saveSettings({ worktreeIsolation: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ worktreeIsolation: false });
    saveSettings({ worktreeIsolation: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ worktreeIsolation: true });
    writeProject({ worktreeIsolation: "off" } as any);
    expect(loadSettings(projectDir)).toEqual({}); // non-boolean dropped
  });

  it("round-trips reportUsage and showCost; drops non-boolean", () => {
    saveSettings({ reportUsage: true, showCost: true }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ reportUsage: true, showCost: true });
    saveSettings({ reportUsage: false, showCost: false }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ reportUsage: false, showCost: false });
    // The sanitizer is an allowlist: a key it does not name is dropped, and the
    // setting silently never applies.
    writeProject({ reportUsage: "on", showCost: 1 } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("sanitize drops non-boolean schedulingEnabled silently", async () => {
    writeProject({ schedulingEnabled: "yes" } as any);
    expect(loadSettings(projectDir)).toEqual({});
    writeProject({ schedulingEnabled: 1 } as any);
    expect(loadSettings(projectDir)).toEqual({});
  });

  it("saveSettings writes only to the project file; global is untouched", () => {
    writeGlobal({ maxConcurrent: 16 });
    saveSettings({ maxConcurrent: 2 }, projectDir);

    // Project file contains the new value
    expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    // Global file unchanged
    expect(JSON.parse(readFileSync(globalFile(), "utf-8"))).toEqual({ maxConcurrent: 16 });
  });

  it("saveSettings creates <cwd>/.pi/ when missing", () => {
    expect(existsSync(join(projectDir, ".pi"))).toBe(false);
    saveSettings({ maxConcurrent: 4 }, projectDir);
    expect(existsSync(projectFile())).toBe(true);
  });

  it("round-trips defaultMaxTurns: 0 (unlimited marker)", () => {
    saveSettings({ defaultMaxTurns: 0 }, projectDir);
    expect(loadSettings(projectDir)).toEqual({ defaultMaxTurns: 0 });
  });

  it("ignores unknown extra fields on load (forward-compat)", () => {
    writeProject({ maxConcurrent: 2, futureField: "ignored" });
    const loaded = loadSettings(projectDir);
    expect(loaded.maxConcurrent).toBe(2);
    // Unknown fields are stripped by the sanitizer — old versions won't persist garbage
    expect((loaded as Record<string, unknown>).futureField).toBeUndefined();
  });

  it("composes partial global + partial project correctly", () => {
    writeGlobal({ graceTurns: 10 });
    writeProject({ maxConcurrent: 2 });
    expect(loadSettings(projectDir)).toEqual({ graceTurns: 10, maxConcurrent: 2 });
  });

  describe("sanitizer", () => {
    it("drops maxConcurrent < 1", () => {
      writeProject({ maxConcurrent: 0, graceTurns: 5 });
      expect(loadSettings(projectDir)).toEqual({ graceTurns: 5 });
    });

    it("drops negative maxConcurrent", () => {
      writeProject({ maxConcurrent: -3 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops non-integer maxConcurrent (floats, NaN, strings)", () => {
      writeProject({ maxConcurrent: 3.5 });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: "four" });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ maxConcurrent: null });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
    });

    it("accepts defaultMaxTurns: 0 (explicit unlimited)", () => {
      writeProject({ defaultMaxTurns: 0 });
      expect(loadSettings(projectDir)).toEqual({ defaultMaxTurns: 0 });
    });

    it("drops negative defaultMaxTurns", () => {
      writeProject({ defaultMaxTurns: -1 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops graceTurns < 1", () => {
      writeProject({ graceTurns: 0 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("keeps maxSubagentDepth 0 (nesting off) but drops negative, fractional, and over-ceiling values", () => {
      writeProject({ maxSubagentDepth: 0 });
      expect(loadSettings(projectDir)).toEqual({ maxSubagentDepth: 0 });
      writeProject({ maxSubagentDepth: -1 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ maxSubagentDepth: 1.5 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ maxSubagentDepth: 17 });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("accepts `none` and `false` as the disabled fallback, nothing else", () => {
      // Only the boolean needs an alias: it would otherwise be dropped, leaving
      // the PERMISSIVE default while the author believed strict was on. Every
      // string stays an agent name, so a mistaken "off" fails loudly at dispatch
      // instead of meaning one thing here and another in the resolver.
      for (const spelling of ["none", "NONE", " none ", false]) {
        writeProject({ fallbackSubagent: spelling });
        expect(loadSettings(projectDir).fallbackSubagent?.toLowerCase()).toBe("none");
      }
      writeProject({ fallbackSubagent: "off" });
      expect(loadSettings(projectDir)).toEqual({ fallbackSubagent: "off" });
    });

    it("drops values that aren't a string or `false`, without coercing them", () => {
      // String(["none"]) is "none" — coercing would silently enable strict mode.
      for (const junk of [["none"], null, 42, true, {}]) {
        writeProject({ fallbackSubagent: junk });
        expect(loadSettings(projectDir)).toEqual({});
      }
    });

    it("keeps a named fallback agent and drops non-strings", () => {
      writeProject({ fallbackSubagent: "  my-router  " });
      expect(loadSettings(projectDir)).toEqual({ fallbackSubagent: "my-router" });
      writeProject({ fallbackSubagent: 42 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ fallbackSubagent: "   " });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("drops invalid defaultJoinMode values", () => {
      writeProject({ defaultJoinMode: "invalid" });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ defaultJoinMode: 42 });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ defaultJoinMode: "" });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("accepts all three valid join modes", () => {
      for (const mode of ["async", "group", "smart"] as const) {
        writeProject({ defaultJoinMode: mode });
        expect(loadSettings(projectDir)).toEqual({ defaultJoinMode: mode });
      }
    });

    it("accepts valid isolation backends and drops invalid values", () => {
      for (const backend of ["auto", "jj", "git"] as const) {
        writeProject({ isolationBackend: backend });
        expect(loadSettings(projectDir)).toEqual({ isolationBackend: backend });
      }
      writeProject({ isolationBackend: "svn" });
      expect(loadSettings(projectDir)).toEqual({});
      writeProject({ isolationBackend: false });
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("accepts scopeModels boolean (true and false)", () => {
      writeProject({ scopeModels: true });
      expect(loadSettings(projectDir)).toEqual({ scopeModels: true });
      writeProject({ scopeModels: false });
      expect(loadSettings(projectDir)).toEqual({ scopeModels: false });
    });

    it("accepts strictAgentFiles boolean (true and false)", () => {
      writeProject({ strictAgentFiles: true });
      expect(loadSettings(projectDir)).toEqual({ strictAgentFiles: true });
      writeProject({ strictAgentFiles: false });
      expect(loadSettings(projectDir)).toEqual({ strictAgentFiles: false });
    });

    it("drops non-boolean strictAgentFiles", () => {
      writeProject({ strictAgentFiles: "yes" });
      expect(loadSettings(projectDir).strictAgentFiles).toBeUndefined();
      writeProject({ strictAgentFiles: 1 });
      expect(loadSettings(projectDir).strictAgentFiles).toBeUndefined();
    });

    it("drops non-boolean scopeModels", () => {
      writeProject({ scopeModels: "yes" });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
      writeProject({ scopeModels: 1 });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
      writeProject({ scopeModels: null });
      expect(loadSettings(projectDir).scopeModels).toBeUndefined();
    });

    it("accepts disableDefaultAgents boolean (true and false)", () => {
      writeProject({ disableDefaultAgents: true });
      expect(loadSettings(projectDir)).toEqual({ disableDefaultAgents: true });
      writeProject({ disableDefaultAgents: false });
      expect(loadSettings(projectDir)).toEqual({ disableDefaultAgents: false });
    });

    it("drops non-boolean disableDefaultAgents", () => {
      writeProject({ disableDefaultAgents: "yes" });
      expect(loadSettings(projectDir).disableDefaultAgents).toBeUndefined();
      writeProject({ disableDefaultAgents: 1 });
      expect(loadSettings(projectDir).disableDefaultAgents).toBeUndefined();
      writeProject({ disableDefaultAgents: null });
      expect(loadSettings(projectDir).disableDefaultAgents).toBeUndefined();
    });

    it("accepts all valid toolDescriptionMode values", () => {
      for (const mode of ["full", "compact", "custom"] as const) {
        writeProject({ toolDescriptionMode: mode });
        expect(loadSettings(projectDir)).toEqual({ toolDescriptionMode: mode });
      }
    });

    it("drops invalid toolDescriptionMode", () => {
      writeProject({ toolDescriptionMode: "tiny" });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
      writeProject({ toolDescriptionMode: true });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
      writeProject({ toolDescriptionMode: null });
      expect(loadSettings(projectDir).toolDescriptionMode).toBeUndefined();
    });

    it("returns {} when the JSON root is not an object (array, string, null)", () => {
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), '["not", "an", "object"]');
      expect(loadSettings(projectDir)).toEqual({});
      writeFileSync(projectFile(), '"just a string"');
      expect(loadSettings(projectDir)).toEqual({});
      writeFileSync(projectFile(), "null");
      expect(loadSettings(projectDir)).toEqual({});
    });

    it("keeps valid fields while dropping invalid siblings", () => {
      writeProject({
        maxConcurrent: 4, // ok
        defaultMaxTurns: -5, // dropped
        graceTurns: 3, // ok
        defaultJoinMode: "nope", // dropped
      });
      expect(loadSettings(projectDir)).toEqual({ maxConcurrent: 4, graceTurns: 3 });
    });

    it("accepts values at the ceiling (maxConcurrent=1024, defaultMaxTurns=10000, graceTurns=1000)", () => {
      writeProject({ maxConcurrent: 1024, defaultMaxTurns: 10_000, graceTurns: 1_000 });
      expect(loadSettings(projectDir)).toEqual({
        maxConcurrent: 1024,
        defaultMaxTurns: 10_000,
        graceTurns: 1_000,
      });
    });

    it("drops values above the ceiling", () => {
      writeProject({ maxConcurrent: 1025 });
      expect(loadSettings(projectDir).maxConcurrent).toBeUndefined();
      writeProject({ defaultMaxTurns: 10_001 });
      expect(loadSettings(projectDir).defaultMaxTurns).toBeUndefined();
      writeProject({ graceTurns: 1_001 });
      expect(loadSettings(projectDir).graceTurns).toBeUndefined();
    });

    it("drops absurdly large values (e.g. 1e6)", () => {
      writeProject({ maxConcurrent: 1_000_000, defaultMaxTurns: 1_000_000, graceTurns: 1_000_000 });
      expect(loadSettings(projectDir)).toEqual({});
    });
  });

  describe("save result + corrupt-file warning", () => {
    it("saveSettings returns true on success", () => {
      expect(saveSettings({ maxConcurrent: 2 }, projectDir)).toBe(true);
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual({ maxConcurrent: 2 });
    });

    it("saveSettings returns false when the target dir cannot be created", () => {
      // Place a regular file where the parent of the settings file would go —
      // mkdirSync + writeFileSync both fail with ENOTDIR / EEXIST.
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      try {
        expect(saveSettings({ maxConcurrent: 1 }, filePosingAsCwd)).toBe(false);
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });

    it("warns to console.warn when an existing file is malformed", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(projectFile(), "not valid json {{{");
      try {
        expect(loadSettings(projectDir)).toEqual({});
        expect(spy).toHaveBeenCalledTimes(1);
        expect(String(spy.mock.calls[0][0])).toMatch(/Ignoring malformed settings/);
      } finally {
        spy.mockRestore();
      }
    });

    it("does NOT warn when a file is simply missing", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(loadSettings(projectDir)).toEqual({});
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("applySettings", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setIsolationBackend: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setSchedulingEnabled: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
      setRememberAgents: vi.fn(),
        setWidgetMode: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setFallbackSubagent: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
      };
    });

    it("applies reportUsage and showCost", () => {
      applySettings({ reportUsage: true, showCost: true }, appliers);
      expect(appliers.setReportUsage).toHaveBeenCalledWith(true);
      expect(appliers.setShowCost).toHaveBeenCalledWith(true);

      applySettings({ reportUsage: false, showCost: false }, appliers);
      expect(appliers.setReportUsage).toHaveBeenCalledWith(false);
      expect(appliers.setShowCost).toHaveBeenCalledWith(false);
    });

    it("is a no-op on an empty settings object", () => {
      applySettings({}, appliers);
      expect(appliers.setReportUsage).not.toHaveBeenCalled();
      expect(appliers.setShowCost).not.toHaveBeenCalled();
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setGraceTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setIsolationBackend).not.toHaveBeenCalled();
      expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
      expect(appliers.setDisableDefaultAgents).not.toHaveBeenCalled();
      expect(appliers.setToolDescriptionMode).not.toHaveBeenCalled();
    });

    it("applies fallbackSubagent through to the registry", () => {
      // Without this, deleting the applySettings line for this field leaves the
      // whole suite green while `subagents.json` silently stops working.
      applySettings({ fallbackSubagent: "none" }, appliers);
      expect(appliers.setFallbackSubagent).toHaveBeenCalledWith("none");
    });

    it("applies only the fields that are present", () => {
      applySettings({ maxConcurrent: 4, graceTurns: 3, maxSubagentDepth: 1 }, appliers);
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(4);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(3);
      expect(appliers.setMaxSubagentDepth).toHaveBeenCalledWith(1);
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
      expect(appliers.setIsolationBackend).not.toHaveBeenCalled();
      expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
      expect(appliers.setScopeModels).not.toHaveBeenCalled();
    });

    it("applies all fields when all are present", () => {
      applySettings(
        {
          maxConcurrent: 8,
          defaultMaxTurns: 50,
          graceTurns: 7,
          defaultJoinMode: "group",
          isolationBackend: "jj",
          schedulingEnabled: false,
          scopeModels: true,
          disableDefaultAgents: true,
          toolDescriptionMode: "compact",
          fleetView: false,
          widgetMode: "off",
        },
        appliers,
      );
      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(8);
      expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(50);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
      expect(appliers.setDefaultJoinMode).toHaveBeenCalledWith("group");
      expect(appliers.setIsolationBackend).toHaveBeenCalledWith("jj");
      expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(false);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(true);
      expect(appliers.setStrictAgentFiles).not.toHaveBeenCalled();  // absent from this snapshot
      expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(true);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("compact");
      expect(appliers.setFleetView).toHaveBeenCalledWith(false);
      expect(appliers.setWidgetMode).toHaveBeenCalledWith("off");
    });

    it("applies strictAgentFiles; skips it when absent", () => {
      applySettings({ strictAgentFiles: true }, appliers);
      expect(appliers.setStrictAgentFiles).toHaveBeenCalledWith(true);
      applySettings({}, appliers);
      expect(appliers.setStrictAgentFiles).toHaveBeenCalledTimes(1);
    });

    it("applies widgetMode; skips it when absent", () => {
      applySettings({ widgetMode: "off" }, appliers);
      expect(appliers.setWidgetMode).toHaveBeenCalledWith("off");
      applySettings({}, appliers);
      expect(appliers.setWidgetMode).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies fleetView (true and false); skips it when absent", () => {
      applySettings({ fleetView: true }, appliers);
      expect(appliers.setFleetView).toHaveBeenCalledWith(true);
      applySettings({}, appliers);
      expect(appliers.setFleetView).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies agentMentions; skips it when absent", () => {
      applySettings({ agentMentions: "direct" }, appliers);
      expect(appliers.setAgentMentions).toHaveBeenCalledWith("direct");
      applySettings({}, appliers);
      expect(appliers.setAgentMentions).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies rememberAgents; skips it when absent", () => {
      applySettings({ rememberAgents: false }, appliers);
      expect(appliers.setRememberAgents).toHaveBeenCalledWith(false);
      applySettings({}, appliers);
      expect(appliers.setRememberAgents).toHaveBeenCalledTimes(1); // absence is "use default"
    });

    it("applies scopeModels: false", () => {
      applySettings({ scopeModels: false }, appliers);
      expect(appliers.setScopeModels).toHaveBeenCalledWith(false);
    });

    it("applies disableDefaultAgents: false", () => {
      applySettings({ disableDefaultAgents: false }, appliers);
      expect(appliers.setDisableDefaultAgents).toHaveBeenCalledWith(false);
    });

    it("applies toolDescriptionMode", () => {
      applySettings({ toolDescriptionMode: "full" }, appliers);
      expect(appliers.setToolDescriptionMode).toHaveBeenCalledWith("full");
    });

    it("applies outputTranscript (both true and false)", () => {
      applySettings({ outputTranscript: false }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(false);
      applySettings({ outputTranscript: true }, appliers);
      expect(appliers.setOutputTranscript).toHaveBeenCalledWith(true);
    });

    it("applies worktreeIsolation (both true and false)", () => {
      applySettings({ worktreeIsolation: false }, appliers);
      expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(false);
      applySettings({ worktreeIsolation: true }, appliers);
      expect(appliers.setWorktreeIsolation).toHaveBeenCalledWith(true);
    });

    it("applies defaultMaxTurns: 0 as the explicit unlimited marker", () => {
      applySettings({ defaultMaxTurns: 0 }, appliers);
      expect(appliers.setDefaultMaxTurns).toHaveBeenCalledWith(0);
    });

    it("calls setBackgroundByDefault with either boolean", () => {
      applySettings({ backgroundByDefault: false }, appliers);
      expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(false);
      applySettings({ backgroundByDefault: true }, appliers);
      expect(appliers.setBackgroundByDefault).toHaveBeenCalledWith(true);
    });

    // Absence must leave the in-memory default (background) alone — calling
    // the applier with `undefined` would read as foreground at the spawn site.
    it("does not call setBackgroundByDefault when the field is absent", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setBackgroundByDefault).not.toHaveBeenCalled();
    });

    // Wiring tests for the master switch — ensures the schedulingEnabled
    // field flows from the parsed settings into the applier callback that
    // sets the in-memory flag in index.ts.
    it("calls setSchedulingEnabled(true) when schedulingEnabled is true", () => {
      applySettings({ schedulingEnabled: true }, appliers);
      expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(true);
    });

    it("calls setSchedulingEnabled(false) when schedulingEnabled is false", () => {
      applySettings({ schedulingEnabled: false }, appliers);
      expect(appliers.setSchedulingEnabled).toHaveBeenCalledWith(false);
    });

    // Absence preserves the in-memory default — the applier must NOT be
    // called, otherwise loading a settings file without the field would
    // overwrite the runtime default with `undefined`.
    it("does not call setSchedulingEnabled when the field is absent", () => {
      applySettings({ maxConcurrent: 4 }, appliers);
      expect(appliers.setSchedulingEnabled).not.toHaveBeenCalled();
    });
  });

  describe("persistToastFor", () => {
    it("returns info-level toast with the plain message on success", () => {
      expect(persistToastFor("Max concurrency set to 7", true)).toEqual({
        message: "Max concurrency set to 7",
        level: "info",
      });
    });

    it("returns warning-level toast with session-only suffix on failure", () => {
      expect(persistToastFor("Max concurrency set to 7", false)).toEqual({
        message: "Max concurrency set to 7 (session only; failed to persist)",
        level: "warning",
      });
    });
  });

  describe("applyAndEmitLoaded", () => {
    let appliers: SettingsAppliers;

    beforeEach(() => {
      appliers = {
        setMaxConcurrent: vi.fn(),
        setDefaultMaxTurns: vi.fn(),
        setGraceTurns: vi.fn(),
        setDefaultJoinMode: vi.fn(),
        setIsolationBackend: vi.fn(),
        setBackgroundByDefault: vi.fn(),
        setSchedulingEnabled: vi.fn(),
        setScopeModels: vi.fn(),
        setStrictAgentFiles: vi.fn(),
        setDisableDefaultAgents: vi.fn(),
        setToolDescriptionMode: vi.fn(),
        setFleetView: vi.fn(),
        setAgentMentions: vi.fn(),
      setRememberAgents: vi.fn(),
        setWidgetMode: vi.fn(),
        setOutputTranscript: vi.fn(),
        setWorktreeIsolation: vi.fn(),
        setMaxSubagentDepth: vi.fn(),
        setFallbackSubagent: vi.fn(),
        setReportUsage: vi.fn(),
        setShowCost: vi.fn(),
      };
    });

    it("loads, applies, and emits subagents:settings_loaded with merged settings", () => {
      writeGlobal({ maxConcurrent: 16 });
      writeProject({ graceTurns: 7 });
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit, projectDir);

      expect(appliers.setMaxConcurrent).toHaveBeenCalledWith(16);
      expect(appliers.setGraceTurns).toHaveBeenCalledWith(7);
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", {
        settings: { maxConcurrent: 16, graceTurns: 7 },
      });
      expect(result).toEqual({ maxConcurrent: 16, graceTurns: 7 });
    });

    it("still emits the event when both files are missing (payload carries {})", () => {
      const emit = vi.fn();

      const result = applyAndEmitLoaded(appliers, emit, projectDir);

      expect(emit).toHaveBeenCalledWith("subagents:settings_loaded", { settings: {} });
      expect(result).toEqual({});
      // No setters fired — defaults preserved
      expect(appliers.setMaxConcurrent).not.toHaveBeenCalled();
      expect(appliers.setDefaultMaxTurns).not.toHaveBeenCalled();
      expect(appliers.setGraceTurns).not.toHaveBeenCalled();
      expect(appliers.setDefaultJoinMode).not.toHaveBeenCalled();
    });
  });

  describe("saveAndEmitChanged", () => {
    it("persists, emits with persisted=true, and returns info toast on success", () => {
      const emit = vi.fn();
      const snapshot = { maxConcurrent: 5, graceTurns: 2 };

      const toast = saveAndEmitChanged(snapshot, "Max concurrency set to 5", emit, projectDir);

      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
        settings: snapshot,
        persisted: true,
      });
      expect(toast).toEqual({ message: "Max concurrency set to 5", level: "info" });
      // File actually written
      expect(JSON.parse(readFileSync(projectFile(), "utf-8"))).toEqual(snapshot);
    });

    it("emits with persisted=false and returns warning toast on save failure", () => {
      const filePosingAsCwd = join(tmpdir(), `pi-settings-notdir-${Date.now()}`);
      writeFileSync(filePosingAsCwd, "");
      const emit = vi.fn();
      try {
        const toast = saveAndEmitChanged(
          { maxConcurrent: 5 },
          "Max concurrency set to 5",
          emit,
          filePosingAsCwd,
        );
        expect(emit).toHaveBeenCalledWith("subagents:settings_changed", {
          settings: { maxConcurrent: 5 },
          persisted: false,
        });
        expect(toast).toEqual({
          message: "Max concurrency set to 5 (session only; failed to persist)",
          level: "warning",
        });
      } finally {
        rmSync(filePosingAsCwd, { force: true });
      }
    });
  });
});
