import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { isolationParam } from "../src/invocation-config.js";

/**
 * The `isolation` parameter's *shape* is the fix for #231, so it is worth
 * asserting directly rather than only through behaviour.
 *
 * As a single-value optional literal it gave models that fill every optional
 * parameter nothing harmless to fill it with: the session log on #231 shows one
 * emitting `isolation: "worktree"` on three consecutive calls — alongside
 * `resume: ""` and `schedule: ""` — while its own reasoning, its message to the
 * user, and two explicit user instructions all said to omit the field. A second
 * legal value is what lets it comply.
 */
describe("isolationParam", () => {
  function schema(enabled: boolean) {
    const built = isolationParam(enabled);
    return built.isolation as { type?: string; enum?: string[] } | undefined;
  }

  it("offers a value meaning 'no isolation', not just 'worktree'", () => {
    const values = schema(true)?.enum;
    expect(values).toContain("off");
    expect(values).toContain("worktree");
  });

  // #467: a relay in front of Gemini rejected the union-of-literals form (once a
  // top-level `type` sat beside its `anyOf`) and accepted `{ type: "string",
  // enum }`. Pin the enum shape and keep union keywords out.
  it("serializes as a string enum, without anyOf/oneOf/const", () => {
    const json = JSON.parse(JSON.stringify(schema(true)));
    expect(json.type).toBe("string");
    expect(json.enum).toEqual(["off", "worktree"]);
    expect(json).not.toHaveProperty("anyOf");
    expect(json).not.toHaveProperty("oneOf");
    expect(JSON.stringify(json)).not.toContain('"const"');
  });

  it("still accepts 'off' and 'worktree' and rejects anything else", () => {
    const isolation = isolationParam(true).isolation as Parameters<typeof Value.Check>[0];
    expect(Value.Check(isolation, "off")).toBe(true);
    expect(Value.Check(isolation, "worktree")).toBe(true);
    expect(Value.Check(isolation, "remote")).toBe(false);
    expect(Value.Check(isolation, "")).toBe(false);
    expect(Value.Check(isolation, 1)).toBe(false);
  });

  // A model that fills optional fields tends to reach for what it reads first,
  // so the inert value leads. This is the whole mitigation — if the order flips,
  // the schema stops steering and the bug is back in practice.
  it("lists the inert value first", () => {
    expect(schema(true)?.enum?.[0]).toBe("off");
  });

  it("warns that a worktree cannot see uncommitted work", () => {
    // The specific trap in #231: the subagent reviewed an empty `git diff
    // --cached` in a fresh copy and returned nothing, three times.
    const described = JSON.stringify(schema(true));
    expect(described).toMatch(/uncommitted or staged/);
  });

  it("omits the parameter entirely when the project disabled worktrees", () => {
    // Nothing to pass beats accepting it and quietly downgrading — and it costs
    // the model no context in disabled mode, as `scheduleParam` already does.
    expect(isolationParam(false)).toEqual({});
  });
});
