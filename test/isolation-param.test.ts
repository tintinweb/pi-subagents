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
    return built.isolation as { anyOf?: { const?: string }[] } | undefined;
  }

  it("offers a value meaning 'no isolation', not just 'worktree'", () => {
    const values = schema(true)?.anyOf?.map(v => v.const);
    expect(values).toContain("off");
    expect(values).toContain("worktree");
  });

  // A model that fills optional fields tends to reach for what it reads first,
  // so the inert value leads. This is the whole mitigation — if the order flips,
  // the schema stops steering and the bug is back in practice.
  it("lists the inert value first", () => {
    expect(schema(true)?.anyOf?.[0]?.const).toBe("off");
  });

  it("describes both supported repository backends", () => {
    const described = JSON.stringify(schema(true));
    expect(described).toMatch(/configured jj or Git backend/);
    expect(described).not.toMatch(/temporary git worktree/i);
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
