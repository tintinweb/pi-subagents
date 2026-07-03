---
description: "Execute an existing plan: parallel implement, review, fix-up (file-handoff)"
---

# /execute-plan

Run a 3-step chain via the `Agent` tool's native `chain` parameter, starting from a plan that ALREADY EXISTS (no scout, no planning). The implementation step runs as a parallel stage. Every step writes its output to `{chain_dir}` and downstream steps consume those files via `reads:` (full content, bypasses compaction). `output_mode: file-only` keeps `{previous}` light.

**Plan source**: $@

`$@` is a path to a plan file, the plan text itself, or a reference like "the plan we just wrote". Resolve it to concrete plan content before anything else.

## Step 0: Resolve the plan and partition the work (REQUIRED, do not skip)

1. **Resolve the plan.** If `$@` is a path, read it. If it is a reference to prior work, locate that plan. If inline, use it. You must hold the full plan content.

2. **Partition into N disjoint packages** (usually 2-4) for the parallel workers. Each package is a set of plan steps whose file ownership does NOT overlap any other package:
   - No two packages may edit the same file.
   - Shared files (package.json, lockfiles, shared config/barrels/snapshots) are owned by exactly ONE package, or deferred to the fix-up step.
   - Repo-wide commands that rewrite files (format-all, codegen, global build) are deferred to the fix-up step, never run during the parallel stage.
   - Try a coarser partition (fewer, larger packages) before giving up on splitting entirely — 2 packages with a clean file boundary still beats 1. Only use the single-worker fallback below when the plan is genuinely one coupled change with no clean file boundary at any granularity.

The partition (per-package owned files + assigned plan steps) is substituted into each member prompt. The resolved plan becomes `{{PLAN}}`.

## Step 0.5: Synthesize context

Condense the full conversation into one block: where the plan came from, decisions and constraints already locked, files/symbols mentioned, things ruled out, current branch/PR state. Factual, no speculation. Substitute into `{{CONVO_CONTEXT}}`. Substitute `{{PLAN}}` with the resolved plan from Step 0.

## Why the parallel workers do NOT use worktree isolation

`isolation: "worktree"` commits each worker's changes onto a separate branch that does NOT merge back into the working tree. The reviewer in this chain inspects `git diff` in the main tree, so worktree-isolated changes would be invisible to it. For execution→review→fix to work in one chain, all edits must land in one tree. Safety comes from the strict disjoint partition in Step 0 instead of isolation.

## Parallel stage shape (reference)

A chain element may be a parallel stage that runs several subagents concurrently, then merges their outputs (labeled concat) into the next step's `{previous}`/file. Shape:

```
{
  parallel: [ {step}, {step}, ... ],   // static count, declared up front
  continue_on_error?: boolean,          // default false = fail-fast (one member fails, stage aborts)
  output?: "{chain_dir}/worker.md",     // stage-level merged output
  output_mode?: "file-only"
}
```

The merged file contains `### Member 1 (worker)` and `### Member 2 (worker)` blocks, one per package, so the reviewer reads a single file covering every package. Give each member a non-overlapping (disjoint) file scope so changes never collide. Keep `continue_on_error` at its default (fail-fast) here: a half-applied package leaves the tree in a state the reviewer cannot safely reason about.

## Invoke as a single tool call

Replace the two members below with your actual N packages. Each member prompt must name its OWNED files and assigned plan steps and forbid touching anything else.

