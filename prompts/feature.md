---
description: "E2E feature chain: scout, plan, implement, review, fix-up (file-handoff)"
---

# /feature

Run a 5-step chain via the `Agent` tool's native `chain` parameter. Every step writes its output to `{chain_dir}` and downstream steps consume those files via `reads:` (full content, bypasses compaction). `output_mode: file-only` keeps `{previous}` light.

**User task**: $@

## Step 0: Tighten the requirement (REQUIRED, do not skip)

Turn the user task ($@) into a clearly bounded requirement before invoking the chain.

Use the ask-user / interview tool to ask pointed clarifying questions. The chain is expensive, so one upfront round prevents wasted scout/plan/worker turns.

Cover only intent gaps the planner cannot derive from the codebase:
- **Acceptance criteria**: what "done" looks like, observably
- **Scope boundaries**: what is IN, what is OUT
- **Constraints**: perf budgets, compat targets, libraries to use/avoid, deadlines
- **Non-goals**: things the user does NOT want changed
- **Ambiguous trade-offs**: where multiple reasonable approaches exist and the user has a preference

Do NOT ask about file paths, edge cases, test strategy, or validation commands. The planner derives those. Stop when intent is unambiguous.

If the user says "just run it" or "skip questions", proceed with the original task verbatim and record that in `{{CONVO_CONTEXT}}`.

The refined requirement becomes `{{TASK}}`.

## Step 0.5: Synthesize context

With the requirement locked, condense the full conversation (clarifying Q&A plus prior chat) into one block: requirements clarified, decisions, constraints, files/symbols mentioned, things ruled out, current branch/PR state. Factual, no speculation. Substitute into `{{CONVO_CONTEXT}}`. Substitute `{{TASK}}` with the refined requirement from Step 0.

## Invoke as a single tool call

```
Agent({
  subagent_type: "general-purpose",
  description: "feature chain",
  prompt: "chain",
  chain: [
    {
      subagent_type: "Explore",
      description: "Scout codebase",
      output: "{chain_dir}/scout.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout the codebase for everything relevant to the task. Use write_output to persist findings INCREMENTALLY as you discover them. Do not wait for a final report.\n\nThe findings file must be EXHAUSTIVE:\n- Affected files (absolute paths)\n- Key functions/classes with file:line citations\n- Data flow: which file reads/writes which state\n- Existing test files and their coverage scope\n- Patterns already used in this area the implementation must follow\n- Concrete risks with file:line evidence\n- Open questions the planner must resolve\n\nCite every claim. The planner depends on this report being complete enough to plan without re-reading the codebase."
    },
    {
      subagent_type: "Plan",
      description: "Implementation plan",
      reads: ["{chain_dir}/scout.md"],
      output: "{chain_dir}/plan.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe scout findings are prepended above as <context>. Produce an EXHAUSTIVE implementation plan. Use write_output to persist incrementally.\n\nPlan must include:\n- File-by-file changes with absolute paths and exact functions/lines\n- Test strategy: which tests to add/update, which files, what they assert\n- Edge cases enumerated with handling\n- Validation commands (exact shell invocations)\n- Rollback strategy\n- Sequencing if order matters\n- Explicit decisions on every open question from the scout findings; cite which evidence resolved each\n\nDo NOT defer decisions to the worker. If genuinely ambiguous, list options with tradeoffs and pick one with reasoning."
    },
    {
      subagent_type: "worker",
      description: "Implement plan",
      reads: ["{chain_dir}/plan.md"],
      output: "{chain_dir}/worker.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe plan is prepended above. Implement it end-to-end. Edit files, add or update tests, run validations. If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it.\n\nUse write_output to persist your implementation report incrementally. The report must include:\n- Every file changed (absolute path) with one-line change summary\n- Every test added/modified with file:line\n- Exact validation commands run and full output per command\n- Every decision you made beyond the plan, with reasoning\n- Open risks discovered during implementation\n- `Need decision:` section only if you stopped on an unapproved decision\n\nVerbose receipts. The reviewer cross-checks against this."
    },
    {
      subagent_type: "reviewer",
      description: "Review diff",
      reads: ["{chain_dir}/plan.md", "{chain_dir}/worker.md"],
      output: "{chain_dir}/review.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nPlan and worker report are prepended above. Inspect the actual diff via `git diff` (and `git status` for untracked files). Cross-check the diff against plan and worker report.\n\nUse write_output to persist findings incrementally. Review must cover:\n- Correctness/contract violations (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code, premature abstraction (file:line)\n- Mismatches between worker report and actual diff\n- Mismatches between plan and actual diff\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do not edit."
    },
    {
      subagent_type: "worker",
      description: "Apply review fixes",
      reads: ["{chain_dir}/review.md"],
      output: "{chain_dir}/worker-final.md",
      output_mode: "inline",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe review is prepended above. Apply only the fixes clearly worth doing now. Re-run validations.\n\nUse write_output to persist the final report. Must include:\n- Every fix applied (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks"
    }
  ]
})
```

## Optional: parallel scout stage (use when applicable)

A chain element may be a parallel stage that runs several subagents concurrently, then merges their outputs (labeled concat) into the next step's `{previous}`/file. Shape:

```
{
  parallel: [ {step}, {step}, ... ],   // static count, declared up front
  continue_on_error?: boolean,          // default false = fail-fast
  output?: "{chain_dir}/scout.md",      // stage-level merged output
  output_mode?: "file-only"
}
```

Apply this ONLY when recon splits into clearly separable domains (e.g. frontend vs backend, two independent services). For most tasks the single Explore step is simpler and cheaper, so do not parallelize by default. When it applies, replace the first Explore step with a parallel scout stage and keep the rest of the chain identical:

```
chain: [
  {
    parallel: [
      { subagent_type: "Explore", description: "Scout frontend", output_mode: "file-only",
        prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout ONLY the frontend/UI layer for everything relevant. Use write_output. Cite every claim file:line." },
      { subagent_type: "Explore", description: "Scout backend", output_mode: "file-only",
        prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout ONLY the backend/data layer for everything relevant. Use write_output. Cite every claim file:line." }
    ],
    output: "{chain_dir}/scout.md",
    output_mode: "file-only"
  },
  { subagent_type: "Plan", reads: ["{chain_dir}/scout.md"], output: "{chain_dir}/plan.md", output_mode: "file-only", prompt: "...{{TASK}}... plan from the merged scout findings ..." },
  // worker, reviewer, worker (unchanged)
]
```

The merged `scout.md` contains `### Member 1 (Explore)` and `### Member 2 (Explore)` blocks, so Plan reads one file covering both domains. Give each member a non-overlapping scope so findings do not duplicate.

## Rules

- Substitute `{{CONVO_CONTEXT}}` and `{{TASK}}` in every step's `prompt` BEFORE calling `Agent`. Runtime substitutes `{previous}` and `{chain_dir}`, not `{{...}}`.
- Do NOT collapse, skip, or modify chain steps.
- Parallel scout stage is OPTIONAL. Use only when recon splits into separable domains. Default to the single Explore step.
- If parallel members ever edit files (not the scout case), give each `isolation: "worktree"` to avoid races.
- Wait for the chain to complete, then report the final summary to the user.
