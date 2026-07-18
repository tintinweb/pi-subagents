---
description: "Execute an existing plan: parallel implement, review, fix-up (coordinator-driven)"
---

# /execute-plan

You are the **coordinator**. You dispatch individual Agent() calls, read their results, synthesize understanding, and write the next agent's prompt. You start from a plan that ALREADY EXISTS — no scout, no planning.

The flow is: resolve plan → present to user → implement (parallel) → review → fix-up. Each step is a separate Agent() call (or set of parallel calls). You wait for each to complete before deciding the next.

**Plan source**: $@

`$@` is a path to a plan file, the plan text itself, or a reference like "the plan we just wrote". Resolve it to concrete plan content before anything else.

## Step 0: Resolve the plan and partition the work (REQUIRED, do not skip)

1. **Resolve the plan.** If `$@` is a path, read it. If it is a reference to prior work, locate that plan. If inline, use it. You must hold the full plan content.

2. **Verify the plan has per-file structure.** The plan should describe changes organized by file (path, action, what to change, cross-file relationships). If the plan is unstructured or vague, reorganize it by file yourself before partitioning — workers need to know which files they own and what to build in each.

3. **Partition into N disjoint packages** (usually 2-4) for the parallel workers. **Parallel is the default — the decision is mechanical.** Look at the file paths. Group them so no two groups share a file. If you can form 2+ groups, it's parallel. Period.
   - No two packages may edit the same file.
   - Shared files (package.json, lockfiles, shared config/barrels/snapshots) are owned by exactly ONE package, or deferred to the fix-up step.
   - Repo-wide commands that rewrite files (format-all, codegen, global build) are deferred to the fix-up step, never run during the parallel stage.
   - **Five files that import from each other are five disjoint files.** The plan's cross-file contracts tell workers what to expect from files they don't own. The fix-up worker resolves mismatches. Import relationships are not file overlap.
   - Try a coarser partition (fewer, larger packages) before giving up on splitting entirely — 2 packages with a clean file boundary still beats 1. Only use the single-worker fallback when every change targets the same file(s) and a disjoint partition is literally impossible.

Each worker prompt must include a synthesized implementation directive for its files — not just file paths and step numbers. Workers should know WHAT to build from their prompt without parsing the whole plan. The resolved plan becomes `{{PLAN}}`.

## Step 0.5: Synthesize context

Condense the full conversation into one block: where the plan came from, decisions and constraints already locked, files/symbols mentioned, things ruled out, current branch/PR state. Factual, no speculation. Substitute into `{{CONVO_CONTEXT}}`. Substitute `{{PLAN}}` with the resolved plan from Step 0.

## Step 0.6: Create scratch directory

```bash
mkdir -p /tmp/pi-ep-XXXXX
```

Replace `XXXXX` with a random short identifier.

---

## Step 1: Present plan to user

Read the plan. Present a concise summary to the user: what files change, the approach, the parallel partition, key decisions, risks. Ask for approval. **Do NOT proceed to implementation until the user says "go".**

---

## Step 2: Implement (parallel by default)

Once the user approves, launch parallel workers in ONE message. For each package, write a synthesized implementation directive.

Do NOT use `isolation: "worktree"` — the reviewer reads `git diff` in the main tree.

**Parallel implementation (example with 2 packages — add/remove members to match your partition):**

```
Agent({
  subagent_type: "worker",
  description: "Implement package A",
  files: ["/absolute/path/to/file1.ts", "/absolute/path/to/file2.ts"],
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<your_files>\n<SYNTHESIZED_DIRECTIVE_FOR_PACKAGE_A>\n</your_files>\n\nImplement ONLY the files described above. Edit ONLY your listed files. Do NOT touch any file outside your list, do NOT edit shared config/lockfiles, do NOT run repo-wide format/build/codegen. Validate ONLY your slice (scoped typecheck/test).\n\nWrite your report to /tmp/pi-ep-XXXXX/worker-a.md. Include: every file changed (absolute path + one-line summary), every test added/modified (file:line), exact scoped validation commands run with full output, any file outside your list you needed to touch (do NOT touch it — report it for fix-up), every decision made beyond the plan with reasoning, open risks.",
  run_in_background: true,
})

Agent({
  subagent_type: "worker",
  description: "Implement package B",
  files: ["/absolute/path/to/file3.ts", "/absolute/path/to/file4.ts"],
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<your_files>\n<SYNTHESIZED_DIRECTIVE_FOR_PACKAGE_B>\n</your_files>\n\nSame contract as package A: implement ONLY your listed files, no shared/global changes, validate your slice. Write your report to /tmp/pi-ep-XXXXX/worker-b.md.",
  run_in_background: true,
})
```

