/**
 * mention.test.ts — the `@handle` grammar.
 *
 * Both halves are load-bearing in a way that fails silently. A handle that
 * isn't `[\w-]` can never be typed back (the trigger regex would not match it),
 * and a collision that reuses a name makes an older sibling permanently
 * unreachable. On the parse side, every rejection here is a case where being
 * too eager would swallow input the user meant for the main model — a leading
 * file path, a bare handle, a mention mid-sentence.
 */
import { describe, expect, it } from "vitest";
import { agentMentionReminder, assignHandle, describeMention, handleBase, isReservedHandle, MENTION_TRIGGER, parseMention, resolveHandleToType, stripAgentPrefix } from "../src/mention.js";

describe("handleBase", () => {
  it("lowercases so the handle matches how it is typed", () => {
    expect(handleBase("Explore")).toBe("explore");
  });

  it("keeps a hyphenated type as-is", () => {
    expect(handleBase("general-purpose")).toBe("general-purpose");
  });

  it("reduces anything outside [\\w-] to hyphens, without leaving edge hyphens", () => {
    expect(handleBase("Code Review!")).toBe("code-review");
    expect(handleBase("  spaced  out  ")).toBe("spaced-out");
  });

  it("always produces something typeable", () => {
    // A type made entirely of stripped characters would otherwise slug to "",
    // and `@` alone can address nothing.
    expect(handleBase("!!!")).toBe("agent");
    expect(handleBase("")).toBe("agent");
  });

  it("caps a long name so one agent can't own an unreadable row", () => {
    const slug = handleBase("x".repeat(200));
    expect(slug).toHaveLength(64);
  });

  it("never leaves a trailing hyphen the cap sliced into", () => {
    // 63 chars, then a hyphen run: a naive slice(0, 64) keeps that hyphen.
    expect(handleBase(`${"x".repeat(63)}   tail`).endsWith("-")).toBe(false);
  });

  it("only ever produces handles the suggestion trigger can match", () => {
    for (const type of ["Explore", "general-purpose", "Code Review!", "!!!", "デバッグ"]) {
      expect(MENTION_TRIGGER.test(`@${handleBase(type)}`)).toBe(true);
    }
  });
});

describe("assignHandle", () => {
  it("takes the plain base when it is free", () => {
    expect(assignHandle("explore", new Set())).toBe("explore");
  });

  it("numbers from 2 on the first collision", () => {
    expect(assignHandle("explore", new Set(["explore"]))).toBe("explore-2");
  });

  it("keeps counting past every taken form", () => {
    expect(assignHandle("explore", new Set(["explore", "explore-2"]))).toBe("explore-3");
  });

  it("never hands out the reserved main handle", () => {
    // `@main` addresses the main conversation. An agent holding that name
    // would silently swallow the one escape hatch out of the mention grammar.
    expect(assignHandle("main", new Set())).toBe("main-2");
  });

  it("skips a gap rather than reusing a live handle", () => {
    // explore-2 finished and was evicted; reusing it is fine, but explore-3
    // is still running and must not be shadowed.
    expect(assignHandle("explore", new Set(["explore", "explore-3"]))).toBe("explore-2");
  });
});

describe("resolveHandleToType", () => {
  const TYPES = ["general-purpose", "Explore", "Code Review!"];

  it("finds the type a handle was derived from, whatever its casing", () => {
    expect(resolveHandleToType("explore", TYPES)).toBe("Explore");
    expect(resolveHandleToType("EXPLORE", TYPES)).toBe("Explore");
  });

  it("resolves a type whose slug differs from its name", () => {
    expect(resolveHandleToType("code-review", TYPES)).toBe("Code Review!");
  });

  it("is exact, not a prefix match — a partial handle must not start an agent", () => {
    expect(resolveHandleToType("ex", TYPES)).toBeUndefined();
    expect(resolveHandleToType("explore-2", TYPES)).toBeUndefined();
  });

  it("round-trips every registered type", () => {
    for (const type of TYPES) expect(resolveHandleToType(handleBase(type), TYPES)).toBe(type);
  });

  it("refuses to resolve the reserved handle, even to a type named for it", () => {
    // Otherwise `@main do this` would start an agent instead of reaching the
    // main model — and `assignHandle` already denies its instances that name,
    // so resolving the type here would promise something unreachable.
    expect(resolveHandleToType("main", ["main", ...TYPES])).toBeUndefined();
  });
});

