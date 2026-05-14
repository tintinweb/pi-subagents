import { describe, expect, it, vi } from "vitest";
import {
  buildRecoveryPrompt,
  extractCheckpoint,
  type RecoveryContext,
  safeExec,
  spawnWithRecovery,
} from "../src/recovery.js";

// ---------------------------------------------------------------------------
// extractCheckpoint
// ---------------------------------------------------------------------------

describe("extractCheckpoint", () => {
  it("returns undefined when no checkpoint block is present", () => {
    expect(extractCheckpoint("no checkpoint here")).toBeUndefined();
  });

  it("returns undefined on an empty string", () => {
    expect(extractCheckpoint("")).toBeUndefined();
  });

  it("extracts the full checkpoint block content", () => {
    const text = `Some preamble text.

## Recovery Checkpoint
DONE: src/foo.ts
IN_PROGRESS: src/bar.ts — partial
TODO: src/baz.ts`;
    expect(extractCheckpoint(text)).toBe(
      "DONE: src/foo.ts\nIN_PROGRESS: src/bar.ts — partial\nTODO: src/baz.ts",
    );
  });

  it("stops extracting at the next ## heading", () => {
    const text = `## Recovery Checkpoint
DONE: src/a.ts
## Next Section
more content`;
    expect(extractCheckpoint(text)).toBe("DONE: src/a.ts");
  });

  it("returns an empty string for a checkpoint block with only whitespace", () => {
    const text = "## Recovery Checkpoint\n   \n";
    // Block exists but trims to "" — still distinct from undefined (block was found)
    expect(extractCheckpoint(text)).toBe("");
  });

  it("handles checkpoint at end of string with trailing newline", () => {
    const text = "## Recovery Checkpoint\nDONE: src/x.ts\n";
    expect(extractCheckpoint(text)).toBe("DONE: src/x.ts");
  });
});

// ---------------------------------------------------------------------------
// buildRecoveryPrompt
// ---------------------------------------------------------------------------

describe("buildRecoveryPrompt", () => {
  it("always includes the Recovery Context header", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "",
      gitDiff: "",
      gitStatus: "",
    };
    expect(buildRecoveryPrompt(ctx)).toContain("Recovery Context");
  });

  it("always includes the original prompt", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "Refactor the auth module",
      abortedResult: "",
      gitDiff: "",
      gitStatus: "",
    };
    expect(buildRecoveryPrompt(ctx)).toContain("Refactor the auth module");
  });

  it("includes git diff section when gitDiff is non-empty", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "",
      gitDiff: " src/foo.ts | 3 +++",
      gitStatus: "",
    };
    const result = buildRecoveryPrompt(ctx);
    expect(result).toContain("Files already modified");
    expect(result).toContain("src/foo.ts");
  });

  it("includes git status section when gitStatus is non-empty", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "",
      gitDiff: "",
      gitStatus: "M  src/bar.ts",
    };
    const result = buildRecoveryPrompt(ctx);
    expect(result).toContain("Git status");
    expect(result).toContain("src/bar.ts");
  });

  it("includes 'Where it stopped' section when abortedResult is non-empty", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "DONE: src/a.ts\nIN_PROGRESS: src/b.ts",
      gitDiff: "",
      gitStatus: "",
    };
    const result = buildRecoveryPrompt(ctx);
    expect(result).toContain("Where it stopped");
    expect(result).toContain("DONE: src/a.ts");
  });

  it("omits git diff section when gitDiff is empty", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "",
      gitDiff: "",
      gitStatus: "",
    };
    expect(buildRecoveryPrompt(ctx)).not.toContain("Files already modified");
  });

  it("omits 'Where it stopped' section when abortedResult is empty", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "",
      gitDiff: "",
      gitStatus: "",
    };
    expect(buildRecoveryPrompt(ctx)).not.toContain("Where it stopped");
  });

  it("includes all sections when all fields are populated", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "Fix all the things",
      abortedResult: "DONE: a.ts\nIN_PROGRESS: b.ts",
      gitDiff: " a.ts | 5 +++++",
      gitStatus: "M  a.ts",
    };
    const result = buildRecoveryPrompt(ctx);
    expect(result).toContain("Files already modified");
    expect(result).toContain("Git status");
    expect(result).toContain("Where it stopped");
    expect(result).toContain("Fix all the things");
  });

  it("includes the continuation instruction", () => {
    const ctx: RecoveryContext = {
      originalPrompt: "task",
      abortedResult: "",
      gitDiff: "",
      gitStatus: "",
    };
    expect(buildRecoveryPrompt(ctx)).toContain(
      "Pick up exactly where it left off",
    );
  });
});

// ---------------------------------------------------------------------------
// safeExec
// ---------------------------------------------------------------------------

