/**
 * review-panel.js — the case where a barrier is actually earned.
 *
 * Demonstrates: `parallel` used correctly, `effort` tiering (cheap reviewers,
 * an expensive judge), and a `model` override.
 *
 * Most of the time `pipeline` beats `parallel`, because a barrier idles every
 * fast agent until the slowest finishes. This is the exception: the synthesis
 * prompt interpolates ALL of the reviews, so it genuinely cannot start until
 * every one of them is in. That — a prompt that compares results against each
 * other — is what justifies a barrier.
 *
 * args: { target?: string, lenses?: string[] }
 *
 * Run: ask the model — "run the workflow at examples/workflows/review-panel.js
 * against src/auth.ts".
 */
export const meta = {
  name: 'review-panel',
  description: 'Review one thing from several angles, then reconcile the verdicts',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
}

const target = args?.target ?? 'the changed files'
const lenses = args?.lenses ?? ['correctness', 'security', 'performance']

phase('Review')

// Perspective diversity, not redundancy: three reviewers with DIFFERENT briefs
// catch failure modes that three identical ones cannot.
const reviews = await parallel(
  lenses.map(lens => () =>
    agent(`Review ${target} through the lens of ${lens} alone. Be specific and brief.`, {
      label: `review:${lens}`,
      // Cheap for the survey work; the judge below gets the depth.
      effort: 'low',
    }),
  ),
)

// A thunk that throws becomes null without taking its siblings down.
const usable = reviews
  .map((text, i) => ({ lens: lenses[i], text }))
  .filter(r => r.text !== null)

if (usable.length === 0) {
  log('every reviewer failed — nothing to synthesize')
  return { reviewed: 0, verdict: null }
}

phase('Synthesize')

// This is the barrier's payoff: one prompt that sees all of them at once and can
// weigh them against each other.
const verdict = await agent(
  [
    `Reconcile these reviews of ${target}. Where they disagree, say which is right and why.`,
    ...usable.map(r => `\n## ${r.lens}\n${r.text}`),
  ].join('\n'),
  { label: 'synthesize', effort: 'high', agentType: 'Plan' },
)

return { reviewed: usable.length, verdict }
