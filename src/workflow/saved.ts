/**
 * saved.ts — resolve `SubagentWorkflow({ name })` to a script on disk.
 *
 * A saved workflow is a plain `.js` file whose contents are exactly what
 * `script` would have carried. Nothing is parsed here: `extractMeta` still runs
 * over the source at the call site, so a saved file and an inline one fail the
 * same way on a bad `meta` block.
 *
 * Roots mirror `loadCustomAgents` rather than inventing a fourth convention —
 * project `.pi` is the authority, the shared `.agents` workspace is an extra
 * read location, and the user's agent dir is the fallback:
 *
 *   1. <cwd>/.pi/workflows/<name>.js
 *   2. <cwd>/.agents/workflows/<name>.js
 *   3. getAgentDir()/workflows/<name>.js   (default ~/.pi/agent/workflows)
 *
 * Precedence is expressed as first-hit-wins here, not last-write-wins as in the
 * agent loader, because a name resolves to one file — there is no map to
 * overwrite.
 *
 * Symlinks are rejected through `safeReadFile`, and the name is whitelisted
 * before it is ever joined to a path: `name` arrives from a model, and
 * `../../etc/passwd` must not become a readable workflow.
 *
 * ## Not every `.js` in the folder is a workflow
 *
 * These are ordinary directories. `.agents/workflows/` is shared across tools
 * and the user's agent dir is theirs to fill; either may hold a build artifact,
 * a config, or a scratch script. A file is only treated as a workflow if it
 * carries the `export const meta =` declaration every workflow opens with.
 *
 * Nothing is ever executed to decide this — the check is a regex over the
 * source, and even the real parse only evaluates the `meta` object literal in
 * an empty vm. What the filter buys is honesty: a listing that offers `utils.js`
 * as a runnable workflow invites the model to try it, and naming it should say
 * "that is not a workflow" rather than produce a parser error about a block the
 * author never intended to write.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isSymlink, isUnsafeName, safeReadFile } from "../memory.js";
import { hasMetaDeclaration } from "./meta.js";
import { MAX_SCRIPT_LENGTH } from "./runtime.js";

/** Extension a saved workflow file carries. */
const WORKFLOW_EXTENSION = ".js";

/** The roots a `name` is looked up in, highest priority first. */
export function savedWorkflowRoots(cwd: string): string[] {
  return [
    join(cwd, ".pi", "workflows"),
    join(cwd, ".agents", "workflows"),
    join(getAgentDir(), "workflows"),
  ];
}

export type SavedWorkflow =
  | { ok: true; script: string; path: string }
  | { ok: false; message: string };

/**
 * Read the saved workflow called `name`.
 *
 * Failure carries the roots that were searched and, when there are any, the
 * names that do exist — a model that guessed the name can correct itself from
 * the error instead of spending a turn asking.
 */
export function readSavedWorkflow(name: string, cwd: string): SavedWorkflow {
  const trimmed = name.trim();
  if (isUnsafeName(trimmed)) {
    return {
      ok: false,
      message:
        `"${name}" is not a usable workflow name. Use letters, digits, dots, hyphens and underscores only ` +
        "— a path is what `scriptPath` is for.",
    };
  }

  const roots = savedWorkflowRoots(cwd);
  for (const root of roots) {
    if (isSymlink(root)) continue; // reject a symlinked root entirely, as skill-loader does
    const path = join(root, `${trimmed}${WORKFLOW_EXTENSION}`);
    const script = safeReadFile(path);
    if (script === undefined) continue;
    // Found the file, so stop looking — a shadowing name that turns out not to
    // be a workflow is worth reporting, not worth silently reaching past.
    if (!hasMetaDeclaration(script)) {
      return {
        ok: false,
        message:
          `"${path}" is not a workflow script — it has no \`export const meta = { name, description }\` ` +
          "declaration. Nothing was run.",
      };
    }
    return { ok: true, script, path };
  }

  const known = listSavedWorkflows(cwd);
  return {
    ok: false,
    message:
      `No saved workflow named "${trimmed}". Looked in: ${roots.join(", ")}. ` +
      (known.length > 0
        ? `Available: ${known.join(", ")}.`
        : "Save one as `<name>.js` in one of those directories, or pass `script`/`scriptPath` instead."),
  };
}

/**
 * Resolve a reference — a saved name, or a path — to source.
 *
 * The one place that decides what a reference means, so the tool's `name` /
 * `scriptPath` parameters and a script's nested `workflow()` cannot drift apart
 * on precedence or on what counts as a workflow.
 */
export function resolveWorkflowSource(
  ref: { name?: string; scriptPath?: string },
  cwd: string,
): SavedWorkflow {
  const path = ref.scriptPath?.trim();
  if (path !== undefined && path !== "") {
    const resolved = isAbsolute(path) ? path : join(cwd, path);
    try {
      return { ok: true, script: readFileSync(resolved, "utf-8"), path: resolved };
    } catch (err) {
      return {
        ok: false,
        message: `Could not read workflow script "${resolved}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const name = ref.name?.trim();
  if (name !== undefined && name !== "") return readSavedWorkflow(name, cwd);
  return { ok: false, message: "A workflow reference needs a `name` or a `scriptPath`." };
}

/** Every saved workflow name, de-duplicated across roots and sorted. */
export function listSavedWorkflows(cwd: string): string[] {
  const names = new Set<string>();
  for (const root of savedWorkflowRoots(cwd)) {
    if (!existsSync(root) || isSymlink(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // an unreadable root is not worth failing a lookup over
    }
    for (const entry of entries) {
      if (!entry.endsWith(WORKFLOW_EXTENSION)) continue;
      const name = entry.slice(0, -WORKFLOW_EXTENSION.length);
      if (isUnsafeName(name)) continue;
      if (isWorkflowFile(join(root, entry))) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Whether the file at `path` is a workflow rather than some other script.
 *
 * Size-guarded before reading: the listing runs over a whole directory, and a
 * file too large to be a workflow at all should not be pulled into memory just
 * to check its first line.
 */
function isWorkflowFile(path: string): boolean {
  try {
    if (statSync(path).size > MAX_SCRIPT_LENGTH) return false;
  } catch {
    return false;
  }
  const source = safeReadFile(path);
  return source !== undefined && hasMetaDeclaration(source);
}
