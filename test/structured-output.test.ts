/**
 * structured-output.test.ts — the synthetic tool behind `agent({ schema })`.
 *
 * The contract this pins: the caller's schema reaches the provider verbatim,
 * a bad payload is answered in-band rather than silently accepted, and the box
 * says enough afterwards to tell "never answered" from "answered wrongly".
 */

import { describe, expect, it } from "vitest";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  STRUCTURED_OUTPUT_TOOL_NAME,
  structuredRetryPrompt,
} from "../src/structured-output.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";

const SCHEMA = {
  type: "object",
  properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
  required: ["file"],
};

function build() {
  const compilation = compileJsonSchema(SCHEMA);
  if (!compilation.ok) throw new Error(compilation.message);
  const capture = createStructuredCapture();
  return { tool: createStructuredOutputTool(compilation.compiled, capture), capture };
}

const call = (tool: ReturnType<typeof build>["tool"], params: unknown) =>
  (tool as unknown as {
    execute(id: string, params: unknown): Promise<{ isError?: boolean; content: { text: string }[] }>;
  }).execute("tc-1", params);

describe("the StructuredOutput tool", () => {
  it("carries Claude Code's name, so a ported prompt stays true", () => {
    expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe("StructuredOutput");
    expect(build().tool.name).toBe("StructuredOutput");
  });

  it("uses the caller's schema as its own parameters, verbatim", () => {
    // This is what makes the provider fill the fields; a copy or a conversion
    // would be a second place for the shape to drift.
    expect(build().tool.parameters).toBe(SCHEMA);
  });

  it("asks the provider to constrain sampling, but does not require it", () => {
    // "require" would fail the call outright on a provider that cannot do it,
    // where we would rather fall through to validate-and-retry.
    expect(build().tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("captures a conforming payload as canonical JSON", async () => {
    const { tool, capture } = build();
    const result = await call(tool, { file: "a.ts", line: 3 });

    expect(result.isError).toBeFalsy();
    expect(capture.called).toBe(true);
    expect(JSON.parse(capture.json as string)).toEqual({ file: "a.ts", line: 3 });
    expect(capture.lastError).toBeUndefined();
  });

  it("answers a bad payload in-band, so the model can correct itself", async () => {
    const { tool, capture } = build();
    const result = await call(tool, { line: 0 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/did not match the required schema/);
    // The reason has to reach the model, or the retry is a guess.
    expect(result.content[0].text).toContain("file");
    expect(capture.json).toBeUndefined();
    expect(capture.called).toBe(true);
    expect(capture.lastError).toBeDefined();
  });

  it("lets a corrected second call win", async () => {
    const { tool, capture } = build();
    await call(tool, { line: 0 });
    await call(tool, { file: "a.ts" });

    expect(JSON.parse(capture.json as string)).toEqual({ file: "a.ts" });
    // Cleared, or the retry prompt would report a problem already fixed.
    expect(capture.lastError).toBeUndefined();
  });

  it("takes the last valid call when a model answers twice", async () => {
    const { tool, capture } = build();
    await call(tool, { file: "first.ts" });
    await call(tool, { file: "second.ts" });

    expect(JSON.parse(capture.json as string)).toEqual({ file: "second.ts" });
  });

  it("recovers a payload sent as a JSON string", async () => {
    // A common model slip; parsing it here saves a whole retry.
    const { tool, capture } = build();
    const prepared = tool.prepareArguments?.(JSON.stringify({ file: "a.ts" }));
    await call(tool, prepared);

    expect(JSON.parse(capture.json as string)).toEqual({ file: "a.ts" });
  });

  it("leaves an unparseable string alone for validation to reject", async () => {
    const { tool } = build();
    expect(tool.prepareArguments?.("not json at all")).toBe("not json at all");
  });
});

describe("the retry prompt", () => {
  it("distinguishes never answering from answering wrongly", () => {
    const silent = createStructuredCapture();
    expect(structuredRetryPrompt(silent)).toMatch(/did not call/i);

    const wrong = { called: true, lastError: "$: must have required properties file" };
    const prompt = structuredRetryPrompt(wrong);
    expect(prompt).toMatch(/did not match the required schema/);
    // Telling a model it got the shape wrong when it never answered would send
    // it hunting for a mistake it did not make.
    expect(prompt).not.toMatch(/did not call/i);
    expect(prompt).toContain("must have required properties file");
  });

  it("always ends by asking for the call", () => {
    for (const capture of [createStructuredCapture(), { called: true, lastError: "x" }]) {
      expect(structuredRetryPrompt(capture)).toMatch(/Call StructuredOutput now/);
    }
  });
});
