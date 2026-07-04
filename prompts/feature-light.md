---
description: "Lightweight feature/fix chain: implement, review, fix-up (file-handoff)"
---

# /feature-light

Run a 3-step chain via the `Agent` tool's native `chain` parameter. Each step writes to `{chain_dir}` and downstream steps consume via `reads:` (full content, bypasses compaction).

**User task**: $@

## Step -1: Escalation gate (REQUIRED, check before Step 0)

`/feature-light` skips Explore, Plan, and any informed fan-out decision. That is only safe when the task is small enough that one worker can hold the whole thing in one pass. Before proceeding, check the task against every line below. If ANY line is true, STOP and use `/feature` instead — tell the user why in one sentence and switch.

- Touches more than one architectural layer (e.g. backend + frontend, server + CLI plugin, schema + consumer) in the same change.
- Touches 3 or more files that are not all trivial variations of the same edit (e.g. renaming a symbol everywhere doesn't count; changing three unrelated modules to support one feature does).
- Requires understanding cross-file contracts or data flow you cannot see just by reading the task text (i.e. you would need to explore the codebase first to know what "done" requires).
- The task description itself lists several sub-parts, phases, or "and also" clauses.
- You are unsure whether it is scoped enough to hold in one worker's head. Default to `/feature` when unsure — the cost of an extra Explore+Plan pass is small, the cost of a 1000+ second single-worker mega-diff is not.

Only proceed past this gate when the task is truly one tightly-coupled, single-layer change: a bug fix, a small UI tweak, a single function's behavior, one config change.

## Step 0: Tighten the requirement (REQUIRED, do not skip)

Turn the user task ($@) into a clearly bounded requirement before invoking the chain.

Use the ask-user / interview tool to ask pointed clarifying questions. One upfront round prevents wasted worker/reviewer turns.

Cover only intent gaps the worker/reviewer cannot derive from the codebase:

- **Acceptance criteria**: what "done" looks like
- **Scope boundaries**: what is IN, what is OUT
- **Constraints**: libraries to use/avoid, perf/compat targets
- **Non-goals**: things NOT to change
- **Ambiguous trade-offs**: where the user has a preference between reasonable approaches

Do NOT ask about file paths, test cases, or validation commands. The worker derives those. Stop when intent is unambiguous. If the user says "just run it" or "skip questions", proceed with the original task and record that in `{{CONVO_CONTEXT}}`.

The refined requirement becomes `{{TASK}}`.

## Step 0.5: Synthesize context

With the requirement locked, condense the full conversation (clarifying Q&A plus prior chat) into one block: requirements clarified, decisions, constraints, files/symbols mentioned, things ruled out, current branch/PR state. Factual, no speculation. Substitute into `{{CONVO_CONTEXT}}`. Substitute `{{TASK}}` with the refined requirement from Step 0.

## Invoke as a single tool call

```
Agent({
  subagent_type: "general-purpose",
  description: "feature-light chain",
  prompt: "chain",
  chain: [
    {
      subagent_type: "worker",
      description: "Implement task",
      output: "{chain_dir}/worker.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nImplement the task. Edit files directly, add or update tests, run validations. If a decision is ambiguous, pick the least-risky option and log it.\n\nUse write_output to persist your implementation report INCREMENTALLY. Must include:\n- Every file changed (absolute path) with one-line change summary\n- Every test added/modified with file:line\n- Exact validation commands run and full output\n- Every decision you made, with reasoning\n- Open risks discovered during implementation\n- `Need decision:` section only if you stopped on an unapproved decision\n\nVerbose receipts. The reviewer cross-checks against this."
    },
    {
      subagent_type: "reviewer",
      description: "Review diff",
      reads: ["{chain_dir}/worker.md"],
      output: "{chain_dir}/review.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe worker report is prepended above. Inspect the actual diff via `git diff` (and `git status` for untracked files). Cross-check against the worker report.\n\nUse write_output to persist findings. Cover:\n- Correctness/contract violations (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code (file:line)\n- Mismatches between worker report and actual diff\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do not edit."
    },
    {
      subagent_type: "worker",
      description: "Apply review fixes",
      reads: ["{chain_dir}/review.md"],
      output: "{chain_dir}/worker-final.md",
      output_mode: "inline",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe review is prepended above. Apply only the fixes worth doing now. Re-run validations.\n\nUse write_output to persist final report. Must include:\n- Every fix applied (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks"
    }
  ]
})
```

## Check for a parallel implement stage before defaulting to a single worker

Check every task against this, even here: does it touch 2-3 files with NO overlap between them (e.g. one change in file A, an unrelated change in file B)? If yes, replace the worker step with a parallel stage instead of doing them one after another. There is no Plan step here, so YOU (the parent) must define the disjoint partition up front in Step 0.

Most tasks that pass the escalation gate above are small enough that this won't apply — the gate already filtered out cross-cutting, multi-layer work. But do the check; don't skip straight to a single worker out of habit when a task genuinely has two independent parts.

Same rules as `/feature`'s parallel implement: disjoint file ownership (no two packages edit the same file), shared files + repo-wide commands (format-all, codegen, global build) deferred to the fix-up worker, NO `isolation: "worktree"` (the reviewer reads `git diff` in the main tree, so worktree changes would be invisible), `continue_on_error` left at its fail-fast default.

Replace the worker step with:

```
{
  parallel: [
    { subagent_type: "worker", description: "Implement package A", output: "{chain_dir}/worker-a.md", output_mode: "file-only", files: ["<absolute paths package A owns>"],
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_package>\nPACKAGE A. You OWN exactly these files: <absolute paths>.\n</your_package>\n\nImplement ONLY your package. Edit ONLY your owned files. No shared config/lockfiles, no repo-wide commands. Validate ONLY your slice. Use write_output: every file changed (path + summary), every test (file:line), scoped validation output, any out-of-package file you needed (report it, do NOT touch), decisions, risks." },
    { subagent_type: "worker", description: "Implement package B", output: "{chain_dir}/worker-b.md", output_mode: "file-only", files: ["<absolute paths package B owns>"],
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_package>\nPACKAGE B. You OWN exactly these files: <absolute paths>.\n</your_package>\n\nSame contract as package A." }
  ],
  output: "{chain_dir}/worker.md",
  output_mode: "file-only"
}
```

The reviewer reads the merged `worker.md` + the combined `git diff`. The fix-up worker (full tree, no restriction) wires cross-package integration and runs the deferred shared-file + repo-wide validation.

## Rules

- Substitute `{{CONVO_CONTEXT}}` and `{{TASK}}` in every step's `prompt` BEFORE calling `Agent`. Runtime substitutes `{previous}` and `{chain_dir}`.
- Do NOT collapse, skip, or modify chain steps.
- Check for a disjoint-file split before defaulting to a single worker, even on small tasks. Use it when the task splits into non-overlapping files; never with `isolation: "worktree"` (the reviewer needs the main tree).
- Wait for the chain to complete, then report the final summary to the user.
