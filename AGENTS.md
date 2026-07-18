# pi-subagents

Repo orientation for agents.

## Architecture

- `src/index.ts` owns the `Agent` tool definition, `renderCall`, and single-agent dispatch.
- `src/agent-guards.ts` owns reusable guard functions: `guardAgentSpawn` (concurrency/overlap checks), `formatConcurrentActivityNote`, and `validateFilesOverlap`.
- `src/agent-runner.ts` and `src/agent-manager.ts` handle agent lifecycle and tracking.
- `src/default-agents.ts` defines built-in agent types (Explore, Plan, worker, reviewer, oracle, designer, etc.).

## Coordinator Pattern

There is no chain mechanism. The parent agent drives multi-step workflows by:
1. Dispatching individual `Agent()` calls sequentially or with `run_in_background: true` for parallel work.
2. Reading each agent's result before deciding the next step.
3. Synthesizing understanding between steps — the parent is the coordinator, not a chain conductor.

Parallel workers declare file ownership via `files: [...]` for collision detection. `isolation: "worktree"` redirects the agent's `cwd` for relative path resolution but is not a security sandbox.

## Tests

- `test/agent-guards.test.ts` covers guard functions (concurrency checks, file overlap validation).
- Keep changes narrow; match existing semantics unless feature explicitly changes them.
