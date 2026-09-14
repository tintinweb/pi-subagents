/**
 * ab.mjs — run the benchmarks against the working tree AND against another git
 * ref, then print the difference.
 *
 *   npm run bench:ab -- master
 *   npm run bench:ab -- HEAD~1 --rounds 5 --filter viewer
 *
 * This is the question `vitest bench --compare` cannot answer. `--compare` only
 * annotates a run with a stored baseline and never fails; more importantly the
 * baseline has to have been produced by the other tree, which is precisely the
 * work this script does. Here the comparison is built fresh, from the same
 * benchmark sources, on the machine you are sitting at.
 *
 * METHOD, and why each part is there:
 *
 *  - One process per measurement. Two configurations benchmarked in one process
 *    are not comparable: this repo produced a 7% spread between identical code
 *    paths purely from JIT ordering.
 *  - Rounds alternate A, B, A, B. A machine that gets busy mid-run then damages
 *    both trees rather than whichever went second.
 *  - Each round contributes its MEDIAN sample, and the reported number is the
 *    fastest of those rounds. Noise only ever adds time, so the lowest
 *    observation sits closest to the truth; the median makes each round robust
 *    to a single outlier rather than letting one GC pause set the number.
 *  - The working tree's benchmark files and fixtures are COPIED into the base
 *    worktree before it runs. The base commit does not contain them; without
 *    this the older side silently benchmarks nothing.
 *  - Surplus arguments are ignored by JavaScript, which is what lets one
 *    benchmark file drive an older constructor. A benchmark that names a symbol
 *    the base lacks fails only that task, and is reported as "n/a" rather than
 *    taking the run down.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const PERF_DIR = join("test", "perf");
const FIXTURES = join("test", "helpers", "perf-fixtures.ts");

function usage(message) {
  if (message) console.error(`\n  ${message}`);
  console.error(`
  Usage: npm run bench:ab -- <ref> [--rounds N] [--filter substring]

    <ref>       git ref to compare the working tree against (e.g. master, HEAD~1)
    --rounds    how many alternating A/B rounds to run (default 3)
    --filter    only benchmark files whose path contains this substring
`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const opts = { ref: undefined, rounds: 3, filter: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (!opts.ref) opts.ref = arg;
    else usage(`Unexpected argument: ${arg}`);
  }
  if (!opts.ref) usage("Missing <ref>.");
  if (!Number.isInteger(opts.rounds) || opts.rounds < 1) usage("--rounds must be a positive integer.");
  return opts;
}

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf-8" }).trim();

/** Run the benchmarks in `cwd`, returning task name → median ms per sample. */
function runBench(cwd, filter, jsonPath) {
  const args = ["vitest", "bench", ...(filter ? [filter] : []), `--outputJson=${jsonPath}`];
  try {
    execFileSync("npx", args, { cwd, stdio: "ignore" });
  } catch {
    // A failed task still writes the file for everything that did run; a missing
    // file means the whole run died, which the caller reports as "n/a".
    if (!existsSync(jsonPath)) return null;
  }
  if (!existsSync(jsonPath)) return null;

  const report = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const out = new Map();
  for (const file of report.files ?? []) {
    for (const group of file.groups ?? []) {
      // Group names are absolute-path-prefixed; strip so the two trees agree.
      const groupName = String(group.fullName ?? "").replace(/^.*\.bench\.ts > /, "");
      for (const bench of group.benchmarks ?? []) {
        // Median, not mean: the spawn task does real disk I/O and throws the
        // occasional millisecond-scale outlier, which drags a mean around by
        // tens of percent between runs while the median barely moves.
        out.set(`${groupName} > ${bench.name}`, bench.median ?? bench.mean);
      }
    }
  }
  return out;
}

/** Keep the fastest round per task. */
function mergeMin(into, sample) {
  if (!sample) return;
  for (const [name, value] of sample) {
    const prev = into.get(name);
    if (prev == null || value < prev) into.set(name, value);
  }
}

