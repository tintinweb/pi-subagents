/**
 * meta.ts — extract and validate a workflow script's `meta` block.
 *
 * Workflow scripts open with `export const meta = { ... }`, but the script body
 * runs through `node:vm`, which has no module loader — `export` is a syntax
 * error there. The block also has to be readable *before* execution, because the
 * declared phases seed the progress groups the UI renders from the first frame.
 *
 * Claude Code solves this by parsing with acorn and requiring `meta` to be a
 * pure literal (no variables, calls, spreads, or template interpolation). We
 * take the same contract without the dependency: scan to the matching brace,
 * then evaluate *only* that fragment in an empty vm context. A pure literal has
 * nothing to call, so evaluating it cannot reach anything — and anything that
 * isn't a pure literal either throws (unbound identifier) or is rejected below.
 *
 * The scanner is string-, comment-, and regex-aware. That matters: a workflow's
 * `detail` text routinely contains braces, and `phases: [{ title: "a}b" }]` must
 * not terminate the scan early.
 */

import { createContext, Script } from "node:vm";

/** A phase declared up front, so the UI can show it before any agent runs. */
export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  /** Set when a phase pins a model; display-only, the runtime does not read it. */
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  /** Shown in the saved-workflow listing. Not used by the runtime. */
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
}

export interface MetaExtraction {
  meta: WorkflowMeta;
  /**
   * The script with the leading `export ` stripped, so `const meta = {...}`
   * compiles inside the vm. Byte offsets after the keyword are untouched, which
   * keeps stack-trace line numbers aligned with what the author wrote.
   */
  body: string;
}

export class WorkflowMetaError extends Error {}

/**
 * Wall-clock bound on evaluating the `meta` fragment. Generous for a literal —
 * this exists only to stop a pathological one from hanging the host thread.
 */
const META_EVAL_TIMEOUT_MS = 100;

const PURE_LITERAL_HINT =
  "The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation.";

/** Matches `export const meta =` allowing arbitrary inner whitespace. */
const META_DECLARATION = /(^|[\r\n])[ \t]*export[ \t\r\n]+const[ \t\r\n]+meta[ \t\r\n]*=/;

/**
 * Whether `source` even claims to be a workflow script.
 *
 * The cheap half of {@link extractMeta}, exported so a directory of `.js` files
 * can be told apart from a directory of workflows without evaluating anything.
 * A saved-workflow folder is a normal folder — it may hold a build artifact, a
 * config, someone's scratch script — and those should neither be offered as
 * workflows nor produce a parser error when named.
 */
export function hasMetaDeclaration(source: string): boolean {
  return META_DECLARATION.test(source);
}

interface ScanResult {
  /** Index of the literal's closing brace, or -1 when braces never balance. */
  end: number;
  /**
   * True when a `${` substitution opened inside a template literal. Reported
   * separately because such a fragment can still *evaluate* — `` `a${1+1}b` ``
   * needs no globals — so the impure-literal check below cannot catch it.
   */
  sawInterpolation: boolean;
}

/**
 * Find the index just past the object literal that starts at `open`.
 *
 * Tracks string, template, comment, and regex context so braces inside them do
 * not move the depth counter.
 */
function scanObjectLiteral(source: string, open: number): ScanResult {
  let depth = 0;
  let i = open;
  let sawInterpolation = false;
  // What we are currently inside of. "code" means brace counting is live.
  let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" | "regex" = "code";
  // Template literals nest: `${ {a:1} }` re-enters code, and the closing brace
  // of that substitution must not be read as the object's. One depth per level.
  const templateStack: number[] = [];

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (mode === "line-comment") {
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "block-comment") {
      if (c === "*" && next === "/") { mode = "code"; i += 2; continue; }
      i++;
      continue;
    }
    if (mode === "single" || mode === "double" || mode === "regex") {
      if (c === "\\") { i += 2; continue; }
      if (mode === "single" && c === "'") mode = "code";
      else if (mode === "double" && c === '"') mode = "code";
      else if (mode === "regex" && c === "/") mode = "code";
      // An unterminated regex/string can't run past a newline; bail to code so a
      // misdetected regex (see below) cannot swallow the rest of the literal.
      else if (c === "\n" && mode !== "double") mode = "code";
      i++;
      continue;
    }
    if (mode === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { mode = "code"; i++; continue; }
      if (c === "$" && next === "{") {
        sawInterpolation = true;
        templateStack.push(depth);
        depth++;
        mode = "code";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // mode === "code"
    if (c === "/" && next === "/") { mode = "line-comment"; i += 2; continue; }
    if (c === "/" && next === "*") { mode = "block-comment"; i += 2; continue; }
    if (c === "'") { mode = "single"; i++; continue; }
    if (c === '"') { mode = "double"; i++; continue; }
    if (c === "`") { mode = "template"; i++; continue; }
    if (c === "/" && isRegexPosition(source, i)) { mode = "regex"; i++; continue; }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") {
      depth--;
      i++;
      if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        mode = "template";
        continue;
      }
      if (depth === 0) return { end: i, sawInterpolation };
      continue;
    }
    i++;
  }
  return { end: -1, sawInterpolation };
}

