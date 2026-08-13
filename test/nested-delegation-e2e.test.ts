/**
 * nested-delegation-e2e.test.ts — regression for opt-in nested delegation, run
 * through the real stack: real pi loader + real extension + real runAgent + two
 * real child sessions, on a faux model.
 *
 * Everything else that covers nesting stops short of a real session — the tool
 * unit tests use a fake manager, and the runner tests assert against a mocked
 * pi. That leaves the load-bearing integration facts unproven: that pi actually
 * admits the injected `customTools` into a child session's ACTIVE tool set
 * (they collide with EXCLUDED_TOOL_NAMES by design, so a registry gate could
 * silently drop them), and that a grandchild's output travels back up two hops.
 * Those are exactly the things that break quietly, so they are pinned here.
 *
 * Deliberately faux, not live: `PI_E2E_LIVE=1` cannot drive a three-level chain
 * deterministically, and a live model choosing not to delegate would look like
 * a passing test. Each run therefore pins `live: false` rather than trusting the
 * env var to leave it alone — the pre-publish smoke sets it globally.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCwd } from "../src/output-file.js";
import {
  agentCall,
  type FauxReply,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

/** Marker the deepest agent emits — it must survive two hops back to the parent. */
const WORKER_MARKER = "WORKER-REACHED-THE-TOP";

/** First user message of a session — the only stable way to tell three faux sessions apart. */
function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

/** Tool results in a session context, newest last, with their tool names. */
function toolResultTexts(context: Context): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const m of context.messages) {
    if (m.role !== "toolResult") continue;
    const name = (m as { toolName?: string }).toolName ?? "";
    const text = ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    out.push({ name, text });
  }
  return out;
}

/** Every `.output` transcript beneath a root, at any session/tasks depth. */
function findOutputFiles(root: string): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((e) => {
    const full = join(root, e);
    if (statSync(full).isDirectory()) return findOutputFiles(full);
    return full.endsWith(".output") ? [full] : [];
  });
}

function writeAgents(cwd: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  // Opts into nesting, restricted to one type — the allowlist path, not `all`.
  writeFileSync(
    join(dir, "orchestrator.md"),
    "---\ndescription: Delegating orchestrator\ntools: read\nextensions: false\nallowed_subagents: worker\n---\nDelegate to worker.\n",
  );
  writeFileSync(
    join(dir, "worker.md"),
    "---\ndescription: Leaf worker\ntools: read\nextensions: false\n---\nDo the work.\n",
  );
}

