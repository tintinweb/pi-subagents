/**
 * workflow-json-schema.test.ts — the validator behind `agent({ schema })`.
 *
 * Pure, no stubs: this is the one place that decides whether a script-supplied
 * JSON Schema is usable and whether a child's payload matches it. What it pins
 * is the refusals, their order and their wording, for the schema and for the
 * payload.
 */

import { describe, expect, it } from "vitest";
import { compileJsonSchema, lintJsonSchema } from "../src/workflow/json-schema.js";

/** A schema shaped like the one Claude Code's own example passes. */
const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { file: { type: "string" }, line: { type: "integer", minimum: 1 } },
        required: ["file"],
      },
    },
  },
  required: ["findings"],
} as const;

const compile = (schema: unknown) => {
  const result = compileJsonSchema(schema);
  if (!result.ok) throw new Error(`expected a compiled schema, got: ${result.message}`);
  return result.compiled;
};

describe("compiling a script-supplied schema", () => {
  it("accepts a plain JSON Schema, with no TypeBox ceremony", () => {
    expect(compileJsonSchema(FINDINGS).ok).toBe(true);
  });

  it("keeps the schema object as given, for the tool and the journal key", () => {
    expect(compile(FINDINGS).schema).toBe(FINDINGS);
  });

  it("refuses anything that cannot be a tool's input schema", () => {
    for (const bad of [5, "x", null, undefined, [], { type: "array" }, { type: "string" }]) {
      const result = compileJsonSchema(bad);
      expect(result.ok, `${JSON.stringify(bad)} should not compile`).toBe(false);
    }
  });

  it("says why a non-object root is refused", () => {
    const expected = {
      ok: false,
      message:
        "agent({schema}) received an unusable JSON Schema — the API only accepts an object-rooted tool input schema, "
        + "so every request would be rejected: the root schema must declare type: 'object' (the API rejects any other "
        + "root type for a tool input schema); wrap arrays or primitives in an object property. The subagent was not "
        + "started — fix the schema and call agent() again.",
    };
    // A missing type and a one-element type array are refused too: the check is
    // on the exact string.
    for (const schema of [{ type: "array" }, {}, { type: ["object"] }, { properties: {} }]) {
      expect(compileJsonSchema(schema), JSON.stringify(schema)).toEqual(expected);
    }
  });

  it("reports an invalid schema before a non-object root", () => {
    // An invalid schema is reported before a non-object root.
    const result = compileJsonSchema({ type: "array", items: { type: "strin" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("received an invalid JSON Schema: data/items/type");
  });

  it("refuses a schema it cannot use, at the call", () => {
    // Each would otherwise reach a child and fail every attempt, or throw in
    // its tool handler. The checks and texts are Ajv's, configured as Claude
    // Code configures it.
    const cases: Array<[unknown, string]> = [
      [{ type: "object", properties: { a: { type: "strin" } } }, "data/properties/a/type must be equal to one of the allowed values"],
      [{ type: "object", properties: { a: { type: "string", minLength: "x" } } }, "data/properties/a/minLength must be integer"],
      [{ type: "object", properties: { a: { type: "string", pattern: "(" } } }, "Invalid regular expression: /(/u"],
      [{ type: "object", properties: { a: { type: "string", minLenght: 1 } } }, 'strict mode: unknown keyword: "minLenght"'],
      [{ type: "object", properties: { a: { $ref: "#/definitions/missing" } } }, "can't resolve reference #/definitions/missing"],
      [{ type: "object", properties: {}, $async: true }, "$async schemas are not supported"],
    ];
    for (const [schema, expected] of cases) {
      const result = compileJsonSchema(schema);
      expect(result.ok, JSON.stringify(schema)).toBe(false);
      if (!result.ok) {
        expect(result.message.startsWith("agent({schema}) received an invalid JSON Schema: ")).toBe(true);
        expect(result.message).toContain(expected);
      }
    }
  });

  it("words an invalid schema exactly", () => {
    const result = compileJsonSchema({ type: "object", properties: { a: { type: "string", minLength: "x" } } });
    expect(result).toEqual({
      ok: false,
      message: "agent({schema}) received an invalid JSON Schema: data/properties/a/minLength must be integer",
    });
  });

  it("refuses a schema past the size guard, and no smaller one", () => {
    const wide = (count: number) => ({
      type: "object",
      properties: Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, { type: "string" }])),
    });
    // Two values per property (the sub-schema and its `type`), plus the root's.
    const refused = compileJsonSchema(wide(50_000));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toBe("agent({schema}) received an invalid JSON Schema: schema too large");
    expect(compileJsonSchema(wide(1_000)).ok).toBe(true);
  });

  it("accepts a schema larger than 64 KB, which the old byte limit refused", () => {
    const big = { type: "object", properties: { a: { type: "string", description: "x".repeat(70_000) } } };
    expect(compileJsonSchema(big).ok).toBe(true);
  });

  it("reports an invalid schema before a contradiction in it", () => {
    // An invalid schema is reported before a contradiction.
    // Both invalid (`minLength: "x"`) and contradictory (`ok` required but forbidden).
    const result = compileJsonSchema({
      type: "object",
      properties: { a: { type: "string", minLength: "x" } },
      required: ["ok"],
      additionalProperties: false,
    });
    expect(result).toEqual({
      ok: false,
      message: "agent({schema}) received an invalid JSON Schema: data/properties/a/minLength must be integer",
    });
  });

  it("does not validate formats, in the schema or the payload", () => {
    // Formats are ignored: an `$id` that is not a URI
    // compiles, and a payload is not held to `format: "email"`.
    expect(compileJsonSchema({ type: "object", properties: {}, $id: "not a uri ^" }).ok).toBe(true);
    const compiled = compile({ type: "object", properties: { m: { type: "string", format: "email" } } });
    expect(compiled.check({ m: "not-an-email" })).toBe(true);
  });

  it("accepts nullable, a resolvable $ref, and a schema with no properties", () => {
    for (const schema of [
      { type: "object", properties: { a: { type: "string", nullable: true } } },
      { type: "object", properties: { a: { $ref: "#/definitions/s" } }, definitions: { s: { type: "string" } } },
      { type: "object" },
    ]) {
      expect(compileJsonSchema(schema).ok, JSON.stringify(schema)).toBe(true);
    }
  });
});

