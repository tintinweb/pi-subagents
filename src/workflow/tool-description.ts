/**
 * tool-description.ts — the model-facing description of the `SubagentWorkflow` tool.
 *
 * This is a deliberate port of Claude Code's `Workflow` tool description, not a
 * paraphrase of it. The rule the text is held to: **match Claude Code's wording
 * everywhere; deviate only in the specific clause where its sentence would be
 * false about pi, and keep that deviation minimal and in its voice.** Wording
 * parity is the point — a user who knows one tool should not have to relearn
 * the other, and the orchestration patterns below are load-bearing guidance
 * that gets used badly when compressed.
 *
 * Parts omitted because pi has no such feature: the `ultracode` opt-in, MCP
 * tools reached through `ToolSearch`, the `agent-<id>.jsonl` resume fallback,
 * and the `/config` workflow-size guideline.
 *
 * Clauses that had to deviate, each because Claude Code's is untrue here:
 *   - `schema` is pressure, not force — `toolChoice` is not plumbed through
 *     pi's `AgentSession`, so a child can decline and the call returns null.
 *   - `budget.total` is always null; pi has no token-target directive.
 *   - `parallel` propagates a fatal run error instead of folding it to null.
 *   - `effort` inherits the agent definition's level, then the parent's.
 *   - `isolation` removes the worktree on settle, changes kept on a branch.
 * Additions with no upstream counterpart: `gate`, `resume`, `effort: "minimal"`,
 * the saved-workflow directories, and the reject-unknown-options guarantee.
 *
 * Kept out of index.ts purely for size. `{{placeholder}}` tokens are rendered by
 * the same substitution pass the Agent tool's description uses, so a
 * user-authored override can interpolate the live agent roster.
 */

/**
 * Rendered with `{{typeList}}` substituted. Keep the prose accurate to what the
 * runtime actually implements — documenting a global we do not ship is worse
 * than documenting nothing, because the script only fails once it is running.
 * `workflow-tool-description.test.ts` pins the parts that can drift: the
 * `agent()` option set, the `resume` exclusions, the effort levels, the caps,
 * and that every example here uses options the runtime actually accepts.
 */
export const fullWorkflowToolDescription = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and you are notified when the workflow completes. Use /agents → Workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call SubagentWorkflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the channels, scope the diff) to discover the work-list, then call SubagentWorkflow to pipeline over it. You don't need to know the shape before the *task* — only before the *orchestration step*.

Common single-phase workflows you can chain across turns:
- **Understand** — parallel readers over relevant subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify (example below)
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

For larger work, run several in sequence — read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

