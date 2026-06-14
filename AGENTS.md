# pi-subagents

Repo orientation for agents.

## Chain

- `src/index.ts` owns `executeChain` and `renderCall`.
- `src/chain-io.ts` owns chain file I/O, placeholder substitution, file-only handoff validation, and parallel merge helpers.
- Chain elements are a flat union: sequential step or `{ parallel: [...] }` stage.
- Parallel stages run static members concurrently, merge labeled outputs, and pass merged `{previous}` downstream.
- Writable parallel members should use `isolation: "worktree"` or be read-only.

## Tests

- `test/chain-io.test.ts` covers chain I/O helpers and parallel merge/validation logic.
- Keep changes narrow; match existing sequential semantics unless feature explicitly changes them.
