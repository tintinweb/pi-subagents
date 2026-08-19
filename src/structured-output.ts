/**
 * structured-output.ts — the synthetic tool behind `agent(prompt, { schema })`.
 *
 * A workflow script that passes a `schema` wants an *object* back, not prose it
 * has to parse. Claude Code does this by giving the child a `StructuredOutput`
 * tool whose input schema is the caller's schema, so the provider fills the
 * fields, and returning the validated payload as the agent's result.
 *
 * We do the same, with one gap named up front: Claude Code *forces* the call,
 * and we cannot. `toolChoice` exists in pi-ai's provider layer but is not
 * plumbed through `AgentSession`, so an extension has no way to require a
 * particular tool. What we have instead is three softer pressures —
 *
 *   1. `constrainedSampling`, so providers that support it hold the payload to
 *      the schema at sampling time;
 *   2. the tool's description, snippet and guideline, which say the answer must
 *      come through this call;
 *   3. validation here, answering a bad payload with `isError` so the model
 *      sees what was wrong and calls again inside the same run.
 *
 * — and, when all three fail, one more prompt from `runAgent`. See
 * {@link structuredRetryPrompt}.
 *
 * The name matches Claude Code's exactly, so a ported prompt that mentions
 * `StructuredOutput` is still telling the truth.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CompiledSchema } from "./workflow/json-schema.js";

/**
 * Deliberately NOT added to `SUBAGENT_TOOL_NAMES`: that list becomes
 * `EXCLUDED_TOOL_NAMES`, which is exactly the denial this tool has to avoid.
 * Nor to `BUILTIN_TOOL_NAMES` — it is ours to inject, never a name a user may
 * ask for in an agent's `tools:` frontmatter.
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

/** What the child produced, filled in as the tool is called. */
export interface StructuredCapture {
  /** The last payload that validated, canonicalised. Absent until one does. */
  json?: string;
  /** Why the most recent attempt was rejected, for the retry prompt. */
  lastError?: string;
  /** Whether the tool was called at all — "never tried" reads differently. */
  called: boolean;
}

export function createStructuredCapture(): StructuredCapture {
  return { called: false };
}

/**
 * Build the tool for one child.
 *
 * `capture` is the box the caller reads afterwards. It is passed in rather than
 * returned so `runAgent` owns its lifetime and can consult it on every exit
 * path, including the ones where the tool was never reached.
 */
export function createStructuredOutputTool(
  compiled: CompiledSchema,
  capture: StructuredCapture,
): ToolDefinition {
  return defineTool({
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    label: "Structured Output",
    description:
      "Report your final answer. Call this exactly once, with the complete result, and put everything the "
      + "caller needs inside the arguments — text written outside this call is discarded. If a call is "
      + "rejected for not matching the schema, fix the reported fields and call it again.",
    promptSnippet: "Report your final answer as structured data",
    promptGuidelines: [
      "Your final answer MUST be reported by calling StructuredOutput. Prose outside that call is discarded.",
    ],
    // The caller's schema *is* the tool's input schema, verbatim — that is what
    // makes the provider fill the fields. pi types this as TypeBox's `TSchema`,
    // which v1 defines as an open interface, so a plain JSON Schema satisfies
    // it without a cast at runtime or a conversion at author time.
    parameters: compiled.schema as never,
    // "prefer", not "require": a provider that cannot constrain sampling should
    // fall through to validation-and-retry rather than fail the call outright.
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    // Models occasionally send the whole payload as one JSON string instead of
    // an object. Recovering that costs nothing and saves a whole retry.
    prepareArguments: (args: unknown) => {
      if (typeof args !== "string") return args as never;
      try {
        return JSON.parse(args) as never;
      } catch {
        return args as never;
      }
    },
    execute: async (_toolCallId, params) => {
      capture.called = true;
      const verdict = compiled.check(params);
      if (verdict !== true) {
        capture.lastError = verdict;
        // `isError` puts the reason in front of the model as a tool result, so
        // it can correct itself inside this same run. This is where most
        // mismatches are resolved; the prompt-level retry is the backstop.
        return {
          content: [{
            type: "text",
            text: `StructuredOutput did not match the required schema:\n${verdict}\nCall it again with a corrected value.`,
          }],
          isError: true,
          details: {},
        };
      }
      // Last valid call wins: a model that calls twice meant the second one.
      capture.json = JSON.stringify(params);
      capture.lastError = undefined;
      return { content: [{ type: "text", text: "Recorded." }], details: {} };
    },
  }) as ToolDefinition;
}

/**
 * The one extra prompt sent when a run ended with nothing captured.
 *
 * Distinguishes "never called it" from "called it wrongly" — the two need
 * different corrections, and telling a model it got the shape wrong when it
 * never answered at all sends it looking for a mistake it did not make.
 */
export function structuredRetryPrompt(capture: StructuredCapture): string {
  const reason = capture.called && capture.lastError !== undefined
    ? `Your last ${STRUCTURED_OUTPUT_TOOL_NAME} call did not match the required schema: ${capture.lastError}`
    : `You did not call ${STRUCTURED_OUTPUT_TOOL_NAME}, so your answer was not recorded.`;
  return `${reason}\n\nCall ${STRUCTURED_OUTPUT_TOOL_NAME} now with your complete final answer. Do not reply with prose.`;
}
