/**
 * structured-findings.js — get objects back, not prose.
 *
 * Demonstrates: `schema` on every agent call, so the script manipulates
 * validated objects instead of parsing text it hopes is well-formed.
 *
 * Reach for this whenever the script has to *do* something with the results —
 * sort, count, filter, compare — rather than hand them straight to you.
 *
 * args: { dimensions?: string[] }  — review angles, default bugs + perf
 *
 * Run: ask the model — "run the workflow at
 * examples/workflows/structured-findings.js".
 */
export const meta = {
  name: 'structured-findings',
  description: 'Review changed files across dimensions and verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          severity: { type: 'string' },
        },
        required: ['title', 'file'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: { isReal: { type: 'boolean' }, why: { type: 'string' } },
  required: ['isReal'],
}

const dimensions = args?.dimensions ?? ['bugs', 'performance']

const reviewed = await pipeline(
  dimensions,
  dim => agent(`Review the changed files for ${dim}. Report every finding.`, {
    label: `review:${dim}`,
    phase: 'Review',
    // With a schema the call resolves to the validated object, so `.findings`
    // below is a real array rather than something scraped out of prose.
    schema: FINDINGS,
  }),
  // A barrier is earned here only per-dimension: each dimension's findings are
  // verified concurrently, but dimensions never wait for each other.
  review => parallel(
    review.findings.map(f => () =>
      agent(`Try to REFUTE this finding: ${f.title} (${f.file})`, {
        label: `verify:${f.file}`,
        phase: 'Verify',
        schema: VERDICT,
      }).then(verdict => ({ ...f, verdict })),
    ),
  ),
)

// filter(Boolean) twice: once for a whole dimension that failed, once for an
// individual verification that did. A schema call can still return null.
const confirmed = reviewed
  .filter(Boolean)
  .flat()
  .filter(Boolean)
  .filter(f => f.verdict?.isReal)

return { confirmed: confirmed.length, findings: confirmed }
