---
description: "E2E feature chain: scout, plan, implement, review, fix-up (file-handoff, plan-gated fan-out)"
---

# /feature

Run this as two `Agent` chain calls, not one. The first call scouts and plans, then pauses. You read the plan (and any fan-out proposal it emits) and decide the implement shape before the second call runs the rest. This exists because a single upfront call would force you to guess the implement shape (single worker vs several parallel workers on disjoint files) before the plan exists to tell you what the shape should be.

Every step writes its output to `{chain_dir}` and downstream steps consume those files via `reads:` (full content, bypasses compaction). `output_mode: file-only` keeps `{previous}` light.

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

## Call 1: scout + plan (pauses after Plan)

```
Agent({
  subagent_type: "general-purpose",
  description: "feature chain: scout + plan",
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
      pause_after: true,
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe scout findings are prepended above as <context>. Produce an EXHAUSTIVE implementation plan. Use write_output to persist incrementally.\n\nPlan must include:\n- File-by-file changes with absolute paths and exact functions/lines\n- Test strategy: which tests to add/update, which files, what they assert\n- Edge cases enumerated with handling\n- Validation commands (exact shell invocations)\n- Rollback strategy\n- Sequencing if order matters\n- Explicit decisions on every open question from the scout findings; cite which evidence resolved each\n\nDo NOT defer decisions to the worker. If genuinely ambiguous, list options with tradeoffs and pick one with reasoning.\n\nIf, and only if, the implementation splits into independently-scoped, file-disjoint chunks that could be built in parallel, also append a fenced `chain-next` block: a JSON array where each item is {\"subagent_type\": \"worker\", \"prompt\": \"<self-contained outcome-based task for this chunk>\", \"files\": [\"<absolute paths this chunk touches>\"]}. Each chunk's files must be mutually disjoint — if any overlap or you are uncertain, do NOT emit the proposal; produce a single-worker plan instead. Implement chunks must never set `isolation: \"worktree\"` — the reviewer reads `git diff` in the main tree and worktree changes would be invisible. Do not emit this for single-scope or tightly-coupled work."
    }
  ]
})
```

`pause_after: true` on the Plan step stops the chain there. The result includes the plan's full output, a `chain_run_id`, and — if Plan emitted one — a parsed, validated fan-out proposal (or an explicit warning if the block was malformed). Nothing is dispatched yet.

## Step 1.5: Decide the implement shape (REQUIRED, do not skip)

Read the returned plan. Default to parallel: actively look for a disjoint-file split before settling on a single worker. Do not wait for Plan to volunteer one.

- If Plan emitted a fan-out proposal: review it against the plan text. Use it as-is, or edit it, if the split is genuinely disjoint and each chunk's prompt is self-contained and outcome-based. Do not paste it through unreviewed — you are the gate, not Plan.
- If there is no proposal, check the plan's file list yourself: does it already group into independent chunks (different files, different layers, different modules) with no real coupling between them? If yes, build the parallel shape yourself, even though Plan didn't propose one.
- Only fall back to a single worker when the plan is genuinely one coupled change: chunks would overlap files, need to run in a specific order, or share enough context that splitting adds coordination cost without saving time. That is a real judgment call, not a default you reach for out of habit.
- Never give parallel implement workers `isolation: "worktree"` here — the reviewer inspects `git diff` in the main tree, so worktree-isolated changes would be invisible to it. Safety comes from disjoint file ownership, not isolation. If two chunks are not truly disjoint, merge them into one worker instead of isolating them.

Build `{{IMPLEMENT_STEP}}`: either the single-worker step or a `parallel` stage, per the two shapes below.

**Single worker (default):**

```
{
  subagent_type: "worker",
  description: "Implement plan",
  reads: ["{chain_dir}/plan.md"],
  output: "{chain_dir}/worker.md",
  output_mode: "file-only",
  prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe plan is prepended above. Implement it end-to-end. Edit files, add or update tests, run validations. If a decision is ambiguous AND not resolved by the plan, pick the least-risky option and log it.\n\nUse write_output to persist your implementation report incrementally. The report must include:\n- Every file changed (absolute path) with one-line change summary\n- Every test added/modified with file:line\n- Exact validation commands run and full output per command\n- Every decision you made beyond the plan, with reasoning\n- Open risks discovered during implementation\n- `Need decision:` section only if you stopped on an unapproved decision\n\nVerbose receipts. The reviewer cross-checks against this."
}
```

**Parallel workers (only when the plan/proposal cleanly partitions into disjoint files, 2-4 chunks):**

```
{
  parallel: [
    { subagent_type: "worker", description: "Implement chunk A", output: "{chain_dir}/worker-a.md", output_mode: "file-only", files: ["<absolute paths chunk A owns>"],
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_chunk>\nCHUNK A. You OWN exactly these files: <absolute paths>. Assigned plan steps: <list>.\n</your_chunk>\n\nImplement ONLY your chunk. Edit ONLY your owned files. Do NOT touch files outside your list, edit shared config/lockfiles, or run repo-wide format/build/codegen. Validate ONLY your slice. Use write_output for a verbose report: every file changed (path + summary), every test (file:line), scoped validation commands + full output, any out-of-chunk file you needed (report it, do NOT touch), decisions beyond the plan, open risks." },
    { subagent_type: "worker", description: "Implement chunk B", output: "{chain_dir}/worker-b.md", output_mode: "file-only", files: ["<absolute paths chunk B owns>"],
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\n<your_chunk>\nCHUNK B. You OWN exactly these files: <absolute paths>. Assigned plan steps: <list>.\n</your_chunk>\n\nSame contract as chunk A: edit ONLY your owned files, no shared/global changes, validate your slice, verbose write_output report." }
  ],
  output: "{chain_dir}/worker.md",
  output_mode: "file-only"
}
```

Shared files (lockfiles, barrels, config) and repo-wide commands (format-all, codegen, global build) are deferred to the fix-up worker, never run during the parallel stage. Keep `continue_on_error` at its default (fail-fast): a half-applied chunk leaves the tree in a state the reviewer cannot safely reason about.

## Call 2: resume with implement + review + fix-up

```
Agent({
  subagent_type: "general-purpose",
  description: "feature chain: implement + review",
  prompt: "chain",
  chain_run_id: "<id returned by call 1>",
  remaining: [
    {{IMPLEMENT_STEP}},
    {
      subagent_type: "reviewer",
      description: "Review diff",
      reads: ["{chain_dir}/plan.md", "{chain_dir}/worker.md"],
      output: "{chain_dir}/review.md",
      output_mode: "file-only",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nPlan and worker report are prepended above. Inspect the actual diff via `git diff` (and `git status` for untracked files). Cross-check the diff against plan and worker report.\n\nUse write_output to persist findings incrementally. Review must cover:\n- Plan steps not implemented or implemented wrong (file:line)\n- Correctness/contract violations (file:line)\n- Integration gaps if implementation was split into chunks: mismatched signatures, missing wiring, shared files no chunk updated (file:line)\n- Test coverage gaps (cite missing case names)\n- Unnecessary complexity, dead code, premature abstraction (file:line)\n- Mismatches between worker report and actual diff\n- Mismatches between plan and actual diff\n\nPer finding: severity (blocker/note), exact location, recommended fix. Flag only fixes worth doing now. Do not edit."
    },
    {
      subagent_type: "worker",
      description: "Apply review fixes",
      reads: ["{chain_dir}/review.md"],
      output: "{chain_dir}/worker-final.md",
      output_mode: "inline",
      prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nThe review is prepended above. You work in the full tree now (no chunk restriction if implementation was split). Apply only the fixes clearly worth doing now, wire up any cross-chunk integration gaps, make deferred shared-file/repo-wide changes, then re-run validations (full suite if implementation was split).\n\nUse write_output to persist the final report. Must include:\n- Every fix applied (file:line)\n- Every review finding marked applied/deferred/disagreed with reasoning\n- Final validation command output\n- Final list of changed files\n- Remaining risks"
    }
  ]
})
```

`{{IMPLEMENT_STEP}}` is whichever shape you built in Step 1.5 — a single object (single worker) or `{ parallel: [...] }` (parallel chunks). `remaining` must have at least one element; `chain_run_id` must be the exact ID call 1 returned. `{chain_dir}` in these prompts still resolves correctly — it is the same scratch directory from call 1.

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

Apply this ONLY when recon splits into clearly separable domains (e.g. frontend vs backend, two independent services). For most tasks the single Explore step is simpler and cheaper, so do not parallelize by default. When it applies, replace the Explore step in call 1 with a parallel scout stage and keep the Plan step (with `pause_after: true`) identical:

```
chain: [
  {
    parallel: [
      { subagent_type: "Explore", description: "Scout frontend", output: "{chain_dir}/scout-frontend.md", output_mode: "file-only",
        prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout ONLY the frontend/UI layer for everything relevant. Use write_output. Cite every claim file:line." },
      { subagent_type: "Explore", description: "Scout backend", output: "{chain_dir}/scout-backend.md", output_mode: "file-only",
        prompt: "<conversation_context>\n{{CONVO_CONTEXT}}\n</conversation_context>\n\n<task>\n{{TASK}}\n</task>\n\nScout ONLY the backend/data layer for everything relevant. Use write_output. Cite every claim file:line." }
    ],
    output: "{chain_dir}/scout.md",
    output_mode: "file-only"
  },
  { subagent_type: "Plan", reads: ["{chain_dir}/scout.md"], output: "{chain_dir}/plan.md", output_mode: "file-only", pause_after: true, prompt: "...{{TASK}}... plan from the merged scout findings ..." }
]
```

The merged `scout.md` contains `### Member 1 (Explore)` and `### Member 2 (Explore)` blocks, so Plan reads one file covering both domains. Give each member a non-overlapping scope so findings do not duplicate.

## Rules

- This is two `Agent` calls, not one. Do not try to declare the implement/review/fix-up steps in call 1 — they are unreachable, since `pause_after: true` returns before the chain gets to them.
- Substitute `{{CONVO_CONTEXT}}` and `{{TASK}}` in every step's `prompt` BEFORE calling `Agent`, in both calls. Runtime substitutes `{previous}` and `{chain_dir}`, not `{{...}}`.
- Do NOT collapse, skip, or modify the Explore/Plan/implement/reviewer/fix-up steps.
- Step 1.5 is REQUIRED, not optional — even a fan-out proposal from Plan must be reviewed by you before use, never dispatched unreviewed.
- Check the parallel scout stage before defaulting to a single Explore step: if recon splits into separable domains (frontend vs backend, independent services), use it.
- Check the parallel implement stage before defaulting to a single worker: if the plan (or its proposal) partitions into disjoint files, use it. Only stay single-worker when the work is genuinely one coupled change. Do NOT give parallel implement workers `isolation: "worktree"`: the reviewer reads `git diff` in the main tree, so worktree changes would be invisible. Safety comes from disjoint file ownership; shared/global changes go to the fix-up worker.
- Wait for each call to complete before issuing the next, then report the final summary to the user.
