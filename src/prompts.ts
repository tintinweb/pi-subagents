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
  /**
   * Set only for a workflow's own children, and only when they have no
   * `StructuredOutput` tool to answer through.
   *
   * A workflow child's final text is not read by a human — it is the value
   * `agent()` resolves to, and the script interpolates it straight into the
   * next stage's prompt. Without this, children answer the way every other
   * subagent does (a report addressed to a reader), and the padding becomes
   * input tokens for the stage downstream. Claude Code's `Workflow` tool
   * documents this contract to the script-writing model; this is the end of it
   * that makes the documentation true.
   *
   * Deliberately NOT applied to every subagent. In pi an ordinary agent's
   * output IS read by a human — through FleetView, the conversation viewer and
   * `get_subagent_result` — so terse raw data would be the wrong answer there.
   */
  workflowChild?: boolean;
}

/**
 * Build the system prompt for an agent from its config.
 *
 * - "replace" mode: env header + config.systemPrompt (full control, no parent identity)
 * - "append" mode: parent system prompt + sub-agent context + env header + config.systemPrompt
 * - "append" with empty systemPrompt: pure parent clone
 *
 * Both modes include an `<active_agent name="${config.name}"/>` tag so downstream
 * extensions (e.g. permission/policy systems) can resolve per-agent policy
 * inside the child session by parsing the system prompt. In replace mode the tag
 * is prepended; in append mode it follows the shared inherited content so the
 * parent prompt forms an identical, cacheable byte prefix with the parent
 * session (the LLM's KV cache can then reuse those tokens across every spawn).
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

  // The script, not a person, reads what this child returns — see
  // `PromptExtras.workflowChild` for why only workflow children get this.
  const workflowBlock = extras?.workflowChild
    ? `\n\n<workflow_child>
Your final message IS the return value of this task. A workflow script captures it and passes it to the next stage; no person reads it.
Return only the answer, in exactly the shape the prompt asks for — no preamble, no summary of what you did, no offer to continue.
</workflow_child>`
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
    // with the parent session, maximising KV cache hits. The <active_agent>
    // tag and env block vary per call and are placed after the cached prefix.
    return identity + "\n\n" + bridge + "\n\n" + activeAgentTag + envBlock + worktreeBlock + workflowBlock + customSection + extrasSuffix;
  }

  // "replace" mode — env header + the config's full system prompt
  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return activeAgentTag + replaceHeader + worktreeBlock + workflowBlock + "\n\n" + config.systemPrompt + extrasSuffix;
}

/**
 * The part of the parent's rendered system prompt that an append-mode child inherits.
 *
 * Pi renders a prompt as the preamble followed by tagged sections in a fixed order:
 * `tools`, `rules`, `docs` (default preamble only), `addendum`, `project_context`,
 * `skills`, `cwd`, then the sections extensions add during a turn. The child session renders its own `skills` (from its `skills:`
 * setting), its own `cwd` and its own extension sections after the inherited text.
 * Inheriting the parent's copies too listed them twice, showed the parent's skills to
 * children configured with `skills: false` or a preload list, and left copies that
 * section-editing extensions in the child cannot reach. It also made the result depend
 * on timing: `getSystemPrompt()` includes the extension sections only while the
 * parent's turn runs.
 *
 * Returns the text before the `skills` section, or before the `cwd` section when there
 * are no skills. A prompt without the `cwd` section (for example, a forced prompt) is
 * returned unchanged.
 *
 * @param rendered  The parent's `ctx.getSystemPrompt()`.
 * @param cwd  The cwd the parent's prompt was rendered with.
 */
export function inheritableParentPrompt(rendered: string, cwd: string): string {
  const cwdAt = rendered.lastIndexOf(`\n\n<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`);
  if (cwdAt < 0) return rendered;
  const head = rendered.slice(0, cwdAt);
  if (!head.endsWith("\n</skills>")) return head;
  const skillsAt = head.lastIndexOf("\n\n<skills>\n");
  return skillsAt < 0 ? head : head.slice(0, skillsAt);
}

/** Fallback base prompt when parent system prompt is unavailable in append mode. */
const genericBase = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.`;
