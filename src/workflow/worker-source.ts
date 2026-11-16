/**
 * worker-source.ts — the JavaScript that runs inside the workflow worker thread.
 *
 * The host spawns this with `new Worker(WORKER_SOURCE, { eval: true })`, so the
 * source has to be an inlined string: `AGENTS.md` forbids dynamic `import()`,
 * and a file path would have to survive bundling. Keeping it as a template
 * literal costs editor tooling but nothing else — the worker is plain CommonJS
 * JavaScript and never sees the TypeScript pipeline.
 *
 * Two boundaries stack here, and they are not the same boundary:
 *
 *   host thread  ←postMessage→  worker thread  ←vm context→  workflow script
 *
 * The worker/host split exists for *killability*: `worker.terminate()` stops a
 * runaway script mid-loop, which an in-process `vm` timeout cannot do once the
 * script is inside an `await`. The vm context exists for *determinism and
 * accident-avoidance*, not security — see the note on `codeGeneration` below.
 *
 * ## Why the context gets no host built-ins
 *
 * `vm.createContext(sandbox)` gives the script a fresh realm that already owns
 * `Object`, `Array`, `JSON`, `Math`, `Date`, `Promise`, `Map`, `Set`. We inject
 * *only* our own globals on top. Injecting host built-ins instead would hand the
 * script `Object.constructor` → the **host** `Function`, i.e. a compiler for
 * arbitrary host-realm code.
 *
 * That said: our injected globals are themselves host closures, so
 * `agent.constructor` is still the host `Function`. The hygiene shrinks the
 * surface; it does not close the hole. **`codeGeneration: { strings: false }` is
 * the load-bearing defense** — it makes `Function("…")` and `eval("…")` throw
 * `EvalError`, so a captured host `Function` cannot compile anything. Treat this
 * as a determinism boundary, not a security boundary against a hostile script.
 *
 * ## Why determinism is a shim and not a stub
 *
 * Because `Date` and `Math` come *from the realm*, they cannot be neutered by
 * injection — there is nothing to inject over. So before the script runs, a
 * shim runs inside the realm: it replaces
 * `globalThis.Date` with a constructor whose zero-argument and call forms
 * throw, points `Date.prototype.constructor` at it, makes `Date.now` and
 * `Math.random` throw, and freezes the real constructor. A global rather than
 * a lexical shadow, because a lexical `const Date` left `new globalThis.Date()`
 * reading the real clock.
 *
 * Determinism is enforced because a workflow's journal is replayed by prefix on
 * resume: a script that reads the clock produces a different prefix on the
 * second run and the replay silently diverges.
 */

const NOW_ERROR =
  "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.";
const RANDOM_ERROR =
  "Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.";

/** Runs once per vm context, before any script is compiled into it. Messages match what Claude Code scripts see, for compatibility. */
const DETERMINISM_SHIM = `(() => {
  "use strict";
  const NOW_ERROR = ${JSON.stringify(NOW_ERROR)};
  const RANDOM_ERROR = ${JSON.stringify(RANDOM_ERROR)};
  Math.random = function random() { throw new Error(RANDOM_ERROR); };
  const RealDate = Date;
  RealDate.now = function now() { throw new Error(NOW_ERROR); };
  function WorkflowDate(...args) {
    if (!new.target || args.length === 0) throw new Error(NOW_ERROR);
    return Reflect.construct(RealDate, args, new.target);
  }
  WorkflowDate.now = RealDate.now;
  WorkflowDate.parse = RealDate.parse;
  WorkflowDate.UTC = RealDate.UTC;
  WorkflowDate.prototype = RealDate.prototype;
  RealDate.prototype.constructor = WorkflowDate;
  Object.freeze(RealDate);
  globalThis.Date = WorkflowDate;
})()`;

