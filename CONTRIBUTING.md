# Contributing to @tintinweb/pi-subagents

This guide exists to save both sides time.

## Philosophy

`pi-subagents` is a [pi](https://pi.dev) extension, and it tries to stay focused:
spawn and orchestrate autonomous sub-agents that feel native to pi, and do that
well. Features that don't serve that goal, or that bolt on unrelated complexity,
are likely to be declined. When in doubt, open an issue and discuss the idea
before writing the code.

The extension deliberately mirrors Claude Code's tool names, calling
conventions, and UI patterns. Changes should respect that compatibility unless
there's a good reason to diverge.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and
how they interact with the rest of the system, the PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without
understanding it is not.

## Filing Issues

Keep issues short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice. If you used an LLM to draft it, review and shape it
  yourself before posting.
- State the bug or request clearly, and explain why it matters.
- For bugs, include a minimal repro: pi version, this extension's version, your
  agent/config, the steps, and the actual vs. expected behavior.
- If you want to implement the change yourself, say so.

For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Before Submitting a PR

For anything beyond a trivial fix, open an issue first so we can agree on the
approach before you invest the time.

Make sure the full check suite passes locally:

```bash
npm run lint        # biome
npm run typecheck   # tsc --noEmit
npm run test        # vitest
npm run build       # tsc
```

All four must pass. `npm run lint:fix` will auto-fix most style issues, and
`npm run test:e2e` runs the end-to-end suite if your change touches that surface.

If your change touches a render path or the spawn path, `npm run bench` prints
absolute timings and `npm run bench:ab -- master` compares them against master.
Neither is required to pass; both are opt-in, and neither runs in CI.

Other guidelines:

- Keep PRs focused — one logical change per PR. Unrelated refactors make review
  harder and are likely to be split out or declined.
- Add or update tests for behavior you change.
- Match the surrounding code style (enforced by biome).
- Do not edit `CHANGELOG.md`. Changelog entries are added by the maintainer.
- Update the README when you add or change user-facing behavior.

## Questions?

Open an [issue](https://github.com/tintinweb/pi-subagents/issues) — questions and
discussion are welcome.