describe("checking a payload", () => {
  it("passes a conforming value", () => {
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts", line: 3 }] })).toBe(true);
  });

  it("passes when an optional field is absent", () => {
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts" }] })).toBe(true);
  });

  it("names a root problem as root, and a nested one by its JSON Pointer", () => {
    expect(compile(FINDINGS).check({})).toBe("root: must have required property 'findings'");
    expect(compile(FINDINGS).check({ findings: [{ file: "a.ts", line: 0 }] })).toBe("/findings/0/line: must be >= 1");
  });

  it("reports every problem, comma-joined, each with what it saw", () => {
    const schema = {
      type: "object",
      properties: {
        s: { type: "string", minLength: 3 },
        e: { enum: ["x", "y"] },
        c: { const: 1 },
        l: { type: "array", maxItems: 1 },
        o: { type: "object", maxProperties: 1 },
      },
      required: ["s"],
      additionalProperties: false,
    };
    expect(compile(schema).check({ s: "ab", e: "z", c: 2, l: [1, 2], o: { a: 1, b: 2 }, extra: 1 })).toBe(
      [
        "root: must NOT have additional properties ('extra' is not allowed)",
        "/s: must NOT have fewer than 3 characters (got 2)",
        '/e: must be equal to one of the allowed values: ["x","y"]',
        "/c: must be equal to constant: 1",
        "/l: must NOT have more than 1 items (got 2)",
        "/o: must NOT have more than 1 properties (got 2)",
      ].join(", "),
    );
  });

  it("names every missing property, so one retry can fix them all", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" }, c: { type: "string" } },
      required: ["a", "b", "c"],
    };
    const message = String(compile(schema).check({}));
    for (const missing of ["a", "b", "c"]) expect(message).toContain(`'${missing}'`);
  });

  it("counts a string's length in code points, and cuts a long disallowed name", () => {
    const compiled = compile({
      type: "object",
      properties: { s: { type: "string", minLength: 3 } },
      additionalProperties: false,
    });
    expect(compiled.check({ s: "😀😀" })).toBe("/s: must NOT have fewer than 3 characters (got 2)");
    const long = "k".repeat(100);
    expect(compiled.check({ [long]: 1 })).toBe(
      `root: must NOT have additional properties ('${"k".repeat(80)}…' is not allowed)`,
    );
  });

  it("rejects a value of the wrong type entirely", () => {
    expect(compile(FINDINGS).check("not an object")).toBe("root: must be object");
    expect(compile(FINDINGS).check(null)).not.toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    const compiled = compile(FINDINGS);
    const cyclic: Record<string, unknown> = { findings: [] };
    cyclic.self = cyclic;
    for (const value of [undefined, Number.NaN, cyclic, new Map(), Symbol("s")]) {
      expect(() => compiled.check(value)).not.toThrow();
    }
  });
});

