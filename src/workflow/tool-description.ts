/**
 * tool-description.ts — the model-facing description of the `SubagentWorkflow` tool.
 *
 * Written for compatibility with Claude Code's `Workflow` tool, so a model
 * that knows one does not have to relearn the other, and in two parts:
 *
 *   - this description: what decides *whether* to call the tool (the opt-in
 *     rule), the `meta` and `script` rules, the one pattern to start from,
 *     and the live agent roster;
 *   - the `workflow-authoring` skill (`skills/workflow-authoring/SKILL.md`):
 *     the reference for *writing* a script — hooks, options, barriers,
 *     patterns, resume. Declared in the package's `pi.skills`, so pi lists
 *     it, and pointed at by absolute path here, so it is reachable without
 *     discovery (`--no-skills`, `pi -e <file>`). Listed in every session, it
 *     says in its description that it applies only where this tool exists.
 *
 * By default (`workflowToolExposure: "inline"`) the skill's body is appended in
 * place of the pointer, because a model can skip the pointer; `"skill"` keeps
 * the split and several thousand tokens out of every session. `"deferred"`
 * carries the inline body too: the tool is declared only once `tool_search`
 * loads it, and a pointer would then cost a second round trip. The roster stays here because the skill is a static file
 * and `{{typeList}}` can only be substituted into this text.
 *
 * Omitted because pi has no such feature: the `ultracode` opt-in, MCP tools
 * reached through `ToolSearch`, the `agent-<id>.jsonl` resume fallback, and
 * the `/config` workflow-size guideline. Where pi behaves differently, the text
 * says what pi does:
 *   - `schema` is pressure, not force — `toolChoice` is not plumbed through
 *     pi's `AgentSession`, so a child can decline and the call returns null.
 *   - `budget.total` is always null; pi has no token-target directive.
 *   - `parallel` and `pipeline` propagate a fatal run error, an unusable
 *     `schema` among them, instead of folding it to null.
 *   - `log()` lines render below the progress tree.
 *   - concurrency is `max(1, min(16, cpus - 2))`.
 *   - `whenToUse` has no workflow list to appear in, and a phase's `model`
 *     is accepted but displayed nowhere, so neither is advertised.
 *   - the result labels the run id `Task ID`.
 *   - `effort` inherits the agent definition's level, then the parent's.
 *   - `isolation` removes the worktree on settle, changes kept on a branch.
 * Additions: `gate`, `resume`, `effort: "minimal"`, `disallowedTools`, the
 * saved-workflow directories, and the reject-unknown-options guarantee.
 *
 * Kept out of index.ts purely for size.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorkflowToolExposureMode } from "../settings.js";

/**
 * The shipped skill, resolved from this module: `src/workflow/` and
 * `dist/workflow/` both sit two levels below the package root.
 */
export const WORKFLOW_SKILL_PATH = fileURLToPath(new URL("../../skills/workflow-authoring/SKILL.md", import.meta.url));

/** The one line that stands in for the reference; `inline` swaps the skill body in for it. */
const WORKFLOW_SKILL_POINTER =
  `Before writing a script, load the \`workflow-authoring\` skill (read \`${WORKFLOW_SKILL_PATH}\`) — `
  + "the workflow authoring reference: script API and gotchas, resume, quality patterns, worked examples.";

/**
 * Heads the inline body. pi lists the same skill in the system prompt, and
 * without this line a model read SKILL.md on top of the identical body.
 */
const WORKFLOW_SKILL_INLINE_LEAD = "Do not load the `workflow-authoring` skill: its full text follows.";

/**
 * Rendered with `{{typeList}}` substituted. Keep the prose, here and in the
 * skill, accurate to what the runtime implements — documenting a global we do
 * not ship is worse than documenting nothing, because the script only fails
 * once it is running. `workflow-tool-description.test.ts` pins the parts of
 * the pair that can drift; `workflow-skill.test.ts` pins the split.
 */
export const fullWorkflowToolDescription = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and you are notified when the workflow completes. Use /agents → Workflows to watch live progress.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call SubagentWorkflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` (shown in the permission dialog) and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not Write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.

${WORKFLOW_SKILL_POINTER}

Agent types for agent(prompt, {agentType}):
{{typeList}}`;

/**
 * The description for the `workflowToolExposure` setting. `inline` (the default)
 * puts the skill's body where the pointer was, so the model cannot skip it,
 * headed by a line saying not to load the listed skill as well;
 * `skill` keeps the pointer, about 4k tokens lighter, for a model that follows it.
 * `deferred` gets the inline body: exposure, not this text, is what it saves.
 * Read from the shipped file, so the reference still has one source. A missing
 * or unreadable file falls back to the pointer, with a warning.
 */
export function workflowToolDescription(mode: WorkflowToolExposureMode): string {
  if (mode === "skill") return fullWorkflowToolDescription;
  let body: string;
  try {
    body = readFileSync(WORKFLOW_SKILL_PATH, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  } catch (error) {
    console.warn(`[pi-subagents] workflowToolExposure is "inline" but ${WORKFLOW_SKILL_PATH} could not be read — using "skill": ${String(error)}`);
    return fullWorkflowToolDescription;
  }
  return fullWorkflowToolDescription.replace(WORKFLOW_SKILL_POINTER, () => `${WORKFLOW_SKILL_INLINE_LEAD}\n\n${body}`);
}
