/**
 * compose.js — reuse a saved workflow inside another one.
 *
 * Demonstrates: `workflow(nameOrRef, args?)`, `args` plumbing into the child,
 * and catching the failures a bad reference throws.
 *
 * The child runs in the SAME worker and vm context under its own globals, so it
 * shares this run's concurrency cap, agent counter, abort signal, journal and
 * budget by construction — its agents are simply this run's agents, visible and
 * controllable from the same inspector. What it does not share is phase state:
 * the child's phases render under their own `▸ count-child` group.
 *
 * Nesting is ONE level deep. A `workflow()` call inside the child throws.
 *
 * Requires `lib/count-child.js` to be resolvable — copy both this file and the
 * child into `.pi/workflows/` (the child as `count-child.js`) before running it
 * by name.
 *
 * args: { root?: string }
 *
 * Run: ask the model — "run the workflow at examples/workflows/compose.js".
 */
export const meta = {
  name: 'compose',
  description: 'Count files with a nested workflow, then summarize what it found',
  phases: [{ title: 'Count' }, { title: 'Summarize' }],
}

const root = args?.root ?? 'src/'

phase('Count')

// An unknown name, an unreadable path, a file with no `meta`, or a child that
// will not parse all throw into this script — so catch if you want to carry on.
let count
try {
  count = await workflow('count-child', { root })
} catch (error) {
  log(`nested workflow failed: ${error.message}`)
  return { ok: false, reason: error.message }
}

log(`the child counted ${count} files under ${root}`)

phase('Summarize')
const summary = await agent(
  `There are ${count} source files under ${root}. In one sentence, say whether that is a lot for a project of this kind.`,
  { label: 'summarize', effort: 'low' },
)

return { ok: true, count, summary }