describe("refusing a schema no value can satisfy", () => {
  /** The refusal message, or a failure if the schema compiled. */
  const refusal = (schema: unknown) => {
    const result = compileJsonSchema(schema);
    if (result.ok) throw new Error(`expected ${JSON.stringify(schema)} to be refused`);
    return result.message;
  };
  const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties,
    ...extra,
  });

  it("refuses a required name the schema also forbids, saying the subagent was not started", () => {
    const message = refusal(obj({ okay: { type: "boolean" } }, { required: ["ok"], additionalProperties: false }));
    expect(message).toContain("no output can satisfy this schema");
    expect(message).toContain('the root object lists "ok" in required but does not declare it in properties');
    expect(message).toContain("The subagent was not started — fix the schema and call agent() again.");
  });

  it("accepts an undeclared required name the schema still allows", () => {
    // `required` ⊆ `properties` is advice, not a rule: without
    // additionalProperties: false, or with patternProperties, a child can send it.
    expect(compileJsonSchema(obj({}, { required: ["ok"] })).ok).toBe(true);
    expect(
      compileJsonSchema(obj({}, { required: ["ok"], additionalProperties: false, patternProperties: { "^o": {} } })).ok,
    ).toBe(true);
  });

  it("refuses an enum with no value of the declared type", () => {
    expect(refusal(obj({ a: { type: "string", enum: [1, 2] } }, { required: ["a"] }))).toContain(
      "declares type 'string' but none of its enum values has that type",
    );
  });

  it("accepts an enum of null once nullable folds null into the type", () => {
    expect(compileJsonSchema(obj({ a: { type: "string", nullable: true, enum: [null] } })).ok).toBe(true);
  });

  it("refuses a const of the wrong type, and one outside its enum", () => {
    expect(refusal(obj({ a: { type: "integer", const: 1.5 } }, { required: ["a"] }))).toContain(
      "its const value does not have that type",
    );
    expect(refusal(obj({ a: { const: "x", enum: ["y"] } }, { required: ["a"] }))).toContain(
      "has a const value that is not one of its enum values",
    );
  });

  it("refuses crossed bounds of every kind it knows", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: "number", minimum: 5, maximum: 1 }, "minimum 5 and maximum 1, which admit no number"],
      [{ type: "integer", exclusiveMinimum: 1, maximum: 1 }, "exclusiveMinimum 1 and maximum 1"],
      [{ type: "string", minLength: 3, maxLength: 2 }, "minLength 3 greater than maxLength 2"],
      [{ type: "array", minItems: 2, maxItems: 1 }, "minItems 2 greater than maxItems 1"],
      [{ type: "object", minProperties: 2, maxProperties: 1 }, "minProperties 2 greater than maxProperties 1"],
    ];
    for (const [sub, expected] of cases) {
      expect(refusal(obj({ a: sub }, { required: ["a"] })), JSON.stringify(sub)).toContain(expected);
    }
    expect(refusal(obj({ a: {}, b: {} }, { required: ["a", "b"], maxProperties: 1 }))).toContain(
      "2 required properties but maxProperties 1",
    );
  });

  it("accepts touching inclusive bounds", () => {
    expect(compileJsonSchema(obj({ a: { type: "number", minimum: 1, maximum: 1 } })).ok).toBe(true);
  });

  it("calls a contradiction in an optional property or an array item a sub-schema problem", () => {
    // Still refused — the child could only succeed by leaving the field out —
    // but the message must not claim the whole schema is impossible.
    const optional = refusal(obj({ a: { type: "string", enum: [1] } }));
    expect(optional).toContain("one property or item sub-schema admits no value");
    expect(optional).toContain("the sub-schema at /properties/a");

    const item = refusal(obj({ list: { type: "array", items: { type: "string", enum: [1] } } }, { required: ["list"] }));
    expect(item).toContain("one property or item sub-schema admits no value");
    expect(item).toContain("/properties/list/items");
  });

  it("follows required properties down, so a nested contradiction is still whole", () => {
    const nested = obj({ inner: obj({ n: { type: "number", minimum: 2, maximum: 1 } }, { required: ["n"] }) }, {
      required: ["inner"],
    });
    expect(refusal(nested)).toContain("no output can satisfy this schema");
  });

  it("does not lint a node that carries a $ref", () => {
    const schema = obj({ a: { $ref: "#/definitions/s", type: "string", enum: [1] } }, {
      definitions: { s: { type: "string" } },
    });
    expect(compileJsonSchema(schema).ok).toBe(true);
  });

  it("accepts the shape the tool description's example passes", () => {
    expect(compileJsonSchema(FINDINGS).ok).toBe(true);
  });
});

