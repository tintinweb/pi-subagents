/**
 * chain-io.ts — File-based output/input utilities for agent chain execution.
 *
 * Imitates the file-based output-input chaining pattern from nicobailon/pi-subagents:
 *   - Each chain run gets a unique scratch directory under $TMPDIR.
 *   - Steps can write output to a named file via a chain-scoped `write_output` tool
 *     injected into the agent session (orchestrator fallback saves in-memory output if unused).
 *   - Steps can read input from previously-written files (via `reads`).
 *   - Prompts support {previous} and {chain_dir} placeholder substitution.
 *   - outputMode "inline" (default) includes content in results; "file-only" omits it.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChainOutputMode = "inline" | "file-only";

export interface ChainStepIO {
  /** Optional path to write step output to (relative to cwd or absolute). */
  output?: string;
  /** Whether to include file content inline in the result or only store on disk. */
  outputMode?: ChainOutputMode;
  /** File paths to read at the start of this step and prepend to the prompt. */
  reads?: string[] | false;
}

export interface PersistResult {
  /** Absolute path the output was saved to. */
  savedPath: string;
  /** Error message if the write failed. */
  saveError?: string;
}

// ---------------------------------------------------------------------------
// Chain directory
// ---------------------------------------------------------------------------

/**
 * Create a per-run scratch directory under $TMPDIR.
 * Returns the absolute path. Callers should clean up when the chain is done.
 *
 * Layout: /tmp/pi-subagents-chain-<uid>/<runId>
 */