/**
 * Decide whether the `/` at `i` opens a regex literal rather than a division.
 *
 * Walks back past whitespace and comments to the previous significant char: a
 * regex can only follow an operator or opener, never a value. This is the usual
 * heuristic and it is sufficient here, because the only thing riding on it is
 * not miscounting braces inside a `meta` literal — and a `meta` literal
 * containing division is already not a pure literal.
 */
function isRegexPosition(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j--;
  if (j < 0) return true;
  const prev = source[j];
  // Identifier/number/closer before `/` means division.
  return !/[\w$)\]]/.test(prev);
}

function fail(message: string): never {
  throw new WorkflowMetaError(message);
}

function assertPhases(value: unknown): WorkflowPhaseMeta[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail("`meta.phases` must be an array of { title, detail?, model? } objects.");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`\`meta.phases[${index}]\` must be an object with a \`title\`.`);
    }
    const { title, detail, model } = entry as Record<string, unknown>;
    if (typeof title !== "string" || title.trim() === "") {
      fail(`\`meta.phases[${index}].title\` must be a non-empty string.`);
    }
    if (detail !== undefined && typeof detail !== "string") {
      fail(`\`meta.phases[${index}].detail\` must be a string.`);
    }
    if (model !== undefined && typeof model !== "string") {
      fail(`\`meta.phases[${index}].model\` must be a string.`);
    }
    return { title, ...(detail !== undefined ? { detail } : {}), ...(model !== undefined ? { model } : {}) };
  });
}

/**
 * Pull `meta` off the front of a workflow script and hand back the runnable body.
 *
 * Throws {@link WorkflowMetaError} with author-facing guidance for every
 * rejection — these messages are shown verbatim to whoever wrote the script.
 */
export function extractMeta(source: string): MetaExtraction {
  const declaration = META_DECLARATION.exec(source);
  if (!declaration) {
    fail(
      "A workflow script must begin with `export const meta = { name, description }`.\n" +
      PURE_LITERAL_HINT,
    );
  }

  const open = source.indexOf("{", declaration.index + declaration[0].length);
  if (open === -1) fail("`export const meta` must be assigned an object literal.\n" + PURE_LITERAL_HINT);

  const { end: close, sawInterpolation } = scanObjectLiteral(source, open);
  if (close === -1) fail("`meta` object literal is never closed — check for an unbalanced `{`.");

  // Caught here rather than by evaluation: a self-contained substitution such as
  // `` `a${1 + 1}b` `` resolves without touching a single global, so it would
  // sail through the empty-context check below and silently produce "a2b".
  if (sawInterpolation) {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: quoting the syntax being rejected
    fail("`meta` must not use template interpolation (`${...}`).\n" + PURE_LITERAL_HINT);
  }

  const fragment = source.slice(open, close);
  let value: unknown;
  try {
    // Empty context: a pure literal needs no globals, so anything reaching for
    // one (a variable, a helper call) throws here and is reported as impure.
    //
    // The timeout is not belt-and-braces. An IIFE needs no globals either, so
    // `name: (() => { while (true); })()` is evaluable — and this runs on the
    // host thread, before the script ever reaches the worker. Without a bound it
    // would wedge pi itself. `timeout` only governs synchronous execution, which
    // is all a literal can contain.
    value = new Script(`(${fragment})`, { filename: "workflow-meta.js" })
      .runInContext(createContext({}), { timeout: META_EVAL_TIMEOUT_MS });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/timed out|Script execution/i.test(detail)) {
      fail(
        `\`meta\` did not finish evaluating within ${META_EVAL_TIMEOUT_MS}ms — it must be a literal, not a computation.\n` +
        PURE_LITERAL_HINT,
      );
    }
    fail(`\`meta\` could not be evaluated: ${detail}\n${PURE_LITERAL_HINT}`);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("`meta` must be an object literal.\n" + PURE_LITERAL_HINT);
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    fail("`meta.name` is required and must be a non-empty string.");
  }
  if (typeof raw.description !== "string" || raw.description.trim() === "") {
    fail("`meta.description` is required and must be a non-empty string.");
  }
  if (raw.whenToUse !== undefined && typeof raw.whenToUse !== "string") {
    fail("`meta.whenToUse` must be a string.");
  }
  const phases = assertPhases(raw.phases);

  const meta: WorkflowMeta = {
    name: raw.name,
    description: raw.description,
    ...(raw.whenToUse !== undefined ? { whenToUse: raw.whenToUse as string } : {}),
    ...(phases !== undefined ? { phases } : {}),
  };

  // Strip only the `export ` keyword. Replacing it with spaces rather than
  // deleting it keeps every subsequent offset — and therefore every reported
  // line and column — identical to the source the author wrote.
  const exportAt = source.indexOf("export", declaration.index);
  const body = `${source.slice(0, exportAt)}${" ".repeat(6)}${source.slice(exportAt + 6)}`;

  return { meta, body };
}
