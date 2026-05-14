# Branch Decisions Log

This file tracks architectural decisions, trade-offs, and context for `upstream-plus-prs` and `feat/chain-file-io`.

---

## 2026-05-14 — File-based chain IO + chain write tool

### Context
Imitating [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) file-based output-input pattern for agent chains. The goal: guarantee no detail loss when chaining agents, especially read-only agents like `Explore` and `Plan`.

### What was built

**`src/chain-io.ts`** — all chain IO primitives:
- `createChainDir()` — per-run scratch dir under `$TMPDIR/pi-subagents-chain-<uid>/<runId>`
- `substituteChainPlaceholders()` — replaces `{previous}` and `{chain_dir}` in prompts and paths
- `resolveOutputPath()` / `persistStepOutput()` / `snapshotOutputFile()` / `resolveStepOutput()` — orchestrator-side file capture with fallback write
- `buildReadsBlock()` — reads listed files, prepends as `<context>` XML in the next step's prompt
- `validateStepIO()` — pre-flight validation
- `isAgentReadOnly()` — detects read-only agents by inspecting tool list + disallowedTools
- `validateFileOnlyChain()` — warns when `output_mode: "file-only"` is followed by a step with no matching `reads`
- `createChainOutputTool()` — injects a `write_output` custom tool scoped to the exact output path

**`src/index.ts`** — wired into chain execution:
- New fields on chain step schema: `output`, `output_mode`, `reads`
- `{chain_dir}` placeholder supported in prompts, paths, and reads
- `write_output` tool injected into agent session when step has `output` set

**`src/agent-runner.ts`** — `customTools?: ToolDefinition[]` added to `RunOptions`, threaded to `createAgentSession`

**`src/agent-manager.ts`** — `write_output` tool survives the active-tool filter for read-only agent types

### Key decisions

**Why a write tool instead of just text instructions?**
`collectResponseText` in `agent-runner.ts` resets on every `message_start` — it only captures the *last* assistant message. A multi-turn `Explore` or `Plan` agent that discovers things over 10 turns will only have turn 10 captured as `{previous}`. The `write_output` tool lets agents write incrementally during execution, so even if the session hits `maxTurns` or gets compacted, whatever was written is preserved.

**Why keep the orchestrator fallback write?**
If an agent never calls `write_output` (e.g. it forgets, or it was invoked without the tool), the orchestrator still writes the in-memory final response to the output path. This is a safety net, not the primary mechanism.

**Why suppress the text instruction for read-only agents?**
The `injectOutputInstruction` text ("Write your findings to: /path") is injected into the prompt as guidance. For read-only agents, this instruction is impossible to follow without the write tool, so it was misleading. With `write_output` injected, the tool description itself serves as the instruction — no extra text needed.

**How `reads` guarantees no data loss**
`{previous}` is plain text injected into the next prompt — subject to context compaction. `reads` is an orchestrator-level transform: the file is read fresh and prepended as `<context>` XML before the prompt is built, bypassing compaction entirely. Always use `reads` for large or critical outputs between steps.

**Footgun: `output_mode: "file-only"` without `reads`**
If step N sets `output_mode: "file-only"` and step N+1 doesn't declare `reads`, step N+1 only sees `"Output saved to: /path"` in `{previous}` — not the actual content. Pre-flight validation warns visibly in the chain result (not just `console.warn`) when this pattern is detected.

### Nicobailon comparison
Nicobailon's implementation:
- Also uses both text instruction AND orchestrator fallback (same two-layer approach)
- Uses `suppressProgressForReadOnlyTask` for read-only agents (we use `isAgentReadOnly` + tool injection instead)
- Runs agents as separate Pi processes (subprocess), so file writes are by the child process; fallback is orchestrator-side
- Warns but does NOT fallback-write in chain-level code (fallback happens inside `runSync` via `resolveSingleOutput`)

Our implementation differs: agents are in-process, `write_output` tool is the primary write mechanism, orchestrator fallback is secondary.

---

## 2026-05-14 — Upstream cherry-picks onto upstream-plus-prs

### Context
`upstream/master` had 17 commits not in `upstream-plus-prs`. Evaluated each; picked the 7 meaningful ones. Skipped changelogs, version bumps, and merge commits.

### Picked

| Commit | What | Notes |
|---|---|---|
| `3a13191` | pgUp/pgDown in conversation viewer | Low-risk, UI only |
| `2c43c94` | fix(rpc): string model resolution | Low-risk, untouched files |
| `e5a4e40` | Pi-standard skill layout support | Low-risk, skill-loader only |
| `f4c5868` | `<active_agent>` tag in child system prompts | Low-risk, prompts.ts only |
| `d98b116` | Show passed args in conversation viewer | Required by `3a13191` (dependency); manual conflict resolution in `index.ts` and `agent-widget.ts` |
| `8a18944` | Set session name per agent | Auto-merged cleanly despite touching `agent-runner.ts` |
| `2620738` | Normalize maxturns | Skipped (empty after our refactoring already handled it) |

### Skipped (functional)
- `2620738` normalize maxturns — our version already applies `normalizeMaxTurns` in the same place via a different refactor; cherry-pick was empty after conflict resolution.

### Skipped (noise)
- `a574a1e`, `5733fb9`, `2afeae1`, `c6d0c20` — changelogs
- `7b8846a` — version bump to 0.7.2
- `2f4deeb`, `13da9f1`, `3a2c03a` — merge commits
- `1c40dcd` — minor viewport height constant

### Branch strategy decision
Attempted to merge `upstream/master` into `main` first. Aborted after repeated turn-limit failures on `src/index.ts` conflict resolution (33 conflicts, ~3000-line file). Pivoted to cherry-picking specific commits onto `upstream-plus-prs` directly.

`main` was assessed as legacy — it has 76 commits of independent fork work diverged from upstream's base. `upstream-plus-prs` is the branch of record: built directly on tintinweb's upstream, contains all the meaningful features from `main` (chain-mode, nudge-fixes, card-grid, routing-guidelines) plus our chain-io work.
