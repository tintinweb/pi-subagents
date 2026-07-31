/**
 * subagents-nested-print-mode-e2e.test.ts — remaining real-session coverage for
 * opt-in nested delegation after #164 landed.
 *
 * `test/nested-delegation-e2e.test.ts` already pins the happy path (tool
 * admission + two-hop foreground return + background poll/transcript). This
 * file covers the production-boundary cases that suite still leaves open:
 * default-off injection, depth-cap tool stripping, background parent holds
 * while a child nests, and cross-parent ownership denial against the published
 * root manager lifecycle.
 *
 * Extracted from codesoda/pi-subagents#2 (test-only follow-up to #164) and
 * reconciled with the merged #164 frontmatter contract (`allowed_subagents`
 * opt-in; no nested tools injected at the depth cap).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import {
  agentCall,
  type FauxResponder,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const NESTED_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"];

function userPrompt(ctx: Context): string {
  for (const message of ctx.messages) {
    if (message.role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find(
        (block: { type?: string; text?: string }) => block.type === "text",
      ) as { text?: string } | undefined;
      if (text?.text) return text.text;
    }
  }
  return "";
}

function tools(ctx: Context): string[] {
  return (ctx.tools ?? []).map((tool) => tool.name);
}

function toolResults(ctx: Context, name: string): string[] {
  return ctx.messages.flatMap((message) => {
    if (
      message.role !== "toolResult" ||
      (message as { toolName?: string }).toolName !== name
    ) {
      return [];
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return [
      content
        .map((block: { type?: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : "",
        )
        .join(""),
    ];
  });
}

function nestedToolsIn(toolNames: string[] | undefined): string[] {
  return (toolNames ?? []).filter((name) => NESTED_TOOLS.includes(name));
}

async function waitForChildReady(
  ready: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Nested child did not enter its deferred response within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lastToolResult(ctx: Context, name: string): string {
  const results = toolResults(ctx, name);
  return results[results.length - 1] ?? "";
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ToolCall {
  return { type: "toolCall", id, name, arguments: args } as ToolCall;
}

function writeAgents(cwd: string, agents: Record<string, string>): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  for (const [name, frontmatter] of Object.entries(agents)) {
    writeFileSync(
      join(dir, `${name}.md`),
      `---\ndescription: ${name}\n${frontmatter}---\n${name} agent\n`,
    );
  }
}

async function runWithAgents(
  agents: Record<string, string>,
  respond: FauxResponder,
  options: { prompt: string; maxModelCalls?: number; hold?: boolean } = {
    prompt: "root",
  },
): Promise<{ run: PrintModeRun; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-nested-e2e-"));
  writeAgents(cwd, agents);
  const run = await runPrintMode({
    ...options,
    cwd,
    respond,
    beforeRun: () => registerAgents(loadCustomAgents(cwd)),
  });
  return { run, cwd };
}

describe("PR #164 nested agents through the real print-mode boundary", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("does not inject nested orchestration tools into a custom agent by default", async () => {
    const observed = new Map<string, string[]>();
    ({ run, cwd } = await runWithAgents(
      { plain: "" },
      (ctx) => {
        const route = userPrompt(ctx);
        if (route === "plain-child") {
          observed.set(route, tools(ctx));
          return "PLAIN_CHILD_RESULT";
        }
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "plain",
            description: "plain child",
            prompt: "plain-child",
            run_in_background: false,
          });
        }
        return lastToolResult(ctx, "Agent");
      },
      { prompt: "root-default" },
    ));

    expect(run.responseText).toContain("PLAIN_CHILD_RESULT");
    expect(observed.get("plain-child")).toBeDefined();
    expect(nestedToolsIn(observed.get("plain-child"))).toEqual([]);
  });

  it("strips nested tools at the depth cap instead of injecting always-failing ones", async () => {
    // Default maxSubagentDepth is 2: main(0) → level_one(1) → level_two(2).
    // #164 injects nested tools only while depth < max, so the agent at the cap
    // never sees Agent/get/steer even when it opts in via allowed_subagents.
    const observed = new Map<string, string[]>();
    ({ run, cwd } = await runWithAgents(
      {
        level_one: "allowed_subagents: level_two\n",
        level_two: "allowed_subagents: level_three\n",
        level_three: "",
      },
      (ctx) => {
        const route = userPrompt(ctx);
        observed.set(route, tools(ctx));
        if (route === "level_three-child") return "UNEXPECTED_LEVEL_THREE";
        if (route === "level_two-child") {
          const nested = nestedToolsIn(tools(ctx));
          // Cap agents must complete directly — they have no nested tools.
          return `AT_CAP tools=${nested.length === 0 ? "none" : nested.join(",")}`;
        }
        if (route === "level_one-child") {
          if (toolResults(ctx, "Agent").length === 0) {
            return agentCall({
              subagent_type: "level_two",
              description: "allowed level",
              prompt: "level_two-child",
              run_in_background: false,
            });
          }
          return lastToolResult(ctx, "Agent");
        }
        if (toolResults(ctx, "Agent").length === 0) {
          return agentCall({
            subagent_type: "level_one",
            description: "recursive chain",
            prompt: "level_one-child",
            run_in_background: false,
          });
        }
        return lastToolResult(ctx, "Agent");
      },
      { prompt: "root-depth", maxModelCalls: 24 },
    ));

    expect(run.responseText).toContain("AT_CAP tools=none");
    expect(observed.get("level_one-child")).toEqual(
      expect.arrayContaining(NESTED_TOOLS),
    );
    expect(nestedToolsIn(observed.get("level_two-child"))).toEqual([]);
    expect(observed.has("level_three-child")).toBe(false);
  });

  it("holds a background child while it performs real nested delegation", async () => {
    const calls = new Map<string, number>();
    ({ run, cwd } = await runWithAgents(
      {
        background_delegator: "allowed_subagents: background_grandchild\n",
        background_grandchild: "",
      },
      async (ctx) => {
        const route = userPrompt(ctx);
        calls.set(route, (calls.get(route) ?? 0) + 1);
        if (route === "background-grandchild-child") {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return "BACKGROUND_NESTED_RESULT";
        }
        if (route === "background-delegator-child") {
          if (toolResults(ctx, "Agent").length === 0) {
            return agentCall({
              subagent_type: "background_grandchild",
              description: "nested foreground work",
              prompt: "background-grandchild-child",
              run_in_background: false,
            });
          }
          return lastToolResult(ctx, "Agent");
        }
        const agents = toolResults(ctx, "Agent");
        if (agents.length === 0) {
          return agentCall({
            subagent_type: "background_delegator",
            description: "background nested work",
            prompt: "background-delegator-child",
            run_in_background: true,
          });
        }
        if (toolResults(ctx, "get_subagent_result").length === 0) {
          const id = agents[0].match(/Agent ID: ([^\s]+)/)?.[1];
          if (!id) throw new Error(`No background agent ID in: ${agents[0]}`);
          return toolCall(
            "get_subagent_result",
            { agent_id: id, wait: true },
            "get-background-result",
          );
        }
        return lastToolResult(ctx, "get_subagent_result");
      },
      { prompt: "root-background", maxModelCalls: 24 },
    ));

    expect(run.responseText).toContain("BACKGROUND_NESTED_RESULT");
    expect(calls.get("background-delegator-child")).toBe(2);
    expect(calls.get("background-grandchild-child")).toBe(1);
    expect(
      run.parentSession.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (block) =>
              block.type === "toolCall" && block.name === "get_subagent_result",
          ),
      ),
    ).toBe(true);
  });

  it("keeps nested get and steer ownership-scoped to the calling parent", async () => {
    // #164 aborts nested children when their owner settles, so the owner must
    // stay running while a foreign peer probes the live nested record. Spawn
    // both owner and probe as top-level background agents (hold:false so the
    // root can continue); the nested tools themselves enforce ownership.
    const probeResults: { get?: string; steer?: string } = {};
    let ownedChildBlocked = false;
    let releaseOwnedChild = () => {};
    let releaseOwner = () => {};
    let ownedChildEntered!: () => void;
    let ownerHolding!: () => void;
    let nestedId = "";
    const ownedChildReady = new Promise<void>((resolve) => {
      ownedChildEntered = resolve;
    });
    const ownedChildRelease = new Promise<void>((resolve) => {
      releaseOwnedChild = resolve;
    });
    const ownerHold = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const ownerHoldingReady = new Promise<void>((resolve) => {
      ownerHolding = resolve;
    });
    let waitForAll: Promise<void> | undefined;

    try {
      ({ run, cwd } = await runWithAgents(
        {
          owner: "allowed_subagents: owned_child\n",
          // Unrestricted nested allowlist — still ownership-scoped at runtime.
          probe: "allowed_subagents: all\n",
          owned_child: "",
        },
        async (ctx) => {
          const route = userPrompt(ctx);
          if (route === "owned-child") {
            ownedChildBlocked = true;
            ownedChildEntered();
            await ownedChildRelease;
            return "OWNED_NESTED_RESULT";
          }
          if (route === "owner-child") {
            const agents = toolResults(ctx, "Agent");
            if (agents.length === 0) {
              return agentCall({
                subagent_type: "owned_child",
                description: "owned nested child",
                prompt: "owned-child",
                run_in_background: true,
              });
            }
            const id = agents[0].match(/Agent ID: ([^\s]+)/)?.[1];
            if (!id) throw new Error(`No nested ID in: ${agents[0]}`);
            nestedId = id;
            ownerHolding();
            // Stay running so #164 does not abortOwnedChildren(owned_child).
            await ownerHold;
            return `OWNER_NESTED_ID:${id}`;
          }
          if (route === "probe-child") {
            await ownedChildReady;
            // Wait until the owner has published the nested id.
            await waitForChildReady(ownerHoldingReady, 5_000);
            const id = nestedId;
            if (!id) throw new Error("Owner never published a nested agent id");
            const gets = toolResults(ctx, "get_subagent_result");
            const steers = toolResults(ctx, "steer_subagent");
            if (gets.length === 0) {
              return toolCall(
                "get_subagent_result",
                { agent_id: id },
                "foreign-get",
              );
            }
            if (steers.length === 0) {
              return toolCall(
                "steer_subagent",
                { agent_id: id, message: "foreign guidance" },
                "foreign-steer",
              );
            }
            probeResults.get = gets.at(-1);
            probeResults.steer = steers.at(-1);
            return "OWNERSHIP_PROBE_DONE";
          }
          const agents = toolResults(ctx, "Agent");
          if (agents.length === 0) {
            return agentCall({
              subagent_type: "owner",
              description: "nested record owner",
              prompt: "owner-child",
              run_in_background: true,
            });
          }
          if (agents.length === 1) {
            // Fire probe without waiting for the background owner to finish.
            return agentCall({
              subagent_type: "probe",
              description: "foreign ownership probe",
              prompt: "probe-child",
              run_in_background: true,
            });
          }
          const results = toolResults(ctx, "get_subagent_result");
          if (results.length === 0) {
            // Poll the probe (second background agent) for the denial outcome.
            const probeSpawn = agents[1];
            const probeId = probeSpawn.match(/Agent ID: ([^\s]+)/)?.[1];
            if (!probeId) throw new Error(`No probe ID in: ${probeSpawn}`);
            return toolCall(
              "get_subagent_result",
              { agent_id: probeId, wait: true },
              "await-probe",
            );
          }
          return lastToolResult(ctx, "get_subagent_result");
        },
        { prompt: "root-ownership", maxModelCalls: 32, hold: false },
      ));

      await waitForChildReady(ownedChildReady, 5_000);
      expect(ownedChildBlocked).toBe(true);
      expect(run.manager).toBeDefined();
      const manager = run.manager;
      if (!manager) throw new Error("Print-mode manager was not published");
      // Owner (and its nested child) are still live — root finished without hold.
      expect(manager.hasRunning()).toBe(true);
      waitForAll = manager.waitForAll();
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const waitState = await Promise.race([
        waitForAll.then(() => "settled" as const),
        new Promise<"pending">((resolve) => {
          waitTimer = setTimeout(() => resolve("pending"), 50);
        }),
      ]);
      if (waitTimer) clearTimeout(waitTimer);
      expect(waitState).toBe("pending");

      expect(run.responseText).toContain("OWNERSHIP_PROBE_DONE");
      expect(probeResults.get).toBeDefined();
      expect(probeResults.steer).toBeDefined();
      expect(probeResults.get).toMatch(
        /^Nested agent not found or not owned by this parent:/i,
      );
      expect(probeResults.steer).toMatch(
        /^Running nested agent not found or not owned by this parent:/i,
      );
      expect(probeResults.get).not.toContain("OWNED_NESTED_RESULT");
      expect(probeResults.steer).not.toContain("Steering message sent");

      releaseOwnedChild();
      releaseOwner();
      await expect(waitForAll).resolves.toBeUndefined();
      expect(manager.hasRunning()).toBe(false);
    } finally {
      releaseOwnedChild();
      releaseOwner();
      if (waitForAll) {
        await Promise.race([
          waitForAll,
          new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
        ]);
      }
    }
  });
});
