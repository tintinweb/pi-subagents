# pi-subagents

Repo orientation for agents.

## Chain

- `src/index.ts` owns `executeChain` and `renderCall`.
- `src/chain-io.ts` owns chain file I/O, placeholder substitution, file-only handoff validation, and parallel merge helpers.
- Chain elements are a flat union: sequential step or `{ parallel: [...] }` stage.
- Parallel stages run static members concurrently, merge labeled outputs, and pass merged `{previous}` downstream.
- Writable parallel members should use `isolation: "worktree"` or be read-only.
- A sequential step can set `pause_after: true` to stop the chain there instead of continuing. The caller resumes with a second `Agent({ chain_run_id, remaining })` call. If the paused step's output contains a fenced ```chain-next``` JSON array, `parseChainNext` (`src/chain-io.ts`) validates it (file-overlap, non-empty files, chunk count) and it is returned as a reviewable proposal only — the runtime never auto-dispatches it into `remaining`.

## Tests

- `test/chain-io.test.ts` covers chain I/O helpers and parallel merge/validation logic.
- Keep changes narrow; match existing sequential semantics unless feature explicitly changes them.
