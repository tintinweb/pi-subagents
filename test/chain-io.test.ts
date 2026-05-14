import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildReadsBlock,
  createChainDir,
  injectOutputInstruction,
  isAgentReadOnly,
  persistStepOutput,
  resolveOutputPath,
  resolveStepOutput,
  snapshotOutputFile,
  substituteChainPlaceholders,
  validateChainFileOnlyHandoff,
  validateStepIO,
} from "../src/chain-io.js";

// ---------------------------------------------------------------------------
// substituteChainPlaceholders
// ---------------------------------------------------------------------------

describe("substituteChainPlaceholders", () => {
  it("replaces {previous} with the prior step output", () => {
    expect(substituteChainPlaceholders("Use: {previous}", "hello", "/tmp/chain")).toBe(
      "Use: hello"
    );
  });

  it("replaces {chain_dir} with the chain directory path", () => {
    expect(
      substituteChainPlaceholders("Write to {chain_dir}/out.txt", "", "/tmp/chain-abc")
    ).toBe("Write to /tmp/chain-abc/out.txt");
  });

  it("replaces both {previous} and {chain_dir} in one pass", () => {
    const result = substituteChainPlaceholders(
      "prev={previous} dir={chain_dir}",
      "PREV",
      "/my/dir"
    );
    expect(result).toBe("prev=PREV dir=/my/dir");
  });

  it("replaces multiple occurrences", () => {
    expect(
      substituteChainPlaceholders("{previous} and again {previous}", "X", "/d")
    ).toBe("X and again X");
  });

  it("returns the prompt unchanged when no placeholders present", () => {
    expect(substituteChainPlaceholders("no placeholders", "prev", "/dir")).toBe(
      "no placeholders"
    );
  });
});

// ---------------------------------------------------------------------------
// resolveOutputPath
// ---------------------------------------------------------------------------

describe("resolveOutputPath", () => {
  it("returns undefined for undefined output", () => {
    expect(resolveOutputPath(undefined, "/cwd")).toBeUndefined();
  });

  it("returns undefined for false", () => {
    expect(resolveOutputPath(false, "/cwd")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveOutputPath("", "/cwd")).toBeUndefined();
  });

  it("returns an absolute path unchanged", () => {
    expect(resolveOutputPath("/abs/path/out.txt", "/cwd")).toBe("/abs/path/out.txt");
  });

  it("resolves a relative path against cwd", () => {
    expect(resolveOutputPath("out.txt", "/home/user/project")).toBe(
      "/home/user/project/out.txt"
    );
  });

  it("resolves a nested relative path", () => {
    expect(resolveOutputPath("results/report.md", "/home/user")).toBe(
      "/home/user/results/report.md"
    );
  });
});

// ---------------------------------------------------------------------------
// injectOutputInstruction
// ---------------------------------------------------------------------------

describe("injectOutputInstruction", () => {
  it("returns the prompt unchanged when no outputPath is provided", () => {
    expect(injectOutputInstruction("Do the thing.", undefined)).toBe("Do the thing.");
  });

  it("appends an output instruction when outputPath is provided", () => {
    const result = injectOutputInstruction("Do the thing.", "/tmp/out.txt");
    expect(result).toContain("Do the thing.");
    expect(result).toContain("/tmp/out.txt");
    expect(result).toContain("Output");
  });

  it("places the instruction after a separator", () => {
    const result = injectOutputInstruction("Task.", "/tmp/out.txt");
    expect(result).toMatch(/Task\.\n\n---\n/);
  });
});

// ---------------------------------------------------------------------------
// validateStepIO
// ---------------------------------------------------------------------------

