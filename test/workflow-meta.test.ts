import { describe, expect, it } from "vitest";
import { extractMeta, WorkflowMetaError } from "../src/workflow/meta.js";

/** Minimal valid header, so each test only varies what it is about. */
const HEADER = `export const meta = { name: 'wf', description: 'does a thing' }`;

describe("extractMeta — acceptance", () => {
  it("accepts a pure literal and returns the parsed meta", () => {
    const { meta } = extractMeta(`${HEADER}\nreturn 1`);
    expect(meta).toEqual({ name: "wf", description: "does a thing" });
  });

  it("accepts optional whenToUse and phases", () => {
    const { meta } = extractMeta(`export const meta = {
      name: 'review',
      description: 'review the diff',
      whenToUse: 'when a PR lands',
      phases: [{ title: 'Scan' }, { title: 'Verify', detail: 'adversarial', model: 'haiku' }],
    }
    return 1`);
    expect(meta.whenToUse).toBe("when a PR lands");
    expect(meta.phases).toEqual([
      { title: "Scan" },
      { title: "Verify", detail: "adversarial", model: "haiku" },
    ]);
  });

  it("tolerates whitespace and newlines inside the declaration", () => {
    const { meta } = extractMeta("export   const\n  meta\n=\n{ name: 'a', description: 'b' }\nreturn 1");
    expect(meta.name).toBe("a");
  });

  it("allows a declaration that is not on the first line", () => {
    const { meta } = extractMeta(`// a leading comment\n\n${HEADER}\nreturn 1`);
    expect(meta.name).toBe("wf");
  });
});

describe("extractMeta — body rewriting", () => {
  it("strips the export keyword so the body compiles outside a module", () => {
    const { body } = extractMeta(`${HEADER}\nreturn 1`);
    expect(body).not.toMatch(/\bexport\b/);
    expect(body).toContain("const meta =");
  });

  it("preserves byte offsets so reported line numbers stay accurate", () => {
    const source = `${HEADER}\nreturn 1`;
    const { body } = extractMeta(source);
    expect(body).toHaveLength(source.length);
    expect(body.split("\n")).toHaveLength(source.split("\n").length);
  });
});

describe("extractMeta — brace scanning", () => {
  it("survives braces inside single- and double-quoted strings", () => {
    const { meta } = extractMeta(
      `export const meta = { name: 'a}b', description: "c{d}e" }\nreturn 1`,
    );
    expect(meta.name).toBe("a}b");
    expect(meta.description).toBe("c{d}e");
  });

  it("survives braces inside line and block comments", () => {
    const { meta } = extractMeta(`export const meta = {
      // a stray } here
      name: 'a',
      /* and a { block } one */
      description: 'b',
    }
    return 1`);
    expect(meta.name).toBe("a");
  });

  it("survives braces inside template literals", () => {
    const { meta } = extractMeta(
      "export const meta = { name: `a}b`, description: `plain` }\nreturn 1",
    );
    expect(meta.name).toBe("a}b");
  });

  it("rejects a self-contained template substitution", () => {
    // Evaluating this would succeed and quietly yield "a1b" — nothing in it
    // touches a global. Only the scanner's ${} bookkeeping catches it.
    expect(() => extractMeta(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the substitution is the subject under test
      "export const meta = { name: `a${ {x:1}.x }b`, description: 'b' }\nreturn 1",
    )).toThrow(/template interpolation/);
  });

  it("resumes template scanning after a substitution closes", () => {
    // The `}` that ends `${...}` must not be mistaken for the literal's own, and
    // the `}` in the trailing template text must stay inert. If either slipped,
    // the fragment would be truncated and the message would be about braces.
    expect(() => extractMeta(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the substitution is the subject under test
      "export const meta = { name: `${ x }and}then`, description: 'b' }\nreturn 1",
    )).toThrow(/template interpolation/);
  });

  it("leaves `${` inside an ordinary string alone", () => {
    // Built by concatenation so the literal never appears in this file — the
    // point is that the scanner only reacts to `${` in *template* context.
    const dollarBrace = `$${"{"}`;
    const { meta } = extractMeta(
      `export const meta = { name: 'a', description: 'costs ${dollarBrace}5} per run' }\nreturn 1`,
    );
    expect(meta.description).toBe(`costs ${dollarBrace}5} per run`);
  });

  it("does not stop at a brace inside an escaped quote", () => {
    const { meta } = extractMeta(
      `export const meta = { name: 'it\\'s }', description: 'b' }\nreturn 1`,
    );
    expect(meta.name).toBe("it's }");
  });

  it("keeps scanning past nested objects", () => {
    const { meta } = extractMeta(`export const meta = {
      name: 'a', description: 'b',
      phases: [{ title: 'x' }, { title: 'y' }],
    }
    return 1`);
    expect(meta.phases).toHaveLength(2);
  });

  it("reports an unbalanced opening brace", () => {
    expect(() => extractMeta("export const meta = { name: 'a'\nreturn 1"))
      .toThrow(/never closed/);
  });
});