export const WORKER_SOURCE = `"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const port = parentPort;
const ITEM_CAP = workerData.itemCap;
const DETERMINISM_SHIM = ${JSON.stringify(DETERMINISM_SHIM)};

/* ------------------------------------------------------------------ *
 * RPC to the host
 *
 * The script never touches the agent manager. Every effect leaves as a
 * "call" message and comes back as a "response", so the host owns the
 * semaphore, the caps, and the abort story.
 * ------------------------------------------------------------------ */

let nextCallId = 1;
const pendingCalls = new Map();

/**
 * Label → why the most recent agent() call under it failed, for
 * \`agentError(label)\`. Per worker, so a nested workflow shares it the way it
 * shares resume labels; a success under the label clears it.
 */
const agentErrors = new Map();

/**
 * Output tokens this run has spent, as last reported by the host.
 *
 * A mirror, not a tally: every response carries the host's current total, so
 * there is exactly one counter and it cannot drift. Between responses it cannot
 * be stale in any way the script could observe — tokens only accrue through
 * agents, and an agent's response is the only thing the script waits on.
 */
let spentOutput = 0;

function callHost(method, payload) {
  // Drain first, so the phase() that named this agent reaches the host ahead of
  // the agent entry rather than a tick behind it.
  flushProgress();
  return new Promise(function (resolve, reject) {
    const callId = nextCallId++;
    pendingCalls.set(callId, { resolve: resolve, reject: reject });
    port.postMessage({ type: "call", callId: callId, method: method, payload: payload });
  });
}

port.on("message", function (message) {
  if (!message || message.type !== "response") return;
  if (typeof message.spent === "number") spentOutput = message.spent;
  const waiter = pendingCalls.get(message.callId);
  if (!waiter) return;
  pendingCalls.delete(message.callId);
  if (message.ok) {
    // Before resolving, so the script can read the reason as soon as agent()
    // hands it the null.
    if (typeof message.agentLabel === "string") {
      if (message.value === null && typeof message.error === "string") agentErrors.set(message.agentLabel, message.error);
      else agentErrors.delete(message.agentLabel);
    }
    waiter.resolve(message.value);
    return;
  }
  const error = new Error(message.error || "The workflow host rejected the call.");
  // Fatal errors are the run's, not the item's: parallel() and pipeline()
  // swallow ordinary failures into null, and a cap breach must not be
  // silently absorbed that way.
  if (message.fatal) error.workflowFatal = true;
  waiter.reject(error);
});

function isFatal(error) {
  return !!(error && typeof error === "object" && error.workflowFatal === true);
}

/* ------------------------------------------------------------------ *
 * Progress entries
 * ------------------------------------------------------------------ */

let progressQueue = [];
let flushTimer = null;

function emit(entry) {
  progressQueue.push(entry);
  // Batched on a macrotask: a fan-out emits a burst of phase/log entries in one
  // turn, and the host renders once per batch rather than once per entry.
  if (flushTimer === null) flushTimer = setTimeout(flushProgress, 0);
}

function flushProgress() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (progressQueue.length === 0) return;
  const batch = progressQueue;
  progressQueue = [];
  port.postMessage({ type: "progress", entries: batch });
}

/* ------------------------------------------------------------------ *
 * The JSON boundary
 *
 * Two directions, two policies. What the *script hands out* — its return
 * value, a child's args and result — is copied for compatibility with Claude
 * Code, so a script written there returns the same value here. What it hands
 * *in* as configuration — \`opts.schema\` — is checked strictly, because a
 * schema that changes shape in transit is a schema the journal key and the
 * tool's parameters disagree about.
 * ------------------------------------------------------------------ */

/**
 * The VM-boundary copy Claude Code scripts expect: own enumerable keys only, so \`toJSON\` is
 * never called and a Date, Map, Set or class instance arrives as \`{}\` plus its
 * own fields. A function property is dropped and a function array slot becomes
 * \`undefined\`; a \`__proto__\` key is skipped; a getter that throws loses its
 * property. Shared references and cycles are preserved, which is what lets the
 * stringify that follows reject a cycle instead of recursing forever.
 */
function toPlain(root) {
  const seen = new Map();
  function copy(value) {
    if (typeof value === "function") return undefined;
    if (value === null || typeof value !== "object") return value;
    const hit = seen.get(value);
    if (hit !== undefined) return hit;
    if (Array.isArray(value)) {
      const out = [];
      seen.set(value, out);
      const length = value.length;
      for (let i = 0; i < length; i++) {
        let item;
        try {
          item = value[i];
        } catch {
          item = undefined;
        }
        out[i] = copy(item);
      }
      return out;
    }
    const out = {};
    seen.set(value, out);
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return out;
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "__proto__") continue;
      let item;
      try {
        item = value[key];
      } catch {
        continue;
      }
      if (typeof item === "function") continue;
      out[key] = copy(item);
    }
    return out;
  }
  return copy(root);
}

/** The copy as JSON. Only a cycle or a BigInt can fail here. */
function toJson(value, what) {
  try {
    return JSON.stringify(toPlain(value));
  } catch (error) {
    throw new Error(what + " cannot be serialized: " + describe(error));
  }
}

/** The copy re-materialised in the script's realm, for a child's args and result. */
function toRealmCopy(value, what) {
  const json = toJson(value, what);
  return json === undefined ? undefined : realmParse(json);
}

let realmObjectPrototype = null;
/**
 * The realm's own \`JSON.parse\`.
 *
 * Module-scope, not local to main(), because \`agent({ schema })\` parses its
 * result here — outside main's closure — and the object has to carry the
 * *script's* Object.prototype, not the worker's, or \`instanceof Object\` fails
 * inside the script it was handed to.
 */
let realmParse = null;

/**
 * The top-level script's scope.
 *
 * Module-scope because a nested \`workflow()\` needs the realm-native function
 * compiler that \`main()\` builds, and because the compiled child function is
 * cached per body — see {@link workflowIn}.
 */
let rootScope = null;
/**
 * The vm context every script runs in.
 *
 * Held so a nested \`workflow()\` can compile its child there. Compiled from
 * *outside* the realm, with \`vm.Script\`, because the context itself has
 * \`codeGeneration.strings\` off — the script cannot build code, but the worker
 * that owns it still can.
 */
let realmContext = null;
/** Nested invocations made so far, against \`workerData.nestedCap\`. */
let nestedCount = 0;

function boundaryError(what, path) {
  return new Error(
    "Cannot pass " + what + " across the workflow VM boundary (at " + path + ")."
  );
}

function assertBoundary(value, path, seen) {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
    return;
  }
  if (kind === "undefined") throw boundaryError("undefined", path);
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError("a " + kind, path);

  if (seen.has(value)) throw boundaryError("a circular structure", path);
  seen.add(value);

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw boundaryError("an object with symbol keys", path);
  }

  if (Array.isArray(value)) {
    const length = value.length;
    for (let i = 0; i < length; i++) {
      // A sparse array round-trips through JSON as nulls, which silently
      // changes the data. Reject instead.
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw boundaryError("a sparse array", path + "[" + i + "]");
      }
      assertBoundary(value[i], path + "[" + i + "]", seen);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  // Two prototypes are legitimate: the realm's own Object.prototype (anything
  // the script built) and the worker's (arrays we hand back from parallel).
  // Everything else — Map, Set, Date, a class instance — loses meaning here.
  if (prototype !== null && prototype !== realmObjectPrototype && prototype !== Object.prototype) {
    throw boundaryError("a non-plain object", path);
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    assertBoundary(value[keys[i]], path + "." + keys[i], seen);
  }
  seen.delete(value);
}

function checkBoundary(value, path) {
  assertBoundary(value, path, new Set());
  return value;
}

/* ------------------------------------------------------------------ *
 * Realm helpers
 *
 * parallel() and pipeline() build their result arrays in worker code, but
 * the script should get an array its own realm recognises — otherwise
 * \`result instanceof Array\` is false and \`Array.isArray\` is the only thing
 * that works. Item values are moved across untouched.
 * ------------------------------------------------------------------ */

let realmNewArray = null;
let realmPush = null;

function toRealmArray(items) {
  const array = realmNewArray();
  for (let i = 0; i < items.length; i++) realmPush(array, items[i]);
  return array;
}

function toList(value, what) {
  if (!Array.isArray(value)) throw new Error(what + " expects an array.");
  const length = value.length >>> 0;
  if (length > ITEM_CAP) {
    throw new Error(
      what + " was given " + length + " items, over the limit of " + ITEM_CAP + "."
    );
  }
  const out = [];
  for (let i = 0; i < length; i++) out.push(value[i]);
  return out;
}

function requireText(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(what + " requires a non-empty string.");
  }
  return value;
}

function optionalText(value, what) {
  if (value === undefined || value === null) return undefined;
  return requireText(value, what);
}

/**
 * Reasoning effort a child may be spawned under — pi's \`ThinkingLevel\`.
 *
 * A superset of Claude Code's five, so a script written there runs here; the
 * extra \`minimal\` is pi's own. Validated in the worker rather than the host
 * because a typo should stop the script at the call that made it, not surface
 * later as an agent that quietly ran at the wrong depth.
 */
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * \`opts.effort\`, read for compatibility with Claude Code: empty means unset, case does not
 * matter, \`med\` means \`medium\`. An unknown level still throws here where
 * Claude Code drops it to the default — the same typo guard unknown option
 * keys get.
 */
function normalizeEffort(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const lower = String(value).toLowerCase();
  const level = lower === "med" ? "medium" : lower;
  if (EFFORT_LEVELS.indexOf(level) === -1) {
    throw new Error("agent() opts.effort must be one of: " + EFFORT_LEVELS.join(", ") + ".");
  }
  return level;
}

/**
 * \`opts.disallowedTools\`, validated for compatibility with Claude Code: a
 * malformed list refuses the spawn rather than running it un-narrowed. Empty
 * means unset; otherwise deduped and sorted, so the journal key does not
 * depend on the order the script listed them in.
 */
function normalizeDisallowedTools(value) {
  if (value === undefined) return undefined;
  const malformed = function (entry) {
    return typeof entry !== "string" || entry === "" || entry !== entry.trim();
  };
  if (!Array.isArray(value) || value.some(malformed)) {
    throw new Error(
      "agent() opts.disallowedTools must be an array of non-empty tool-name strings (e.g. ['Bash', 'Write']); got "
        + (Array.isArray(value) ? "an array with non-string, empty, or whitespace-padded entries" : typeof value)
        + ". Refusing the spawn rather than running it un-narrowed."
    );
  }
  if (value.length === 0) return undefined;
  return Array.from(new Set(value)).sort();
}

/**
 * Every option \`agent()\` understands.
 *
 * Checked rather than ignored, because the alternative is the worst failure a
 * ported script can have. Claude Code's \`agent()\` also takes \`schema\`, and its
 * own canonical example uses it; quietly dropping it hands the script the
 * agent's raw text where it expected a validated object, and the run then dies
 * several lines later reading a field off a string. A typo behaves the same
 * way. Naming the option costs one error message and no model calls.
 */
const AGENT_OPTIONS = [
  "label",
  "phase",
  "model",
  "agentType",
  "isolation",
  "gate",
  "resume",
  "effort",
  "schema",
  "disallowedTools",
];

/** Claude Code options this runtime does not have, and why. */
const UNSUPPORTED_AGENT_OPTIONS = {};

/* ------------------------------------------------------------------ *
 * Script globals
 * ------------------------------------------------------------------ */

/**
 * Phase indices are allocated once for the whole run, so parent and child never
 * collide. What is per-scope is the *title to index* map: a child's
 * \`phase("Scan")\` must not resolve to the parent's "Scan".
 */
let nextPhaseIndex = 0;

/**
 * One script's view of the world.
 *
 * A nested \`workflow()\` runs in this same worker and this same vm context —
 * which is what makes it share the run's semaphore, agent counter, journal,
 * abort signal and budget without any of them being plumbed anywhere. What it
 * must NOT share is ambient phase state, so that lives here and the child's
 * globals are closures over its own scope.
 */
function makeScope(name, depth) {
  const scope = {
    name: name,
    depth: depth,
    // Prefixed into every phase title the child defines, which is the whole of
    // how a nested run reads as its own group in the progress tree — no new
    // entry type, no renderer change.
    prefix: name === undefined ? "" : "\u25b8 " + name,
    ambientPhaseIndex: undefined,
    ambientPhaseTitle: undefined,
    phaseIndexByTitle: new Map(),
  };
  scope.agent = function (prompt, opts) {
    return agentIn(scope, prompt, opts);
  };
  scope.phase = function (title) {
    return phaseIn(scope, title);
  };
  scope.log = function (message) {
    return logIn(scope, message);
  };
  scope.workflow = function (ref, args) {
    return workflowIn(scope, ref, args);
  };
  scope.parallel = function (thunks) {
    return parallelIn(scope, thunks);
  };
  scope.pipeline = function (items, ...stages) {
    return pipelineIn(scope, items, stages);
  };
  scope.console = makeConsole(scope);
  return scope;
}

/** A scope's title for a phase: the child's own group, or the parent's bare title. */
function scopedTitle(scope, title) {
  if (scope.prefix === "") return title;
  return title === undefined ? scope.prefix : scope.prefix + " \u203a " + title;
}

function definePhaseIn(scope, title) {
  let index = scope.phaseIndexByTitle.get(title);
  if (index !== undefined) return index;
  index = nextPhaseIndex++;
  scope.phaseIndexByTitle.set(title, index);
  emit({ type: "workflow_phase", index: index, title: scopedTitle(scope, title) });
  return index;
}

function phaseIn(scope, title) {
  const text = requireText(title, "phase(title)");
  scope.ambientPhaseIndex = definePhaseIn(scope, text);
  scope.ambientPhaseTitle = scopedTitle(scope, text);
}

function describe(value) {
  if (typeof value === "string") return value;
  // Duck-typed, not \`instanceof Error\`: an error thrown by the script belongs
  // to the vm realm, so it fails an instanceof check against the worker's.
  if (value && typeof value === "object" && typeof value.message === "string" && typeof value.stack === "string") {
    return value.message;
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    /* cycles and BigInt fall through to String() */
  }
  return String(value);
}

/** Attribute a line to the child that wrote it; logs carry no phase of their own. */
function logPrefix(scope) {
  return scope.prefix === "" ? "" : scope.prefix + ": ";
}

function logIn(scope, message) {
  emit({ type: "workflow_log", message: logPrefix(scope) + describe(message) });
}

/** A slot that dropped to null: a log line now, and a \`<failures>\` line in the notification. */
function reportFailure(scope, line) {
  logIn(scope, line);
  port.postMessage({ type: "failure", message: logPrefix(scope) + line });
}

function makeConsole(scope) {
  const write = function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(describe(arguments[i]));
    emit({ type: "workflow_log", message: logPrefix(scope) + parts.join(" ") });
  };
  return { log: write, info: write, warn: write, error: write, debug: write };
}

async function agentIn(scope, prompt, opts) {
  const text = requireText(prompt, "agent(prompt)");
  const options = opts === undefined || opts === null ? {} : opts;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error("agent(prompt, opts) expects opts to be an object.");
  }

  for (const key of Object.keys(options)) {
    if (AGENT_OPTIONS.indexOf(key) !== -1) continue;
    const why = UNSUPPORTED_AGENT_OPTIONS[key];
    throw new Error(
      why !== undefined
        ? "agent() opts." + key + " is not supported here: " + why
        : "agent() opts." + key + " is not a recognised option. Supported: " + AGENT_OPTIONS.join(", ") + "."
    );
  }

  const label = optionalText(options.label, "agent() opts.label");
  const phaseName = optionalText(options.phase, "agent() opts.phase");
  const model = optionalText(options.model, "agent() opts.model");
  const agentType = optionalText(options.agentType, "agent() opts.agentType");
  const isolation = optionalText(options.isolation, "agent() opts.isolation");
  if (isolation !== undefined && isolation !== "worktree") {
    throw new Error("agent() opts.isolation must be \\"worktree\\".");
  }
  const gate = optionalText(options.gate, "agent() opts.gate");
  const resume = optionalText(options.resume, "agent() opts.resume");
  const effort = normalizeEffort(options.effort);
  const disallowedTools = normalizeDisallowedTools(options.disallowedTools);
  const schema = options.schema;
  if (schema !== undefined) {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new Error("agent() opts.schema must be a JSON Schema object.");
    }
    // Structured clone would happily carry a Map or a cycle that neither the
    // journal key nor the tool's parameters can survive. Same check the return
    // value gets.
    checkBoundary(schema, "agent() opts.schema");
  }

  // resume revives a child that already exists, so anything describing how to
  // *start* one is not a thing this call gets to decide — the revived child
  // keeps the agent, model and tool contract it was started with. Rejecting is
  // the point: silently ignoring these opts would look like they applied.
  if (resume !== undefined) {
    if (agentType !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.agentType are mutually exclusive: a resumed agent keeps the agent type it was started with."
      );
    }
    if (model !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.model are mutually exclusive: a resumed agent keeps the model it was started with."
      );
    }
    if (isolation !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.isolation are mutually exclusive: a resumed agent keeps the working tree it was started in."
      );
    }
    if (effort !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.effort are mutually exclusive: a resumed agent keeps the reasoning effort it was started with."
      );
    }
    if (schema !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.schema are mutually exclusive: a resumed child re-prompts the session it "
          + "already had, whose tool set was fixed when it started — it has no StructuredOutput tool to answer through."
      );
    }
    if (disallowedTools !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.disallowedTools are mutually exclusive: a resumed agent keeps the tool set it was started with."
      );
    }
    if (gate !== undefined) {
      throw new Error("agent() opts.gate cannot be combined with opts.resume.");
    }
  }

  // An explicit opts.phase files this agent under that phase without moving
  // the ambient one, so a stray verify step does not re-point the phases that
  // follow it.
  const phaseIndex = phaseName !== undefined ? definePhaseIn(scope, phaseName) : scope.ambientPhaseIndex;
  const phaseTitle = phaseName !== undefined ? scopedTitle(scope, phaseName) : scope.ambientPhaseTitle;

  const result = await callHost("agent", {
    prompt: text,
    label: label,
    model: model,
    agentType: agentType,
    isolation: isolation,
    phaseIndex: phaseIndex,
    phaseTitle: phaseTitle,
    gate: gate,
    resume: resume,
    effort: effort,
    schema: schema,
    disallowedTools: disallowedTools,
  });
  if (result === undefined || result === null) return null;
  if (schema === undefined) return result;
  // Parsed with the realm's own JSON.parse so the script gets an object whose
  // prototype is its own — \`x instanceof Object\` and \`x.list instanceof Array\`
  // both hold.
  try {
    return realmParse(result);
  } catch (error) {
    logIn(scope, "agent(): the host returned a structured result that is not JSON");
    return null;
  }
}

/**
 * A barrier: every thunk starts now, and nothing past the await runs until all
 * of them have settled. A thunk that throws resolves to null rather than
 * failing its siblings — the script filters, it does not try/catch — and
 * leaves a \`parallel[i] failed: …\` log line, so the null
 * is not silent. Per scope, so a nested child's line carries its prefix.
 */
async function parallelIn(scope, thunks) {
  const list = toList(thunks, "parallel(thunks)");
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "function") {
      throw new Error("parallel(thunks) expects an array of functions; item " + i + " is not one.");
    }
  }
  const settled = await Promise.all(
    list.map(async function (thunk, index) {
      try {
        return await thunk();
      } catch (error) {
        if (isFatal(error)) throw error;
        reportFailure(scope, "parallel[" + index + "] failed: " + describe(error));
        return null;
      }
    })
  );
  return toRealmArray(settled);
}

/**
 * No barrier between stages. Each item walks its own chain, so item A can be
 * in stage 3 while item B is still in stage 1 — which is the whole point:
 * a barrier makes every stage wait on its slowest sibling, and with agents in
 * the stages that latency is measured in minutes.
 *
 * A stage that throws drops that item to null, skips its remaining stages and
 * logs \`pipeline[i] failed: …\`. A stage that *returns* null also ends the
 * item's chain — the next stage would otherwise spend an
 * agent on "verify null" — and so does a null item. An item that is a promise
 * is awaited before stage one. Every stage sees (previousResult,
 * originalItem, index).
 */
async function pipelineIn(scope, items, stages) {
  const list = toList(items, "pipeline(items, ...stages)");
  for (let i = 0; i < stages.length; i++) {
    if (typeof stages[i] !== "function") {
      throw new Error("pipeline(items, ...stages) expects stages to be functions; stage " + i + " is not one.");
    }
  }
  const settled = await Promise.all(
    list.map(async function (item, index) {
      try {
        let value = await item;
        for (let s = 0; s < stages.length && value !== null; s++) {
          value = await stages[s](value, item, index);
        }
        return value;
      } catch (error) {
        if (isFatal(error)) throw error;
        reportFailure(scope, "pipeline[" + index + "] failed: " + describe(error));
        return null;
      }
    })
  );
  return toRealmArray(settled);
}

/**
 * The \`workflow(nameOrRef, args?)\` global.
 *
 * Runs another workflow inline. The child executes in *this* worker and *this*
 * vm context, as a function whose parameters shadow the globals — which is why
 * it shares the run's concurrency cap, agent counter, abort signal, journal and
 * budget without any of them being passed anywhere: there is only ever one of
 * each. What it does not share is ambient phase state, which lives on the scope.
 *
 * One level only, as in Claude Code. The child's \`workflow\` is present and
 * throws rather than absent, so the error names the limit instead of reading
 * \`workflow is not defined\`.
 */
async function workflowIn(scope, nameOrRef, args) {
  if (scope.depth > 0) {
    throw new Error(
      "workflow() cannot be nested more than one level deep — you are already inside the workflow '" +
        scope.name + "'. Call the agents inline instead."
    );
  }

  let ref;
  if (typeof nameOrRef === "string") {
    if (nameOrRef.trim() === "") throw new Error("workflow(nameOrRef) expects a non-empty name.");
    ref = { name: nameOrRef };
  } else if (nameOrRef && typeof nameOrRef === "object" && !Array.isArray(nameOrRef)) {
    const scriptPath = optionalText(nameOrRef.scriptPath, "workflow() scriptPath");
    const name = optionalText(nameOrRef.name, "workflow() name");
    if (scriptPath === undefined && name === undefined) {
      throw new Error("workflow({ ... }) expects a \`name\` or a \`scriptPath\`.");
    }
    ref = { name: name, scriptPath: scriptPath };
  } else {
    throw new Error("workflow(nameOrRef) expects a saved workflow name or { scriptPath }.");
  }

  const label = ref.name !== undefined ? ref.name : ref.scriptPath;
  // A copy, as Claude Code scripts expect: the child must not be able to
  // mutate the parent's object through its \`args\`.
  const childArgs = toRealmCopy(args, 'workflow("' + label + '") args');

  if (nestedCount >= workerData.nestedCap) {
    // Fatal, like the agent cap: a limit that silently drops work would be
    // worse than no limit.
    const error = new Error(
      "Workflow exceeded its cap of " + workerData.nestedCap + " nested workflow() calls."
    );
    error.workflowFatal = true;
    throw error;
  }
  nestedCount++;

  let loaded;
  try {
    loaded = await callHost("workflow", ref);
  } catch (error) {
    // Resolution failures are the script's to handle — Claude Code documents
    // workflow() as throwing on an unknown name so a script can catch it.
    // Attributed, so a caught error says which reference failed.
    if (isFatal(error)) throw error;
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }

  const child = makeScope(loaded.name, scope.depth + 1);
  // The child's own group, defined before its first agent so a child that never
  // calls phase() still reads as its own section rather than falling into the
  // parent's un-phased bucket.
  child.ambientPhaseIndex = definePhaseIn(child, undefined);
  child.ambientPhaseTitle = scopedTitle(child, undefined);

  let run;
  try {
    const compiled = new vm.Script(
      // The body runs in an inner function, so its own declarations shadow
      // these parameters instead of colliding with them — Claude Code hands a
      // child the same names as globals, which a \`const pipeline\` may shadow.
      // \`meta\` is not a parameter: the body opens with its own
      // \`const meta = { ... }\` (extractMeta strips only the \`export\`).
      "(async (agent, phase, log, workflow, console, args, parallel, pipeline) => {'use strict'; return (async () => {\\n"
        + loaded.body
        + "\\n})(); })",
      { filename: "workflow:" + loaded.name + ".js", lineOffset: -1 }
    );
    run = compiled.runInContext(realmContext);
  } catch (error) {
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }

  const value = await run(
    child.agent, child.phase, child.log, child.workflow, child.console, childArgs, child.parallel, child.pipeline
  );
  // Refused as a script's own result is, rather than copied to undefined.
  if (typeof value === "function") throw new Error('workflow("' + label + '") result cannot be a function');
  return toRealmCopy(value, 'the result of workflow("' + label + '")');
}

/**
 * The \`budget\` global.
 *
 * \`total\` is permanently null, and that is the honest answer rather than a
 * stub: Claude Code fills it from the user's "+500k" directive and pi has no
 * such directive, so "no target set" is the state this runtime is always in.
 * Every pattern Claude Code documents guards on exactly that — \`while
 * (budget.total && ...)\`, \`budget.total ? ... : 5\` — so those scripts run here
 * unchanged and take the branch they were written for. Leaving \`budget\`
 * undefined instead would turn a graceful guard into a ReferenceError.
 *
 * \`spent()\` is real. It differs from Claude Code's in scope: theirs pools the
 * main loop and every workflow in the turn, ours counts this run's agents.
 */
function makeBudget() {
  return {
    total: null,
    spent: function () {
      return spentOutput;
    },
    remaining: function () {
      // Infinity, not a number, because there is no target to subtract from.
      return Infinity;
    },
  };
}

/**
 * The \`setTimeout\` / \`clearTimeout\` globals, for compatibility with Claude
 * Code scripts: the delay coerced to a number, ids rather than handles, and a
 * callback that throws — or, being async, rejects — swallowed rather than
 * failing the run. Nothing clears them on
 * settle or abort because nothing has to — the host terminates this worker
 * either way.
 */
function makeTimers() {
  const handles = new Map();
  let nextId = 1;
  return {
    setTimeout: function (callback, ms) {
      if (typeof callback !== "function") {
        throw new TypeError("setTimeout(callback, ms) expects a function.");
      }
      const id = nextId++;
      handles.set(
        id,
        setTimeout(function () {
          handles.delete(id);
          // A timer callback cannot fail the run. Through a promise, so an
          // async callback's rejection is caught too rather than surfacing as
          // an unhandled rejection that kills the worker.
          Promise.resolve().then(callback).catch(function () {});
        }, Number(ms) || 0)
      );
      return id;
    },
    clearTimeout: function (id) {
      const handle = handles.get(id);
      if (handle === undefined) return;
      handles.delete(id);
      clearTimeout(handle);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  rootScope = makeScope(undefined, 0);
  const timers = makeTimers();
  const sandbox = {
    agent: rootScope.agent,
    parallel: rootScope.parallel,
    pipeline: rootScope.pipeline,
    phase: rootScope.phase,
    log: rootScope.log,
    workflow: rootScope.workflow,
    budget: makeBudget(),
    console: rootScope.console,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  // Read-only: a script that assigned over it would silently read its own
  // stand-in instead of the host's answer.
  Object.defineProperty(sandbox, "agentError", {
    value: function agentError(label) {
      return agentErrors.get(requireText(label, "agentError(label)"));
    },
    enumerable: true,
  });
  const context = vm.createContext(sandbox, {
    name: "workflow",
    codeGeneration: { strings: false, wasm: false },
  });

  vm.runInContext(DETERMINISM_SHIM, context);
  realmObjectPrototype = vm.runInContext("Object.prototype", context);
  realmNewArray = vm.runInContext("(function () { return []; })", context);
  realmPush = vm.runInContext("(function (array, value) { array.push(value); })", context);
  realmParse = vm.runInContext("JSON.parse", context);
  realmContext = context;

  // meta and args are materialised *inside* the realm rather than injected, so
  // the script sees objects whose prototype is its own Object.prototype and
  // whose .constructor is its own Function.
  sandbox.meta = realmParse(workerData.metaJson);
  sandbox.args = workerData.argsJson === undefined ? undefined : realmParse(workerData.argsJson);

  const script = new vm.Script("(async () => {'use strict';\\n" + workerData.body + "\\n})()", {
    filename: "workflow.js",
    // The wrapper, strict directive included, adds exactly one line above the
    // body; undo it so a thrown error points at the line the author wrote.
    // Strict: a Claude Code workflow script must not be relying on
    // sloppy-mode leniency here.
    lineOffset: -1,
  });

  const value = await script.runInContext(context);
  // The one value refused outright; everything else is copied.
  if (typeof value === "function") throw new Error("workflow result cannot be a function");
  const resultJson = toJson(value, "the workflow result");
  flushProgress();
  port.postMessage({ type: "complete", resultJson: resultJson });
}

main().catch(function (error) {
  flushProgress();
  port.postMessage({
    type: "error",
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack) : undefined,
  });
});
`;