export function createChainDir(): string {
  const uid = process.getuid?.() ?? 0;
  const root = join(tmpdir(), `pi-subagents-chain-${uid}`);
  const runId = nanoid(12);
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Placeholder substitution
// ---------------------------------------------------------------------------

/**
 * Replace {previous} and {chain_dir} placeholders in a prompt string.
 *
 * @param prompt    Raw prompt from the chain step config
 * @param previous  Output of the preceding step (empty string for step 0)
 * @param chainDir  Absolute path to the per-run chain directory
 */
export function substituteChainPlaceholders(
  prompt: string,
  previous: string,
  chainDir: string,
): string {
  return prompt
    .replace(/\{previous\}/g, previous)
    .replace(/\{chain_dir\}/g, chainDir);
}

// ---------------------------------------------------------------------------
// Output file management
// ---------------------------------------------------------------------------

/**
 * Resolve a step's output path.
 * Relative paths are resolved against `cwd`.
 * Returns undefined when `output` is not a non-empty string.
 */
export function resolveOutputPath(
  output: string | false | undefined,
  cwd: string,
): string | undefined {
  if (typeof output !== "string" || !output) return undefined;
  return isAbsolute(output) ? output : resolve(cwd, output);
}

/**
 * Inject an "Output:" instruction into a prompt so the agent knows where to
 * write its findings. Placed after a separator at the end of the prompt.
 *
 * Only injected when `outputPath` is defined.
 */
export function injectOutputInstruction(
  prompt: string,
  outputPath: string | undefined,
): string {
  if (!outputPath) return prompt;
  return `${prompt}\n\n---\n**Output:** Write your complete findings/result to: ${outputPath}`;
}

/**
 * Write `content` to `outputPath`, creating parent directories as needed.
 * Returns a PersistResult describing success or failure.
 */
export function persistStepOutput(
  outputPath: string,
  content: string,
): PersistResult {
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content, "utf-8");
    return { savedPath: outputPath };
  } catch (err) {
    return {
      savedPath: outputPath,
      saveError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Capture the mtime+size of an output file before a step runs (snapshot),
 * so we can detect whether the agent actually wrote to it.
 */
export function snapshotOutputFile(
  outputPath: string | undefined,
): { exists: boolean; mtimeMs?: number; size?: number } | undefined {
  if (!outputPath) return undefined;
  try {
    const stat = statSync(outputPath);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false };
  }
}

/**
 * After a step completes, resolve the canonical output string.
 *
 * Priority:
 *  1. If `outputPath` is set and the file was written (or updated) by the agent
 *     since the snapshot, read its content.
 *  2. Otherwise fall back to `fallbackOutput` (in-memory agent response).
 *
 * Returns `{ output, savedPath?, saveError? }`.
 */
export function resolveStepOutput(params: {
  outputPath: string | undefined;
  fallbackOutput: string;
  snapshot: ReturnType<typeof snapshotOutputFile>;
}): { output: string; savedPath?: string; saveError?: string } {
  const { outputPath, fallbackOutput, snapshot } = params;

  if (!outputPath) return { output: fallbackOutput };

  // Check whether the agent actually wrote/modified the file
  let fileContent: string | undefined;
  try {
    const stat = statSync(outputPath);
    const wasModified =
      !snapshot?.exists ||
      stat.mtimeMs !== snapshot.mtimeMs ||
      stat.size !== snapshot.size;
    if (wasModified) {
      fileContent = readFileSync(outputPath, "utf-8");
    }
  } catch {
    // File not found or unreadable — fall back to in-memory output
  }

  if (fileContent !== undefined) {
    return { output: fileContent, savedPath: outputPath };
  }

  // Agent didn't write the file — persist the in-memory output and warn
  const persist = persistStepOutput(outputPath, fallbackOutput);
  return {
    output: fallbackOutput,
    savedPath: persist.savedPath,
    saveError: persist.saveError
      ? persist.saveError
      : "Agent did not write to the output file; in-memory output was saved instead.",
  };
}

// ---------------------------------------------------------------------------
// Reads (input files)
// ---------------------------------------------------------------------------

/**
 * Read a list of files and build a prefix block to prepend to the step prompt.
 *
 * Files that cannot be read are skipped with a warning comment embedded in the block.
 * Returns an empty string when `reads` is falsy or empty.
 */
export function buildReadsBlock(
  reads: string[] | false | undefined,
  cwd: string,
): string {
  if (!reads || reads.length === 0) return "";

  const sections: string[] = [];

  for (const rawPath of reads) {
    const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
    try {
      const content = readFileSync(absPath, "utf-8");
      sections.push(`<file path="${absPath}">\n${content}\n</file>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sections.push(`<file path="${absPath}" error="Could not read: ${msg}" />`);
    }
  }

  if (sections.length === 0) return "";

  return `<context>\n${sections.join("\n")}\n</context>\n\n`;
}

// ---------------------------------------------------------------------------
// Chain output tool
// ---------------------------------------------------------------------------

/**
 * Create a `write_output` custom tool scoped to the given `outputPath`.
 *
 * Injecting this tool into a chain step's agent session guarantees that the
 * agent can persist its findings incrementally — even across multi-turn sessions
 * and even for agents that lack general write/edit tools (read-only agents).
 *
 * Security: the tool rejects any attempt to write to a path other than the
 * exact `outputPath` it was created with.
 */
export function createChainOutputTool(outputPath: string): ToolDefinition {
  return defineTool({
    name: "write_output",
    label: "Write Output",
    description:
      `Write your complete findings, analysis, or result to the designated output file: ${outputPath}\n\n` +
      `This is the ONLY supported way to persist your output for this chain step. ` +
      `Subsequent steps in the chain will read this file directly.\n\n` +
      `Guidelines:\n` +
      `- Write complete, self-contained output — do not assume the next step has prior context.\n` +
      `- Call this once with all your findings, or use append: true to build the file incrementally.\n` +
      `- Calling this with append: false overwrites any previous content.`,
    parameters: Type.Object({
      content: Type.String({ description: "The content to write to the output file." }),
      append: Type.Optional(
        Type.Boolean({
          description: "If true, append to existing content instead of overwriting. Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
        if (params.append) {
          appendFileSync(outputPath, params.content, "utf-8");
        } else {
          writeFileSync(outputPath, params.content, "utf-8");
        }
        const bytes = Buffer.byteLength(params.content, "utf-8");
        const mode = params.append ? "appended" : "written";
        return {
          content: [{ type: "text" as const, text: `Output ${mode}: ${bytes} bytes saved to ${outputPath}` }],
          details: undefined as any,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error writing output: ${msg}` }],
          details: undefined as any,
        };
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Read-only agent detection
// ---------------------------------------------------------------------------

/**
 * Return true if the agent is considered read-only based on its explicit tool list.
 *
 * Detection rule:
 *  - If `builtinToolNames` is undefined (no explicit list) → assume writable → false.
 *  - If `builtinToolNames` is set but includes neither "edit" nor "write" → read-only → true.
 *  - Otherwise → writable → false.
 */
export function isAgentReadOnly(
  builtinToolNames: string[] | undefined,
  disallowedTools?: string[],
): boolean {
  const denied = disallowedTools
    ? new Set(disallowedTools.map((t) => t.toLowerCase()))
    : undefined;

  if (!builtinToolNames) {
    // No explicit allowlist ⟹ all tools are available by default.
    // The agent is only read-only if both edit AND write are explicitly denied.
    if (!denied) return false;
    return denied.has("edit") && denied.has("write");
  }

  // Start from the explicit allowlist, then remove denylisted tools.
  const effective = new Set(builtinToolNames.map((t) => t.toLowerCase()));
  if (denied) {
    for (const t of denied) effective.delete(t);
  }
  return !effective.has("edit") && !effective.has("write");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a chain step's IO config.
 * Returns an error string if the config is invalid, undefined otherwise.
 */
export function validateStepIO(
  stepIndex: number,
  io: ChainStepIO,
): string | undefined {
  if (io.outputMode === "file-only" && !io.output) {
    return (
      `Chain step ${stepIndex + 1}: outputMode "file-only" requires an output path. ` +
      `Set the \`output\` field to a file path, or use outputMode "inline".`
    );
  }
  return undefined;
}

/**
 * Validate that every `file-only` step is followed by a step that declares a
 * matching `reads` entry.
 *
 * When `output_mode: "file-only"` is used without a corresponding `reads` on the
 * next step, the next step receives only the raw file path string in `{previous}`
 * rather than the actual file content — a common footgun.
 *
 * Comparison is done on the raw (pre-substitution) path strings so validation
 * can run before `chainDir` is created.
 *
 * Returns an array of human-readable warning strings (empty = no issues found).
 */
export function validateChainFileOnlyHandoff(
  chain: ReadonlyArray<{
    output?: string;
    output_mode?: string;
    reads?: string[];
  }>,
): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const step = chain[i];
    if (step.output_mode !== "file-only" || !step.output) continue;
    const nextStep = chain[i + 1];
    const nextReads = nextStep.reads ?? [];
    if (!nextReads.includes(step.output) && !nextReads.includes("{previous}")) {
      warnings.push(
        `⚠ Step ${i + 1} uses output_mode "file-only" but step ${i + 2} does not declare ` +
        `a matching reads entry for "${step.output}". ` +
        `Step ${i + 2} will receive only the file path in {previous}, not the file content. ` +
        `Add \`reads: ["${step.output}"]\` to step ${i + 2} to pass the content through.`,
      );
    }
  }
  return warnings;
}
