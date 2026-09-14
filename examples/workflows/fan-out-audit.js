/**
 * fan-out-audit.js — the canonical workflow shape.
 *
 * Demonstrates: a fan-out whose width is discovered at runtime, `pipeline`
 * (no barrier between stages), `label` for readable progress rows, and a
 * per-stage `phase` override.
 *
 * args: { root?: string }  — directory to audit, default "src/routes/"
 *
 * Run: ask the model — "run the workflow at examples/workflows/fan-out-audit.js
 * against src/", or copy it to .pi/workflows/ and ask for it by name.
 */
export const meta = {
  name: 'fan-out-audit',
  description: 'Find files missing auth checks, then try to refute each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }, { title: 'Verify' }],
}

const root = args?.root ?? 'src/routes/'

phase('Scan')
const listing = await agent(
  `List every source file under ${root}. One path per line, nothing else.`,
  { label: 'discover' },
)
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
log(`auditing ${files.length} files under ${root}`)

// pipeline, not parallel: a file that finishes auditing moves straight to
// verification instead of waiting for the slowest sibling to catch up.
phase('Audit')
const findings = await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks. Report findings, or "none".`, {
    label: `audit:${file}`,
  }),
  // Later stages still receive the original item — no need to thread it through
  // the previous stage's return value.
  (found, file) => agent(`Try to REFUTE this finding about ${file}: ${found}`, {
    label: `verify:${file}`,
    // Explicit, because the ambient phase() races inside pipeline stages.
    phase: 'Verify',
  }),
)

// A skipped or failed agent is a null, so filter before returning.
return findings.filter(Boolean)
