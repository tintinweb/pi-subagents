/**
 * cli-print-mode-e2e.test.ts — the real `pi` CLI, run the way a user runs it:
 * `pi -e <this repo> -p --subagents-workflow-file=x.js`, as a child process.
 *
 * The in-process runner (`helpers/print-mode-runner.ts`) is an SDK host: it
 * disposes the session itself and never sees what pi's print mode writes to
 * stderr after `session_shutdown`. Work that settles after shutdown and touches
 * the dead session shows up only here — as `Extension error (…)` lines, a stale
 * ctx warning, or a crash with a non-zero exit.
 *
 * No model is needed: with no prompt, pi never calls one. Runs against whichever
 * pi the repo has installed, so CI's floor and latest jobs cover both.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PI_PKG = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent");
const PI_CLI = join(PI_PKG, JSON.parse(readFileSync(join(PI_PKG, "package.json"), "utf-8")).bin.pi);

/** Run the CLI in a hermetic home, stdin closed; resolve with its exit code and output. */
function runPi(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent"), PI_E2E_LIVE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`pi did not exit:\n${stderr}`)); }, 25_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe("pi CLI, print mode", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("`pi -p --subagents-workflow-file=x.js` with no prompt stops the run and exits cleanly", async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-cli-e2e-"));
    const script = join(dir, "busy.js");
    // Still running at shutdown, so session_shutdown has to stop it.
    writeFileSync(script, [
      'export const meta = { name: "busy", description: "runs until stopped" };',
      "let n = 0; for (let i = 0; i < 1e12; i++) n += i;",
      "return n;",
    ].join("\n"));

    const { code, stdout, stderr } = await runPi(["-e", REPO, "-p", `--subagents-workflow-file=${script}`], dir);

    expect(code, stderr).toBe(0);
    expect(stdout).toBe("");
    // Exactly the two lines the user should see: the run started, and why it was
    // stopped. Anything else is the stopped run reaching into the dead session.
    expect(stderr.trim().split("\n")).toEqual([
      "[pi-subagents] Running workflow busy…",
      '[pi-subagents] --subagents-workflow-file under -p needs a prompt; workflow stopped. Example: pi -p --subagents-workflow-file=x.js "Report the result."',
    ]);
  }, 30_000);
});