describe("isReservedHandle", () => {
  it("recognizes main whatever its casing", () => {
    expect(isReservedHandle("main")).toBe(true);
    expect(isReservedHandle("MAIN")).toBe(true);
  });

  it("leaves every ordinary handle alone", () => {
    for (const handle of ["explore", "mainframe", "main-2", "ma"]) {
      expect(isReservedHandle(handle)).toBe(false);
    }
  });
});

describe("stripAgentPrefix", () => {
  it("unwraps Claude Code's manual @agent-<type> spelling", () => {
    expect(stripAgentPrefix("agent-explore")).toBe("explore");
  });

  it("keeps the remainder intact when it is itself prefixed", () => {
    expect(stripAgentPrefix("agent-agent-foo")).toBe("agent-foo");
  });

  it("returns nothing when there is no prefix or nothing behind it", () => {
    expect(stripAgentPrefix("explore")).toBeUndefined();
    expect(stripAgentPrefix("agent-")).toBeUndefined();
    expect(stripAgentPrefix("agentexplore")).toBeUndefined();
  });

  it("only unwraps a prefix at the very start", () => {
    // `@sub-agent-explore` names an agent called `sub-agent-explore`. Matching
    // `agent-` anywhere would silently redirect it to `@explore`.
    expect(stripAgentPrefix("sub-agent-explore")).toBeUndefined();
  });
});

describe("describeMention", () => {
  it("uses the message as the agent's short label", () => {
    expect(describeMention("find every retry marker")).toBe("find every retry marker");
  });

  it("takes the first line and collapses whitespace", () => {
    expect(describeMention("  audit   the RPC path\nthen report back  ")).toBe("audit the RPC path");
  });

  it("clips a long message rather than putting a paragraph in every agent surface", () => {
    const label = describeMention("x".repeat(200));
    expect(label).toHaveLength(40);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("parseMention", () => {
  it("splits a leading handle from its message", () => {
    expect(parseMention("@explore check the RPC path")).toEqual({
      handle: "explore",
      message: "check the RPC path",
    });
  });

  it("trims the message and accepts a newline as the separator", () => {
    expect(parseMention("@explore   spaced   ")).toEqual({ handle: "explore", message: "spaced" });
    expect(parseMention("@explore\nline1\nline2")).toEqual({ handle: "explore", message: "line1\nline2" });
  });

  it("rejects a bare handle — that belongs to the main model", () => {
    expect(parseMention("@explore")).toBeNull();
    expect(parseMention("@explore ")).toBeNull();
    expect(parseMention("@explore \t ")).toBeNull();
  });

  it("rejects a leading file path so pi's @-attachment keeps working", () => {
    expect(parseMention("@src/index.ts summarize this")).toBeNull();
    expect(parseMention("@README.md what changed")).toBeNull();
  });

  it("rejects a mention that is not at the start of the input", () => {
    expect(parseMention("hey @explore look at this")).toBeNull();
    expect(parseMention(" @explore look at this")).toBeNull();
  });
});

describe("agentMentionReminder", () => {
  it("is Claude Code's string, byte for byte", () => {
    // Fixed wording rather than a paraphrase, so the model gets the
    // wording it was trained against. Asserted whole — including the trailing
    // space before the closing newline, which is in the original and is exactly the kind of thing a tidy-up would drop.
    expect(agentMentionReminder("code-review")).toBe(
      '<system-reminder>\nThe user has expressed a desire to invoke the agent "code-review". Please invoke the agent appropriately, passing in the required context to it. \n</system-reminder>',
    );
  });

  it("names the agent it was given", () => {
    expect(agentMentionReminder("Plan")).toContain('invoke the agent "Plan"');
  });
});
