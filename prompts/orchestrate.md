---
description: "Fan out independent work threads to autonomous orchestrator subagents, each in its own worktree"
---

# /orchestrate

You are the **coordinator**. You split the user's request into independent threads and hand each to an autonomous orchestrator agent running in its own git worktree. Orchestrators run concurrently — launch them all in ONE message with `run_in_background: true`.

Each orchestrator is a `general-purpose` subagent, so it inherits the parent system prompt (including delegation rules) and knows how to run its own scout, implement, review agents. Nesting is one level deep by design: the orchestrator (depth 1) spawns workers (depth 2). Depth-2 workers cannot nest further.

This is the right tool when one conversation contains two or more genuinely separate pieces of work (for example two features, or a feature plus an unrelated refactor). For a single feature, use `/feature` instead.

**User request**: $@

## Step 0: Partition into independent threads (REQUIRED, do not skip)

1. Read `$@` and identify the distinct pieces of work. Each becomes one thread.
2. Confirm the threads are actually independent. They must not depend on each other's output, and ideally touch different areas of the codebase. Worktree isolation prevents file clobbering, but two threads that both need the same new shared module will each build their own copy on separate branches, which you then have to reconcile by hand.
3. If the work is really one feature with internal steps, or the threads are tightly coupled, STOP and use `/feature` (single thread) instead. Tell the user why.
4. Keep it to 2 to 4 threads. More than the background concurrency limit (default 4) will queue and lose the parallelism.

For each thread, write a self-contained brief: the goal (what done looks like, observably), the relevant area of the codebase, constraints, and what is out of scope. The orchestrator starts cold, so the brief must stand alone.

## Step 0.5: Synthesize context

Condense the conversation into one shared block: decisions, constraints, libraries to use or avoid, branch/PR state, anything ruled out. Substitute it into `{{CONVO_CONTEXT}}` in every member prompt. Substitute each thread's brief into its own `{{THREAD_GOAL}}`.

---

## Launch all orchestrators in ONE message

The example shows two threads; add or remove members to match your partition. Every orchestrator MUST set `isolation: "worktree"` — parallel orchestrators that write to the shared tree would clobber each other.

```
Agent({
  subagent_type: "general-purpose",
  description: "Orchestrate: <thread 1 name>",
  isolation: "worktree",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<your_thread>\n{{THREAD_1_GOAL}}\n</your_thread>\n\nYou are the orchestrator for this thread. Own it end to end: understand the requirement, scout the codebase, plan, implement, test, and self-review. You run in an isolated git worktree, so every change you and your subagents make lands here and is committed to a branch when you finish.\n\nDelegate the work to your own subagents instead of doing it all yourself. You are the decision maker; subagents return evidence and edits, you decide. Typical flow: spawn Explore for recon, a worker (or parallel workers on disjoint files) to implement, and a reviewer to check the diff, then apply fixes.\n\nValidate before you finish: run the project's typecheck, lint, and tests for the area you touched. Do not leave the worktree in a broken state.\n\nReturn a single report:\n- Goal and whether it is met\n- Every file changed (absolute path) with a one-line summary\n- Tests added or changed (file:line)\n- Validation commands run and their result\n- Decisions made beyond the brief, with reasoning\n- Open risks or follow-ups\n- The branch your changes were committed to",
  run_in_background: true,
})

Agent({
  subagent_type: "general-purpose",
  description: "Orchestrate: <thread 2 name>",
  isolation: "worktree",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<your_thread>\n{{THREAD_2_GOAL}}\n</your_thread>\n\nSame contract as thread 1: you are the orchestrator, you run in your own worktree, you delegate scout/implement/review to your own subagents, you validate before finishing, and you return the same structured report including your branch name.",
  run_in_background: true,
})
```

Wait for all orchestrators to complete. Check results with `get_subagent_result`.

---

## After all threads complete

Read each orchestrator's result. Synthesize a per-thread summary:

- Goal, status (done / partial / blocked)
- Files touched
- Validation result
- The branch it committed to with its `git merge <branch>` command

Present the summary to the user. Do NOT merge any branch yourself — merging is the user's decision, and threads may need to land in a specific order or be reviewed first.

---

## Rules

- You are the coordinator. You launch orchestrators, read their results, and summarize.
- Every orchestrator MUST set `isolation: "worktree"` — they run concurrently and must not clobber each other.
- Worktree isolation needs a git repo with at least one commit. If the repo is not initialized, tell the user before running.
- One orchestrator per independent thread, 2 to 4 threads. If the work is a single feature, use `/feature` instead.
- **Synthesis rule**: when summarizing results, extract the key facts from each orchestrator — do not paste raw output.
- Wait for all orchestrators to complete before presenting the summary.
