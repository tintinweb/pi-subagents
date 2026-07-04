# pi-subagents

Repo orientation for agents.

## Chain

- `src/index.ts` owns `executeChain` and `renderCall`.
- `src/chain-io.ts` owns chain file I/O, placeholder substitution, file-only handoff validation, and parallel merge helpers.
- Chain elements are a flat union: sequential step or `{ parallel: [...] }` stage.
- Parallel stages run static members concurrently, merge labeled outputs, and pass merged `{previous}` downstream.
- Writable parallel members default to `isolation: "worktree"` or read-only. Exception: the /feature and /feature-light pattern intentionally runs parallel workers in the main tree without worktree isolation when they have pre-declared disjoint file ownership and are reviewed together by one shared reviewer after the stage lands. Worktree would hide their changes from that reviewer's `git diff`, so main-tree writable is the correct choice for this pattern. For parallel members without this disjoint-ownership + shared-reviewer structure, worktree or read-only remains the default.
- `isolation: "worktree"` (`src/worktree.ts`) only redirects the agent's default `cwd` for *relative* path resolution — it is a convention, not a filesystem sandbox. `read`/`edit`/`write` are pi-core tools; a tool call using an absolute path always resolves against the real filesystem regardless of the agent's assigned `cwd`, so it can still touch the main tree. Don't rely on `isolation: "worktree"` as a security boundary against a misbehaving or confused agent — it only prevents *accidental* relative-path collisions between concurrent writers.
- A sequential step can set `pause_after: true` to stop the chain there instead of continuing. The caller resumes with a second `Agent({ chain_run_id, remaining })` call. If the paused step's output contains a fenced ```chain-next``` JSON array, `parseChainNext` (`src/chain-io.ts`) validates it (file-overlap, non-empty files, chunk count) and it is returned as a reviewable proposal only — the runtime never auto-dispatches it into `remaining`.
- `prepareStep` (in `executeChain`) checks `manager.listAgents()` for any other `running`, writable, non-worktree agent before building a step's prompt, and appends `formatConcurrentActivityNote` if found. This exists because chain-internal validation (`validateParallelStage`, `formatParallelEditHazardWarning`) only sees members of the current chain's own `parallel` stage — it's blind to a separate, concurrently dispatched top-level `Agent` call sharing the same cwd. The note tells the step not to misattribute a concurrent sibling's legitimate changes as its own task's issues.

## Tests

- `test/chain-io.test.ts` covers chain I/O helpers and parallel merge/validation logic.
- Keep changes narrow; match existing sequential semantics unless feature explicitly changes them.
