---
description: "E2E feature workflow: scout, plan, implement, review, fix-up (coordinator-driven)"
---

# /feature

You are the **coordinator** for this feature. You dispatch individual Agent() calls, read their results, synthesize understanding, and write the next agent's prompt. You drive the workflow step by step.

The flow is: scout → plan → present to user → implement → review → fix-up. Each step is a separate Agent() call (or set of parallel calls). You wait for each to complete before deciding the next.

**User task**: $@

## Step 0: Clarify requirements (REQUIRED, do not skip)

Turn the user task ($@) into a clearly bounded requirement before dispatching any work.

Use the ask-user / interview tool to ask pointed clarifying questions. One upfront round prevents wasted scout/plan/worker turns.

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

## Step 0.6: Create scratch directory

Create a scratch directory for this feature:

```bash
mkdir -p /tmp/pi-feature-XXXXX
```

Replace `XXXXX` with a random short identifier. All agents will write their reports here. You read them between steps.

---

## Step 1: Scout (parallel when applicable)

Determine whether the task touches 2+ separable domains (frontend + backend, CLI + library, two independent services). If yes, launch parallel scouts in ONE message. If single-domain, one foreground scout is fine.

**Parallel scout (2+ domains):**

```
Agent({
  subagent_type: "Explore",
  description: "Scout frontend",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout ONLY the frontend/UI layer for everything relevant to the task. Write your findings to /tmp/pi-feature-XXXXX/scout-frontend.md — be EXHAUSTIVE: every affected file (absolute path), every key function/class with file:line, data flow, existing tests, patterns to follow, concrete risks with file:line evidence, and open questions. Do NOT write a summary at the end — just write the findings file and stop.",
  run_in_background: true,
})

Agent({
  subagent_type: "Explore",
  description: "Scout backend",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout ONLY the backend/data layer for everything relevant to the task. Write your findings to /tmp/pi-feature-XXXXX/scout-backend.md — be EXHAUSTIVE: every affected file (absolute path), every key function/class with file:line, data flow, existing tests, patterns to follow, concrete risks with file:line evidence, and open questions. Do NOT write a summary at the end — just write the findings file and stop.",
  run_in_background: true,
})
```

Wait for both to complete (check results via `get_subagent_result`).

**Single-domain scout:**

```
Agent({
  subagent_type: "Explore",
  description: "Scout codebase",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout the codebase for everything relevant to the task. Write your findings to /tmp/pi-feature-XXXXX/scout.md — be EXHAUSTIVE: every affected file (absolute path), every key function/class with file:line, data flow, existing tests, patterns to follow, concrete risks with file:line evidence, and open questions. Do NOT write a summary at the end — just write the findings file and stop.",
})
```

---

## Step 2: Plan

**Read the scout findings.** Do NOT paste raw scout output into the Plan prompt. Synthesize: extract specific file paths, symbols, patterns, risks, and open questions. Write a concise synthesis paragraph for the Plan agent.

**Launch the Plan agent with your synthesized findings:**

```
Agent({
  subagent_type: "Plan",
  description: "Implementation plan",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<scout_synthesis>\n<YOUR_SYNTHESIZED_FINDINGS_HERE>\n</scout_synthesis>\n\nProduce an EXHAUSTIVE implementation plan. Write the plan to /tmp/pi-feature-XXXXX/plan.md.\n\nPlan must be organized as per-file sections — one section per file the plan touches. This structure is what makes parallel implementation possible.\n\nPer-file section (REQUIRED for every file):\n- Path (absolute) and action (NEW or MODIFY)\n- What to change and why: outcome-level description. Name the functions/types/exports involved but do NOT pre-write exact signatures — that is the worker's job.\n- Cross-file contracts: if this file exports something other changed files will consume, or imports from other changed files, name those relationships. This is what makes parallel safe.\n- Tests: which test file covers this, what behaviors to assert.\n\nAlso include:\n- Edge cases with handling\n- Validation commands (exact shell invocations)\n- Rollback strategy\n- Explicit decisions on every open question from the scout synthesis; cite which evidence resolved each\n\nDo NOT defer decisions to the worker. If genuinely ambiguous, list options with tradeoffs and pick one with reasoning.",
})
```

Wait for the Plan agent to complete. Then read `/tmp/pi-feature-XXXXX/plan.md`.

---

## Step 3: Present plan to user

Read the plan. Present a concise summary to the user: what files change, the approach, key decisions, risks. Ask for approval. **Do NOT proceed to implementation until the user says "go".**

---

## Step 4: Implement

Once the user approves, **read the plan's per-file sections.** Partition them into 2-4 groups where no two groups share a file path. This is the ONLY criterion — imports between files are not file overlap. Five frontend files that import from each other are five disjoint files.

**Parallel is the default.** If you can form 2+ disjoint groups, use parallel. Only fall back to a single worker when every per-file section targets the SAME file(s).

For each group, write a synthesized implementation directive: what to build in each file, what cross-file contracts to respect, what tests to write. Do NOT paste raw plan text — extract and synthesize the parts relevant to that group's files.

Do NOT use `isolation: "worktree"` — the reviewer reads `git diff` in the main tree.

**Parallel implementation (2-4 groups):**

