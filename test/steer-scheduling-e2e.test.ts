import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

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
      extensionPaths: [BLOCKING_TOOL_EXTENSION],
      prompt: "Start a background child and keep working with a blocking tool.",
      onParentSession: (session) => {
        currentParentSession = session;
      },
      respond: async (context) => {
        const isParent = (context.tools ?? []).some((tool) => tool.name === "Agent");
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
        const control = (globalThis as Record<symbol, Record<string, unknown>>)[BLOCKING_TOOL_CONTROL];
        Object.assign(control, {
          entered: (signal: AbortSignal | undefined) => enteredBlockingTool?.(signal),
          release: releaseBlockingTool,
          completed: (signal: AbortSignal | undefined) => completedBlockingTool?.(signal),
        });
      },
    });

    await Promise.race([
      blockingToolEntered,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`blocking tool was not entered; parent=${parentModelCalls} child=${childModelCalls}`));
        }, 2_000);
      }),
    ]);
    expect(parentModelCalls).toBe(1);

    await Promise.race([
      backgroundAgentCompleted,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("background completion event was not emitted")), 2_000);
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

  it("starts an idle parent turn when a completion is delivered with triggerTurn", async () => {
    let sendCompletion: (() => Promise<void>) | undefined;
    let parentCalls = 0;
    let completionWasVisible = false;

    run = await runPrintMode({
      hold: false,
      prompt: "Answer once, then wait for a completion notification.",
      onParentSession: (session) => {
        sendCompletion = () => session.sendCustomMessage(
          {
            customType: "subagent-notification",
            content: COMPLETION_MARKER,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      },
      respond: (context) => {
        parentCalls++;
        completionWasVisible = parentHasCompletion(context);
        return completionWasVisible ? "processed idle completion" : "initial answer";
      },
    });

    expect(parentCalls).toBe(1);
    expect(completionWasVisible).toBe(false);

    await sendCompletion?.();
    await run.parentSession.waitForIdle();

    expect(parentCalls).toBe(2);
    expect(completionWasVisible).toBe(true);
  });
});
