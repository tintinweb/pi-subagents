import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, isSubagentContext, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

const BLOCKING_TOOL_EXTENSION = fileURLToPath(
  new URL("./fixtures/blocking-tool-ext.mjs", import.meta.url),
);
const COMPLETION_MARKER = "BACKGROUND_COMPLETION_VISIBLE";
const BLOCKING_TOOL_CONTROL = Symbol.for("pi-subagents:test:blocking-tool");

function parentHasCompletion(context: Context): boolean {
  return context.messages.some(
    (message) =>
      message.role === "user" &&
      message.content.some(
        (block) => block.type === "text" && block.text.includes(COMPLETION_MARKER),
      ),
  );
}

describe("background completion steering scheduling", () => {
  let run: PrintModeRun | undefined;
  let cwd: string | undefined;
  let releaseBlockedTool: (() => void) | undefined;

  afterEach(async () => {
    releaseBlockedTool?.();
    releaseBlockedTool = undefined;
    await run?.dispose();
    run = undefined;
    delete (globalThis as Record<symbol, unknown>)[BLOCKING_TOOL_CONTROL];
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("finishes a blocking tool batch, then delivers the completion before the next model call", async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-steer-scheduling-"));

    let enteredBlockingTool: ((signal: AbortSignal | undefined) => void) | undefined;
    let completedBlockingTool: ((signal: AbortSignal | undefined) => void) | undefined;
    let toolSignalAtEntry: AbortSignal | undefined;
    let toolSignalAtCompletion: AbortSignal | undefined;
    const blockingToolEntered = new Promise<void>((resolve) => {
      enteredBlockingTool = (signal) => {
        toolSignalAtEntry = signal;
        resolve();
      };
    });
    const blockingToolCompleted = new Promise<void>((resolve) => {
      completedBlockingTool = (signal) => {
        toolSignalAtCompletion = signal;
        resolve();
      };
    });
    const releaseBlockingTool = new Promise<void>((resolve) => {
      releaseBlockedTool = resolve;
    });
    let completedAgentEvent: unknown;
    const backgroundAgentCompleted = new Promise<void>((resolve) => {
      completedAgentEvent = undefined;
      (globalThis as Record<symbol, unknown>)[BLOCKING_TOOL_CONTROL] = {
        agentCompleted: (data: unknown) => {
          completedAgentEvent = data;
          resolve();
        },
      };
    });

    const firstParentCall = agentCall({
      description: "background child",
      prompt: "Reply with the completion marker.",
      run_in_background: true,
    });
    const blockingToolCall = {
      type: "toolCall" as const,
      id: "blocking-call",
      name: "blocking_tool",
      arguments: {},
    };

    let parentModelCalls = 0;
    let childModelCalls = 0;
    const completionVisibleByParentCall: boolean[] = [];
    let currentParentSession: {
      isStreaming: boolean;
      messages: Array<{ role: string; content: unknown }>;
    } | undefined;

    const runPromise = runPrintMode({
      cwd,
      hold: false,
      // Pinned faux: the scheduling assertions count scripted model calls, so the
      // pre-publish smoke's global `PI_E2E_LIVE=1` must not swap a real model in.
      live: false,
      extensionPaths: [BLOCKING_TOOL_EXTENSION],
      prompt: "Start a background child and keep working with a blocking tool.",
      onParentSession: (session) => {
        currentParentSession = session;
      },
      respond: async (context) => {
        const isParent = !isSubagentContext(context);
        if (!isParent) {
          childModelCalls++;
          return COMPLETION_MARKER;
        }

        parentModelCalls++;
        const completionVisible = parentHasCompletion(context);
        completionVisibleByParentCall.push(completionVisible);
        if (completionVisible) return "parent processed the completion";
        if (parentModelCalls === 1) return [firstParentCall, blockingToolCall];
        return "completion was missing";
      },
      beforeRun: () => {
        const control = (globalThis as Record<symbol, Record<string, unknown>>)[BLOCKING_TOOL_CONTROL] ?? {};
        Object.assign(control, {
          entered: (signal: AbortSignal | undefined) => enteredBlockingTool?.(signal),
          release: releaseBlockingTool,
          completed: (signal: AbortSignal | undefined) => completedBlockingTool?.(signal),
        });
        (globalThis as Record<symbol, Record<string, unknown>>)[BLOCKING_TOOL_CONTROL] = control;
      },
    });

    await Promise.race([
      blockingToolEntered,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`blocking tool was not entered; parent=${parentModelCalls} child=${childModelCalls}`));
        }, 10_000);
      }),
    ]);
    expect(parentModelCalls).toBe(1);

    await Promise.race([
      backgroundAgentCompleted,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("background completion event was not emitted")), 10_000);
      }),
    ]);
    expect(completedAgentEvent).toEqual(expect.objectContaining({ description: "background child" }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(childModelCalls).toBe(1);
    expect(parentModelCalls).toBe(1);
    expect(currentParentSession?.isStreaming).toBe(true);
    expect(currentParentSession?.messages.some((message) =>
      message.role === "custom" && JSON.stringify(message.content).includes(COMPLETION_MARKER)
    )).toBe(false);

    expect(toolSignalAtEntry?.aborted).toBe(false);
    releaseBlockedTool?.();
    releaseBlockedTool = undefined;
    await blockingToolCompleted;

    run = await runPromise;

    expect(toolSignalAtCompletion?.aborted).toBe(false);
    expect(completionVisibleByParentCall[1]).toBe(true);
    expect(parentModelCalls).toBeGreaterThanOrEqual(2);
    expect(childModelCalls).toBe(1);
  });

  it("delivers children that finished during one tool batch together, in one message", async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-steer-scheduling-"));

    let release!: () => void;
    let entered!: () => void;
    const blockingToolEntered = new Promise<void>((resolve) => { entered = resolve; });
    let completions = 0;
    let bothCompleted!: () => void;
    const bothChildrenCompleted = new Promise<void>((resolve) => { bothCompleted = resolve; });
    (globalThis as Record<symbol, unknown>)[BLOCKING_TOOL_CONTROL] = {
      agentCompleted: () => { if (++completions === 2) bothCompleted(); },
      entered: () => entered(),
      release: new Promise<void>((resolve) => { release = resolve; }),
      completed: () => {},
    };
    releaseBlockedTool = () => release();

    // What the parent's next model call sees: one entry per message carrying a completion.
    let completionMessagesAtSecondCall: string[] | undefined;
    let parentModelCalls = 0;

    const runPromise = runPrintMode({
      cwd,
      hold: false,
      live: false, // scripted on purpose: the blocking tool and the timing are the test
      extensionPaths: [BLOCKING_TOOL_EXTENSION],
      prompt: "Start two background children and keep working with a blocking tool.",
      respond: async (context) => {
        if (isSubagentContext(context)) return COMPLETION_MARKER;
        parentModelCalls++;
        if (parentModelCalls === 1) {
          return [
            agentCall({ description: "first child", prompt: "first", run_in_background: true }, { id: "agent-1" }),
            agentCall({ description: "second child", prompt: "second", run_in_background: true }, { id: "agent-2" }),
            { type: "toolCall" as const, id: "blocking-call", name: "blocking_tool", arguments: {} },
          ];
        }
        completionMessagesAtSecondCall ??= context.messages.flatMap((message) =>
          message.role === "user"
            ? message.content.flatMap((block) =>
              block.type === "text" && block.text.includes(COMPLETION_MARKER) ? [block.text] : [])
            : []);
        return "done";
      },
    });

    await blockingToolEntered;
    await bothChildrenCompleted;
    releaseBlockedTool?.();
    releaseBlockedTool = undefined;
    run = await runPromise;

    expect(completionMessagesAtSecondCall).toHaveLength(1);
    expect(completionMessagesAtSecondCall?.[0]).toContain("first child");
    expect(completionMessagesAtSecondCall?.[0]).toContain("second child");
  });
});