function fmt(ms) {
  if (ms == null) return "n/a";
  if (ms >= 1) return `${ms.toFixed(3)}ms`;
  if (ms >= 0.001) return `${(ms * 1000).toFixed(2)}us`;
  return `${(ms * 1_000_000).toFixed(1)}ns`;
}

function report(head, base, ref) {
  const names = [...new Set([...head.keys(), ...base.keys()])].sort();
  const rows = names.map(name => {
    const a = base.get(name);
    const b = head.get(name);
    const delta = a != null && b != null && a > 0 ? (b - a) / a : undefined;
    return { name, base: a, head: b, delta };
  });

  const width = Math.max(20, ...rows.map(r => r.name.length));
  const pad = (s, n) => String(s).padEnd(n);
  const padStart = (s, n) => String(s).padStart(n);

  console.log(`\n  ${pad("benchmark", width)}  ${padStart(ref, 12)}  ${padStart("working", 12)}  ${padStart("delta", 9)}`);
  console.log(`  ${"-".repeat(width)}  ${"-".repeat(12)}  ${"-".repeat(12)}  ${"-".repeat(9)}`);
  for (const r of rows) {
    const delta = r.delta == null
      ? "n/a"
      : `${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)}%`;
    console.log(`  ${pad(r.name, width)}  ${padStart(fmt(r.base), 12)}  ${padStart(fmt(r.head), 12)}  ${padStart(delta, 9)}`);
  }

  const missing = rows.filter(r => r.base == null || r.head == null);
  if (missing.length > 0) {
    console.log(`\n  ${missing.length} task(s) ran on only one side — a benchmark naming a symbol the other tree lacks.`);
  }
  console.log(
    "\n  Reported value is the fastest round's median sample. " +
    "Treat anything under ~5% as noise unless it reproduces.\n",
  );
}

const opts = parseArgs(process.argv.slice(2));

if (!existsSync(join(REPO, PERF_DIR))) usage(`No ${PERF_DIR} directory here — run from the repo root.`);

const sha = git("rev-parse", "--short", opts.ref);
const worktree = mkdtempSync(join(tmpdir(), "pi-subagents-ab-"));
const jsonDir = mkdtempSync(join(tmpdir(), "pi-subagents-ab-json-"));

console.log(`\n  Comparing working tree against ${opts.ref} (${sha}), ${opts.rounds} round(s).`);

try {
  git("worktree", "add", "--detach", worktree, sha);

  // Dependencies are identical for both sides by construction; installing them
  // twice would take minutes and prove nothing.
  symlinkSync(join(REPO, "node_modules"), join(worktree, "node_modules"), "dir");

  // The base commit predates these files. Carrying them over is what makes the
  // two runs the same benchmark.
  mkdirSync(join(worktree, PERF_DIR), { recursive: true });
  for (const file of readdirSync(join(REPO, PERF_DIR))) {
    if (file.endsWith(".bench.ts")) {
      cpSync(join(REPO, PERF_DIR, file), join(worktree, PERF_DIR, file));
    }
  }
  mkdirSync(join(worktree, "test", "helpers"), { recursive: true });
  cpSync(join(REPO, FIXTURES), join(worktree, FIXTURES));

  const head = new Map();
  const base = new Map();

  for (let round = 1; round <= opts.rounds; round++) {
    process.stdout.write(`  round ${round}/${opts.rounds}: working tree… `);
    mergeMin(head, runBench(REPO, opts.filter, join(jsonDir, `head-${round}.json`)));
    process.stdout.write(`${sha}… `);
    mergeMin(base, runBench(worktree, opts.filter, join(jsonDir, `base-${round}.json`)));
    console.log("done");
  }

  report(head, base, sha);
} finally {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: REPO, stdio: "ignore" });
  } catch {
    rmSync(worktree, { recursive: true, force: true });
    try { execFileSync("git", ["worktree", "prune"], { cwd: REPO, stdio: "ignore" }); } catch { /* best effort */ }
  }
  rmSync(jsonDir, { recursive: true, force: true });
}
