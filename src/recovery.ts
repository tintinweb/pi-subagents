/**
 * recovery.ts — Subagent recovery utilities.
 *
 * Combines three recovery strategies into a single wrapper:
 *   Strategy 1: Embed a checkpoint protocol into every spawned prompt.
 *   Strategy 2: Inject a softLimitSteer that commands checkpoint writing at the turn limit.
 *   Strategy 4: On abort, try session resume if session is alive and context is not exhausted.
 *   Strategy 3: Fall back to a fresh spawn with git diff + checkpoint as context.
 */

import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import type { AgentRecord, SubagentType } from "./types.js";

/** Context needed to build a recovery prompt for a fresh-spawn retry. */
export interface RecoveryContext {
  originalPrompt: string;
  abortedResult: string;
  gitDiff: string;
  gitStatus: string;
}

/**
 * Execute a shell command safely.
 * Returns the stdout string on success, or an empty string on any error.
 */
export function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8" });
  } catch {
    return "";
  }
}

/**
 * Extract the ## Recovery Checkpoint block from a text string.
 * Returns the trimmed content of the block, or undefined if the block is absent.
 */
export function extractCheckpoint(text: string): string | undefined {
  const match = text.match(/## Recovery Checkpoint\n([\s\S]+?)(?:\n##|$)/);
  return match?.[1]?.trim();
}

/**
 * Build a recovery prompt from a RecoveryContext.
 * Sections with empty content are omitted.
 */
export function buildRecoveryPrompt(ctx: RecoveryContext): string {
  return [
    "## Recovery Context",
    "A previous agent was aborted before completing this task.",
    "",
    ctx.gitDiff && `### Files already modified:\n\`\`\`\n${ctx.gitDiff}\n\`\`\``,
    ctx.gitStatus && `### Git status:\n\`\`\`\n${ctx.gitStatus}\n\`\`\``,
    ctx.abortedResult && `### Where it stopped:\n${ctx.abortedResult}`,
    "",
    "## Continue the original task",
    "Pick up exactly where it left off. Do not redo already-completed work.",
    "",
    ctx.originalPrompt,
  ].filter(Boolean).join("\n");
}

/** Context-pressure threshold: skip session resume if lifetime input tokens exceed this. */
const CONTEXT_PRESSURE_THRESHOLD = 150_000;

/**
 * Checkpoint protocol appended to every prompt in spawnWithRecovery (Strategy 1).
 * Asks the agent to log progress after each file and write a structured checkpoint
 * before stopping, so recovery can pick up exactly where work left off.
 */
export const CHECKPOINT_PROTOCOL = `

---
After each file edit, log progress with write_output (append: true):
  ✓ DONE: <path>

Before stopping (whether done or not), end your final message with:
## Recovery Checkpoint
DONE: <completed paths, one per line>
IN_PROGRESS: <current file and what remains>
TODO: <not yet started>`;

/**
 * Soft-limit steer message injected via softLimitSteer (Strategy 2).
 * Fires at turnCount >= maxTurns, commanding the agent to write its checkpoint
 * before the hard abort fires at maxTurns + graceTurns.
 */
export const SOFT_LIMIT_STEER =
  "You are running out of turns. STOP current work immediately. " +
  "Write your ## Recovery Checkpoint section NOW (DONE / IN_PROGRESS / TODO). " +
  "Then provide your final answer.";

/**
 * Spawn an agent with built-in recovery support (single retry).
 *
 * Flow:
 *   1. Augment prompt with checkpoint protocol (Strategy 1).
 *   2. Set softLimitSteer to command checkpoint writing at turn limit (Strategy 2).
 *   3. On abort: try session resume if session is alive and input < 150k tokens (Strategy 4).
 *   4. If resume unavailable/skipped: fresh spawn with git diff + checkpoint (Strategy 3).
 *
 * @param manager  The AgentManager instance.
 * @param pi       The ExtensionAPI instance.
 * @param ctx      The parent ExtensionContext.
 * @param type     The subagent type to spawn.
 * @param prompt   The original task prompt (unaugmented).
 * @param opts     Spawn options (same shape as spawnAndWait's options param).
 * @param cwd      Working directory used for git commands on recovery.
 */
export async function spawnWithRecovery(
  manager: AgentManager,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  opts: Parameters<AgentManager["spawnAndWait"]>[4],
  cwd: string,
): Promise<AgentRecord> {
  // Strategies 1 + 2: augment prompt and inject steer
  const augmentedPrompt = prompt + CHECKPOINT_PROTOCOL;

  const record = await manager.spawnAndWait(pi, ctx, type, augmentedPrompt, {
    ...opts,
    softLimitSteer: SOFT_LIMIT_STEER,
  });

  if (record.status !== "aborted") return record;

  const checkpoint = extractCheckpoint(record.result ?? "");
  const contextPressure = record.lifetimeUsage.input > CONTEXT_PRESSURE_THRESHOLD;

  // Strategy 4: try session resume (cheap — full conversation context preserved).
  // Attempt even without a checkpoint: the full message history is still in the session.
  if (record.session && !contextPressure) {
    const resumeContext = checkpoint ?? record.result ?? "";
    const resumed = await manager.resume(
      record.id,
      `You were aborted before finishing.${
        resumeContext ? `\n\nYour last output:\n\n${resumeContext}` : ""
      }\n\nContinue from where you left off.`,
    );
    // Only accept the resumed record if it did not itself error out.
    if (resumed && resumed.status !== "error") return resumed;
  }

  // Strategy 3: fresh spawn with full git diff + checkpoint as context.
  const recoveryCtx: RecoveryContext = {
    originalPrompt: prompt,
    abortedResult: checkpoint ?? record.result ?? "",
    gitDiff: safeExec("git diff HEAD", cwd),
    gitStatus: safeExec("git status --short", cwd),
  };

  return manager.spawnAndWait(pi, ctx, type, buildRecoveryPrompt(recoveryCtx), opts);
}