```
Agent({
  subagent_type: "worker",
  description: "Implement group A",
  files: ["/absolute/path/to/file1.ts", "/absolute/path/to/file2.ts"],
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_files>\n<SYNTHESIZED_DIRECTIVE_FOR_GROUP_A_FILES>\n</your_files>\n\nImplement ONLY the files described above. Edit ONLY your listed files. Do NOT touch files outside your list, edit shared config/lockfiles, or run repo-wide format/build/codegen. Validate ONLY your slice (scoped typecheck/test).\n\nWrite your implementation report to /tmp/pi-feature-XXXXX/worker-a.md. Include: every file changed (absolute path + one-line summary), every test added/modified (file:line), exact scoped validation commands run with full output, any file outside your list you found you needed to touch (do NOT touch it — report it for fix-up), every decision made beyond the plan with reasoning, open risks.",
  run_in_background: true,
})

Agent({
  subagent_type: "worker",
  description: "Implement group B",
  files: ["/absolute/path/to/file3.ts", "/absolute/path/to/file4.ts"],
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_files>\n<SYNTHESIZED_DIRECTIVE_FOR_GROUP_B_FILES>\n</your_files>\n\nSame contract as group A: implement ONLY your listed files, no shared/global changes, validate your slice. Write your report to /tmp/pi-feature-XXXXX/worker-b.md.",
  run_in_background: true,
})
```

All workers launched in ONE message with `run_in_background: true`. Wait for all to complete before proceeding.

**Single worker (only when every change targets the same file):**

```
Agent({
  subagent_type: "worker",
  description: "Implement plan",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_files>\n<SYNTHESIZED_IMPLEMENTATION_DIRECTIVE>\n</your_files>\n\nImplement the plan end-to-end. Edit files, add or update tests, run validations. If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it.\n\nWrite your implementation report to /tmp/pi-feature-XXXXX/worker.md. Include: every file changed (absolute path + one-line summary), every test added/modified (file:line), exact validation commands run with full output, decisions made beyond the plan with reasoning, open risks discovered during implementation.",
})
```

---

## Step 5: Review

Read the worker reports (worker-a.md, worker-b.md, or worker.md). Synthesize: extract which files changed, which tests were added, what risks were flagged, what integration gaps exist between groups. Do NOT paste raw reports.

Launch the reviewer:

```
Agent({
  subagent_type: "reviewer",
  description: "Review diff",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<plan_summary>\n<KEY_PARTS_OF_THE_PLAN>\n</plan_summary>\n\n<worker_synthesis>\n<YOUR_SYNTHESIZED_WORKER_FINDINGS>\n</worker_synthesis>\n\nInspect the actual diff via `git diff` (and `git status` for untracked files). Cross-check the diff against the plan and what workers reported.\n\nWrite your review to /tmp/pi-feature-XXXXX/review.md. Cover:\n- Plan steps not implemented or implemented wrong (file:line)\n- Correctness/contract violations (file:line)\n- Integration gaps between worker groups: mismatched signatures, missing wiring, shared files no group updated (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code, premature abstraction (file:line)\n- Mismatches between worker reports and actual diff\n- Repo-wide validation deferred during implementation that still needs running\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do NOT edit files.",
})
```

Wait for the reviewer. Read `/tmp/pi-feature-XXXXX/review.md`.

---

## Step 6: Fix-up

Read the review. Synthesize: extract the blocker findings and their locations. Launch a fix-up worker with NO file restriction — it can edit anything:

```
Agent({
  subagent_type: "worker",
  description: "Apply review fixes",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<review_synthesis>\n<SYNTHESIZED_REVIEW_FINDINGS>\n</review_synthesis>\n\nYou work in the full tree (no file restrictions). Apply the fixes clearly worth doing now, wire up cross-group integration gaps, make shared-file and repo-wide changes that were deferred during implementation, then run the FULL validation suite (global typecheck, build, full test run, format if the plan requires it).\n\nWrite your final report to /tmp/pi-feature-XXXXX/worker-final.md. Include:\n- Every fix applied (file:line)\n- Every integration gap resolved (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks",
})
```

Wait for the fix-up worker. Read the final report. Summarize to the user: what was done, what was fixed, remaining risks.

---

## Rules

- You are the coordinator. You dispatch Agent() calls, read results, synthesize, write the next prompt. Each step is a separate dispatch.
- **Synthesis rule**: never paste an agent's raw output into another agent's prompt. Read the result, extract specific paths/facts/directives, and write a fresh prompt.
- **Large handoffs**: tell agents to write to file paths in the scratch directory. Read those files yourself, synthesize, pass key findings to the next agent.
- **Parallel by default**: when the plan yields ≥2 disjoint-file groups with real work, launch parallel background workers. Imports between files are not coupling. Single worker only for trivial scope or literal file overlap. Don't fan out one-line edits.
- Do NOT skip the scout or plan steps. Do NOT skip the review or fix-up steps.
- Do NOT use `isolation: "worktree"` for implement workers — the reviewer needs `git diff` in the main tree.
- Each worker prompt must include synthesized directives for its specific files, not "implement plan steps 3-7" and not raw plan text.
- Wait for each step's agents to complete before issuing the next step.