describe("the lint's edges", () => {
  const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: "object",
    properties,
    ...extra,
  });
  /** `levels` objects nested under `a`, with `leaf` at the bottom. */
  const nested = (levels: number, leaf: Record<string, unknown>, key = "a") => {
    let node: Record<string, unknown> = leaf;
    for (let i = 0; i < levels; i++) node = obj({ [key]: node });
    return node;
  };
  const crossed = { type: "number", minimum: 2, maximum: 1 };

  it("words a finding exactly", () => {
    const result = compileJsonSchema(obj({ okay: { type: "boolean" } }, { required: ["ok"], additionalProperties: false }));
    expect(result).toEqual({
      ok: false,
      message:
        "agent({schema}) received an unusable JSON Schema — no output can satisfy this schema, so StructuredOutput "
        + 'validation would fail on every attempt: the root object lists "ok" in required but does not declare it in '
        + "properties, and additionalProperties is false, so no object can satisfy it — declare the property or drop it "
        + "from required. The subagent was not started — fix the schema and call agent() again.",
    });
  });

  it("stops looking 32 levels down", () => {
    // The root spends one level, so the deepest node still linted sits 31 below it.
    expect(lintJsonSchema(nested(31, crossed))?.reason).toBe("crossed_bounds");
    expect(lintJsonSchema(nested(32, crossed))).toBeUndefined();
  });

  it("skips a property named __proto__", () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","enum":[1]}}}');
    expect(lintJsonSchema(schema)).toBeUndefined();
  });

  it("ignores required names that are Object.prototype members", () => {
    expect(lintJsonSchema(obj({}, { required: ["constructor", "toString"], additionalProperties: false }))).toBeUndefined();
  });

  it("checks object rules only when the type is exactly object", () => {
    const forbidden = { required: ["ok"], additionalProperties: false };
    expect(lintJsonSchema(obj({ a: { ...obj({}, forbidden), type: ["object", "null"] } }))).toBeUndefined();
    expect(lintJsonSchema(obj({ a: { ...obj({}, forbidden), nullable: true } }))).toBeUndefined();
    expect(lintJsonSchema(obj({ a: { ...obj({}), minProperties: 2, maxProperties: 1, nullable: true } }))).toBeUndefined();
  });

  it("treats a required child of a nullable object as a sub-schema problem", () => {
    // null satisfies the parent, so the child's contradiction is avoidable.
    const schema = obj({ inner: { ...obj({ n: crossed }, { required: ["n"] }), nullable: true } }, { required: ["inner"] });
    expect(lintJsonSchema(schema)?.scope).toBe("subschema");
  });

  it("checks numeric bounds for a number/integer pair, and lets an exclusive upper bound win a tie", () => {
    expect(lintJsonSchema(obj({ a: { ...crossed, type: ["integer", "number"] } }))?.reason).toBe("crossed_bounds");
    expect(lintJsonSchema(obj({ a: { type: "number", minimum: 1, exclusiveMaximum: 1 } }))?.message).toContain(
      "minimum 1 and exclusiveMaximum 1, which admit no number",
    );
    expect(lintJsonSchema(obj({ a: { ...crossed, type: ["number", "string"] } }))).toBeUndefined();
  });

  it("checks nothing under a type it does not recognise", () => {
    expect(lintJsonSchema(obj({ a: { type: "nonsense", enum: [1], minimum: 2, maximum: 1 } }))).toBeUndefined();
    expect(lintJsonSchema(obj({ a: { type: ["string", "nonsense"], enum: [1] } }))).toBeUndefined();
  });

  it("does not descend into items when the type excludes arrays", () => {
    expect(lintJsonSchema(obj({ a: { type: "string", items: { type: "string", enum: [1] } } }))).toBeUndefined();
    expect(lintJsonSchema(obj({ a: { items: { type: "string", enum: [1] } } }))?.reason).toBe("enum_type_mismatch");
  });

  it("escapes, cleans and truncates property names in a path", () => {
    expect(lintJsonSchema(obj({ "a/b~c": crossed }))?.message).toContain("the sub-schema at /properties/a~1b~0c has");
    expect(lintJsonSchema(obj({ "a\n\tb\u0007": crossed }))?.message).toContain("/properties/a b has");
    expect(lintJsonSchema(obj({ ["k".repeat(100)]: crossed }))?.message).toContain(`/properties/${"k".repeat(80)}… has`);
  });

  it("keeps the last 300 characters of a long path", () => {
    const key = "k".repeat(70);
    const message = String(lintJsonSchema(nested(6, crossed, key))?.message);
    const path = message.slice("the sub-schema at ".length, message.indexOf(" has "));
    expect(path.startsWith("…")).toBe(true);
    expect(path).toHaveLength(301);
    expect(path.endsWith(`/properties/${key}`)).toBe(true);
  });

  it("reports a node's checks in a fixed order", () => {
    const everything = {
      type: "object",
      properties: {},
      required: ["x"],
      additionalProperties: false,
      enum: [1],
      minProperties: 2,
      maxProperties: 1,
    };
    expect(lintJsonSchema(everything)?.reason).toBe("required_property_forbidden");
    const at = (sub: Record<string, unknown>) => lintJsonSchema(obj({ a: sub }));
    expect(at({ type: "string", enum: [1], const: 1, minLength: 2, maxLength: 1 })?.reason).toBe("enum_type_mismatch");
    expect(at({ type: "string", const: 1, minLength: 2, maxLength: 1 })?.message).toContain(
      "its const value does not have that type",
    );
    expect(at({ const: "a", enum: ["b"], type: "string", minLength: 2, maxLength: 1 })?.message).toContain(
      "not one of its enum values",
    );
    expect(at({ type: "string", minLength: 2, maxLength: 1 })?.reason).toBe("crossed_bounds");
  });
});
