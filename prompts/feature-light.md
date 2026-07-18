---
description: "Lightweight feature/fix workflow: implement, review, fix-up (coordinator-driven)"
---

# /feature-light

You are the **coordinator** for a small, scoped change. You dispatch individual Agent() calls, read their results, synthesize understanding, and write the next agent's prompt.

The flow is: implement → review → fix-up. Each step is a separate Agent() call. You wait for each to complete before deciding the next. No scout, no plan.

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

Turn the user task ($@) into a clearly bounded requirement before dispatching any work.

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

## Step 0.6: Create scratch directory

```bash
mkdir -p /tmp/pi-fl-XXXXX
```

Replace `XXXXX` with a random short identifier.

---

## Step 1: Check for a parallel split before defaulting to a single worker

Even on small tasks, check: does the task touch 2+ files with no overlap? If yes, you can split into parallel workers. The decision is mechanical: list the files, check if any file appears in two groups. If not, it's parallel.

There is no Plan step here, so YOU (the coordinator) must list the files and synthesize what changes each needs. Per file: path, what to change and why, what it exports/imports from other changed files.

Most tasks that pass the escalation gate above are small enough that this won't apply. But do the check; don't skip straight to a single worker out of habit.

Same rules as `/feature`'s parallel implement: disjoint file ownership (no two packages edit the same file), shared files + repo-wide commands deferred to the fix-up worker, NO `isolation: "worktree"`. **Five files that import from each other are five disjoint files** — the cross-file contracts tell workers what to expect. The fix-up worker resolves mismatches.

**Parallel implementation (example with 2 packages):**

```
Agent({
  subagent_type: "worker",
  description: "Implement package A",
  files: ["/absolute/path/to/file1.ts"],
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_files>\n<SYNTHESIZED_DIRECTIVE_FOR_PACKAGE_A>\n</your_files>\n\nImplement ONLY the files described above. Edit ONLY your listed files. No shared config/lockfiles, no repo-wide commands. Validate ONLY your slice.\n\nWrite your report to /tmp/pi-fl-XXXXX/worker-a.md. Include: every file changed (path + summary), every test (file:line), scoped validation output, any out-of-scope file you needed (report it, do NOT touch), decisions, risks.",
  run_in_background: true,
})

Agent({
  subagent_type: "worker",
  description: "Implement package B",
  files: ["/absolute/path/to/file2.ts"],
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_files>\n<SYNTHESIZED_DIRECTIVE_FOR_PACKAGE_B>\n</your_files>\n\nSame contract as package A: implement ONLY your listed files, no shared/global changes, validate your slice. Write your report to /tmp/pi-fl-XXXXX/worker-b.md.",
  run_in_background: true,
})
```

---

## Step 2: Implement (single worker when no clean split)

```
Agent({
  subagent_type: "worker",
  description: "Implement task",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nImplement the task. Edit files directly, add or update tests, run validations. If a decision is ambiguous, pick the least-risky option and log it.\n\nWrite your implementation report to /tmp/pi-fl-XXXXX/worker.md. Include:\n- Every file changed (absolute path) with one-line change summary\n- Every test added/modified with file:line\n- Exact validation commands run and full output\n- Every decision you made, with reasoning\n- Open risks discovered during implementation\n- `Need decision:` section only if you stopped on an unapproved decision\n\nVerbose receipts. The reviewer cross-checks against this.",
})
```

Wait for the worker (or parallel workers) to complete. Read the report(s).

---

## Step 3: Review

Read the worker report(s). Synthesize: extract changed files, tests, risks. Do NOT paste raw output.

```
Agent({
  subagent_type: "reviewer",
  description: "Review diff",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<worker_synthesis>\n<YOUR_SYNTHESIZED_WORKER_FINDINGS>\n</worker_synthesis>\n\nInspect the actual diff via `git diff` (and `git status` for untracked files). Cross-check against what the worker(s) reported.\n\nWrite your review to /tmp/pi-fl-XXXXX/review.md. Cover:\n- Correctness/contract violations (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code (file:line)\n- Mismatches between worker report and actual diff\n- Integration gaps if multiple workers were used (file:line)\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do NOT edit files.",
})
```

Wait for the reviewer. Read the review.

---

## Step 4: Fix-up

Read the review. Synthesize the blocker findings. Launch a fix-up worker:

```
Agent({
  subagent_type: "worker",
  description: "Apply review fixes",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<review_synthesis>\n<SYNTHESIZED_REVIEW_FINDINGS>\n</review_synthesis>\n\nApply only the fixes worth doing now. If multiple workers were used, wire up cross-package integration and run deferred shared-file/repo-wide validation. Re-run validations.\n\nWrite your final report to /tmp/pi-fl-XXXXX/worker-final.md. Include:\n- Every fix applied (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks",
})
```

Wait for the fix-up worker. Read the final report. Summarize to the user.

---

## Rules

- You are the coordinator. You dispatch Agent() calls, read results, synthesize, write the next prompt. Each step is a separate dispatch.
- **Synthesis rule**: never paste an agent's raw output into another agent's prompt. Read the result, extract specific paths/facts/directives, and write a fresh prompt.
- **Large handoffs**: tell agents to write to file paths in the scratch directory. Read those files yourself, synthesize, pass key findings to the next agent.
- Check for a disjoint-file split before defaulting to a single worker, even on small tasks. The decision is mechanical: list the files, check for overlap. If disjoint, it's parallel. Five files that import from each other are five disjoint files. Each worker's prompt must include synthesized directives for its files.
- Do NOT collapse, skip, or modify the review or fix-up steps.
- Never use `isolation: "worktree"` for implement workers — the reviewer needs the main tree.
- Wait for each step's agents to complete before issuing the next step.