All workers launched in ONE message with `run_in_background: true`. Wait for all to complete before proceeding.

**Single worker (only when every change targets the same file):**

```
Agent({
  subagent_type: "worker",
  description: "Implement plan",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan>\n{{PLAN}}\n</plan>\n\nImplement the plan end-to-end. Edit files, add or update tests, run validations. If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it.\n\nWrite your report to /tmp/pi-ep-XXXXX/worker.md. Include: every file changed with summary, every test with file:line, exact validation commands and full output, decisions beyond the plan, open risks.",
})
```

---

## Step 3: Review

Read the worker reports. Synthesize: extract which files changed, which tests were added, what risks were flagged, what integration gaps exist. Do NOT paste raw reports.

```
Agent({
  subagent_type: "reviewer",
  description: "Review diff",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan_summary>\n<KEY_PARTS_OF_THE_PLAN>\n</plan_summary>\n\n<worker_synthesis>\n<YOUR_SYNTHESIZED_WORKER_FINDINGS>\n</worker_synthesis>\n\nInspect the actual diff via `git diff` (and `git status` for untracked files). Cross-check the diff against the plan and what workers reported.\n\nWrite your review to /tmp/pi-ep-XXXXX/review.md. Cover:\n- Plan steps not implemented or implemented wrong (file:line)\n- Correctness/contract violations (file:line)\n- Integration gaps at package boundaries: mismatched signatures, missing wiring, shared files no package updated (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code, premature abstraction (file:line)\n- Mismatches between worker reports and actual diff\n- Repo-wide validation deferred during implementation that still needs running\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do NOT edit files.",
})
```

Wait for the reviewer. Read the review.

---

## Step 4: Fix-up

Read the review. Synthesize the blocker findings. Launch a fix-up worker with full tree access:

```
Agent({
  subagent_type: "worker",
  description: "Apply review fixes",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<plan_summary>\n<KEY_PARTS_OF_THE_PLAN>\n</plan_summary>\n\n<review_synthesis>\n<SYNTHESIZED_REVIEW_FINDINGS>\n</review_synthesis>\n\nYou work in the full tree now (no package restriction). Apply the fixes clearly worth doing now, wire up cross-package integration gaps, make the shared-file and global changes deferred during the parallel stage, then run the FULL validation suite (global typecheck, build, full test run, format if the plan requires it).\n\nWrite your final report to /tmp/pi-ep-XXXXX/worker-final.md. Include:\n- Every fix applied (file:line)\n- Every integration gap resolved (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks",
})
```

Wait for the fix-up worker. Read the final report. Summarize to the user.

---

## Rules

- You are the coordinator. You dispatch Agent() calls, read results, synthesize, write the next prompt. Each step is a separate dispatch.
- **Synthesis rule**: never paste an agent's raw output into another agent's prompt. Read the result, extract specific paths/facts/directives, and write a fresh prompt.
- **Large handoffs**: tell agents to write to file paths in the scratch directory. Read those files yourself, synthesize, pass key findings to the next agent.
- **Parallel by default**: when the plan yields ≥2 disjoint-file groups with real work, launch parallel background workers. Imports between files are not coupling. Single worker only for trivial scope or literal file overlap. Don't fan out one-line edits.
- Do NOT skip or modify the review or fix-up steps.
- Do NOT use `isolation: "worktree"` for implement workers — the reviewer needs `git diff` in the main tree.
- Each worker prompt must include synthesized directives for its specific files, not "implement plan steps 3-7" and not raw plan text.
- Wait for each step's agents to complete before issuing the next step.