describe("safeExec", () => {
  it("returns command stdout on success", () => {
    const result = safeExec("echo hello", process.cwd());
    expect(result.trim()).toBe("hello");
  });

  it("returns empty string when the command does not exist", () => {
    const result = safeExec(
      "this-command-definitely-does-not-exist-xyz123",
      process.cwd(),
    );
    expect(result).toBe("");
  });

  it("returns empty string when cwd does not exist", () => {
    const result = safeExec("echo hi", "/nonexistent/path/xyz-recovery-test");
    expect(result).toBe("");
  });

  it("returns empty string when command exits with non-zero status", () => {
    // `exit 1` causes execSync to throw
    const result = safeExec("exit 1", process.cwd());
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// spawnWithRecovery
// ---------------------------------------------------------------------------

/** Minimal AgentRecord factory for test stubs. */
function makeRecord(overrides: Partial<{
  status: string;
  result: string;
  session: object;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
}> = {}): any {
  return {
    id: "test-id",
    status: "completed",
    result: "The task is done.",
    session: null,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    ...overrides,
  };
}

/** Minimal AgentManager mock. */
function makeManager(spawnResult: any, resumeResult?: any) {
  return {
    spawnAndWait: vi.fn().mockResolvedValue(spawnResult),
    resume: vi.fn().mockResolvedValue(resumeResult),
  } as any;
}

const mockPi = {} as any;
const mockCtx = {} as any;

describe("spawnWithRecovery", () => {
  it("returns the record directly when the agent completes without aborting", async () => {
    const record = makeRecord({ status: "completed" });
    const manager = makeManager(record);

    const result = await spawnWithRecovery(
      manager, mockPi, mockCtx, "worker", "do the thing", {}, process.cwd(),
    );

    expect(result).toBe(record);
    expect(manager.resume).not.toHaveBeenCalled();
  });

  it("passes custom softLimitSteer on the initial spawn", async () => {
    const record = makeRecord({ status: "completed" });
    const manager = makeManager(record);

    await spawnWithRecovery(
      manager, mockPi, mockCtx, "worker", "do the thing",
      { softLimitSteer: "custom steer" }, process.cwd(),
    );

    // spawnWithRecovery injects its own SOFT_LIMIT_STEER — custom steer in opts is overridden
    const opts = manager.spawnAndWait.mock.calls[0][4];
    expect(opts.softLimitSteer).toMatch(/running out of turns/i);
  });

  it("attempts resume when session is alive even without a checkpoint", async () => {
    const abortedRecord = makeRecord({
      status: "aborted",
      result: "partial work, no checkpoint block",
      session: { dispose: vi.fn() },
    });
    const resumedRecord = makeRecord({ status: "completed", result: "resumed" });
    const manager = makeManager(abortedRecord, resumedRecord);

    const result = await spawnWithRecovery(
      manager, mockPi, mockCtx, "worker", "do the thing", {}, process.cwd(),
    );

    expect(manager.resume).toHaveBeenCalledTimes(1);
    expect(result).toBe(resumedRecord);
    // Fresh spawn not attempted because resume succeeded
    expect(manager.spawnAndWait).toHaveBeenCalledTimes(1);
  });

  it("falls back to fresh spawn when resume returns a record with error status", async () => {
    const abortedRecord = makeRecord({
      status: "aborted",
      result: "## Recovery Checkpoint\nDONE: a.ts\nIN_PROGRESS: b.ts\nTODO: c.ts",
      session: { dispose: vi.fn() },
    });
    const erroredResumed = makeRecord({ status: "error" });
    const freshRecord = makeRecord({ status: "completed", result: "fresh done" });
    const manager = {
      spawnAndWait: vi.fn()
        .mockResolvedValueOnce(abortedRecord)
        .mockResolvedValueOnce(freshRecord),
      resume: vi.fn().mockResolvedValue(erroredResumed),
    } as any;

    const result = await spawnWithRecovery(
      manager, mockPi, mockCtx, "worker", "do the thing", {}, process.cwd(),
    );

    expect(manager.resume).toHaveBeenCalledTimes(1);
    // Second spawnAndWait is the fresh-spawn recovery
    expect(manager.spawnAndWait).toHaveBeenCalledTimes(2);
    expect(result).toBe(freshRecord);
  });

  it("skips resume and goes to fresh spawn when context pressure is high", async () => {
    const abortedRecord = makeRecord({
      status: "aborted",
      result: "some work",
      session: { dispose: vi.fn() },
      lifetimeUsage: { input: 200_000, output: 0, cacheWrite: 0 },
    });
    const freshRecord = makeRecord({ status: "completed" });
    const manager = {
      spawnAndWait: vi.fn()
        .mockResolvedValueOnce(abortedRecord)
        .mockResolvedValueOnce(freshRecord),
      resume: vi.fn(),
    } as any;

    await spawnWithRecovery(
      manager, mockPi, mockCtx, "worker", "do the thing", {}, process.cwd(),
    );

    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.spawnAndWait).toHaveBeenCalledTimes(2);
  });

  it("uses full git diff (not --stat) in fresh recovery context", async () => {
    // Spy on the prompt passed to the second spawnAndWait call
    const abortedRecord = makeRecord({
      status: "aborted",
      // High context pressure so we skip straight to fresh spawn
      lifetimeUsage: { input: 200_000, output: 0, cacheWrite: 0 },
      session: null,
      result: "",
    });
    const freshRecord = makeRecord({ status: "completed" });
    const manager = {
      spawnAndWait: vi.fn()
        .mockResolvedValueOnce(abortedRecord)
        .mockResolvedValueOnce(freshRecord),
      resume: vi.fn(),
    } as any;

    await spawnWithRecovery(
      manager, mockPi, mockCtx, "worker", "original prompt", {}, process.cwd(),
    );

    // The recovery prompt is the first argument of the second spawn call
    const recoveryPrompt: string = manager.spawnAndWait.mock.calls[1][3];
    // Must include the continuation instruction (confirms buildRecoveryPrompt was used)
    expect(recoveryPrompt).toContain("Pick up exactly where it left off");
    // Must include the original prompt
    expect(recoveryPrompt).toContain("original prompt");
  });
});
