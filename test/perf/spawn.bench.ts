/**
 * spawn.bench.ts — what one `Agent` tool call costs before the model is even
 * asked anything.
 *
 * The dominant term is not the resolution logic, it is disk. `execute` opens
 * with `reloadCustomAgents()`, and `loadCustomAgents` sweeps three directories
 * with `readdirSync`, then `readFileSync` + parses YAML frontmatter for every
 * `.md` it finds — synchronously, on the event loop, with no mtime cache. A
 * fan-out of ten `Agent` calls in one assistant message pays all of it ten
 * times, and it scales with a directory the user controls.
 *
 * `runAgent` is mocked, so what is measured is the extension's own spawn path:
 * agent-file reload, type/model resolution, record creation, and rendering the
 * background envelope. The child session, and pi's cost in creating one, are
 * deliberately outside the measurement.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, bench, describe, vi } from "vitest";

vi.mock("../../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent-runner.js")>("../../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent } from "../../src/agent-runner.js";
import { registerAgents } from "../../src/agent-types.js";
import { loadCustomAgents } from "../../src/custom-agents.js";
import subagentsExtension from "../../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "../helpers/boot-extension.js";

/** A believable agent file: frontmatter to parse plus a body to read past. */
function agentFile(i: number): string {
  return [
    "---",
    `description: "Perf fixture agent ${i}, one of many in this directory."`,
    "tools: read, grep, bash",
    "---",
    "",
    `You are perf fixture agent ${i}. Do the thing the parent asked, then stop.`,
    "",
  ].join("\n");
}

/**
 * A standalone project dir holding `n` agent files under `.pi/agents`.
 *
 * Deliberately not `hermeticDir()`: that helper also chdir's, and one per size
 * would leave the process in whichever ran last. The one below owns the global
 * redirect for the whole file; these own only the files being counted.
 *
 * They must outlive collection. The first version of this file built each dir
 * and tore it down in the same loop iteration — but a `bench()` body runs long
 * after collection returns, so all three sizes measured a directory that no
 * longer existed and reported an identical 7.6 us (the cost of `existsSync`
 * saying no). A benchmark that cannot see its own fixture reports a flat line,
 * not an error.
 */
function projectDirWith(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "perf-agents-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(agentsDir, `perf-agent-${i}.md`), agentFile(i));
  tempDirs.push(dir);
  return dir;
}

const tempDirs: string[] = [];
const hermetics: Hermetic[] = [];
afterAll(() => {
  for (const h of hermetics.reverse()) h.restore();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  registerAgents(new Map());
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
});

// Empty global agent dir + empty cwd, so the developer's own ~/.pi agents are
// not silently added to every count below.
const globalRedirect = hermeticDir();
hermetics.push(globalRedirect);

describe("loadCustomAgents (runs on every Agent call)", () => {
  for (const n of [5, 50, 200]) {
    const cwd = projectDirWith(n);
    bench(`${n} agent files`, () => {
      loadCustomAgents(cwd);
    });
  }
});

describe("Agent tool — background spawn", () => {
  vi.mocked(runAgent).mockImplementation(async () => ({
    responseText: "done",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  }));

  /** A freshly activated extension, reading agent files from `globalRedirect`. */
  function bootAgentTool() {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    return tools.get("Agent");
  }

  const c = ctx();
  let i = 0;

  const agent = bootAgentTool();

  /**
   * The sample count is pinned, and that pin is what makes this number mean
   * something.
   *
   * Spawned records stay in the manager, and the spawn path scans them —
   * `takenHandles()` walks every live agent plus every tombstone, twice per
   * call — so the population grows underneath the measurement. Measured over
   * 600 consecutive spawns it drifts from 0.416 ms to 0.608 ms, a 46% climb
   * that belongs to the benchmark rather than to the code under test. Over the
   * first hundred it is flat. `time: 0` makes the loop run exactly `iterations`
   * samples instead of as many as fit in 500 ms, which held that drift to
   * roughly 1% between repeat runs; left to the default it sampled ~900 spawns
   * and inflated the mean 2.5x.
   *
   * So this is the cost of a spawn into a manager holding at most ~100 agents.
   * A cleaner design would reset the manager between samples, but the handle
   * published on `Symbol.for("pi-subagents:manager")` exposes no way to clear
   * it, tinybench's per-sample hooks never run (vitest drops them — see
   * `viewer.bench.ts`), and a pool of freshly booted extensions was tried and
   * was worse: 105 live managers and their timers produced a 64 ms outlier and
   * ±42% rme, replacing a known bias with unusable noise.
   */
  bench(
    "general-purpose, run_in_background",
    async () => {
      await agent.execute(
        `bench-${i++}`,
        { subagent_type: "general-purpose", description: "bench spawn", prompt: "go", run_in_background: true },
        undefined,
        undefined,
        c,
      );
    },
    { time: 0, iterations: 100, warmupTime: 0, warmupIterations: 10 },
  );
});