describe("nested delegation e2e (real pi-mono, faux model)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a child with allowed_subagents spawns its own child, and the output travels back up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-"));
    tmpDirs.push(cwd);
    writeAgents(cwd);

    /** Tool names each session was actually offered, keyed by who it is. */
    const toolsSeen = new Map<string, string[]>();

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context);
      const names = (context.tools ?? []).map((t) => t.name);

      // Leaf: no nested tools (it never opted in) — just answer.
      if (text.includes("Do the leaf work")) {
        toolsSeen.set("worker", names);
        return WORKER_MARKER;
      }

      // Middle: opted in, so pi must have admitted the injected Agent tool.
      if (text.includes("Delegate this downward")) {
        toolsSeen.set("orchestrator", names);
        const alreadySpawned = context.messages.some(
          (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
        );
        if (alreadySpawned) {
          const result = [...context.messages]
            .reverse()
            .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");
          const inner = ((result?.content ?? []) as Array<{ text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
          // Echo the child's own text: if it never arrived, the marker is absent
          // and the top-level assertion fails rather than passing vacuously.
          return `orchestrator saw: ${inner}`;
        }
        return agentCall({
          subagent_type: "worker",
          description: "leaf work",
          prompt: "Do the leaf work.",
        });
      }

      // Top-level parent.
      toolsSeen.set("parent", names);
      const spawned = context.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
      );
      if (spawned) {
        const result = [...context.messages]
          .reverse()
          .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");
        const inner = ((result?.content ?? []) as Array<{ text?: string }>)
          .map((b) => b.text ?? "")
          .join("");
        return `parent saw: ${inner}`;
      }
      return agentCall({
        subagent_type: "orchestrator",
        description: "delegate",
        prompt: "Delegate this downward.",
      });
    };

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd,
      respond,
      live: false,
    });

    // pi admitted the injected nested tools into the opted-in child's active set,
    // despite their names colliding with the ones stripped from every subagent.
    expect(toolsSeen.get("orchestrator")).toContain("Agent");
    expect(toolsSeen.get("orchestrator")).toContain("get_subagent_result");
    expect(toolsSeen.get("orchestrator")).toContain("steer_subagent");

    // The leaf never opted in, so it must not have them.
    expect(toolsSeen.get("worker")).toBeDefined();
    expect(toolsSeen.get("worker")).not.toContain("Agent");

    // Two hops home: worker → orchestrator → parent.
    expect(run.responseText).toContain(WORKER_MARKER);
  });

  it("backgrounds a nested child, polls it by id, and streams its transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-bg-"));
    tmpDirs.push(cwd);
    writeAgents(cwd);
    const transcriptRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
    rmSync(transcriptRoot, { recursive: true, force: true });

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context);

      if (text.includes("Do the leaf work")) return WORKER_MARKER;

      if (text.includes("Delegate this downward")) {
        const results = toolResultTexts(context);
        const spawned = results.find((r) => r.name === "Agent")?.text ?? "";
        const polled = results.find((r) => r.name === "get_subagent_result")?.text;
        // Third turn: the poll came back — echo it so a lost result fails loudly.
        if (polled !== undefined) return `orchestrator polled: ${polled}`;
        // Second turn: the spawn returned an id; fetch by exactly that id, which
        // also exercises the manager's ownership check from inside a child.
        if (spawned) {
          const id = /Agent ID:\s*(\S+)/.exec(spawned)?.[1];
          expect(id).toBeTruthy();
          return fauxToolCall("get_subagent_result", { agent_id: id, wait: true });
        }
        return agentCall({
          subagent_type: "worker",
          description: "leaf work",
          prompt: "Do the leaf work.",
          run_in_background: true,
        });
      }

      if (toolResultTexts(context).some((r) => r.name === "Agent")) return "parent done";
      return agentCall({
        subagent_type: "orchestrator",
        description: "delegate",
        prompt: "Delegate this downward.",
      });
    };

    try {
      run = await runPrintMode({
        prompt: "Delegate the work.",
        cwd,
        respond,
        live: false,
      });

      // The background child ran and its output came back through the id the
      // spawn handed out — so it was never queued behind its waiting parent.
      const orchestratorResult = run.parentSession.messages
        .filter((m) => m.role === "toolResult")
        .flatMap((m) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? ""))
        .join("\n");
      expect(orchestratorResult).toContain("orchestrator polled");
      expect(orchestratorResult).toContain(WORKER_MARKER);

      // Only the REAL manager wires onSessionCreated → streamToOutputFile for a
      // nested spawn, and only real rootSessionId propagation puts the file under
      // this root. Identify the WORKER's own transcript by the prompt in its
      // initial entry — matching the marker alone would also match the
      // orchestrator's transcript, which merely echoes it, and would pass even
      // with nested transcripts switched off entirely.
      // Match on the FIRST line — writeInitialEntry seeds each transcript with the
      // prompt that agent was given. Searching the whole file would also match the
      // orchestrator's, which records the same string inside its Agent tool-call
      // arguments, and would pass with nested transcripts switched off entirely.
      const transcripts = findOutputFiles(transcriptRoot).map((f) => readFileSync(f, "utf-8"));
      const workerTranscript = transcripts.find((t) => {
        const first = JSON.parse(t.split("\n")[0]) as { message?: { content?: unknown } };
        return first.message?.content === "Do the leaf work.";
      });
      expect(workerTranscript).toBeDefined();
      // ...and it streamed the child's own turn, not just the seeded prompt.
      expect(workerTranscript).toContain(WORKER_MARKER);
    } finally {
      rmSync(transcriptRoot, { recursive: true, force: true });
    }
  });
});