describe("validateStepIO", () => {
  it("returns undefined for valid inline config", () => {
    expect(validateStepIO(0, { output: "out.txt", outputMode: "inline" })).toBeUndefined();
  });

  it("returns undefined when no output or outputMode is specified", () => {
    expect(validateStepIO(0, {})).toBeUndefined();
  });

  it("returns an error when outputMode is file-only but output is missing", () => {
    const error = validateStepIO(2, { outputMode: "file-only" });
    expect(error).toBeTruthy();
    expect(error).toContain("step 3");
    expect(error).toContain("file-only");
  });

  it("returns undefined when outputMode is file-only and output is provided", () => {
    expect(
      validateStepIO(0, { output: "out.txt", outputMode: "file-only" })
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// persistStepOutput
// ---------------------------------------------------------------------------

describe("persistStepOutput", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `chain-io-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  it("writes content to a file and returns the saved path", () => {
    const outputPath = join(testDir, "out.txt");
    const result = persistStepOutput(outputPath, "hello world");
    expect(result.savedPath).toBe(outputPath);
    expect(result.saveError).toBeUndefined();
    expect(readFileSync(outputPath, "utf-8")).toBe("hello world");
  });

  it("creates parent directories if they don't exist", () => {
    const outputPath = join(testDir, "nested/deep/out.txt");
    const result = persistStepOutput(outputPath, "content");
    expect(result.savedPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
  });

  it("returns a saveError when the path is unwritable", () => {
    // Use an impossible path (null byte in filename)
    const outputPath = "/dev/null/impossible\0/path";
    const result = persistStepOutput(outputPath, "content");
    expect(result.savedPath).toBe(outputPath);
    expect(result.saveError).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// snapshotOutputFile
// ---------------------------------------------------------------------------

describe("snapshotOutputFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `chain-io-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  it("returns undefined when outputPath is undefined", () => {
    expect(snapshotOutputFile(undefined)).toBeUndefined();
  });

  it("returns { exists: false } for a non-existent file", () => {
    const result = snapshotOutputFile(join(testDir, "nonexistent.txt"));
    expect(result).toEqual({ exists: false });
  });

  it("returns { exists: true, mtimeMs, size } for an existing file", () => {
    const filePath = join(testDir, "existing.txt");
    writeFileSync(filePath, "some content");
    const result = snapshotOutputFile(filePath);
    expect(result?.exists).toBe(true);
    expect(typeof result?.mtimeMs).toBe("number");
    expect(typeof result?.size).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// resolveStepOutput
// ---------------------------------------------------------------------------

describe("resolveStepOutput", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `chain-io-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  it("returns fallback output when no outputPath is provided", () => {
    const result = resolveStepOutput({
      outputPath: undefined,
      fallbackOutput: "fallback",
      snapshot: undefined,
    });
    expect(result.output).toBe("fallback");
    expect(result.savedPath).toBeUndefined();
  });

  it("reads file content when the agent wrote to the output file", () => {
    const outputPath = join(testDir, "out.txt");
    // Snapshot before writing (file does not exist)
    const snapshot = snapshotOutputFile(outputPath);

    // Simulate the agent writing to the file
    writeFileSync(outputPath, "agent wrote this");

    const result = resolveStepOutput({
      outputPath,
      fallbackOutput: "in-memory",
      snapshot,
    });
    expect(result.output).toBe("agent wrote this");
    expect(result.savedPath).toBe(outputPath);
  });

  it("persists fallback output when agent did not write the file", () => {
    const outputPath = join(testDir, "out.txt");
    // Pre-create the file with some content
    writeFileSync(outputPath, "old content");
    const snapshot = snapshotOutputFile(outputPath);

    // Agent didn't write — mtime and size are unchanged
    const result = resolveStepOutput({
      outputPath,
      fallbackOutput: "in-memory output",
      snapshot,
    });
    // Should have saved the in-memory output to the file
    expect(result.output).toBe("in-memory output");
    expect(result.savedPath).toBe(outputPath);
    // And note that the agent didn't write
    expect(result.saveError).toBeTruthy();
  });

  it("returns file content when snapshot shows file did not exist before", () => {
    const outputPath = join(testDir, "new.txt");
    const snapshot = snapshotOutputFile(outputPath); // { exists: false }

    writeFileSync(outputPath, "fresh output");

    const result = resolveStepOutput({
      outputPath,
      fallbackOutput: "fallback",
      snapshot,
    });
    expect(result.output).toBe("fresh output");
    expect(result.savedPath).toBe(outputPath);
  });
});

// ---------------------------------------------------------------------------
// buildReadsBlock
// ---------------------------------------------------------------------------

describe("buildReadsBlock", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `chain-io-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  it("returns an empty string for undefined reads", () => {
    expect(buildReadsBlock(undefined, "/cwd")).toBe("");
  });

  it("returns an empty string for false", () => {
    expect(buildReadsBlock(false, "/cwd")).toBe("");
  });

  it("returns an empty string for an empty array", () => {
    expect(buildReadsBlock([], "/cwd")).toBe("");
  });

  it("wraps file content in XML tags", () => {
    const filePath = join(testDir, "input.txt");
    writeFileSync(filePath, "file content here");
    const result = buildReadsBlock([filePath], testDir);
    expect(result).toContain("<context>");
    expect(result).toContain("<file path=");
    expect(result).toContain("file content here");
    expect(result).toContain("</file>");
    expect(result).toContain("</context>");
  });

  it("includes an error attribute for missing files", () => {
    const missingPath = join(testDir, "does-not-exist.txt");
    const result = buildReadsBlock([missingPath], testDir);
    expect(result).toContain('error="Could not read:');
  });

  it("resolves relative paths against cwd", () => {
    writeFileSync(join(testDir, "rel.txt"), "relative content");
    const result = buildReadsBlock(["rel.txt"], testDir);
    expect(result).toContain("relative content");
  });

  it("handles multiple files", () => {
    writeFileSync(join(testDir, "a.txt"), "AAA");
    writeFileSync(join(testDir, "b.txt"), "BBB");
    const result = buildReadsBlock(
      [join(testDir, "a.txt"), join(testDir, "b.txt")],
      testDir
    );
    expect(result).toContain("AAA");
    expect(result).toContain("BBB");
  });
});

// ---------------------------------------------------------------------------
// isAgentReadOnly
// ---------------------------------------------------------------------------

describe("isAgentReadOnly", () => {
  it("returns false when builtinToolNames is undefined (no explicit list)", () => {
    expect(isAgentReadOnly(undefined)).toBe(false);
  });

  it("returns false when the list includes 'edit'", () => {
    expect(isAgentReadOnly(["read", "bash", "edit", "grep", "find", "ls"])).toBe(false);
  });

  it("returns false when the list includes 'write'", () => {
    expect(isAgentReadOnly(["read", "bash", "write"])).toBe(false);
  });

  it("returns false when the list includes both 'edit' and 'write'", () => {
    expect(isAgentReadOnly(["read", "bash", "edit", "write", "grep", "find", "ls"])).toBe(false);
  });

  it("returns true when the list contains neither 'edit' nor 'write'", () => {
    expect(isAgentReadOnly(["read", "bash", "grep", "find", "ls"])).toBe(true);
  });

  it("is case-insensitive (Read, BASH, GREP do not count as edit/write)", () => {
    expect(isAgentReadOnly(["Read", "Bash", "Grep", "Find", "Ls"])).toBe(true);
  });

  it("returns true when the list is empty (no edit or write present)", () => {
    // An empty explicit tool list has neither 'edit' nor 'write', so it is
    // treated as read-only — the agent cannot write files.
    expect(isAgentReadOnly([])).toBe(true);
  });

  // disallowedTools

  it("returns true when edit and write are present but both are denylisted", () => {
    expect(
      isAgentReadOnly(["read", "bash", "edit", "write"], ["edit", "write"])
    ).toBe(true);
  });

  it("returns false when only edit is denylisted but write is still available", () => {
    expect(
      isAgentReadOnly(["read", "bash", "edit", "write"], ["edit"])
    ).toBe(false);
  });

  it("returns false when builtinToolNames is undefined and only edit is denied (write still default-available)", () => {
    expect(isAgentReadOnly(undefined, ["edit"])).toBe(false);
  });

  it("returns true when builtinToolNames is undefined but both edit AND write are denied", () => {
    expect(isAgentReadOnly(undefined, ["edit", "write"])).toBe(true);
  });

  it("is case-insensitive for disallowedTools (Edit/Write match)", () => {
    expect(
      isAgentReadOnly(["read", "bash", "edit", "write"], ["Edit", "Write"])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateChainFileOnlyHandoff
// ---------------------------------------------------------------------------

describe("validateChainFileOnlyHandoff", () => {
  it("returns no warnings for a chain with no file-only steps", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker" },
      { prompt: "step 2", subagent_type: "worker" },
    ];
    expect(validateChainFileOnlyHandoff(chain)).toHaveLength(0);
  });

  it("returns no warnings when file-only step is followed by a matching reads entry", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker", output: "{chain_dir}/step1.md", output_mode: "file-only" },
      { prompt: "step 2", subagent_type: "worker", reads: ["{chain_dir}/step1.md"] },
    ];
    expect(validateChainFileOnlyHandoff(chain)).toHaveLength(0);
  });

  it("warns when file-only step is not followed by any reads at all", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker", output: "{chain_dir}/review.md", output_mode: "file-only" },
      { prompt: "step 2", subagent_type: "worker" },
    ];
    const warnings = validateChainFileOnlyHandoff(chain);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Step 1");
    expect(warnings[0]).toContain("step 2");
    expect(warnings[0]).toContain("file-only");
    expect(warnings[0]).toContain("{chain_dir}/review.md");
  });

  it("warns when file-only step is followed by reads that don't match the output path", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker", output: "{chain_dir}/step1.md", output_mode: "file-only" },
      { prompt: "step 2", subagent_type: "worker", reads: ["{chain_dir}/other.md"] },
    ];
    const warnings = validateChainFileOnlyHandoff(chain);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("{chain_dir}/step1.md");
  });

  it("returns no warnings when the last step uses file-only (no following step to check)", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker" },
      { prompt: "step 2", subagent_type: "worker", output: "{chain_dir}/last.md", output_mode: "file-only" },
    ];
    expect(validateChainFileOnlyHandoff(chain)).toHaveLength(0);
  });

  it("returns multiple warnings for multiple mismatched file-only steps", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker", output: "{chain_dir}/a.md", output_mode: "file-only" },
      { prompt: "step 2", subagent_type: "worker", output: "{chain_dir}/b.md", output_mode: "file-only" },
      { prompt: "step 3", subagent_type: "worker" },
    ];
    const warnings = validateChainFileOnlyHandoff(chain);
    expect(warnings).toHaveLength(2);
  });

  it("returns no warnings when inline mode step is followed by a step without reads", () => {
    const chain = [
      { prompt: "step 1", subagent_type: "worker", output: "{chain_dir}/a.md", output_mode: "inline" },
      { prompt: "step 2", subagent_type: "worker" },
    ];
    expect(validateChainFileOnlyHandoff(chain)).toHaveLength(0);
  });

  it("returns no warnings when file-only output is consumed via reads: ['{previous}']", () => {
    // {previous} is the magic placeholder that the runtime substitutes with the
    // prior step's output path when output_mode is file-only. It is a valid way
    // to thread the output through without hardcoding the chain_dir path.
    const chain = [
      { prompt: "step 1", subagent_type: "worker", output: "{chain_dir}/review.md", output_mode: "file-only" },
      { prompt: "step 2", subagent_type: "worker", reads: ["{previous}"] },
    ];
    expect(validateChainFileOnlyHandoff(chain)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createChainDir
// ---------------------------------------------------------------------------

describe("createChainDir", () => {
  it("creates a directory that exists and is non-empty path", () => {
    const dir = createChainDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir.length).toBeGreaterThan(0);
  });

  it("creates a unique directory on each call", () => {
    const dir1 = createChainDir();
    const dir2 = createChainDir();
    expect(dir1).not.toBe(dir2);
  });

  it("places the directory under tmpdir", () => {
    const dir = createChainDir();
    expect(dir.startsWith(tmpdir())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: output path and reads placeholder substitution ordering
// ---------------------------------------------------------------------------

describe("output path: substitute-then-resolve (blocker regression)", () => {
  it("resolves {chain_dir}/step.md under chainDir, not under cwd", () => {
    const chainDir = "/tmp/pi-chain-abc";
    const cwd = "/my/project";
    const rawOutput = "{chain_dir}/step1.md";

    // Correct pattern: substitute first, then resolve
    const substituted = substituteChainPlaceholders(rawOutput, "", chainDir);
    const resolved = resolveOutputPath(substituted, cwd);
    expect(resolved).toBe("/tmp/pi-chain-abc/step1.md");
  });

  it("old resolve-then-substitute pattern produces a wrong path (demonstrates the bug)", () => {
    const chainDir = "/tmp/pi-chain-abc";
    const cwd = "/my/project";
    const rawOutput = "{chain_dir}/step1.md";

    // Wrong pattern (what old code did): resolve raw string under cwd first
    const wrongFirst = resolveOutputPath(rawOutput, cwd); // /my/project/{chain_dir}/step1.md
    const wrongFinal = wrongFirst
      ? substituteChainPlaceholders(wrongFirst, "", chainDir)
      : undefined;
    // Result is /my/project//tmp/pi-chain-abc/step1.md — not the intended path
    expect(wrongFinal).not.toBe("/tmp/pi-chain-abc/step1.md");
  });

  it("absolute output path is preserved after substitution", () => {
    const chainDir = "/tmp/chain-xyz";
    const cwd = "/my/project";
    const rawOutput = "/abs/output/file.md";

    const substituted = substituteChainPlaceholders(rawOutput, "", chainDir);
    const resolved = resolveOutputPath(substituted, cwd);
    expect(resolved).toBe("/abs/output/file.md");
  });
});

describe("reads paths: {chain_dir} and {previous} substitution (blocker regression)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createChainDir();
  });

  it("substitutes {chain_dir} in reads paths before reading the file", () => {
    const outputFile = join(testDir, "step1.md");
    writeFileSync(outputFile, "step 1 output");

    // Simulate the fixed executeChain: substitute first, then pass to buildReadsBlock
    const rawReads = ["{chain_dir}/step1.md"];
    const resolvedReads = rawReads.map((p) =>
      substituteChainPlaceholders(p, "", testDir)
    );
    const block = buildReadsBlock(resolvedReads, "/any/cwd");
    expect(block).toContain("step 1 output");
  });

  it("substitutes {previous} in reads paths before reading the file", () => {
    const outputFile = join(testDir, "prev-output.md");
    writeFileSync(outputFile, "previous step content");

    const rawReads = ["{previous}"];
    const resolvedReads = rawReads.map((p) =>
      substituteChainPlaceholders(p, outputFile, testDir)
    );
    const block = buildReadsBlock(resolvedReads, "/any/cwd");
    expect(block).toContain("previous step content");
  });

  it("unsubstituted {chain_dir} in reads fails to resolve (demonstrates the bug)", () => {
    const outputFile = join(testDir, "step1.md");
    writeFileSync(outputFile, "step 1 output");

    // Old code would pass raw paths without substitution
    const rawReads = ["{chain_dir}/step1.md"];
    const block = buildReadsBlock(rawReads, "/any/cwd"); // can't find {chain_dir} literally
    // Should NOT contain the real file content
    expect(block).not.toContain("step 1 output");
    // Should contain an error attribute because the literal path doesn't exist
    expect(block).toContain('error=');
  });
});

describe("file-only mode: previousOutput is the raw file path (blocker regression)", () => {
  it("raw savedPath can be used as a path placeholder in the next step prompt", () => {
    const savedPath = "/tmp/pi-chain-abc/step1.md";

    // Fixed code sets: previousOutput = savedPath (not a sentence)
    const previousOutput = savedPath;

    // Next step can cleanly substitute it into a prompt
    const nextPrompt = substituteChainPlaceholders(
      "Read the file at {previous} and summarize.",
      previousOutput,
      "/tmp/pi-chain-abc",
    );
    expect(nextPrompt).toBe("Read the file at /tmp/pi-chain-abc/step1.md and summarize.");
  });

  it("raw savedPath can be used in reads via {previous} substitution", () => {
    const testDir = createChainDir();
    const savedPath = join(testDir, "step1.md");
    writeFileSync(savedPath, "file-only content");

    // Fixed code: previousOutput = savedPath
    const previousOutput = savedPath;

    // Next step uses reads: ["{previous}"] — after substitution it becomes the real path
    const resolvedReads = ["{previous}"].map((p) =>
      substituteChainPlaceholders(p, previousOutput, testDir)
    );
    expect(resolvedReads[0]).toBe(savedPath);

    const block = buildReadsBlock(resolvedReads, "/any/cwd");
    expect(block).toContain("file-only content");
  });

  it("old 'Output saved to: <path>' sentence breaks path usage (demonstrates the bug)", () => {
    const savedPath = "/tmp/pi-chain-abc/step1.md";

    // Old code set: previousOutput = `Output saved to: ${savedPath}`
    const badPreviousOutput = `Output saved to: ${savedPath}`;

    // Trying to use it as a path in reads fails
    const resolvedReads = ["{previous}"].map((p) =>
      substituteChainPlaceholders(p, badPreviousOutput, "/tmp/pi-chain-abc")
    );
    // resolvedReads[0] is now a sentence, not a path
    expect(resolvedReads[0]).toContain("Output saved to:");
    expect(resolvedReads[0]).not.toBe(savedPath);
  });
});