```
Agent({
  subagent_type: "general-purpose",
  description: "execute-plan chain",
  prompt: "chain",
  chain: [
    {
      parallel: [
        {
          subagent_type: "worker",
          description: "Implement package A",
          output_mode: "file-only",
          prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan>\n{{PLAN}}\n</plan>\n\n<your_package>\nPACKAGE A. You OWN exactly these files: <list absolute paths>. Assigned plan steps: <list>.\n</your_package>\n\nImplement ONLY your package. Edit ONLY your owned files. Do NOT touch any file outside your owned list, do NOT edit shared config/lockfiles, do NOT run repo-wide format/build/codegen. Validate ONLY your slice (scoped typecheck/test). If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it.\n\nUse write_output to persist your implementation report incrementally. Must include:\n- Every file changed (absolute path) with one-line change summary\n- Every test added/modified with file:line\n- Exact scoped validation commands run and full output per command\n- Any file outside your package you found you needed to touch (do NOT touch it; report it for fix-up)\n- Every decision made beyond the plan, with reasoning\n- Open risks discovered during implementation\n\nVerbose receipts. The reviewer cross-checks against this."
        },
        {
          subagent_type: "worker",
          description: "Implement package B",
          output_mode: "file-only",
          prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan>\n{{PLAN}}\n</plan>\n\n<your_package>\nPACKAGE B. You OWN exactly these files: <list absolute paths>. Assigned plan steps: <list>.\n</your_package>\n\nImplement ONLY your package. Edit ONLY your owned files. Do NOT touch any file outside your owned list, do NOT edit shared config/lockfiles, do NOT run repo-wide format/build/codegen. Validate ONLY your slice (scoped typecheck/test). If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it.\n\nUse write_output to persist your implementation report incrementally. Must include:\n- Every file changed (absolute path) with one-line change summary\n- Every test added/modified with file:line\n- Exact scoped validation commands run and full output per command\n- Any file outside your package you found you needed to touch (do NOT touch it; report it for fix-up)\n- Every decision made beyond the plan, with reasoning\n- Open risks discovered during implementation\n\nVerbose receipts. The reviewer cross-checks against this."
        }
      ],
      output: "{chain_dir}/worker.md",
      output_mode: "file-only"
    },
    {
      subagent_type: "reviewer",
      description: "Review diff",
      reads: ["{chain_dir}/worker.md"],
      output: "{chain_dir}/review.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan>\n{{PLAN}}\n</plan>\n\nThe merged worker reports (one block per package) are prepended above. Inspect the actual combined diff via `git diff` (and `git status` for untracked files). Cross-check the diff against the plan and each worker report.\n\nUse write_output to persist findings incrementally. Review must cover:\n- Plan steps not implemented or implemented wrong (file:line)\n- Correctness/contract violations (file:line)\n- Integration gaps at package boundaries: mismatched signatures, missing wiring between packages, shared files no package updated (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code, premature abstraction (file:line)\n- Mismatches between any worker report and the actual diff\n- Repo-wide validation deferred during the parallel stage that still needs running\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do not edit."
    },
    {
      subagent_type: "worker",
      description: "Apply review fixes",
      reads: ["{chain_dir}/review.md"],
      output: "{chain_dir}/worker-final.md",
      output_mode: "inline",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan>\n{{PLAN}}\n</plan>\n\nThe review is prepended above. You work in the full tree now (no package restriction). Apply the fixes clearly worth doing now, wire up cross-package integration gaps, make the shared-file and global changes deferred during the parallel stage, then run the FULL validation suite (global typecheck, build, full test run, format if the plan requires it).\n\nUse write_output to persist the final report. Must include:\n- Every fix applied (file:line)\n- Every integration gap resolved (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks"
    }
  ]
})
```

## Fallback: plan not cleanly partitionable

Replace the `parallel` stage with a single sequential worker and keep the reviewer and fix-up steps unchanged:

```
{
  subagent_type: "worker",
  description: "Implement plan",
  output: "{chain_dir}/worker.md",
  output_mode: "file-only",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan>\n{{PLAN}}\n</plan>\n\nImplement the plan end-to-end. Edit files, add or update tests, run validations. If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it. Use write_output for a verbose incremental report (every file changed with summary, every test with file:line, exact validation commands and full output, decisions beyond the plan, open risks)."
}
```

## Rules

- Substitute `{{CONVO_CONTEXT}}`, `{{PLAN}}`, and each member's owned-file list + plan steps in every step's `prompt` BEFORE calling `Agent`. Runtime substitutes `{previous}` and `{chain_dir}`, not `{{...}}`.
- The partition is the parent's responsibility and the main source of correctness. Disjoint file ownership is non-negotiable. When in doubt, partition coarser or use the single-worker fallback.
- Do NOT use `isolation: "worktree"` for the parallel members here; it would strand changes on branches the reviewer cannot see.
- Only the fix-up worker runs repo-wide validation/format/build and shared-file changes.
- Do NOT collapse, skip, or modify the review or fix-up steps.
- Wait for the chain to complete, then report the final summary to the user.
