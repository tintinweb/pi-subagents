/**
 * lib/count-child.js — a nested workflow, invoked by compose.js.
 *
 * A child is an ordinary workflow: it needs its own `export const meta =`
 * declaration, which is exactly what marks a file in a workflows directory as
 * runnable rather than as some unrelated script that happens to live there.
 *
 * args: { root?: string }
 */
export const meta = {
  name: 'count-child',
  description: 'Count the source files under a directory',
}

const root = args?.root ?? 'src/'

const found = await agent(`List every source file under ${root}. One path per line, nothing else.`, {
  label: 'scan',
  schema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' } } },
    required: ['files'],
  },
})

// A schema call can still return null if the child never complied.
return found === null ? 0 : found.files.length
