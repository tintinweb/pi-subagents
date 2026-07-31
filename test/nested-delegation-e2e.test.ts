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
 * a passing test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
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
      beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
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
});
