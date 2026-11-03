import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return { ...actual, keyText: () => "ctrl+o" };
});

import { AgentMessageRow, displayName, mentionName, renderAgentMessageText } from "../src/ui/agent-message.js";

const theme = { fg: (_color: string, text: string) => text } as any;
const one = { messages: [{ fromId: "a1", fromName: "general-purpose", text: "Both verifications complete.\nSecond line." }] };

describe("agent message row (Claude Code's kce / ah)", () => {
  it("collapsed: one line, no body preview", () => {
    expect(renderAgentMessageText(one, false, theme)).toBe("› Message from @general-purpose (ctrl+o to expand)");
  });

  it("expanded: no @, the full body indented two", () => {
    expect(renderAgentMessageText(one, true, theme)).toBe(
      "› Message from general-purpose\n  Both verifications complete.\n  Second line.");
  });

  it("several messages from one sender share a row; other senders get their own", () => {
    const details = {
      messages: [
        { fromId: "a1", fromName: "plan", text: "one" },
        { fromId: "a2", fromName: "explore", text: "x" },
        { fromId: "a1", fromName: "plan", text: "two" },
      ],
    };
    expect(renderAgentMessageText(details, false, theme)).toBe(
      "› 2 messages from @plan (ctrl+o to expand)\n› Message from @explore (ctrl+o to expand)");
    expect(renderAgentMessageText(details, true, theme)).toBe(
      "› 2 messages from plan\n  one\n\n  two\n› Message from explore\n  x");
  });

  it("sanitizes the sender's name", () => {
    expect(displayName("ab\u0007c​")).toBe("abc");
    expect(displayName("")).toBe("agent");
    expect(displayName("x".repeat(70))).toBe(`${"x".repeat(64)}…`);
    expect(mentionName("auth audit/1")).toBe("auth-audit-1");
  });

  it("a click toggles one row; while the global key expands everything, a click does nothing", () => {
    const click = { type: "click", button: "left", x: 0, y: 0, width: 80, height: 1 } as any;
    const row = new AgentMessageRow("k1", one, false, theme);
    expect(row.render(80).join("\n")).toContain("to expand");
    expect(row.handleMouse?.(click)).toEqual({ handled: true, render: true });
    expect(row.render(80).join("\n")).toContain("Second line.");
    // Survives the rebuild pi does on every global toggle: the state is keyed by message.
    expect(new AgentMessageRow("k1", one, false, theme).render(80).join("\n")).toContain("Second line.");
    row.handleMouse?.(click);
    expect(row.render(80).join("\n")).toContain("to expand");

    const globallyExpanded = new AgentMessageRow("k2", one, true, theme);
    expect(globallyExpanded.handleMouse?.(click)).toBeUndefined();
  });

  it("remembers at most 500 click-expanded rows, dropping the oldest", () => {
    const click = { type: "click", button: "left", x: 0, y: 0, width: 80, height: 1 } as any;
    for (let i = 0; i <= 500; i++) new AgentMessageRow(`cap-${i}`, one, false, theme).handleMouse(click);
    expect(new AgentMessageRow("cap-0", one, false, theme).render(80).join("\n")).toContain("to expand");
    expect(new AgentMessageRow("cap-1", one, false, theme).render(80).join("\n")).toContain("Second line.");
    expect(new AgentMessageRow("cap-500", one, false, theme).render(80).join("\n")).toContain("Second line.");
  });
});
