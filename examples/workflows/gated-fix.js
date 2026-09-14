/**
 * gated-fix.js — verify by running a command, not by asking a second opinion.
 *
 * Demonstrates: `gate` (a shell command that must pass, or the agent is failed
 * and its call returns null), and `resume` to hand the failure back to the same
 * child instead of re-paying for the context it already built.
 *
 * Two constraints this example is shaped around, both worth knowing:
 *
 *   1. `gate` cannot be combined with `resume`. A resumed child keeps the agent
 *      type, model, tree and tools it was started with, so the corrective pass
 *      is NOT itself gated — re-verification needs its own gated call.
 *   2. `isolation: "worktree"` is deliberately not used here. An isolated child's
 *      worktree is committed to a branch and removed when it settles, so a later
 *      agent would verify the main tree and could pass while the fix it was
 *      checking lives somewhere else. Isolation is for parallel writers that
 *      would collide; a serial fix-then-verify chain wants one shared tree.
 *
 * args: { task?: string, test?: string }
 *
 * Run: ask the model — "run the workflow at examples/workflows/gated-fix.js
 * with the test command npm test". Needs a real test command to be useful.
 */
export const meta = {
  name: 'gated-fix',
  description: 'Fix a failing test, then prove it passes by running the suite',
  phases: [{ title: 'Fix' }, { title: 'Verify' }],
}

const task = args?.task ?? 'Find and fix the failing test.'
const testCommand = args?.test ?? 'npm test'

phase('Fix')

// The gate runs after the agent finishes. A non-zero exit fails the agent and
// folds the command's output into its error, so `fixed` is null exactly when
// the suite did not pass — no need to ask a model whether the fix worked.
let fixed = await agent(task, { label: 'fix', gate: testCommand })

if (fixed === null) {
  log(`${testCommand} failed — handing the output back to the same child`)

  // Resume, not a fresh spawn: the child still has everything it learned on the
  // first pass, so it is told what broke rather than rediscovering it.
  fixed = await agent(
    `\`${testCommand}\` is still failing. Read the failure above, fix the cause, and stop.`,
    { label: 'fix', resume: 'fix' },
  )

  // The resume could not carry the gate, so verify separately. This child works
  // in the same tree, which is what makes the check meaningful.
  phase('Verify')
  const verified = await agent(
    `Run \`${testCommand}\` and report the result. Change nothing.`,
    { label: 'verify', gate: testCommand, effort: 'low' },
  )
  return { passed: verified !== null, summary: fixed }
}

return { passed: true, summary: fixed }
