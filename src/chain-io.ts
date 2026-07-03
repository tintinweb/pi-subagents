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

import { appendFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
/** Root scratch directory all chain runs live under: /tmp/pi-subagents-chain-<uid>. */
function chainScratchRoot(): string {
  const uid = process.getuid?.() ?? 0;
  return join(tmpdir(), `pi-subagents-chain-${uid}`);
}

export function createChainDir(): string {
  const root = chainScratchRoot();
  const runId = nanoid(12);
  const dir = join(root, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Validate that a model-supplied `chain_run_id` resolves to exactly one
 * directory level under the chain scratch root (i.e. matches `createChainDir`'s
 * own layout) — never higher up, never nested deeper, no `..` escapes.
 *
 * `chain_run_id` is an LLM-controlled string used directly as a filesystem
 * path; without this check it could be pointed at an arbitrary path to read
 * or (via `remaining`'s subsequent writes) write outside the intended scratch
 * directory.
 */
export function isValidChainRunId(candidate: string): boolean {
  if (!candidate) return false;
  const root = chainScratchRoot();
  const resolved = resolve(candidate);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  // Must be exactly one path segment (the runId), not nested deeper.
  return !rel.includes(sep);
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
// chain-next fan-out proposals (pause_after / chain_run_id)
// ---------------------------------------------------------------------------

export interface ChainNextItem {
  subagent_type: string;
  prompt: string;
  files: string[];
  isolation?: "worktree";
}

export interface ChainNextResult {
  /** Present only when the block parsed and validated cleanly. */
  proposal?: ChainNextItem[];
  /** Non-empty when a block was found but is malformed, or fails validation. */
  errors: string[];
}

const CHAIN_NEXT_BLOCK_RE = /```chain-next\s*\n([\s\S]*?)```/;
const MAX_CHAIN_NEXT_CHUNKS = 6;

/**
 * Look for a fenced ```chain-next``` JSON array in a step's output and parse +
 * validate it. Returns `{ errors: [] }` (no proposal, no error) when no block
 * is present — that's a normal outcome, not a failure.
 *
 * Validation gates:
 *  - must be a non-empty JSON array, at most `MAX_CHAIN_NEXT_CHUNKS` items
 *  - each item needs a non-empty `subagent_type`, `prompt`, and `files` array
 *  - two items may not declare the same file unless both set `isolation: "worktree"`
 *
 * This never dispatches anything — it only produces a proposal for the parent
 * to review and, if it agrees, hand-build into `remaining` on the follow-up call.
 */
export function parseChainNext(output: string): ChainNextResult {
  const match = output.match(CHAIN_NEXT_BLOCK_RE);
  if (!match) return { errors: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return { errors: [`chain-next block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { errors: ["chain-next block must be a non-empty JSON array."] };
  }
  if (parsed.length > MAX_CHAIN_NEXT_CHUNKS) {
    return { errors: [`chain-next proposes ${parsed.length} chunks, exceeding the max of ${MAX_CHAIN_NEXT_CHUNKS}.`] };
  }

  const errors: string[] = [];
  const items: ChainNextItem[] = [];

  parsed.forEach((raw, idx) => {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`chain-next[${idx}]: not an object.`);
      return;
    }
    const item = raw as Record<string, unknown>;
    const subagent_type = typeof item.subagent_type === "string" && item.subagent_type ? item.subagent_type : undefined;
    const prompt = typeof item.prompt === "string" && item.prompt ? item.prompt : undefined;
    const isolation = item.isolation === "worktree" ? "worktree" as const : undefined;

    if (!subagent_type) errors.push(`chain-next[${idx}]: missing "subagent_type".`);
    if (!prompt) errors.push(`chain-next[${idx}]: missing "prompt".`);

    let files: string[] = [];
    if (!Array.isArray(item.files) || item.files.length === 0) {
      errors.push(`chain-next[${idx}]: "files" must be a non-empty array.`);
    } else if (item.files.some((f) => typeof f !== "string" || f.trim().length === 0)) {
      errors.push(`chain-next[${idx}]: "files" must contain only non-empty strings — found a malformed entry.`);
    } else {
      files = item.files as string[];
    }

    items.push({ subagent_type: subagent_type ?? "worker", prompt: prompt ?? "", files, isolation });
  });

  if (errors.length > 0) return { errors };

  // File-overlap check across chunks: only OK when both sides are worktree-isolated.
  const ownerOf = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    for (const file of items[i].files) {
      const owner = ownerOf.get(file);
      if (owner === undefined) {
        ownerOf.set(file, i);
        continue;
      }
      const bothIsolated = items[owner].isolation === "worktree" && items[i].isolation === "worktree";
      if (!bothIsolated) {
        errors.push(
          `chain-next[${owner}] and chain-next[${i}] both touch "${file}" without isolation: "worktree" on both — would clobber.`,
        );
      }
    }
  }

  if (errors.length > 0) return { errors };
  return { proposal: items, errors: [] };
}

/** Render a validated chain-next proposal as a human-reviewable block. */
export function formatChainNextProposal(proposal: ChainNextItem[]): string {
  return proposal
    .map((item, i) => {
      const iso = item.isolation ? " (worktree)" : "";
      return `${i + 1}. [${item.subagent_type}]${iso} files: ${item.files.join(", ")}\n   ${item.prompt}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Chain pause/resume state (pause_after → chain_run_id + remaining)
// ---------------------------------------------------------------------------

export interface ChainPauseState {
  previousOutput: string;
  results: Array<{ step: number; agent: string; output: string; savedPath?: string; durationMs: number }>;
  pausedAtStep: number;
}

const PAUSE_STATE_FILENAME = "_chain_pause_state.json";

/** Persist chain state to the chain's scratch directory so a later Agent call (chain_run_id) can resume it. */
export function saveChainPauseState(chainDir: string, state: ChainPauseState): void {
  writeFileSync(join(chainDir, PAUSE_STATE_FILENAME), JSON.stringify(state), "utf-8");
}

/** Load previously persisted chain state. Returns undefined if missing or unreadable. */
export function loadChainPauseState(chainDir: string): ChainPauseState | undefined {
  try {
    return JSON.parse(readFileSync(join(chainDir, PAUSE_STATE_FILENAME), "utf-8")) as ChainPauseState;
  } catch {
    return undefined;
  }
}

/**
 * Load and immediately delete a paused chain's state file, making the pause
 * single-use: a `chain_run_id` cannot be resumed twice (which would otherwise
 * let a model dispatch the same `remaining` steps — and their file writes —
 * more than once). Returns undefined if missing/unreadable (already consumed
 * or never existed) without throwing.
 */
export function consumeChainPauseState(chainDir: string): ChainPauseState | undefined {
  const path = join(chainDir, PAUSE_STATE_FILENAME);
  let state: ChainPauseState | undefined;
  try {
    state = JSON.parse(readFileSync(path, "utf-8")) as ChainPauseState;
  } catch {
    return undefined;
  }
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: if deletion fails, still return the state — losing the
    // single-use guarantee is better than losing the resume entirely.
  }
  return state;
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

/** Merge parallel member outputs into labeled concat for downstream handoff. */
export function mergeParallelOutputs(
  members: Array<{ agent: string; output: string; error?: string }>,
): string {
  return members
    .map((member, index) => {
      const header = `### Member ${index + 1} (${member.agent})${member.error ? ` (failed: ${member.error})` : ""}`;
      const body = member.output.trim() ? member.output : "(no output)";
      return `${header}\n\n${body}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Note appended to a step's prompt when other writable, non-worktree-isolated
 * agents are active concurrently elsewhere (e.g. a sibling top-level `Agent`
 * call, not a member of this same chain/stage). Chain-internal validation
 * (`validateParallelStage`, `formatParallelEditHazardWarning`) only sees
 * members declared inside one chain's own `parallel` array — it has no
 * visibility into a separate concurrent dispatch. This note compensates by
 * telling the step itself: don't misattribute a concurrent sibling's legitimate
 * changes as issues in your own review/validation.
 */
export function formatConcurrentActivityNote(count: number): string {
  const plural = count === 1 ? "agent is" : "agents are";
  return (
    `Note: ${count} other writable ${plural} currently active in this working tree without worktree isolation. ` +
    `If \`git diff\`/\`git status\` or a build/test run shows changes or failures outside your assigned scope, ` +
    `they likely belong to that concurrent work — do not flag them as issues in this task unless they fall within your assigned files.`
  );
}

/** Warn when a writable parallel member can edit files without worktree isolation. */
export function formatParallelEditHazardWarning(
  stageIndex: number,
  memberIndex: number,
  agentType: string,
): string {
  return (
    `⚠ Parallel stage ${stageIndex + 1} member ${memberIndex + 1} (${agentType}) can write files and is not worktree-isolated; ` +
    `concurrent members may clobber each other if their files overlap. Set isolation: "worktree" or make the agent read-only.`
  );
}

export function validateParallelStage(
  stageIndex: number,
  stage: Readonly<{
    parallel?: Array<{
      output?: string;
      output_mode?: string;
      reads?: string[];
    }>;
    output?: string;
    output_mode?: string;
  }>,
): string | undefined {
  if (!stage.parallel || stage.parallel.length === 0) {
    return `Chain stage ${stageIndex + 1}: parallel stage requires at least one member.`;
  }

  const stageIOError = validateStepIO(stageIndex, {
    output: stage.output,
    outputMode: stage.output_mode as ChainStepIO["outputMode"],
  });
  if (stageIOError) return stageIOError;

  for (let i = 0; i < stage.parallel.length; i++) {
    const member = stage.parallel[i];
    const memberIOError = validateStepIO(i, {
      output: member.output,
      outputMode: member.output_mode as ChainStepIO["outputMode"],
      reads: member.reads,
    });
    if (memberIOError) return memberIOError;
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
    parallel?: Array<{
      output?: string;
      output_mode?: string;
      reads?: string[];
    }>;
  }>,
): string[] {
  const warnings: string[] = [];

  const normalizeReads = (reads?: string[]) => {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const read of reads ?? []) {
      if (seen.has(read)) continue;
      seen.add(read);
      normalized.push(read);
    }
    return normalized;
  };

  const normalizeElement = (step: (typeof chain)[number]) => ({
    output: step.output,
    output_mode: step.output_mode,
    reads: step.parallel ? normalizeReads(step.parallel.flatMap((member) => member.reads ?? [])) : normalizeReads(step.reads),
  });

  for (let i = 0; i < chain.length - 1; i++) {
    const step = normalizeElement(chain[i]);
    if (step.output_mode !== "file-only" || !step.output) continue;
    const nextStep = normalizeElement(chain[i + 1]);
    if (!nextStep.reads.includes(step.output) && !nextStep.reads.includes("{previous}")) {
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
