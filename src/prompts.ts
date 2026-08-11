/**
 * prompts.ts — System prompt builder for agents.
 */

import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
  /** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
  memoryBlock?: string;
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
  /**
   * Parent directory the worktree copy was created from. Set only for
   * `isolation: "worktree"` spawns — triggers the block that tells the agent
   * to stay in the copy.
   */
  worktreeBase?: string;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: config.systemPrompt (full control, no parent identity) + env header
 * - "append" mode: parent system prompt + sub-agent context + config.systemPrompt + env header
 * - "append" with empty systemPrompt: pure parent clone
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so downstream
 * extensions (e.g. permission/policy systems) can resolve per-agent policy
 * inside the child session by parsing the system prompt. In replace mode the tag
 * is prepended; in append mode it follows the shared inherited content so the
 * parent prompt forms an identical, cacheable byte prefix with the parent
 * session (the LLM's KV cache can then reuse those tokens across every spawn).
 *
 * Within each mode, the STATIC per-agent-type body (`config.systemPrompt`,
 * typically 1-2KB) is placed BEFORE the VARIABLE env block (cwd/branch, which
 * drifts across spawns in the same session/repo as the user cd's around or
 * commits land) and the worktree block (which names a per-spawn path). Only
 * `activeAgentTag` stays at the front of the static block in both modes —
 * it depends solely on `config.name`, which is invariant for repeated spawns
 * of the same agent type, so it doesn't break the cacheable prefix. This
 * ordering means every spawn of the same agent type shares an identical byte
 * prefix through the end of `config.systemPrompt`, letting the LLM's KV
 * cache reuse it even when cwd/branch/worktree info differs between spawns.
 * Memory/skill extras remain last (session-specific, never worth caching).
 *
 * @param parentSystemPrompt  The parent agent's effective system prompt (for append mode).
 * @param extras  Optional extra sections to inject (memory, preloaded skills).
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  parentSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  const activeAgentTag = `<active_agent name="${config.name}"/>\n\n`;

  const envBlock = `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;

  // A worktree agent is told its cwd twice: by the env block above (the copy)
  // and by whatever names the main checkout — the inherited parent prompt in
  // append mode, or the task prompt in either mode. It follows the latter and
  // works in the shared tree (#187), so resolve the contradiction explicitly.
  const worktreeBlock = extras?.worktreeBase
    ? `\n\n<worktree_isolation>
Your working directory is an isolated git worktree copy of ${extras.worktreeBase}.
Work only inside it — never in ${extras.worktreeBase}, even if other instructions name that path as your working directory.
</worktree_isolation>`
    : "";

  // Build optional extras suffix
  const extraSections: string[] = [];
  if (extras?.memoryBlock) {
    extraSections.push(extras.memoryBlock);
  }
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  const extrasSuffix = extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";

  if (config.promptMode === "append") {
    const identity = parentSystemPrompt || genericBase;

    const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

    const customSection = config.systemPrompt?.trim()
      ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
      : "";

    // Place shared/stable content first so the LLM's KV cache can reuse the
    // inherited prefix across all subagent invocations. The parent prompt is
    // placed verbatim (no wrapper tag) so it forms an identical byte prefix
    // with the parent session, maximising KV cache hits. `activeAgentTag` and
    // `customSection` (config.systemPrompt) are static per agent type — kept
    // adjacent to the cached prefix. `envBlock`/`worktreeBlock` vary per
    // spawn (cwd/branch drift, per-spawn worktree path) and are placed after,
    // so a run of same-type spawns keeps sharing this whole prefix even as
    // cwd/branch change between them.
    return identity + "\n\n" + bridge + "\n\n" + activeAgentTag + customSection + envBlock + worktreeBlock + extrasSuffix;
  }

  // "replace" mode — the config's full system prompt + env header
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.`;

  // Static per-agent-type body (activeAgentTag + replaceHeader + systemPrompt)
  // comes first so it forms an identical, cacheable byte prefix across every
  // spawn of this agent type. The variable envBlock/worktreeBlock (cwd,
  // branch, worktree path — all of which can drift between spawns in the
  // same session) are placed after, instead of before, so they no longer
  // invalidate that cached prefix.
  return activeAgentTag + replaceHeader + "\n\n" + config.systemPrompt + "\n\n" + envBlock + worktreeBlock + extrasSuffix;
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
