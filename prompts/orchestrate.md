---
description: "Fan out independent work threads to autonomous orchestrator subagents, each in its own worktree"
---

# /orchestrate

Run several independent work threads at once. Each thread is handed to its own **orchestrator** subagent that owns the feature end to end and freely spawns its own subagents (scout, implement, review) to get it done. Orchestrators run concurrently as a single `parallel` chain stage, each in an isolated git worktree, so their changes never collide.

This is the right tool when one conversation contains two or more genuinely separate pieces of work (for example two features, or a feature plus an unrelated refactor). For a single feature, use `/feature` instead.

**User request**: $@

## How it works

- The parent (you) splits `$@` into N independent threads and spawns one orchestrator per thread.
- Each orchestrator is a `general-purpose` subagent, so it inherits the parent system prompt (including the delegation rules) and knows how to run its own scout, plan, implement, review subagents.
- Each orchestrator runs with `isolation: "worktree"`, so it gets a private copy of the repo. All of its edits, and the edits of every subagent it spawns, land in that worktree and are committed to a branch (`pi-agent-<id>`) on completion.
- Nesting is one level deep by design: the orchestrator (depth 1) spawns workers (depth 2). Depth-2 workers cannot nest further, which keeps the tree bounded.

## Step 0: Partition into independent threads (REQUIRED, do not skip)

1. Read `$@` and identify the distinct pieces of work. Each becomes one thread.
2. Confirm the threads are actually independent. They must not depend on each other's output, and ideally touch different areas of the codebase. Worktree isolation prevents file clobbering, but two threads that both need the same new shared module will each build their own copy on separate branches, which you then have to reconcile by hand.
3. If the work is really one feature with internal steps, or the threads are tightly coupled, STOP and use `/feature` (single thread) instead. Tell the user why.
4. Keep it to 2 to 4 threads. More than the background concurrency limit (default 4) will queue and lose the parallelism.

For each thread, write a self-contained brief: the goal (what done looks like, observably), the relevant area of the codebase, constraints, and what is out of scope. The orchestrator starts cold, so the brief must stand alone.

## Step 0.5: Synthesize context

Condense the conversation into one shared block: decisions, constraints, libraries to use or avoid, branch/PR state, anything ruled out. Substitute it into `{{CONVO_CONTEXT}}` in every member prompt. Substitute each thread's brief into its own `{{THREAD_GOAL}}`.

## Invoke as a single tool call

The chain has two steps: a `parallel` stage with one member per thread, then a summary step that formats the merged reports for the user. The summary step is required: a chain must have at least two elements, and a lone parallel stage counts as one.

The example shows two threads; add or remove parallel members to match your partition. Leave the members at their default output (inline) so the stage collects them; the stage writes the merged reports to a file, which the summary step reads.

```
Agent({
  subagent_type: "general-purpose",
  description: "orchestrate threads",
  prompt: "chain",
  chain: [
    {
      parallel: [
        {
          subagent_type: "general-purpose",
          description: "Orchestrate: <thread 1 name>",
          isolation: "worktree",
          prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<your_thread>\n{{THREAD_1_GOAL}}\n</your_thread>\n\nYou are the orchestrator for this thread. Own it end to end: understand the requirement, scout the codebase, plan, implement, test, and self-review. You run in an isolated git worktree, so every change you and your subagents make lands here and is committed to a branch when you finish.\n\nDelegate the work to your own subagents instead of doing it all yourself. You are the decision maker; subagents return evidence and edits, you decide. Typical flow: spawn Explore for recon, a worker (or a parallel set of workers on disjoint files) to implement, and a reviewer to check the diff, then apply fixes. Use the Agent tool's chain mode if a linear scout to implement to review flow fits.\n\nValidate before you finish: run the project's typecheck, lint, and tests for the area you touched. Do not leave the worktree in a broken state.\n\nReturn a single report:\n- Goal and whether it is met\n- Every file changed (absolute path) with a one-line summary\n- Tests added or changed (file:line)\n- Validation commands run and their result\n- Decisions made beyond the brief, with reasoning\n- Open risks or follow-ups\n- The branch your changes were committed to"
        },
        {
          subagent_type: "general-purpose",
          description: "Orchestrate: <thread 2 name>",
          isolation: "worktree",
          prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<your_thread>\n{{THREAD_2_GOAL}}\n</your_thread>\n\nSame contract as thread 1: you are the orchestrator, you run in your own worktree, you delegate scout/implement/review to your own subagents, you validate before finishing, and you return the same structured report including your branch name."
        }
      ],
      output: "{chain_dir}/orchestration.md",
      output_mode: "file-only"
    },
    {
      subagent_type: "general-purpose",
      description: "Summarize threads",
      reads: ["{chain_dir}/orchestration.md"],
      prompt: "The merged orchestrator reports are prepended above, one block per thread. Produce a concise per-thread summary for the user and nothing else. For each thread: goal, status (done / partial / blocked), files touched, validation result, and the branch it committed to with its `git merge <branch>` command. Do NOT merge any branch. Do NOT edit files. Output the summary directly."
    }
  ]
})
```

## After the chain

The final step returns the formatted per-thread summary. Relay it to the user, including the `git merge <branch>` command for each thread.

Do NOT merge the branches yourself. Merging is the user's decision, and threads may need to land in a specific order or be reviewed first.

## Rules

- Substitute `{{CONVO_CONTEXT}}` and every `{{THREAD_N_GOAL}}` in the member prompts BEFORE calling `Agent`. Runtime substitutes `{previous}` and `{chain_dir}`, not `{{...}}`.
- Keep the two-step shape: parallel stage, then the summary step. A chain needs at least two elements, so do not drop the summary step.
- Parallel members keep the default inline output (do not set `output_mode: "file-only"` on a member without giving it its own `output` path). The stage-level `output` collects them into one file for the summary step.
- Every member MUST set `isolation: "worktree"`. Parallel orchestrators that write to the shared tree would clobber each other.
- Worktree isolation needs a git repo with at least one commit. If the repo is not initialized, tell the user before running.
- One member per independent thread, 2 to 4 members. If the work is a single feature, use `/feature` instead.
- Wait for the chain to complete, then relay the summary and the branches to merge.
