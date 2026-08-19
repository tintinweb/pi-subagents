/**
 * tool-description.ts — the model-facing description of the `SubagentWorkflow` tool.
 *
 * This is a deliverable, not boilerplate. The orchestration *patterns* — fan out
 * with pipeline, verify adversarially, loop until dry — are deliberately NOT
 * runtime globals; they live here as guidance, which is how Claude Code ships
 * them too. A workflow engine whose description omits them gets used badly: the
 * model reaches for a barrier when it wants a pipeline, or spawns one agent
 * where it needed a panel.
 *
 * Kept out of index.ts purely for size. `{{placeholder}}` tokens are rendered by
 * the same substitution pass the Agent tool's description uses, so a
 * user-authored override can interpolate the live agent roster.
 */

/**
 * Rendered with `{{typeList}}` substituted. Keep the prose accurate to what the
 * runtime actually implements — documenting a global we do not ship is worse
 * than documenting nothing, because the script only fails once it is running.
 */
export const fullWorkflowToolDescription = `Run a deterministic JavaScript script that orchestrates many subagents.

A workflow is for work whose *shape* you know but whose *contents* you don't: fan out over a list you just discovered, run every item through the same stages, verify each result, and synthesize. The script is ordinary JavaScript — loops, conditionals, and control flow are yours — while each \`agent()\` call spawns a real subagent with its own context window.

The tool returns a task ID immediately and the run continues in the background. You are notified when it finishes; do not poll or sleep waiting for it.

## When to use this instead of the Agent tool

Use \`Agent\` for one delegated task, or a handful you can name up front in a single message.

Use \`SubagentWorkflow\` when:
- the number of agents depends on something discovered at runtime ("audit every route file");
- work flows through stages and later stages depend on earlier output;
- you want the same treatment applied uniformly across many items;
- you want findings independently verified before you report them.

Do not reach for a workflow to do one thing, or to dress up work you could finish directly. It costs a subprocess per agent.

## Writing the script

Every script begins with a \`meta\` block, then runs as an async body — top-level \`await\` and \`return\` are both allowed.

\`\`\`js
export const meta = {
  name: 'auth-audit',
  description: 'Find routes missing auth checks, then verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }, { title: 'Verify' }],
}

phase('Scan')
const listing = await agent('List every route file under src/routes/. Return one path per line, nothing else.')
const files = listing.split('\\n').map(s => s.trim()).filter(Boolean)
log(\`scanning \${files.length} route files\`)

phase('Audit')
const findings = await pipeline(
  files,
  file => agent(\`Audit \${file} for missing auth checks. Report findings or "none".\`, { label: \`audit:\${file}\` }),
  (result, file) => agent(\`Try to REFUTE this finding about \${file}: \${result}\`, { label: \`verify:\${file}\`, phase: 'Verify' }),
)

return findings.filter(Boolean)
\`\`\`

\`meta\` must be a **pure literal** — no variables, function calls, spreads, or template interpolation. It is read before the script runs, so the phases can be displayed before any agent starts. \`name\` and \`description\` are required; \`phases\` and \`whenToUse\` are optional.

## Resuming a run

Editing a script and re-running it normally re-pays for every agent. \`resumeFromRunId: "<run id>"\` avoids that: the run's unchanged leading \`agent()\` calls come straight back from its record, and the first call that changed — plus everything after it — runs live. Same script and args means nothing re-runs at all.

It is a *prefix*, not a lookup: a later call that still matches is not reused once an earlier one has changed, because its recorded answer was produced downstream of work that no longer exists. An agent that failed is never replayed as a failure, so resuming a broken run retries exactly the thing that broke. Same session only, and the run has to have finished — stop it from \`/agents → Workflows\` first.

## Saved workflows

A script you will run more than once belongs in a file: put it in \`.pi/workflows/<name>.js\` (or \`.agents/workflows/\`, or \`<agent dir>/workflows/\` for one that follows the user everywhere) and call it with \`name: "<name>"\` instead of re-sending the source. \`scriptPath\` and \`script\` both take precedence over \`name\`, and a saved run reports its own file back, so iterating on it is still edit-the-file-and-re-run.

## Globals

- **\`agent(prompt, opts?)\` → \`Promise<string | object | null>\`** — spawn one subagent and wait for its final text. Returns \`null\` if it is skipped from the /agents → Workflows view or fails terminally, so filter with \`.filter(Boolean)\` when a null would break later stages.
  - \`label\` — display name in the progress tree. Also the handle for \`resume\`.
  - \`phase\` — put this agent in a named group, overriding the ambient \`phase()\`. **Use this inside \`pipeline\`/\`parallel\` stages**, where the ambient phase races.
  - \`agentType\` — which agent definition to use. Available types:
{{typeList}}
  - \`model\` — override the model ("provider/modelId", or fuzzy like "haiku").
  - \`effort\` — reasoning effort for this child: \`minimal\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`. Omit it to inherit — the agent definition's own level, then the parent's. Spend it where the thinking is: \`low\` for mechanical stages, a high tier only for the hardest verify or judge step.
  - \`isolation: "worktree"\` — run in a throwaway git worktree. Use ONLY when agents write files in parallel and would otherwise collide; it costs setup time and disk per agent.
  - \`gate: "<command>"\` — run a shell command after the agent finishes and require it to pass. A failing gate marks the agent failed and its output becomes the error. This is how you make a result *verified* rather than merely claimed — prefer \`gate: "npm test"\` over asking another agent whether the code looks right.
  - \`resume: "<label>"\` — continue the child that ran under that label instead of starting fresh, so an iterative loop keeps its context. Mutually exclusive with \`agentType\`; cannot be combined with \`gate\`.
  - \`schema\` — a JSON Schema object (root \`type: "object"\`). The child gets a \`StructuredOutput\` tool built from it and \`agent()\` resolves to the **validated object** instead of text. A payload that does not match is rejected back to the child, which corrects it; a child that never answers through the tool gets one more prompt and then fails, so the call returns \`null\`. Cannot be combined with \`resume\`.
  - Any other key is rejected by name at the call.
- **\`pipeline(items, ...stages)\` → \`Promise<any[]>\`** — run every item through every stage, with **no barrier between stages**. Each stage receives \`(previousResult, originalItem, index)\`. A stage that throws drops that item to \`null\` and skips its remaining stages.
- **\`parallel(thunks)\` → \`Promise<any[]>\`** — run functions concurrently and wait for all of them. A thunk that throws becomes \`null\` without failing its siblings.
- **\`workflow(nameOrRef, args?)\` → \`Promise<any>\`** — run a saved workflow inline as a sub-step and return whatever it returns. Pass a name, or \`{ scriptPath }\`. \`args\` becomes the child's \`args\` global. The child shares this run's concurrency cap, agent counter, abort signal and budget, and its agents appear under their own \`▸ name\` group. **One level only** — \`workflow()\` inside a child throws. An unknown name, an unreadable path or a child that is not a workflow throws too, so \`try\`/\`catch\` to handle it. Reach for it to reuse a saved workflow, not to structure one script: inline composition is cheaper.
- **\`budget\`** — \`{ total, spent(), remaining() }\`. \`total\` is always \`null\` here: it comes from a token-target directive pi does not have, so guards like \`while (budget.total && budget.remaining() > 50_000)\` correctly do not fire. \`spent()\` is real — output tokens this run's agents have used — and \`remaining()\` is \`Infinity\` with no target.
- **\`phase(title)\`** — start a new progress group. Subsequent \`agent()\` calls are grouped under it.
- **\`log(message)\`** — a progress line shown to the user under the tree.
- **\`args\`** — whatever was passed as the tool's \`args\`, verbatim.

## Prefer pipeline. Barriers cost wall-clock.

This is the single most common mistake. \`parallel\` waits for *everything* before *anything* moves on. If five agents run and the slowest takes three times the fastest, a barrier throws away two-thirds of the fast agents' time — they sit finished while the straggler runs.

\`pipeline\` has no such barrier: item A can be in stage 3 while item B is still in stage 1, so total time is the slowest single *chain*, not the sum of the slowest per stage.

A barrier is right only when a stage genuinely needs every prior result *together*:
- dedupe or merge across the whole result set before expensive downstream work;
- decide whether to continue at all ("zero findings → skip verification");
- a prompt that compares one result against all the others.

A barrier is NOT justified by needing to flatten, map, or filter — do that inside a pipeline stage. If you wrote \`const a = await parallel(...)\`, then a plain transform, then another \`parallel\`, that middle step did not need the barrier.

## Patterns worth knowing

Pick what fits; compose freely.

- **Adversarial verification.** Spawn independent skeptics per finding, each prompted to *refute* it, and keep it only if it survives. Prompting for "verify" invites agreement; prompting for "refute" does not. Cheaper and more honest than a second opinion that already saw the first.
- **Verify by running, not by asking.** When a claim is testable, \`gate\` it. An LLM judging whether a fix works is a weaker signal than the test suite.
- **Perspective-diverse review.** When something can fail in several ways, give each reviewer a distinct lens (correctness, security, performance, does-it-reproduce) rather than N identical ones. Diversity catches what redundancy cannot.
- **Judge panel.** Generate several independent attempts from different angles, score them with separate judges, then synthesize from the winner while grafting good ideas from the runners-up. Beats one attempt iterated when the solution space is wide.
- **Loop until dry.** For open-ended discovery, keep going until N consecutive rounds surface nothing new. A fixed count misses the tail. Deduplicate against everything seen so far, not against what survived judging — otherwise rejected items reappear every round and it never converges.
- **Completeness critic.** A final agent whose only job is "what is missing — which area went unexamined, which claim went unverified?" What it finds is the next round.
- **No silent caps.** If you bound coverage — top-N, no retries, sampling — \`log()\` what you dropped. Silent truncation reads as "covered everything" when it did not.

## Determinism

\`Date.now()\`, \`new Date()\`, and \`Math.random()\` are unavailable and throw. SubagentWorkflow scripts must be reproducible. Stamp timestamps after the workflow returns, or pass them in through \`args\`. For N varied samples, vary the prompt or label by index rather than reaching for randomness.

\`eval\` and \`Function(...)\` are disabled. There is no filesystem, network, or module access inside the script — all real work happens in the agents you spawn.

## Scale

Concurrency is capped automatically, so a large fan-out queues rather than melting the machine. Match effort to the request: a quick check wants a few agents and a single verification pass; "audit this thoroughly" justifies a larger pool, multi-vote adversarial verification, and a synthesis stage. When a run is large enough to be expensive, the progress view says so.

Return a value that is useful on its own — the caller sees your \`return\`, not the individual agent outputs.`;