describe("extractMeta — rejection", () => {
  it("rejects a script with no meta at all", () => {
    expect(() => extractMeta("return 1")).toThrow(WorkflowMetaError);
    expect(() => extractMeta("return 1")).toThrow(/must begin with/);
  });

  it("rejects a computed name — the pure-literal rule", () => {
    expect(() => extractMeta(
      "export const meta = { name: computeName(), description: 'b' }\nreturn 1",
    )).toThrow(/PURE LITERAL/);
  });

  it("rejects a name built from a variable", () => {
    expect(() => extractMeta(
      "const base = 'x'\nexport const meta = { name: base, description: 'b' }\nreturn 1",
    )).toThrow(/PURE LITERAL/);
  });

  it("rejects a spread", () => {
    expect(() => extractMeta(
      "export const meta = { ...defaults, name: 'a', description: 'b' }\nreturn 1",
    )).toThrow(/PURE LITERAL/);
  });

  it("rejects a missing name", () => {
    expect(() => extractMeta("export const meta = { description: 'b' }\nreturn 1"))
      .toThrow(/`meta.name` is required/);
  });

  it("rejects a missing description", () => {
    expect(() => extractMeta("export const meta = { name: 'a' }\nreturn 1"))
      .toThrow(/`meta.description` is required/);
  });

  it("rejects an empty name", () => {
    expect(() => extractMeta("export const meta = { name: '  ', description: 'b' }\nreturn 1"))
      .toThrow(/`meta.name` is required/);
  });

  it("rejects a non-object meta", () => {
    expect(() => extractMeta("export const meta = 'nope'\nreturn 1"))
      .toThrow(/must be assigned an object literal/);
  });

  it("rejects phases that are not an array", () => {
    expect(() => extractMeta(
      "export const meta = { name: 'a', description: 'b', phases: 'Scan' }\nreturn 1",
    )).toThrow(/`meta.phases` must be an array/);
  });

  it("rejects a phase with no title", () => {
    expect(() => extractMeta(
      "export const meta = { name: 'a', description: 'b', phases: [{ detail: 'x' }] }\nreturn 1",
    )).toThrow(/phases\[0\].title/);
  });

  it("rejects a non-string whenToUse", () => {
    expect(() => extractMeta(
      "export const meta = { name: 'a', description: 'b', whenToUse: 3 }\nreturn 1",
    )).toThrow(/`meta.whenToUse` must be a string/);
  });
});

describe("extractMeta — isolation", () => {
  it("cannot reach host globals from the meta fragment", () => {
    expect(() => extractMeta(
      "export const meta = { name: process.platform, description: 'b' }\nreturn 1",
    )).toThrow(/PURE LITERAL/);
  });

  it("bounds evaluation so a non-terminating literal cannot hang the host", () => {
    // An IIFE resolves without any global, so the empty context does not stop
    // it. This runs on pi's own thread, before the worker exists — unbounded, it
    // would wedge the whole process.
    const started = Date.now();
    expect(() => extractMeta(
      "export const meta = { name: (() => { while (true); })(), description: 'b' }\nreturn 1",
    )).toThrow(/did not finish evaluating/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not execute the script body", () => {
    // If the body ran, this would throw something other than a meta error.
    const { meta } = extractMeta(`${HEADER}\nthrow new Error('body ran')`);
    expect(meta.name).toBe("wf");
  });
});