Pass the script inline via \`script\` — do not Write it to a file first. Every invocation automatically persists its script to a file under the session directory and returns the path in the tool result. To iterate on a workflow, edit that file with Write/Edit and re-invoke SubagentWorkflow with \`{scriptPath: "<path>"}\` instead of resending the full script. A script you will run more than once belongs in \`.pi/workflows/<name>.js\` (or \`.agents/workflows/\`, or \`<agent dir>/workflows/\` for one that follows the user everywhere); call it with \`name: "<name>"\` instead of re-sending the source.

Every script must begin with \`export const meta = {...}\`:
  export const meta = {
    name: 'find-flaky-tests',
    description: 'Find flaky tests and propose fixes',   // one-line, shown in permission dialog
    phases: [                                            // one entry per phase() call
      { title: 'Scan', detail: 'grep test logs for retries' },
      { title: 'Fix', detail: 'one agent per flaky test' },
    ],
  }
  // script body starts here — use agent()/parallel()/pipeline()/phase()/log()
  phase('Scan')
  const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
  ...

The \`meta\` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: \`name\`, \`description\`. Optional: \`whenToUse\` (shown in the workflow list), \`phases\`. Use the SAME phase titles in meta.phases as in phase() calls — titles are matched exactly; a phase() call with no matching meta entry just gets its own progress group. Add \`model\` to a phase entry when that phase uses a specific model override.

Script body hooks:
- agent(prompt: string, opts?: {label?: string, phase?: string, schema?: object, model?: string, effort?: string, isolation?: 'worktree', agentType?: string, gate?: string, resume?: string}): Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is given a StructuredOutput tool built from it and agent() returns the validated object — no parsing needed. A payload that does not match is rejected back to the child, which corrects it; a child that never answers through the tool gets one more prompt and then fails, so the call returns null — filter after every schema stage. Returns null if the user skips the agent mid-run or the subagent dies on a terminal API error after retries (filter with .filter(Boolean)). opts.label overrides the display label. opts.phase explicitly assigns this agent to a progress group (use this inside pipeline()/parallel() stages to avoid races on the global phase() state — same phase string → same group box). opts.model overrides the model for this agent call. Default to omitting it — the agent inherits the main-loop model (the resolved session model), which is almost always correct. Only set it when you're highly confident a different tier fits the task; when unsure, omit. opts.effort overrides the reasoning effort for this agent call ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max') — omit to inherit the agent definition's own level, then the parent's; use 'low' for cheap mechanical stages and higher tiers only for the hardest verify/judge stages. opts.isolation: 'worktree' runs the agent in a fresh git worktree — EXPENSIVE (setup time + disk per agent), use ONLY when agents mutate files in parallel and would otherwise conflict; the worktree is removed when the agent settles, its changes preserved on a branch. opts.gate: '<command>' runs a shell command after the agent finishes and requires it to pass — a non-zero exit marks the agent failed and the command's output becomes the error; prefer gate: 'npm test' over asking another agent whether the code looks right. opts.resume: '<label>' continues the child that ran under that label instead of starting fresh, so an iterative loop keeps its context — it cannot be combined with agentType, model, effort, isolation, gate or schema. opts.agentType uses a custom subagent type instead of the default workflow subagent — resolved from the same registry as the Agent tool; composes with schema. Available types:
{{typeList}}
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. This is the DEFAULT for multi-stage work. Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives (prevResult, originalItem, index) — use originalItem/index in later stages to label work without threading context through stage 1's return value. A stage that throws drops that item to \`null\` and skips its remaining stages.
- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws (or whose agent errors) resolves to \`null\` in the result array, so \`.filter(Boolean)\` before using the results; only a fatal run error — a cap breach, or a nested workflow that could not load — propagates instead of being folded into a null. Use ONLY when you genuinely need all results together.
- log(message: string): void — emit a progress message to the user (shown as a narrator line above the progress tree)
- phase(title: string): void — start a new phase; subsequent agent() calls are grouped under this title in the progress display
- args: any — the value passed as SubagentWorkflow's \`args\` input, verbatim (undefined if not provided). Pass arrays/objects as actual JSON values in the tool call, NOT as a JSON-encoded string — \`args: ["a.ts", "b.ts"]\`, not \`args: "[\\"a.ts\\", ...]"\` (a stringified list reaches the script as one string, so \`args.filter\`/\`args.map\` throw). Use this to parameterize named workflows — e.g. pass a research question, target path, or config object directly instead of via a side-channel file.
- budget: {total: number|null, spent(): number, remaining(): number} — \`budget.total\` is always null here: it comes from a token-target directive pi does not have, so guards like \`while (budget.total && budget.remaining() > 50_000) { ... }\` correctly do not fire rather than throwing on a missing global. \`budget.spent()\` returns output tokens spent by this run's agents. \`budget.remaining()\` returns \`Infinity\` with no target.
- workflow(nameOrRef: string | {scriptPath: string}, args?: any): Promise<any> — run another workflow inline as a sub-step and return whatever it returns. Pass a name to invoke a saved workflow (same registry as {name: "..."}), or {scriptPath} to run a script file you Wrote earlier. The child shares this run's concurrency cap, agent counter, abort signal, and token budget — its agents appear under a "▸ name" group in /agents → Workflows and its tokens count toward budget.spent(). The args param becomes the child's \`args\` global. Nesting is one level only: workflow() inside a child throws. Throws on unknown name / unreadable scriptPath / child syntax error; catch to handle gracefully.

Any agent() option not listed above is rejected by name at the call.

Subagents are told their final text IS the return value (not a human-facing message), so they return raw data. For structured output, use the schema option — validation happens at the tool-call layer so the model retries on mismatch.

Scripts are plain JavaScript, NOT TypeScript — type annotations (\`: string[]\`), interfaces, and generics fail to parse. The script body runs in an async context — use await directly. Standard JS built-ins (JSON, Math, Array, etc.) are available — EXCEPT \`Date.now()\`/\`Math.random()\`/argless \`new Date()\`, which throw (they would break resume); pass timestamps in via \`args\`, stamp results after the workflow returns, and for randomness vary the agent prompt/label by index. \`eval\` and \`Function(...)\` throw. No filesystem or Node.js API access.

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: pipeline(items, stageA, r => transform([r]).flat(), stageB)
- "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.

Smell test: if you wrote
  const a = await parallel(...)
  const b = transform(a)        // flatten, map, filter — no cross-item dependency
  const c = await parallel(b.map(...))
that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

Concurrent agent() calls are capped at min(16, available CPUs - 2) per workflow — excess calls queue and run as slots free up. You can still pass 100 items to parallel()/pipeline() and they all complete; only ~10 run at any moment. Total agent count across a workflow's lifetime is capped at 1000 — a runaway-loop backstop set far above any real workflow. A single parallel()/pipeline() call accepts at most 4096 items; passing more is an explicit error, not a silent truncation.

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

When a barrier IS correct — dedup across all findings before expensive verification:
  const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
  const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // <-- genuinely needs ALL at once
  const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))

Loop-until-count pattern — accumulate to a target:
  const bugs = []
  while (bugs.length < 10) {
    const result = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
    bugs.push(...result.bugs)
    log(\`\${bugs.length}/10 found\`)
  }

Gate-and-retry pattern — verify by running, and keep the agent's context across attempts:
  let fixed = await agent('Find and fix the failing test.', {label: 'fix', gate: 'npm test'})
  if (fixed === null) {                        // a non-zero exit failed the agent
    // Resume keeps everything the child already learned. It cannot carry the
    // gate, so re-verification needs its own gated call, in the same tree.
    fixed = await agent('\`npm test\` is still failing. Fix the cause.', {label: 'fix', resume: 'fix'})
    const verified = await agent('Run \`npm test\` and report the result. Change nothing.',
      {label: 'verify', phase: 'Verify', gate: 'npm test', effort: 'low'})
    return { passed: verified !== null, summary: fixed }
  }
  return { passed: true, summary: fixed }
  // An LLM judging whether a fix works is a weaker signal than the test suite.

Composing patterns — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry):
  const seen = new Set(), confirmed = []
  let dry = 0
  while (dry < 2) {                                              // loop-until-dry
    const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
      agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
    const fresh = found.filter(b => !seen.has(key(b)))           // dedup vs ALL seen — plain code, not an agent
    if (!fresh.length) { dry++; continue }
    dry = 0; fresh.forEach(b => seen.add(key(b)))
    const judged = await parallel(fresh.map(b => () =>           // every fresh bug judged concurrently...
      parallel(['correctness','security','repro'].map(lens => () =>   // ...each by 3 distinct lenses
        agent(\`Judge "\${b.desc}" via the \${lens} lens — real?\`, {phase: 'Verify', schema: VERDICT})))
        .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
    confirmed.push(...judged.filter(v => v.real).map(v => v.b))
  }
  return confirmed
  // dedup vs \`seen\`, NOT \`confirmed\` — else judge-rejected findings reappear every round and it never converges.

Quality patterns — common shapes; pick by task and compose freely:
- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Prevents plausible-but-wrong findings from surviving.
    const votes = await parallel(Array.from({length: 3}, () => () =>
      agent(\`Try to refute: \${claim}. Default to refuted=true if uncertain.\`, {schema: VERDICT})))
    const survives = votes.filter(Boolean).filter(v => !v.refuted).length >= 2
- Verify by running, not by asking: when a claim is testable, \`gate\` it rather than asking another model whether it holds.
- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters — diversity catches failure modes redundancy can't.
- Judge panel: generate N independent attempts from different angles (e.g. MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- Loop-until-dry: for unknown-size discovery (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (while count < N) miss the tail.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time). Each is blind to what the others surface; useful when one search angle won't find everything.
- Completeness critic: a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), \`log()\` what was dropped — silent truncation reads as "covered everything" when it didn't.

Scale to what the user asked for. "find any bugs" → a few finders, single-vote verify. "thoroughly audit this" or "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. When unsure, lean toward thoroughness for research/review/audit requests and toward brevity for quick checks.

These patterns aren't exhaustive — compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits).

Use this tool for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## Resume

The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with SubagentWorkflow({scriptPath, resumeFromRunId}) — the longest unchanged prefix of agent() calls returns cached results instantly; the first edited/new call and everything after it runs live. Same script + same args → 100% cache hit. It is a prefix and not a lookup: a later call that still matches is not reused once an earlier one has changed. A journaled failure ends the prefix, so resuming a run that died at agent 5 retries exactly agent 5. Same session only, and the run must have finished — stop it from /agents → Workflows first. Before diagnosing why a completed workflow returned an empty or unexpected result, Read the run's \`<run id>.workflow.jsonl\` beside its script — it records each agent's actual return value; do not assume cached results are non-empty. Date.now()/Math.random()/new Date() are unavailable in scripts (they would break this) — stamp results after the workflow returns, or pass timestamps via args.`;
